import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type Anthropic from "@anthropic-ai/sdk";
import { McpServer, listMcpServers } from "../db.js";

/** 注入工作循环的 MCP 工具数量上限（防上下文膨胀，尤其轻量通道） */
const MAX_MCP_TOOLS = Number(process.env.AITEAM_MAX_MCP_TOOLS ?? 40);
const TOOL_RESULT_LIMIT = 20000;
/** 同参调用结果缓存：重复检索直接回缓存（零计费）。TTL 10 分钟，上限 200 条 */
const CALL_CACHE_TTL = Number(process.env.AITEAM_MCP_CACHE_TTL_MS ?? 10 * 60_000);
const callCache = new Map<string, { text: string; ts: number }>();

interface Connection {
  client: Client;
  tools: { name: string; description: string; inputSchema: any }[];
}

const connections = new Map<string, Connection>(); // serverId -> 连接（懒建立）
const failed = new Map<string, number>(); // serverId -> 失败时间（5 分钟内不重试）

/** MCP 连接/调用超时：防一个挂死的插件把整个 agent 运行（消息）永久卡在 streaming。 */
const MCP_TIMEOUT_MS = Number(process.env.AITEAM_MCP_TIMEOUT_MS ?? 45000);
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label}超时（>${Math.round(ms / 1000)}s）`)), ms)),
  ]);
}

function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24) || "srv";
}

async function connect(server: McpServer): Promise<Connection> {
  const client = new Client({ name: "aiteam", version: "1.0.0" });
  if (server.kind === "stdio") {
    let args: string[] = [];
    try {
      args = JSON.parse(server.args_json);
    } catch { /* ignore */ }
    // 自定义环境变量（如 BOCHA_API_KEY）：在 SDK 安全默认环境(含 PATH)之上叠加，让需要 env key 的 stdio MCP 可用。
    let envExtra: Record<string, string> = {};
    try {
      const parsed = JSON.parse(server.env_json || "{}");
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) envExtra[k] = String(v);
      }
    } catch { /* ignore */ }
    const env = { ...getDefaultEnvironment(), ...envExtra };
    await client.connect(new StdioClientTransport({ command: server.command, args, env }));
  } else {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: server.auth_token ? { headers: { Authorization: `Bearer ${server.auth_token}` } } : undefined,
      })
    );
  }
  const listed = await client.listTools();
  return {
    client,
    tools: listed.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    })),
  };
}

async function ensureConnection(server: McpServer): Promise<Connection | null> {
  const cached = connections.get(server.id);
  if (cached) return cached;
  const failedAt = failed.get(server.id);
  if (failedAt && Date.now() - failedAt < 5 * 60_000) return null; // 熔断窗口内不重试
  try {
    const conn = await withTimeout(connect(server), MCP_TIMEOUT_MS, `连接 MCP「${server.name}」`);
    connections.set(server.id, conn);
    failed.delete(server.id);
    return conn;
  } catch (err) {
    console.error(`[mcp] connect ${server.name} failed:`, err);
    failed.set(server.id, Date.now());
    return null;
  }
}

export function dropConnection(serverId: string) {
  const conn = connections.get(serverId);
  if (conn) void conn.client.close().catch(() => undefined);
  connections.delete(serverId);
  failed.delete(serverId);
}

/** 测试连接：返回工具数（抛错则由路由层转为错误信息） */
export async function testMcpServer(server: McpServer): Promise<number> {
  dropConnection(server.id);
  const conn = await connect(server);
  connections.set(server.id, conn);
  return conn.tools.length;
}

/** 已启用 MCP server 的工具，转换为 Anthropic 工具定义（名字带 mcp__<server>__ 前缀防冲突） */
export async function mcpToolDefs(): Promise<Anthropic.Tool[]> {
  const defs: Anthropic.Tool[] = [];
  for (const server of listMcpServers()) {
    if (!server.enabled) continue;
    const conn = await ensureConnection(server);
    if (!conn) continue;
    const prefix = `mcp__${sanitizeName(server.name)}__`;
    for (const t of conn.tools) {
      if (defs.length >= MAX_MCP_TOOLS) return defs;
      defs.push({
        name: `${prefix}${t.name}`.slice(0, 128),
        description: `[${server.name}] ${t.description}`.slice(0, 1024),
        input_schema: t.inputSchema,
      });
    }
  }
  return defs;
}

export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__");
}

/**
 * capability 技能依赖判断：该 MCP 工具前缀是否就绪。
 * 启用的 server 即视为可达（懒连接：首次调用才连）；若已有缓存连接，则进一步要求工具确实存在
 * （避免 MAX_MCP_TOOLS 截断或工具名不匹配导致"标就绪却调空"）。prefix 形如 mcp__<server>__* 或具体工具名。
 */
export function mcpToolPrefixReady(prefix: string): boolean {
  const m = prefix.match(/^mcp__(.+?)__/);
  if (!m) return false;
  const key = m[1];
  const server = listMcpServers().find((s) => Boolean(s.enabled) && sanitizeName(s.name) === key);
  if (!server) return false;
  const conn = connections.get(server.id);
  if (!conn) return true; // 懒连接：启用即视为就绪
  const wildcard = prefix.endsWith("*");
  const bare = prefix.replace(/\*$/, "").replace(/^mcp__.+?__/, "");
  // 通配前缀（mcp__srv__*）用 startsWith；具体工具名（mcp__srv__tool）必须精确匹配，避免 tool_v2 误判就绪
  return conn.tools.some((t) => (bare === "" ? true : wildcard ? t.name.startsWith(bare) : t.name === bare));
}

/**
 * 引擎审批门：仅当该 MCP 工具所属 server 的 safety 为 **exec**（本地执行/写盘，高 blast radius）时返回该 server，
 * 强制改走 request_approval。network（如联网搜索/抓取，读为主、只发查询）不拦截——否则每次搜索都要人工放行、体验崩坏；
 * network 仅在 UI 标徽章提示。local 不拦截。registry 安装时带入 safety。
 */
export function mcpSafetyGate(name: string): McpServer | null {
  const mt = name.match(/^mcp__(.+?)__(.+)$/);
  if (!mt) return null;
  const server = listMcpServers().find((s) => sanitizeName(s.name) === mt[1] && Boolean(s.enabled));
  if (!server) return null;
  return server.safety === "exec" ? server : null;
}

/** 执行 MCP 工具调用，返回文本结果（供 tool_result） */
export async function callMcpTool(name: string, input: unknown): Promise<string> {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return `错误：无效的 MCP 工具名 ${name}`;
  const [, serverKey, toolName] = m;
  const server = listMcpServers().find((s) => sanitizeName(s.name) === serverKey && s.enabled);
  if (!server) return `错误：MCP server「${serverKey}」不存在或已停用`;
  const conn = await ensureConnection(server);
  if (!conn) return `错误：MCP server「${server.name}」连接失败，请检查配置（设置 → MCP 插件 → 测试）`;
  const cacheKey = `${name}:${JSON.stringify(input ?? {})}`;
  const hit = callCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CALL_CACHE_TTL) return hit.text;
  try {
    const result = await withTimeout(
      conn.client.callTool({ name: toolName, arguments: (input ?? {}) as Record<string, unknown> }),
      MCP_TIMEOUT_MS,
      `插件「${server.name}:${toolName}」调用`
    );
    const parts: string[] = [];
    for (const block of (result.content as any[]) ?? []) {
      if (block?.type === "text") parts.push(block.text);
      else if (block?.type === "resource" && block.resource?.text) parts.push(block.resource.text);
      else parts.push(JSON.stringify(block));
    }
    const text = parts.join("\n") || "(无输出)";
    const out = (result.isError ? `工具返回错误：${text}` : text).slice(0, TOOL_RESULT_LIMIT);
    if (!result.isError) {
      if (callCache.size >= 200) callCache.delete(callCache.keys().next().value as string);
      callCache.set(cacheKey, { text: out, ts: Date.now() });
    }
    return out;
  } catch (err: any) {
    // 连接失效则下次懒重连
    dropConnection(server.id);
    return `MCP 工具执行失败：${err?.message ?? err}`;
  }
}

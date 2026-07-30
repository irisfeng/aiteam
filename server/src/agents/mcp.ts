import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type Anthropic from "@anthropic-ai/sdk";
import { basename } from "node:path";
import { McpServer, listMcpServers } from "../db.js";
import { currentOwnerOrNull } from "../ownerScope.js";
import { decryptSecret } from "../secrets.js";

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

export const STDIO_PRODUCTION_DISABLED_CODE =
  "MCP_STDIO_PRODUCTION_DISABLED";

export function stdioRuntimeAllowed(kind: McpServer["kind"]): boolean {
  return kind !== "stdio" || process.env.NODE_ENV !== "production";
}

/**
 * 生产进程在没有独立 OS/container sandbox runner 前禁止派生 stdio MCP。
 *
 * command basename 白名单不能约束 node -e / python -c / npx package 等参数，
 * cwd 也不是文件系统边界；审批只表达用户意图，不能代替进程隔离。因此生产
 * 必须在唯一真实 spawn 边界 fail-closed。开发/测试仍保留 stdio 便于本地验收。
 */
export function assertStdioServerRuntimeAllowed(server: McpServer): void {
  if (!stdioRuntimeAllowed(server.kind)) {
    throw new Error(
      `${STDIO_PRODUCTION_DISABLED_CODE}: 生产环境未配置独立 stdio 沙箱运行器，拒绝启动本地 MCP 子进程`,
    );
  }
}

export function assertProductionStdioConfiguration(): void {
  if (process.env.NODE_ENV !== "production") return;
  const enabledStdioCount = listMcpServers().filter(
    (server) => server.kind === "stdio" && Boolean(server.enabled),
  ).length;
  if (enabledStdioCount > 0) {
    throw new Error(
      `${STDIO_PRODUCTION_DISABLED_CODE}: 生产数据库中存在 ${enabledStdioCount} 个已启用的 stdio MCP；请在隔离环境中停用后再启动`,
    );
  }
}

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

/**
 * 开发/测试 stdio MCP 启动命令白名单。它只收窄误配置面，不是进程沙箱：
 * node -e / python -c / npx package 仍可通过参数执行代码。生产因此由上面的
 * fail-closed 门完全禁用 stdio，AITEAM_MCP_STDIO_ALLOW 不能改变该结论。
 * 按 basename 匹配（容许绝对路径如 /usr/bin/python3；Windows 去 .exe）。
 */
const STDIO_ALLOWED_DEFAULT = ["npx", "uvx", "uv", "node", "python", "python3", "markitdown-mcp"];
export function stdioAllowedCommands(): string[] {
  const extra = (process.env.AITEAM_MCP_STDIO_ALLOW || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...STDIO_ALLOWED_DEFAULT, ...extra])];
}
export function stdioCommandAllowed(command: string): boolean {
  const base = basename(command.trim()).toLowerCase().replace(/\.exe$/, "");
  return stdioAllowedCommands().includes(base);
}

/** 与 mcpToolDefs 注册用同一套名字规则拼完整工具名；调用侧不要自己拼前缀（大小写/分隔符会对不上）。 */
export function mcpToolName(serverName: string, tool: string): string {
  return `mcp__${sanitizeName(serverName)}__${tool}`;
}

async function connect(server: McpServer): Promise<Connection> {
  const client = new Client({ name: "aiteam", version: "1.0.0" });
  if (server.kind === "stdio") {
    assertStdioServerRuntimeAllowed(server);
    // 二次防御：路由层建档时已校验，但存量行/直接写库的行也必须在启动点被拦下
    if (!stdioCommandAllowed(server.command)) {
      throw new Error(
        `stdio 命令「${server.command}」不在白名单（${stdioAllowedCommands().join("/")}）；如确需可用 AITEAM_MCP_STDIO_ALLOW 扩展`
      );
    }
    let args: string[] = [];
    try {
      args = JSON.parse(server.args_json);
    } catch { /* ignore */ }
    // 自定义环境变量（如 BOCHA_API_KEY）：在 SDK 安全默认环境(含 PATH)之上叠加，让需要 env key 的 stdio MCP 可用。
    let envExtra: Record<string, string> = {};
    try {
      const parsed = JSON.parse(decryptSecret(server.env_json || "{}") || "{}");
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) envExtra[k] = String(v);
      }
    } catch { /* ignore */ }
    const env = { ...getDefaultEnvironment(), ...envExtra };
    await client.connect(new StdioClientTransport({ command: server.command, args, env }));
  } else {
    const token = decryptSecret(server.auth_token);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
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
  if (!server || !stdioRuntimeAllowed(server.kind)) return false;
  const conn = connections.get(server.id);
  if (!conn) return true; // 懒连接：启用即视为就绪
  const wildcard = prefix.endsWith("*");
  const bare = prefix.replace(/\*$/, "").replace(/^mcp__.+?__/, "");
  // 通配前缀（mcp__srv__*）用 startsWith；具体工具名（mcp__srv__tool）必须精确匹配，避免 tool_v2 误判就绪
  return conn.tools.some((t) => (bare === "" ? true : wildcard ? t.name.startsWith(bare) : t.name === bare));
}

export function mcpServerForTool(name: string): McpServer | null {
  const mt = name.match(/^mcp__(.+?)__(.+)$/);
  if (!mt) return null;
  return (
    listMcpServers().find(
      (server) =>
        sanitizeName(server.name) === mt[1] &&
        Boolean(server.enabled) &&
        stdioRuntimeAllowed(server.kind),
    ) ?? null
  );
}

/**
 * 引擎审批门第一层：exec（本地执行/写盘，高 blast radius）始终强制改走 request_approval。
 * network 不在这里一刀切，否则普通搜索会被频繁打断；带来源文档的任务和严格模式在
 * engine.mcpRequiresApprovalForTask 中继续拦截，防止源材料被静默外发。
 */
export function mcpSafetyGate(name: string): McpServer | null {
  const server = mcpServerForTool(name);
  if (!server) return null;
  return server.safety === "exec" ? server : null;
}

/**
 * 从 MCP 工具入参提取"检索查询签名"，用于跨插件去重（同一查询别用多个搜索引擎重复花钱）。
 * 仅匹配常见的查询字段；非检索类工具（如 markitdown 的 uri、tavily_extract 的 urls）返回 null（不参与去重）。
 */
export function searchQuerySignature(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const queryKeys = new Set(["query", "search_query", "q", "keyword", "keywords", "question", "search"]);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (queryKeys.has(k.toLowerCase()) && typeof v === "string" && v.trim()) parts.push(v);
  }
  if (parts.length === 0) return null;
  return parts.join(" ").toLowerCase().replace(/\s+/g, " ").trim();
}

interface CallMcpToolOptions {
  /** 在可能耗时的连接前后核验调用上下文；false 时 fail-closed，不触发真实 callTool。 */
  canDispatch?: () => boolean;
}

function dispatchAllowed(options: CallMcpToolOptions): boolean {
  try {
    return options.canDispatch ? options.canDispatch() : true;
  } catch {
    return false;
  }
}

/** 执行 MCP 工具调用，返回文本结果（供 tool_result） */
export async function callMcpTool(
  name: string,
  input: unknown,
  options: CallMcpToolOptions = {},
): Promise<string> {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return `错误：无效的 MCP 工具名 ${name}`;
  const [, serverKey, toolName] = m;
  const server = listMcpServers().find((s) => sanitizeName(s.name) === serverKey && s.enabled);
  if (!server) return `错误：MCP server「${serverKey}」不存在或已停用`;
  if (!dispatchAllowed(options)) return "错误：任务执行权已撤销，本次 MCP 工具调用未执行";
  const conn = await ensureConnection(server);
  if (!conn) return `错误：MCP server「${server.name}」连接失败，请检查配置（设置 → MCP 插件 → 测试）`;
  // ensureConnection 可能包含网络/进程握手；stop、取消或改派可在 await 期间发生，
  // 因此必须紧邻真实 callTool 再校验一次，而不能只依赖授权消费前的状态。
  if (!dispatchAllowed(options)) return "错误：任务执行权已撤销，本次 MCP 工具调用未执行";
  // 缓存是进程级全局，而结果可能含租户私有数据（检索内容/文档转换产物）——key 必须带 owner 前缀，
  // 否则多用户下 A 的结果会命中给 B。缺 owner 上下文时 fail-closed：不读不写缓存，只走真实调用。
  const owner = currentOwnerOrNull();
  const cacheKey = owner ? `${owner}:${name}:${JSON.stringify(input ?? {})}` : null;
  const hit = cacheKey ? callCache.get(cacheKey) : undefined;
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
    if (!result.isError && cacheKey) {
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

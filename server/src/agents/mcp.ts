import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type Anthropic from "@anthropic-ai/sdk";
import { basename } from "node:path";
import { McpServer, listMcpServers } from "../db.js";
import { currentOwnerOrNull } from "../ownerScope.js";
import { decryptSecret } from "../secrets.js";
import {
  assertStdioSandboxImageReady,
  assertStdioSandboxRunnerReady,
  buildStdioSandboxLaunch,
  isPinnedContainerImage,
  type StdioSandboxScope,
} from "./stdioSandbox.js";

/** 注入工作循环的 MCP 工具数量上限（防上下文膨胀，尤其轻量通道） */
const MAX_MCP_TOOLS = Number(process.env.AITEAM_MAX_MCP_TOOLS ?? 40);
const TOOL_RESULT_LIMIT = 20000;
const MAX_MCP_SCHEMA_BYTES = 16 * 1024;
const MAX_MCP_SCHEMA_DEPTH = 8;
const MAX_MCP_SCHEMA_NODES = 512;
const MAX_MCP_SCHEMA_STRING_BYTES = 8 * 1024;
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
export const STDIO_IMAGE_REQUIRED_CODE = "MCP_STDIO_IMAGE_REQUIRED";
export const STDIO_IMAGE_UNAVAILABLE_CODE = "MCP_STDIO_IMAGE_UNAVAILABLE";
export const STDIO_PRODUCTION_SAFETY_DISABLED_CODE =
  "MCP_STDIO_PRODUCTION_SAFETY_DISABLED";

export function stdioRuntimeAllowed(kind: McpServer["kind"]): boolean {
  if (kind !== "stdio" || process.env.NODE_ENV !== "production") return true;
  try {
    assertStdioSandboxRunnerReady();
    return true;
  } catch {
    return false;
  }
}

export function stdioRuntimeBlockedCode(
  kind: McpServer["kind"],
  safety: McpServer["safety"] = "local",
  containerImage = "",
): string | null {
  if (kind !== "stdio" || process.env.NODE_ENV !== "production") return null;
  if (!stdioRuntimeAllowed(kind)) return STDIO_PRODUCTION_DISABLED_CODE;
  if (safety !== "local") return STDIO_PRODUCTION_SAFETY_DISABLED_CODE;
  if (!isPinnedContainerImage(containerImage)) return STDIO_IMAGE_REQUIRED_CODE;
  return null;
}

export function stdioServerRuntimeAllowed(server: McpServer): boolean {
  try {
    assertStdioServerRuntimeAllowed(server);
    return true;
  } catch {
    return false;
  }
}

export function stdioServerRuntimeBlockedCode(
  server: McpServer,
): string | null {
  const configCode = stdioRuntimeBlockedCode(
    server.kind,
    server.safety,
    server.container_image,
  );
  if (configCode) return configCode;
  if (server.kind !== "stdio" || process.env.NODE_ENV !== "production") {
    return null;
  }
  try {
    assertStdioSandboxImageReady(server.container_image);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.startsWith(`${STDIO_IMAGE_UNAVAILABLE_CODE}:`)
      ? STDIO_IMAGE_UNAVAILABLE_CODE
      : STDIO_PRODUCTION_DISABLED_CODE;
  }
}

/**
 * 生产只允许 rootless Podman 中的 local stdio。network/exec 仍 fail-closed，
 * 因为联网授权必须早于容器启动，exec 还需要独立写入策略；两者不能借 local
 * runner 的容器边界偷渡。
 *
 * command basename 白名单不能约束 node -e / python -c / npx package 等参数，
 * cwd 也不是文件系统边界；审批只表达用户意图，不能代替进程隔离。因此生产
 * 必须在唯一真实 spawn 边界 fail-closed。开发/测试仍保留 stdio 便于本地验收。
 */
export function assertStdioServerRuntimeAllowed(server: McpServer): void {
  const code = stdioRuntimeBlockedCode(
    server.kind,
    server.safety,
    server.container_image,
  );
  if (code) {
    const message =
      code === STDIO_IMAGE_REQUIRED_CODE
        ? "生产 stdio 必须配置按 sha256 digest 固定的 OCI 镜像"
        : code === STDIO_PRODUCTION_SAFETY_DISABLED_CODE
          ? "生产沙箱当前只开放 safety=local；network/exec 继续禁用"
          : "生产环境未配置可用的 rootless Podman stdio 沙箱运行器";
    throw new Error(`${code}: ${message}`);
  }
  if (server.kind === "stdio" && process.env.NODE_ENV === "production") {
    assertStdioSandboxImageReady(server.container_image);
  }
}

export function assertProductionStdioConfiguration(): void {
  if (process.env.NODE_ENV !== "production") return;
  const enabledStdio = listMcpServers().filter(
    (server) => server.kind === "stdio" && Boolean(server.enabled),
  );
  for (const server of enabledStdio) {
    try {
      assertStdioServerRuntimeAllowed(server);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${detail}: 已启用 stdio MCP「${server.name}」不满足生产隔离契约，请先停用或修正配置`,
      );
    }
  }
}

/** MCP 连接/调用超时：防一个挂死的插件把整个 agent 运行（消息）永久卡在 streaming。 */
const MCP_TIMEOUT_MS = Number(process.env.AITEAM_MCP_TIMEOUT_MS ?? 45000);
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}超时（>${Math.round(ms / 1000)}s）`)),
      ms,
    );
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24) || "srv";
}

/**
 * 开发/测试 stdio MCP 启动命令白名单。它只收窄误配置面，不是进程沙箱：
 * node -e / python -c / npx package 仍可通过参数执行代码。生产因此由上面的
 * rootless Podman 隔离；AITEAM_MCP_STDIO_ALLOW 不能改变生产容器边界。
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

function productionSandboxedStdio(server: McpServer): boolean {
  return server.kind === "stdio" && process.env.NODE_ENV === "production";
}

/**
 * MCP tool metadata is untrusted input that is relayed into the model context.
 * Clone only bounded JSON values and fail closed instead of truncating a schema
 * into different validation semantics.
 */
export function boundedMcpInputSchema(
  value: unknown,
): Record<string, unknown> | null {
  let nodes = 0;
  let stringBytes = 0;
  const seen = new Set<object>();

  function clone(candidate: unknown, depth: number): unknown {
    nodes += 1;
    if (nodes > MAX_MCP_SCHEMA_NODES || depth > MAX_MCP_SCHEMA_DEPTH) {
      throw new Error("schema complexity limit exceeded");
    }
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      typeof candidate === "number"
    ) {
      return candidate;
    }
    if (typeof candidate === "string") {
      stringBytes += Buffer.byteLength(candidate);
      if (stringBytes > MAX_MCP_SCHEMA_STRING_BYTES) {
        throw new Error("schema string budget exceeded");
      }
      return candidate;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > 128) throw new Error("schema array limit exceeded");
      if (seen.has(candidate)) throw new Error("cyclic schema");
      seen.add(candidate);
      const result = candidate.map((child) => clone(child, depth + 1));
      seen.delete(candidate);
      return result;
    }
    if (candidate && typeof candidate === "object") {
      if (seen.has(candidate)) throw new Error("cyclic schema");
      seen.add(candidate);
      const entries = Object.entries(candidate as Record<string, unknown>);
      if (entries.length > 128) {
        throw new Error("schema property limit exceeded");
      }
      const result: Record<string, unknown> = {};
      for (const [key, child] of entries) {
        if (Buffer.byteLength(key) > 128 || child === undefined) {
          throw new Error("invalid schema member");
        }
        stringBytes += Buffer.byteLength(key);
        if (stringBytes > MAX_MCP_SCHEMA_STRING_BYTES) {
          throw new Error("schema string budget exceeded");
        }
        result[key] = clone(child, depth + 1);
      }
      seen.delete(candidate);
      return result;
    }
    throw new Error("schema contains a non-JSON value");
  }

  try {
    const cloned = clone(value, 0);
    if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) {
      return null;
    }
    const schema = cloned as Record<string, unknown>;
    if (schema.type !== undefined && schema.type !== "object") return null;
    if (Buffer.byteLength(JSON.stringify(schema)) > MAX_MCP_SCHEMA_BYTES) {
      return null;
    }
    return schema;
  } catch {
    return null;
  }
}

interface ConnectOptions {
  metadataOnly?: boolean;
}

async function connect(
  server: McpServer,
  scope?: StdioSandboxScope,
  options: ConnectOptions = {},
): Promise<Connection> {
  const client = new Client({ name: "aiteam", version: "1.0.0" });
  try {
    if (server.kind === "stdio") {
      assertStdioServerRuntimeAllowed(server);
      // 开发/测试仍在宿主执行，保留 basename 误配置门；生产命令在 digest-pinned
      // 容器内执行，真正安全边界是 buildStdioSandboxLaunch 生成的固定 runner 参数。
      if (
        process.env.NODE_ENV !== "production" &&
        !stdioCommandAllowed(server.command)
      ) {
        throw new Error(
          `stdio 命令「${server.command}」不在白名单（${stdioAllowedCommands().join("/")}）；如确需可用 AITEAM_MCP_STDIO_ALLOW 扩展`
        );
      }
      let args: string[] = [];
      try {
        args = JSON.parse(server.args_json);
      } catch { /* ignore */ }
      // 自定义环境变量（如 BOCHA_API_KEY）：runner 保留 SDK 安全默认环境，
      // 容器只注入 env_json 明确配置的键，避免把宿主 HOME/PATH 等隐式带入。
      let envExtra: Record<string, string> = {};
      if (!options.metadataOnly) {
        try {
          const parsed = JSON.parse(
            decryptSecret(server.env_json || "{}") || "{}",
          );
          if (parsed && typeof parsed === "object") {
            for (const [k, v] of Object.entries(parsed)) {
              envExtra[k] = String(v);
            }
          }
        } catch {
          /* ignore */
        }
      }
      const env = { ...getDefaultEnvironment(), ...envExtra };
      if (process.env.NODE_ENV === "production") {
        const owner = currentOwnerOrNull();
        if (!scope || !owner || scope.ownerId !== owner) {
          throw new Error(
            "MCP_STDIO_CONTEXT_REQUIRED: production stdio requires the current owner and a Mission/task execution scope",
          );
        }
        const launchScope = options.metadataOnly
          ? {
              ownerId: scope.ownerId,
              executionId: `metadata:${server.id}`,
            }
          : scope;
        const requestedContainerEnvKeys = options.metadataOnly
          ? []
          : Object.keys(envExtra);
        const launch = buildStdioSandboxLaunch(
          server,
          launchScope,
          env,
          requestedContainerEnvKeys,
        );
        await withTimeout(
          client.connect(
            new StdioClientTransport({
              command: launch.command,
              args: launch.args,
              env: launch.env,
            }),
          ),
          MCP_TIMEOUT_MS,
          `连接隔离 MCP「${server.name}」`,
        );
      } else {
        await withTimeout(
          client.connect(
            new StdioClientTransport({ command: server.command, args, env }),
          ),
          MCP_TIMEOUT_MS,
          `连接 MCP「${server.name}」`,
        );
      }
    } else {
      const token = decryptSecret(server.auth_token);
      await withTimeout(
        client.connect(
          new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
          })
        ),
        MCP_TIMEOUT_MS,
        `连接 MCP「${server.name}」`,
      );
    }
    const listed = await withTimeout(
      client.listTools(),
      MCP_TIMEOUT_MS,
      `读取 MCP「${server.name}」工具清单`,
    );
    return {
      client,
      tools: listed.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      })),
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function ensureConnection(
  server: McpServer,
  scope?: StdioSandboxScope,
): Promise<Connection | null> {
  // 每次生产 stdio 连接都是单独的 --rm 容器；不进入 server 级全局缓存，
  // 避免一个 Mission 的进程、内存或 workspace 被另一 Mission 复用。
  if (productionSandboxedStdio(server)) {
    try {
      return await connect(server, scope);
    } catch (err) {
      console.error(`[mcp] sandbox connect ${server.name} failed:`, err);
      return null;
    }
  }
  const cached = connections.get(server.id);
  if (cached) return cached;
  const failedAt = failed.get(server.id);
  if (failedAt && Date.now() - failedAt < 5 * 60_000) return null; // 熔断窗口内不重试
  try {
    const conn = await connect(server);
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

/** 测试连接：生产 stdio 使用一次性隔离容器，其他类型保持原有懒连接。 */
export async function testMcpServer(
  server: McpServer,
  scope?: StdioSandboxScope,
): Promise<number> {
  dropConnection(server.id);
  const conn = await connect(server, scope);
  if (productionSandboxedStdio(server)) {
    try {
      return conn.tools.length;
    } finally {
      await conn.client.close().catch(() => undefined);
    }
  }
  connections.set(server.id, conn);
  return conn.tools.length;
}

/** 已启用 MCP server 的工具，转换为 Anthropic 工具定义（名字带 mcp__<server>__ 前缀防冲突） */
export async function mcpToolDefs(
  scope?: StdioSandboxScope,
): Promise<Anthropic.Tool[]> {
  const defs: Anthropic.Tool[] = [];
  for (const server of listMcpServers()) {
    if (!server.enabled) continue;
    if (
      productionSandboxedStdio(server) &&
      (!scope || !stdioServerRuntimeAllowed(server))
    ) {
      continue;
    }
    const conn = productionSandboxedStdio(server)
      ? await connect(server, scope, { metadataOnly: true })
      : await ensureConnection(server, scope);
    if (!conn) continue;
    try {
      const prefix = `mcp__${sanitizeName(server.name)}__`;
      for (const t of conn.tools) {
        if (defs.length >= MAX_MCP_TOOLS) return defs;
        const inputSchema = boundedMcpInputSchema(t.inputSchema);
        if (!inputSchema) {
          console.warn(
            `[mcp] skipped ${server.name}:${t.name} because its input schema exceeds metadata limits`,
          );
          continue;
        }
        defs.push({
          name: `${prefix}${t.name}`.slice(0, 128),
          description: `[${server.name}] ${t.description}`.slice(0, 1024),
          input_schema: inputSchema as Anthropic.Tool.InputSchema,
        });
      }
    } finally {
      if (productionSandboxedStdio(server)) {
        await conn.client.close().catch(() => undefined);
      }
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
  if (!server || !stdioServerRuntimeAllowed(server)) return false;
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
        stdioServerRuntimeAllowed(server),
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
  /** 生产 stdio 用 owner + Mission/task 作用域派生唯一工作区。 */
  scope?: StdioSandboxScope;
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
  const sandboxed = productionSandboxedStdio(server);
  const owner = currentOwnerOrNull();
  const executionScope = sandboxed ? options.scope?.executionId : "";
  const cacheKey =
    owner && (!sandboxed || executionScope)
      ? `${owner}:${executionScope}:${name}:${JSON.stringify(input ?? {})}`
      : null;
  const hit = cacheKey ? callCache.get(cacheKey) : undefined;
  if (hit && Date.now() - hit.ts < CALL_CACHE_TTL) return hit.text;
  const conn = await ensureConnection(server, options.scope);
  if (!conn) return `错误：MCP server「${server.name}」连接失败，请检查配置（设置 → MCP 插件 → 测试）`;
  try {
    // ensureConnection 可能包含网络/进程握手；stop、取消或改派可在 await 期间发生，
    // 因此必须紧邻真实 callTool 再校验一次，而不能只依赖授权消费前的状态。
    if (!dispatchAllowed(options)) {
      return "错误：任务执行权已撤销，本次 MCP 工具调用未执行";
    }
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
  } finally {
    if (sandboxed) {
      await conn.client.close().catch(() => undefined);
    }
  }
}

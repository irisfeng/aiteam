import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import { currentOwner } from "./ownerScope.js";
import { assertCredentialKeyReady, canonicalizeSecret, decryptSecret, encryptSecret } from "./secrets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// AITEAM_DATA_DIR：测试/多实例可指向隔离目录；不设则用默认 server/data
const dataDir = process.env.AITEAM_DATA_DIR || join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, "aiteam.db");

type StoredImageProvider = Record<string, unknown> & { api_key?: string | null };

function parseStoredImageProvider(value: string): StoredImageProvider {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("image_provider 配置格式损坏，拒绝迁移");
  }
  const provider = parsed as StoredImageProvider;
  if (provider.api_key != null && typeof provider.api_key !== "string") {
    throw new Error("image_provider api_key 必须是字符串或空值，拒绝迁移");
  }
  return provider;
}

/**
 * Production copy-only 门禁必须早于 journal_mode、CREATE/ALTER 等任何数据库写入。
 * 把现有 db/WAL/SHM 镜像到临时目录后扫描凭证列，避免 SQLite 在源目录补建 -shm；
 * plaintext/enc:v1/坏 enc1 会直接抛错。
 */
function preflightProductionCredentials(path: string): void {
  if (process.env.NODE_ENV !== "production" || !existsSync(path)) return;
  const probeDir = mkdtempSync(join(tmpdir(), "aiteam-credential-preflight-"));
  const probePath = join(probeDir, "aiteam.db");
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = `${path}${suffix}`;
      if (existsSync(source)) copyFileSync(source, `${probePath}${suffix}`);
    }
    const probe = new Database(probePath, { readonly: true, fileMustExist: true });
    const tableColumns = (table: string): Set<string> => {
      const exists = probe.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
      ).get(table);
      if (!exists) return new Set();
      return new Set(
        (probe.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
          .map((column) => column.name)
      );
    };
    const validate = (value: unknown, emptyValues = new Set([""])) => {
      if (typeof value !== "string") throw new Error("凭证字段格式损坏，必须是字符串");
      if (!emptyValues.has(value)) canonicalizeSecret(value);
    };
    try {
      probe.pragma("query_only = ON");
      const providerColumns = tableColumns("providers");
      if (providerColumns.has("api_key")) {
        for (const row of probe.prepare("SELECT api_key FROM providers").all() as { api_key: unknown }[]) {
          validate(row.api_key);
        }
      }
      const mcpColumns = tableColumns("mcp_servers");
      if (mcpColumns.has("auth_token")) {
        for (const row of probe.prepare("SELECT auth_token FROM mcp_servers").all() as { auth_token: unknown }[]) {
          validate(row.auth_token);
        }
      }
      if (mcpColumns.has("env_json")) {
        for (const row of probe.prepare("SELECT env_json FROM mcp_servers").all() as { env_json: unknown }[]) {
          validate(row.env_json, new Set(["", "{}"]));
        }
      }
      const settingColumns = tableColumns("app_settings");
      if (settingColumns.has("key") && settingColumns.has("value")) {
        const row = probe.prepare(
          "SELECT value FROM app_settings WHERE key = 'image_provider'"
        ).get() as { value: unknown } | undefined;
        if (row?.value != null) {
          if (typeof row.value !== "string") throw new Error("image_provider 配置格式损坏，拒绝迁移");
          const parsed = parseStoredImageProvider(row.value);
          validate(parsed.api_key ?? "");
        }
      }
    } finally {
      probe.close();
    }
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

// 生产缺密钥或含旧格式时，在创建/修改数据库文件前失败。
assertCredentialKeyReady();
preflightProductionCredentials(dbPath);

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🤖',
  role TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'claude-opus-4-8',
  created_at INTEGER NOT NULL,
  UNIQUE(owner_id, name)
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'channel',
  dm_agent_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_agents (
  channel_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  PRIMARY KEY (channel_id, agent_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL,
  author_type TEXT NOT NULL,
  author_id TEXT,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'complete',
  reply_depth INTEGER NOT NULL DEFAULT 0,
  usage_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  channel_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  assignee_agent_id TEXT,
  created_by TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  task_id TEXT NOT NULL,
  channel_id TEXT,
  project_id TEXT,
  agent_id TEXT,
  type TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  channel_id TEXT,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  consumed_at INTEGER
);
CREATE TABLE IF NOT EXISTS agent_memory (
  agent_id TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  channel_id TEXT,
  task_id TEXT,
  agent_id TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  default_model TEXT NOT NULL DEFAULT '',
  max_tokens INTEGER NOT NULL DEFAULT 16000,
  is_official INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'http',
  url TEXT NOT NULL DEFAULT '',
  auth_token TEXT NOT NULL DEFAULT '',
  command TEXT NOT NULL DEFAULT '',
  args_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  desc TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  time TEXT NOT NULL,
  instruction TEXT NOT NULL,
  last_run_date TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  channel_id TEXT,
  lead_agent_id TEXT,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  summary_doc_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(organization_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_missions_org_created
  ON missions(organization_id, created_at DESC);
CREATE TABLE IF NOT EXISTS mission_events (
  mission_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (mission_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_mission_events_org_mission_sequence
  ON mission_events(organization_id, mission_id, sequence);
`);

// 轻量迁移：旧库补新列
function addColumnIfMissing(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
// owner_id：每用户工作区隔离（旧库无此列则补上，归到空 owner 桶，需要时迁移）
for (const t of ["agents", "channels", "messages", "tasks", "task_events", "approvals", "documents", "routines", "projects"]) {
  addColumnIfMissing(t, "owner_id", "owner_id TEXT NOT NULL DEFAULT ''");
}
// owner 索引必须在 owner_id 列补好之后建（旧库 messages 升级前没有该列，建在 schema 块里会报 no such column）
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_owner ON messages(owner_id, created_at)`);
addColumnIfMissing("tasks", "acceptance_criteria", "acceptance_criteria TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("tasks", "depends_on", "depends_on TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("tasks", "project_id", "project_id TEXT");
addColumnIfMissing("tasks", "revision_count", "revision_count INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("agents", "provider_id", "provider_id TEXT");
addColumnIfMissing("providers", "web_tools", "web_tools INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("projects", "autonomy", "autonomy TEXT NOT NULL DEFAULT 'auto'");
addColumnIfMissing("approvals", "kind", "kind TEXT NOT NULL DEFAULT 'action'");
addColumnIfMissing("approvals", "ref_id", "ref_id TEXT");
addColumnIfMissing("approvals", "consumed_at", "consumed_at INTEGER");
addColumnIfMissing("documents", "kind", "kind TEXT NOT NULL DEFAULT 'report'");
addColumnIfMissing("messages", "model", "model TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("messages", "reply_to", "reply_to TEXT");
addColumnIfMissing("providers", "light_model", "light_model TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("tasks", "model_tier", "model_tier TEXT NOT NULL DEFAULT 'standard'");
addColumnIfMissing("tasks", "source_doc_ids", "source_doc_ids TEXT NOT NULL DEFAULT '[]'"); // 定向润色：本任务以这些文档为"来源"做受限改写（grounding，非依赖产物）
addColumnIfMissing("tasks", "reviewer_agent_id", "reviewer_agent_id TEXT");
addColumnIfMissing("tasks", "blocked_approval_id", "blocked_approval_id TEXT");
addColumnIfMissing("providers", "is_strong", "is_strong INTEGER NOT NULL DEFAULT 0");
// D2 成本可预测性：任务级用量累计（跨返工/验收不清零）+ 预算护栏 + 开工估价
addColumnIfMissing("tasks", "usage_json", "usage_json TEXT NOT NULL DEFAULT '{}'");           // 累计 {input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens}
addColumnIfMissing("tasks", "budget_billable", "budget_billable INTEGER NOT NULL DEFAULT 0"); // 0=不设上限（可被全局 AITEAM_TASK_TOKEN_BUDGET 兜底）
addColumnIfMissing("tasks", "estimate_billable", "estimate_billable INTEGER NOT NULL DEFAULT 0"); // 开工估价（按历史同档任务中位数）
addColumnIfMissing("providers", "price_input_per_million", "price_input_per_million REAL NOT NULL DEFAULT 0");
addColumnIfMissing("providers", "price_output_per_million", "price_output_per_million REAL NOT NULL DEFAULT 0");
addColumnIfMissing("providers", "price_currency", "price_currency TEXT NOT NULL DEFAULT 'USD'");
db.exec(`CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(owner_id, task_id, created_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_task_events_owner ON task_events(owner_id, created_at)`);
// D1 质量闭环落表：每次验收裁决一行（此前 verdict 只散落在频道消息流里，无法做质量度量）
db.exec(`CREATE TABLE IF NOT EXISTS verdicts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  task_id TEXT NOT NULL,
  project_id TEXT,
  doc_id TEXT,
  verifier_agent_id TEXT,
  worker_agent_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL,
  reasons TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'auto',
  created_at INTEGER NOT NULL
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_verdicts_task ON verdicts(owner_id, task_id, created_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_verdicts_owner ON verdicts(owner_id, created_at)`);
// 旧库迁移：早期 agents 是全局 UNIQUE(name)；多用户化后应为 UNIQUE(owner_id,name)。
// CREATE TABLE IF NOT EXISTS 不会替换已存在表的约束 → 重建表，否则新用户 seed 撞全局唯一名导致 bootstrap 崩。
(function migrateAgentsUnique() {
  const idx = db.prepare("PRAGMA index_list(agents)").all() as { name: string; unique: number }[];
  let hasNameOnly = false;
  let hasOwnerName = false;
  for (const i of idx) {
    if (!i.unique) continue;
    const cols = (db.prepare(`PRAGMA index_info("${i.name}")`).all() as { name: string }[]).map((c) => c.name);
    if (cols.length === 1 && cols[0] === "name") hasNameOnly = true;
    if (cols.length === 2 && cols.includes("owner_id") && cols.includes("name")) hasOwnerName = true;
  }
  if (!hasNameOnly || hasOwnerName) return; // 新库或已迁移
  db.transaction(() => {
    db.exec(`CREATE TABLE agents_new (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '🤖', role TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL, model TEXT NOT NULL DEFAULT 'claude-opus-4-8',
      provider_id TEXT, created_at INTEGER NOT NULL, UNIQUE(owner_id, name)
    )`);
    db.exec(`INSERT INTO agents_new (id, owner_id, name, emoji, role, system_prompt, model, provider_id, created_at)
             SELECT id, owner_id, name, emoji, role, system_prompt, model, provider_id, created_at FROM agents`);
    db.exec(`DROP TABLE agents`);
    db.exec(`ALTER TABLE agents_new RENAME TO agents`);
  })();
})();
// 文档版本归并：version=第几版（1 起）；superseded_by=被哪条新版取代（NULL=当前版）。
// 返工再写同 (task_id,kind) 不再并列堆叠——旧版自动标 superseded，列表默认只显当前版。
addColumnIfMissing("documents", "version", "version INTEGER NOT NULL DEFAULT 1");
addColumnIfMissing("documents", "superseded_by", "superseded_by TEXT");
db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_task_kind ON documents(task_id, kind, superseded_by)`);
// kind="template"（上传 .pptx 模板就地改图文）：原二进制按 owner 隔离落盘（路径存这里，绝不挂 static），
// 槽位清单(JSON)存 template_meta；binary_format 标来源格式（如 'pptx'）。普通文档这三列为 NULL。
addColumnIfMissing("documents", "binary_format", "binary_format TEXT");
addColumnIfMissing("documents", "original_blob_path", "original_blob_path TEXT");
addColumnIfMissing("documents", "template_meta", "template_meta TEXT");
// 技能系统 v2（渐进式披露 + 混合 method/capability 模型）：旧库补列，向后兼容。
// 旧库的 content 仍是正文权威来源，read_skill 优先 body、回退 content；when_to_use 空时注入回退 desc。
addColumnIfMissing("skills", "kind", "kind TEXT NOT NULL DEFAULT 'method'");          // method | capability
addColumnIfMissing("skills", "trigger", "trigger TEXT NOT NULL DEFAULT ''");          // L1 召回词（逗号/、分隔），取代硬编码 SKILL_KEYWORDS
addColumnIfMissing("skills", "when_to_use", "when_to_use TEXT NOT NULL DEFAULT ''");  // L1 一句话触发条件
addColumnIfMissing("skills", "body", "body TEXT NOT NULL DEFAULT ''");                // L2 正文，按需 read_skill 才进上下文
addColumnIfMissing("skills", "resources_json", "resources_json TEXT NOT NULL DEFAULT '[]'"); // L3 capability 指向的工具/MCP 前缀
addColumnIfMissing("skills", "version", "version INTEGER NOT NULL DEFAULT 1");        // 内置技能版本化（解决"空库才播种"）
// MCP 安全分级（registry 预设带入）：exec/network 受引擎层审批门约束（见 engine.callMcpTool 前置门）
addColumnIfMissing("mcp_servers", "safety", "safety TEXT NOT NULL DEFAULT 'local'");  // local | network | exec
addColumnIfMissing("mcp_servers", "env_json", "env_json TEXT NOT NULL DEFAULT '{}'"); // stdio 子进程环境变量（如 BOCHA_API_KEY），值含密钥→sanitize 只暴露 key 名
db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`);
// 启动凭证门禁：生产只认证已有 enc1，遇到 plaintext/enc:v1 直接拒启并指向 copy-only migrate-copy；
// 仅开发/测试允许在事务内把旧格式原地规范化。任一错误均整体回滚，禁止部分迁移。
(function migrateStoredSecrets() {
  assertCredentialKeyReady();
  db.transaction(() => {
    const providers = db.prepare("SELECT id, api_key FROM providers").all() as { id: string; api_key: string }[];
    const updateProvider = db.prepare("UPDATE providers SET api_key = ? WHERE id = ?");
    for (const row of providers) {
      const next = canonicalizeSecret(row.api_key);
      if (next !== row.api_key) updateProvider.run(next, row.id);
    }

    const servers = db.prepare("SELECT id, auth_token, env_json FROM mcp_servers").all() as {
      id: string;
      auth_token: string;
      env_json: string;
    }[];
    const updateMcp = db.prepare("UPDATE mcp_servers SET auth_token = ?, env_json = ? WHERE id = ?");
    for (const row of servers) {
      const authToken = canonicalizeSecret(row.auth_token);
      const envJson = row.env_json && row.env_json !== "{}" ? canonicalizeSecret(row.env_json) : "{}";
      if (authToken !== row.auth_token || envJson !== row.env_json) updateMcp.run(authToken, envJson, row.id);
    }

    const imageRow = db.prepare("SELECT value FROM app_settings WHERE key = 'image_provider'").get() as
      | { value: string }
      | undefined;
    if (imageRow?.value) {
      const parsed = parseStoredImageProvider(imageRow.value);
      const apiKey = parsed.api_key ?? "";
      const next = canonicalizeSecret(apiKey);
      if (next !== apiKey) {
        db.prepare("UPDATE app_settings SET value = ? WHERE key = 'image_provider'")
          .run(JSON.stringify({ ...parsed, api_key: next }));
      }
    }
  })();
})();
// 用户表（standalone 多用户登录）：全局表，不带 owner_id（owner = user:<id> 由此派生）
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL
)`);
backfillDocVersions(); // 一次性把存量重复版本按 (task_id,kind) 链成版本（幂等，仅处理多当前版的组）

export interface Agent {
  id: string;
  owner_id: string;
  name: string;
  emoji: string;
  role: string;
  system_prompt: string;
  model: string;
  /** null = 使用官方 Anthropic（环境变量 ANTHROPIC_API_KEY） */
  provider_id: string | null;
  created_at: number;
}
export interface Provider {
  id: string;
  name: string;
  /** 空串 = 官方 api.anthropic.com */
  base_url: string;
  api_key: string;
  default_model: string;
  /** 轻量模型（如 deepseek-v4-flash）：重复性/格式化任务走低成本通道；空 = 用 default_model */
  light_model: string;
  max_tokens: number;
  /** 该端点是否支持 Anthropic 服务端联网工具（web_search/web_fetch）。官方恒为支持；
   *  部分兼容端点（如 DeepSeek）声明原生支持，可手动开启。 */
  web_tools: number;
  /** 强通道标志：无官方 key 时，验收/汇总（preferStrong）优先走该供应商的 default_model */
  is_strong: number;
  /** 可选价格：每 100 万输入/输出 token 的单价；0 = 未配置，不估算金额 */
  price_input_per_million: number;
  price_output_per_million: number;
  price_currency: string;
  is_official: number;
  created_at: number;
}
export interface Channel {
  id: string;
  owner_id: string;
  name: string;
  kind: "channel" | "dm";
  dm_agent_id: string | null;
  created_at: number;
  agent_ids?: string[];
}
export interface Message {
  id: string;
  owner_id: string;
  channel_id: string;
  author_type: "user" | "agent" | "system";
  author_id: string | null;
  content: string;
  status: "streaming" | "complete" | "error";
  reply_depth: number;
  usage_json: string | null;
  /** 服务该消息的模型（模型归因，用量账本用） */
  model: string;
  /** 引用回复的目标消息 id */
  reply_to: string | null;
  created_at: number;
}
export interface McpServer {
  id: string;
  name: string;
  kind: "http" | "stdio";
  url: string;
  auth_token: string;
  command: string;
  args_json: string;
  /** stdio 子进程环境变量 JSON（如 {"BOCHA_API_KEY":"..."}）；含密钥，sanitize 只回 key 名不回值 */
  env_json: string;
  enabled: number;
  /** local=本地无副作用 | network=外发数据（来源任务/严格模式需审批） | exec=本地执行/写盘（始终需审批） */
  safety: "local" | "network" | "exec";
  created_at: number;
}
export interface Skill {
  id: string;
  name: string;
  desc: string;
  /** 旧字段：v1 全量注入的正文；v2 起 read_skill 优先 body、回退 content */
  content: string;
  /** method=提示词方法包 | capability=指向工具/MCP 的能力型技能 */
  kind: "method" | "capability";
  /** L1 召回词（逗号/、分隔）；空则回退硬编码 SKILL_KEYWORDS[name] */
  trigger: string;
  /** L1 一句话触发条件；空则注入回退 desc */
  when_to_use: string;
  /** L2 正文，按需 read_skill 才进上下文 */
  body: string;
  /** L3 capability 指向的工具/MCP 工具前缀，JSON 数组字符串 */
  resources_json: string;
  /** 内置技能版本（version-based upsert 用） */
  version: number;
  enabled: number;
  builtin: number;
  created_at: number;
}
export interface Task {
  id: string;
  owner_id: string;
  channel_id: string | null;
  title: string;
  description: string;
  status: "todo" | "doing" | "review" | "blocked" | "done" | "cancelled";
  assignee_agent_id: string | null;
  reviewer_agent_id: string | null;
  blocked_approval_id: string | null;
  created_by: string;
  acceptance_criteria: string;
  /** JSON: 依赖的任务 id 数组；全部交付（review/done）后本任务才会自动开工 */
  depends_on: string;
  /** 模型档位：standard = 全力模型；light = 轻量低成本模型（重复性/格式化/单一明确的执行） */
  model_tier: "standard" | "light";
  /** JSON: 来源文档 id 数组——本任务是对这些文档的"定向润色/受限改写"（grounding），正文会注入工作简报。区别于 depends_on（前置产物） */
  source_doc_ids: string;
  project_id: string | null;
  revision_count: number;
  /** 累计用量 JSON（工作+返工+验收全算入本任务，跨返工不清零）：{input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens} */
  usage_json: string;
  /** 任务级预算（billable 加权 token）；0 = 不设，回退全局 AITEAM_TASK_TOKEN_BUDGET（也为 0 则不限） */
  budget_billable: number;
  /** 开工时按历史同档任务中位数写入的估价（billable）；0 = 无历史可估 */
  estimate_billable: number;
  created_at: number;
  updated_at: number;
}
export interface Project {
  id: string;
  owner_id: string;
  channel_id: string | null;
  lead_agent_id: string | null;
  title: string;
  goal: string;
  /** planned = 计划待用户批准（autonomy=approve_plan）；running → review → done */
  status: "planned" | "running" | "review" | "done";
  /** auto = 全自主闭环；approve_plan = 拆解后先经用户批准再开工 */
  autonomy: "auto" | "approve_plan";
  summary_doc_id: string | null;
  created_at: number;
  updated_at: number;
}
export interface Approval {
  id: string;
  owner_id: string;
  channel_id: string | null;
  agent_id: string;
  title: string;
  payload: string;
  /** action = 普通高风险动作；network = 引擎签发的单次 MCP 外发；plan = 项目计划；clarification = 阻塞输入；budget = 超预算暂停 */
  kind: "action" | "network" | "plan" | "clarification" | "budget";
  /** plan 关联 project id；network/clarification/budget 关联 task id；action 可关联普通动作/任务 id */
  ref_id: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: number;
  resolved_at: number | null;
  /** 一次性 network 授权的关闭时间；真实调用前消费，停止/改派/取消时也会失效关闭 */
  consumed_at: number | null;
}

export interface TaskEvent {
  id: string;
  owner_id: string;
  task_id: string;
  channel_id: string | null;
  project_id: string | null;
  agent_id: string | null;
  type:
    | "created"
    | "claim"
    | "start"
    | "tool"
    | "blocked"
    | "handoff"
    | "delivery"
    | "verification"
    | "approval"
    | "user_close"
    | "cancelled"
    | "failure";
  summary: string;
  metadata_json: string;
  created_at: number;
}

const now = () => Date.now();

// ---- agents（每用户私有）----
export function listAgents(): Agent[] {
  return db.prepare("SELECT * FROM agents WHERE owner_id = ? ORDER BY created_at, rowid").all(currentOwner()) as Agent[];
}
export function getAgent(id: string): Agent | undefined {
  return db.prepare("SELECT * FROM agents WHERE id = ? AND owner_id = ?").get(id, currentOwner()) as Agent | undefined;
}
export function createAgent(a: {
  name: string;
  emoji: string;
  role: string;
  system_prompt: string;
  model?: string;
  provider_id?: string | null;
}): Agent {
  const agent: Agent = {
    id: nanoid(10),
    owner_id: currentOwner(),
    name: a.name,
    emoji: a.emoji,
    role: a.role,
    system_prompt: a.system_prompt,
    model: a.model || "claude-opus-4-8",
    provider_id: a.provider_id ?? null,
    created_at: now(),
  };
  db.prepare(
    "INSERT INTO agents (id, owner_id, name, emoji, role, system_prompt, model, provider_id, created_at) VALUES (@id, @owner_id, @name, @emoji, @role, @system_prompt, @model, @provider_id, @created_at)"
  ).run(agent);
  return agent;
}

// ---- providers（模型供应商 / BYOM）—— 全局共享（管理员配一套 key，所有用户共用）----
function decryptProvider(p: Provider | undefined): Provider | undefined {
  if (!p) return p;
  return { ...p, api_key: decryptSecret(p.api_key) };
}

export function listProviders(): Provider[] {
  return (db.prepare("SELECT * FROM providers ORDER BY created_at").all() as Provider[])
    .map((p) => decryptProvider(p)!);
}
export function getProvider(id: string): Provider | undefined {
  return decryptProvider(db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as Provider | undefined);
}
export function createProvider(p: {
  name: string;
  base_url?: string;
  api_key?: string;
  default_model?: string;
  light_model?: string;
  max_tokens?: number;
  web_tools?: boolean;
  is_strong?: boolean;
  price_input_per_million?: number;
  price_output_per_million?: number;
  price_currency?: string;
}): Provider {
  const provider: Provider = {
    id: nanoid(10),
    name: p.name,
    base_url: p.base_url ?? "",
    api_key: encryptSecret(p.api_key ?? ""),
    default_model: p.default_model ?? "",
    light_model: p.light_model ?? "",
    max_tokens: p.max_tokens && p.max_tokens > 0 ? p.max_tokens : 16000,
    web_tools: p.web_tools ? 1 : 0,
    is_strong: p.is_strong ? 1 : 0,
    price_input_per_million: p.price_input_per_million && p.price_input_per_million > 0 ? p.price_input_per_million : 0,
    price_output_per_million: p.price_output_per_million && p.price_output_per_million > 0 ? p.price_output_per_million : 0,
    price_currency: p.price_currency?.trim().slice(0, 12).toUpperCase() || "USD",
    is_official: 0,
    created_at: now(),
  };
  db.prepare(
    "INSERT INTO providers (id, name, base_url, api_key, default_model, light_model, max_tokens, web_tools, is_strong, price_input_per_million, price_output_per_million, price_currency, is_official, created_at) VALUES (@id, @name, @base_url, @api_key, @default_model, @light_model, @max_tokens, @web_tools, @is_strong, @price_input_per_million, @price_output_per_million, @price_currency, @is_official, @created_at)"
  ).run(provider);
  return { ...provider, api_key: p.api_key ?? "" };
}
export function updateProvider(
  id: string,
  fields: Partial<Pick<Provider, "name" | "base_url" | "default_model" | "light_model" | "max_tokens" | "web_tools" | "is_strong" | "price_input_per_million" | "price_output_per_million" | "price_currency">> & {
    /** 留空 = 保持原 key 不变 */
    api_key?: string;
  }
): Provider | undefined {
  const cur = getProvider(id);
  if (!cur) return undefined;
  const next: Provider = {
    ...cur,
    ...fields,
    api_key: fields.api_key ? fields.api_key : cur.api_key,
  };
  db.prepare(
    "UPDATE providers SET name = @name, base_url = @base_url, api_key = @api_key, default_model = @default_model, light_model = @light_model, max_tokens = @max_tokens, web_tools = @web_tools, is_strong = @is_strong, price_input_per_million = @price_input_per_million, price_output_per_million = @price_output_per_million, price_currency = @price_currency WHERE id = @id"
  ).run({ ...next, api_key: encryptSecret(next.api_key) });
  return next;
}
export function deleteProvider(id: string) {
  db.prepare("UPDATE agents SET provider_id = NULL WHERE provider_id = ?").run(id);
  db.prepare("DELETE FROM providers WHERE id = ?").run(id);
}
/** 给前端的脱敏视图：永不下发 api_key */
export function sanitizeProvider(p: Provider) {
  return {
    id: p.id,
    name: p.name,
    base_url: p.base_url,
    default_model: p.default_model,
    light_model: p.light_model,
    max_tokens: p.max_tokens,
    web_tools: p.web_tools,
    is_strong: p.is_strong,
    price_input_per_million: p.price_input_per_million,
    price_output_per_million: p.price_output_per_million,
    price_currency: p.price_currency,
    is_official: p.is_official,
    has_key: Boolean(p.api_key),
  };
}

// ---- app settings（服务端键值配置）与图像生成供应商 —— 全局共享 ----
export function getSetting(key: string): string {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? "";
}
export function setSetting(key: string, value: string) {
  db.prepare(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

/** 图像生成供应商（Seedream 等 OpenAI images/generations 协议端点），key 只存服务端 */
export interface ImageProvider {
  base_url: string;
  api_key: string;
  model: string;
}
export function getImageProvider(): ImageProvider {
  const stored = getSetting("image_provider");
  if (!stored) return { base_url: "", api_key: "", model: "" };
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { base_url: "", api_key: "", model: "" };
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return { base_url: "", api_key: "", model: "" };
  }
  return {
    base_url: String(raw.base_url ?? ""),
    api_key: decryptSecret(String(raw.api_key ?? "")),
    model: String(raw.model ?? ""),
  };
}
export function setImageProvider(p: { base_url?: string; api_key?: string; model?: string }): ImageProvider {
  const cur = getImageProvider();
  const next: ImageProvider = {
    base_url: (p.base_url ?? cur.base_url).trim().replace(/\/$/, ""),
    // 留空 = 保持原 key；传 "-" 显式清除
    api_key: p.api_key === "-" ? "" : p.api_key ? p.api_key.trim() : cur.api_key,
    model: (p.model ?? cur.model).trim(),
  };
  setSetting("image_provider", JSON.stringify({ ...next, api_key: encryptSecret(next.api_key) }));
  return next;
}
/** 给前端的脱敏视图：永不下发 api_key */
export function sanitizeImageProvider(p: ImageProvider) {
  return { base_url: p.base_url, model: p.model, has_key: Boolean(p.api_key) };
}

// ---- channels（每用户私有）----
export function listChannels(): Channel[] {
  const owner = currentOwner();
  const channels = db.prepare("SELECT * FROM channels WHERE owner_id = ? ORDER BY created_at, rowid").all(owner) as Channel[];
  const members = db
    .prepare(
      "SELECT ca.channel_id, ca.agent_id FROM channel_agents ca JOIN channels c ON c.id = ca.channel_id JOIN agents a ON a.id = ca.agent_id WHERE c.owner_id = ? ORDER BY a.created_at, a.rowid"
    )
    .all(owner) as { channel_id: string; agent_id: string }[];
  for (const c of channels) {
    c.agent_ids = members.filter((m) => m.channel_id === c.id).map((m) => m.agent_id);
  }
  return channels;
}
export function getChannel(id: string): Channel | undefined {
  const c = db.prepare("SELECT * FROM channels WHERE id = ? AND owner_id = ?").get(id, currentOwner()) as Channel | undefined;
  if (c) {
    c.agent_ids = (
      db
        .prepare(
          "SELECT ca.agent_id FROM channel_agents ca JOIN agents a ON a.id = ca.agent_id WHERE ca.channel_id = ? ORDER BY a.created_at, a.rowid"
        )
        .all(id) as { agent_id: string }[]
    ).map((r) => r.agent_id);
  }
  return c;
}
export function createChannel(name: string, agentIds: string[], kind: "channel" | "dm" = "channel", dmAgentId?: string): Channel {
  const channel: Channel = { id: nanoid(10), owner_id: currentOwner(), name, kind, dm_agent_id: dmAgentId ?? null, created_at: now() };
  db.prepare("INSERT INTO channels (id, owner_id, name, kind, dm_agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    channel.id, channel.owner_id, channel.name, channel.kind, channel.dm_agent_id, channel.created_at
  );
  const ins = db.prepare("INSERT OR IGNORE INTO channel_agents (channel_id, agent_id) VALUES (?, ?)");
  for (const id of agentIds) ins.run(channel.id, id);
  channel.agent_ids = agentIds;
  return channel;
}
export function findDm(agentId: string): Channel | undefined {
  const c = db.prepare("SELECT * FROM channels WHERE kind = 'dm' AND dm_agent_id = ? AND owner_id = ?").get(agentId, currentOwner()) as
    | Channel
    | undefined;
  if (c) c.agent_ids = [agentId];
  return c;
}

// ---- messages（每用户私有）----
export function listMessages(channelId: string, limit = 200): Message[] {
  return db
    .prepare("SELECT * FROM messages WHERE channel_id = ? AND owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(channelId, currentOwner(), limit)
    .reverse() as Message[];
}
export function insertMessage(m: {
  channel_id: string;
  author_type: Message["author_type"];
  author_id?: string | null;
  content?: string;
  status?: Message["status"];
  reply_depth?: number;
  reply_to?: string | null;
}): Message {
  const msg: Message = {
    id: nanoid(12),
    owner_id: currentOwner(),
    channel_id: m.channel_id,
    author_type: m.author_type,
    author_id: m.author_id ?? null,
    content: m.content ?? "",
    status: m.status ?? "complete",
    reply_depth: m.reply_depth ?? 0,
    usage_json: null,
    model: "",
    reply_to: m.reply_to ?? null,
    created_at: now(),
  };
  db.prepare(
    "INSERT INTO messages (id, owner_id, channel_id, author_type, author_id, content, status, reply_depth, usage_json, model, reply_to, created_at) VALUES (@id, @owner_id, @channel_id, @author_type, @author_id, @content, @status, @reply_depth, @usage_json, @model, @reply_to, @created_at)"
  ).run(msg);
  return msg;
}
export function getMessage(id: string): Message | undefined {
  return db.prepare("SELECT * FROM messages WHERE id = ? AND owner_id = ?").get(id, currentOwner()) as Message | undefined;
}

// ---- MCP servers —— 全局共享 ----
export function listMcpServers(): McpServer[] {
  return db.prepare("SELECT * FROM mcp_servers ORDER BY created_at").all() as McpServer[];
}
export function getMcpServer(id: string): McpServer | undefined {
  return db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as McpServer | undefined;
}
export function createMcpServer(s: {
  name: string;
  kind: McpServer["kind"];
  url?: string;
  auth_token?: string;
  command?: string;
  args?: string[];
  safety?: McpServer["safety"];
  env?: Record<string, string>;
}): McpServer {
  const server: McpServer = {
    id: nanoid(10),
    name: s.name,
    kind: s.kind,
    url: s.url ?? "",
    auth_token: encryptSecret(s.auth_token ?? ""),
    command: s.command ?? "",
    args_json: JSON.stringify(s.args ?? []),
    env_json: Object.keys(s.env ?? {}).length > 0 ? encryptSecret(JSON.stringify(s.env)) : "{}",
    safety: s.safety ?? "local",
    enabled: 1,
    created_at: now(),
  };
  db.prepare(
    "INSERT INTO mcp_servers (id, name, kind, url, auth_token, command, args_json, env_json, safety, enabled, created_at) VALUES (@id, @name, @kind, @url, @auth_token, @command, @args_json, @env_json, @safety, @enabled, @created_at)"
  ).run(server);
  return server;
}
export function setMcpServerEnabled(id: string, enabled: boolean): McpServer | undefined {
  db.prepare("UPDATE mcp_servers SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  return getMcpServer(id);
}
export function deleteMcpServer(id: string) {
  db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
}
/** 从 env_json 取变量名列表（不含值）——供前端展示"已设哪些 env key"而不泄露密钥值。 */
function envKeyNames(envJson: string): string[] {
  try {
    // env_json 落库是密文（见 encryptSecret），取 key 名前先解；密钥不匹配时宁可回空列表也不炸接口
    const parsed = JSON.parse(decryptSecret(envJson || "{}") || "{}");
    return parsed && typeof parsed === "object" ? Object.keys(parsed) : [];
  } catch {
    return [];
  }
}
/** 脱敏：auth_token 与 env 值永不下发前端（env 只回 key 名） */
export function sanitizeMcpServer(s: McpServer) {
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    url: s.url,
    command: s.command,
    args_json: s.args_json,
    safety: s.safety, // 风险分级前端可见（registry/手填带入）；非敏感，不脱敏
    env_keys: envKeyNames(s.env_json), // 只回 env 变量名（如 ["BOCHA_API_KEY"]），值含密钥绝不下发
    enabled: s.enabled,
    has_token: Boolean(s.auth_token),
  };
}

// ---- skills（技能：横切的工作方法）—— 全局共享（内置 + 管理员自定义，启用后注入所有同事）----
export function listSkills(): Skill[] {
  return db.prepare("SELECT * FROM skills ORDER BY builtin DESC, created_at").all() as Skill[];
}
export function getSkill(id: string): Skill | undefined {
  return db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as Skill | undefined;
}
export interface SkillInput {
  name: string;
  desc?: string;
  /** v2 正文权威字段；缺省时回填 content（向后兼容旧 UI/调用） */
  body?: string;
  content?: string;
  kind?: Skill["kind"];
  trigger?: string;
  when_to_use?: string;
  resources_json?: string;
  version?: number;
  enabled?: boolean;
  builtin?: boolean;
}
export function createSkill(s: SkillInput): Skill {
  const body = s.body ?? s.content ?? "";
  const skill: Skill = {
    id: nanoid(10),
    name: s.name,
    desc: s.desc ?? "",
    content: s.content ?? body, // 旧字段保持非空：回退读取链路（read_skill body→content）始终有值
    kind: s.kind === "capability" ? "capability" : "method",
    trigger: s.trigger ?? "",
    when_to_use: s.when_to_use ?? "",
    body,
    resources_json: s.resources_json ?? "[]",
    version: s.version ?? 1,
    enabled: s.enabled ? 1 : 0,
    builtin: s.builtin ? 1 : 0,
    created_at: now(),
  };
  db.prepare(
    "INSERT INTO skills (id, name, desc, content, kind, trigger, when_to_use, body, resources_json, version, enabled, builtin, created_at) VALUES (@id, @name, @desc, @content, @kind, @trigger, @when_to_use, @body, @resources_json, @version, @enabled, @builtin, @created_at)"
  ).run(skill);
  return skill;
}
export function updateSkill(
  id: string,
  fields: {
    enabled?: boolean;
    name?: string;
    desc?: string;
    content?: string;
    kind?: Skill["kind"];
    trigger?: string;
    when_to_use?: string;
    body?: string;
    resources_json?: string;
  }
): Skill | undefined {
  const cur = db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as Skill | undefined;
  if (!cur) return undefined;
  const next: Skill = {
    ...cur,
    ...(fields.name !== undefined ? { name: fields.name } : {}),
    ...(fields.desc !== undefined ? { desc: fields.desc } : {}),
    ...(fields.content !== undefined ? { content: fields.content } : {}),
    ...(fields.kind !== undefined ? { kind: fields.kind } : {}),
    ...(fields.trigger !== undefined ? { trigger: fields.trigger } : {}),
    ...(fields.when_to_use !== undefined ? { when_to_use: fields.when_to_use } : {}),
    ...(fields.body !== undefined ? { body: fields.body } : {}),
    ...(fields.resources_json !== undefined ? { resources_json: fields.resources_json } : {}),
    ...(fields.enabled !== undefined ? { enabled: fields.enabled ? 1 : 0 } : {}),
  };
  // 保持 body/content 同步：只改其一时镜像到另一，避免 read_skill / 列表读到旧值（旧 content 字段是 read_skill 的回退源）
  if (fields.body !== undefined && fields.content === undefined) next.content = fields.body;
  if (fields.content !== undefined && fields.body === undefined) next.body = fields.content;
  db.prepare(
    "UPDATE skills SET name = @name, desc = @desc, content = @content, kind = @kind, trigger = @trigger, when_to_use = @when_to_use, body = @body, resources_json = @resources_json, enabled = @enabled WHERE id = @id"
  ).run(next);
  return next;
}
/** version-based upsert：升级内置技能正文/元数据，但保留用户的 enabled 开关与 id。 */
export function upsertBuiltinSkill(id: string, s: SkillInput): Skill | undefined {
  const cur = db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as Skill | undefined;
  if (!cur) return undefined;
  const body = s.body ?? s.content ?? cur.body;
  const next: Skill = {
    ...cur,
    name: s.name,
    desc: s.desc ?? cur.desc,
    content: s.content ?? body,
    kind: s.kind === "capability" ? "capability" : "method",
    trigger: s.trigger ?? cur.trigger,
    when_to_use: s.when_to_use ?? cur.when_to_use,
    body,
    resources_json: s.resources_json ?? cur.resources_json,
    version: s.version ?? cur.version,
    // enabled 不动：尊重用户的开关
  };
  db.prepare(
    "UPDATE skills SET name = @name, desc = @desc, content = @content, kind = @kind, trigger = @trigger, when_to_use = @when_to_use, body = @body, resources_json = @resources_json, version = @version WHERE id = @id"
  ).run(next);
  return next;
}
export function deleteSkill(id: string) {
  db.prepare("DELETE FROM skills WHERE id = ? AND builtin = 0").run(id);
}
export function updateMessage(
  id: string,
  fields: { content?: string; status?: Message["status"]; usage_json?: string | null; model?: string }
) {
  const cur = db.prepare("SELECT * FROM messages WHERE id = ? AND owner_id = ?").get(id, currentOwner()) as Message | undefined;
  if (!cur) return;
  db.prepare("UPDATE messages SET content = ?, status = ?, usage_json = ?, model = ? WHERE id = ?").run(
    fields.content ?? cur.content,
    fields.status ?? cur.status,
    fields.usage_json !== undefined ? fields.usage_json : cur.usage_json,
    fields.model ?? cur.model,
    id
  );
}

// ---- 用量统计（每用户私有：只统计当前 owner；Helio 同构：每日消耗 + 活动账本，含模型归因）----
// 计费权重：缓存读 ≈ 全价 1/10，缓存写 ≈ 1.25 倍（贴近 Anthropic 计费）。预算护栏据此估真实成本。
const CACHE_READ_WEIGHT = 0.1;
const CACHE_CREATE_WEIGHT = 1.25;
/**
 * 统一解析 usage_json（兼容老行：老行 input_tokens 已含缓存、无 cache_* 字段）。
 * - promptTotal：展示用的总输入 token（纯输入 + 缓存读 + 缓存写），保持与历史展示口径一致；
 * - billable：加权计费 token，缓存读/写按权重折算，供预算护栏更贴近真实成本。
 */
export function readUsage(json: string | null): {
  input: number; output: number; cacheRead: number; cacheCreation: number; promptTotal: number; billable: number;
} {
  let input = 0, output = 0, cacheRead = 0, cacheCreation = 0;
  if (json) {
    try {
      const u = JSON.parse(json);
      input = u.input_tokens ?? 0;
      output = u.output_tokens ?? 0;
      cacheRead = u.cache_read_tokens ?? 0;
      cacheCreation = u.cache_creation_tokens ?? 0;
    } catch { /* ignore */ }
  }
  const promptTotal = input + cacheRead + cacheCreation;
  // 取整：token 计数本就是整数，且避免 0.1 等权重引入浮点尾差（如 1000*0.1=100.0000…1）
  const billable = Math.round(input + output + cacheCreation * CACHE_CREATE_WEIGHT + cacheRead * CACHE_READ_WEIGHT);
  return { input, output, cacheRead, cacheCreation, promptTotal, billable };
}

// ---- verdicts（D1 质量闭环落表）----
export interface Verdict {
  id: string;
  owner_id: string;
  task_id: string;
  project_id: string | null;
  doc_id: string | null;
  verifier_agent_id: string | null;
  worker_agent_id: string | null;
  /** 第几轮交付的裁决（0 = 首次交付） */
  attempt: number;
  result: "pass" | "revise";
  reasons: string;
  /** auto = 机器验收；solo = 无他人时的自检；fallback = 未提交结构化裁决的兜底 revise；human = 人工复核退回 */
  source: "auto" | "solo" | "fallback" | "human";
  created_at: number;
}
export function createVerdict(v: {
  task_id: string;
  project_id?: string | null;
  doc_id?: string | null;
  verifier_agent_id?: string | null;
  worker_agent_id?: string | null;
  attempt?: number;
  result: Verdict["result"];
  reasons?: string;
  source?: Verdict["source"];
}): Verdict {
  const row: Verdict = {
    id: nanoid(10),
    owner_id: currentOwner(),
    task_id: v.task_id,
    project_id: v.project_id ?? null,
    doc_id: v.doc_id ?? null,
    verifier_agent_id: v.verifier_agent_id ?? null,
    worker_agent_id: v.worker_agent_id ?? null,
    attempt: v.attempt ?? 0,
    result: v.result,
    reasons: (v.reasons ?? "").slice(0, 4000),
    source: v.source ?? "auto",
    created_at: now(),
  };
  db.prepare(
    "INSERT INTO verdicts (id, owner_id, task_id, project_id, doc_id, verifier_agent_id, worker_agent_id, attempt, result, reasons, source, created_at) VALUES (@id, @owner_id, @task_id, @project_id, @doc_id, @verifier_agent_id, @worker_agent_id, @attempt, @result, @reasons, @source, @created_at)"
  ).run(row);
  return row;
}
export function listVerdictsForTask(taskId: string): Verdict[] {
  return db
    .prepare("SELECT * FROM verdicts WHERE owner_id = ? AND task_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(currentOwner(), taskId) as Verdict[];
}
/**
 * 质量度量汇总（D1 面板数据源）：
 * - 按负责人聚合：一次通过率（attempt=0 即 pass 的任务占比）、返工数、参与任务数；
 * - 验收覆盖率：已交付任务中有 ≥1 条裁决记录的占比（衡量质量闸是否被绕过）；
 * - 近期 revise 理由：给人看返工都因为什么（面板原样展示，不做聚类）。
 */
export function qualitySummary(): {
  agents: { agent_id: string; tasks: number; first_pass: number; revises: number }[];
  coverage: { delivered: number; verified: number };
  recent_revises: { task_id: string; reasons: string; source: string; created_at: number }[];
} {
  const owner = currentOwner();
  const rows = db
    .prepare("SELECT task_id, worker_agent_id, attempt, result, reasons, source, created_at FROM verdicts WHERE owner_id = ? ORDER BY created_at ASC")
    .all(owner) as Pick<Verdict, "task_id" | "worker_agent_id" | "attempt" | "result" | "reasons" | "source" | "created_at">[];
  const byAgent = new Map<string, { tasks: Set<string>; firstPass: Set<string>; revises: number }>();
  for (const r of rows) {
    const key = r.worker_agent_id ?? "unknown";
    const s = byAgent.get(key) ?? { tasks: new Set(), firstPass: new Set(), revises: 0 };
    s.tasks.add(r.task_id);
    if (r.attempt === 0 && r.result === "pass") s.firstPass.add(r.task_id);
    if (r.result === "revise") s.revises++;
    byAgent.set(key, s);
  }
  const delivered = (db
    .prepare("SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ? AND status IN ('review','done')")
    .get(owner) as { n: number }).n;
  const verified = (db
    .prepare("SELECT COUNT(DISTINCT t.id) AS n FROM tasks t JOIN verdicts v ON v.task_id = t.id AND v.owner_id = t.owner_id WHERE t.owner_id = ? AND t.status IN ('review','done')")
    .get(owner) as { n: number }).n;
  const recentRevises = rows
    .filter((r) => r.result === "revise" && r.reasons)
    .slice(-20)
    .reverse()
    .map((r) => ({ task_id: r.task_id, reasons: r.reasons.slice(0, 500), source: r.source, created_at: r.created_at }));
  return {
    agents: [...byAgent.entries()].map(([agent_id, s]) => ({
      agent_id,
      tasks: s.tasks.size,
      first_pass: s.firstPass.size,
      revises: s.revises,
    })),
    coverage: { delivered, verified },
    recent_revises: recentRevises,
  };
}

export function usageDaily(days = 14): { date: string; input: number; output: number }[] {
  const since = Date.now() - days * 86400_000;
  const rows = db
    .prepare("SELECT created_at, usage_json FROM messages WHERE owner_id = ? AND author_type = 'agent' AND usage_json IS NOT NULL AND created_at >= ?")
    .all(currentOwner(), since) as { created_at: number; usage_json: string }[];
  const byDay = new Map<string, { input: number; output: number }>();
  for (const r of rows) {
    const date = new Date(r.created_at).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
    const s = byDay.get(date) ?? { input: 0, output: 0 };
    const u = readUsage(r.usage_json);
    s.input += u.promptTotal;
    s.output += u.output;
    byDay.set(date, s);
  }
  const out: { date: string; input: number; output: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400_000).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
    out.push({ date, ...(byDay.get(date) ?? { input: 0, output: 0 }) });
  }
  return out;
}
export function usageRecent(limit = 40) {
  return db
    .prepare(
      "SELECT id, channel_id, author_id, model, usage_json, created_at, substr(content, 1, 80) AS snippet FROM messages WHERE owner_id = ? AND author_type = 'agent' AND usage_json IS NOT NULL ORDER BY created_at DESC LIMIT ?"
    )
    .all(currentOwner(), limit) as { id: string; channel_id: string; author_id: string; model: string; usage_json: string; created_at: number; snippet: string }[];
}

// ---- 频道管理 ----
export function renameChannel(id: string, name: string): Channel | undefined {
  const cur = getChannel(id);
  if (!cur) return undefined;
  db.prepare("UPDATE channels SET name = ? WHERE id = ?").run(name, id);
  return getChannel(id);
}
/** 重置频道的 AI 成员（增减同事按场景定制）；DM 频道成员固定不改。 */
export function setChannelAgents(id: string, agentIds: string[]): Channel | undefined {
  const c = getChannel(id);
  if (!c || c.kind === "dm") return c;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM channel_agents WHERE channel_id = ?").run(id);
    const ins = db.prepare("INSERT OR IGNORE INTO channel_agents (channel_id, agent_id) VALUES (?, ?)");
    for (const aid of agentIds) ins.run(id, aid);
  });
  tx();
  return getChannel(id);
}
export function clearChannelMessages(id: string) {
  db.prepare("DELETE FROM messages WHERE channel_id = ? AND owner_id = ?").run(id, currentOwner());
}
export function deleteChannel(id: string) {
  const owner = currentOwner();
  db.prepare("UPDATE tasks SET channel_id = NULL WHERE channel_id = ? AND owner_id = ?").run(id, owner);
  db.prepare("DELETE FROM messages WHERE channel_id = ? AND owner_id = ?").run(id, owner);
  db.prepare("DELETE FROM channel_agents WHERE channel_id = ?").run(id);
  db.prepare("DELETE FROM routines WHERE channel_id = ? AND owner_id = ?").run(id, owner);
  db.prepare("DELETE FROM channels WHERE id = ? AND owner_id = ?").run(id, owner);
}

// ---- tasks（每用户私有）----
export function listTasks(channelId?: string): Task[] {
  const owner = currentOwner();
  if (channelId)
    return db.prepare("SELECT * FROM tasks WHERE channel_id = ? AND owner_id = ? ORDER BY created_at DESC").all(channelId, owner) as Task[];
  return db.prepare("SELECT * FROM tasks WHERE owner_id = ? ORDER BY created_at DESC").all(owner) as Task[];
}
export function getTask(id: string): Task | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ? AND owner_id = ?").get(id, currentOwner()) as Task | undefined;
}
export function createTask(t: {
  channel_id?: string | null;
  title: string;
  description?: string;
  status?: Task["status"];
  assignee_agent_id?: string | null;
  reviewer_agent_id?: string | null;
  blocked_approval_id?: string | null;
  created_by?: string;
  acceptance_criteria?: string;
  depends_on?: string[];
  model_tier?: Task["model_tier"];
  source_doc_ids?: string[];
  project_id?: string | null;
  budget_billable?: number;
}): Task {
  const task: Task = {
    id: nanoid(10),
    owner_id: currentOwner(),
    channel_id: t.channel_id ?? null,
    title: t.title,
    description: t.description ?? "",
    status: t.status ?? "todo",
    assignee_agent_id: t.assignee_agent_id ?? null,
    reviewer_agent_id: t.reviewer_agent_id ?? null,
    blocked_approval_id: t.blocked_approval_id ?? null,
    created_by: t.created_by ?? "user",
    acceptance_criteria: t.acceptance_criteria ?? "",
    depends_on: JSON.stringify(t.depends_on ?? []),
    model_tier: t.model_tier === "light" ? "light" : "standard",
    source_doc_ids: JSON.stringify(t.source_doc_ids ?? []),
    project_id: t.project_id ?? null,
    revision_count: 0,
    usage_json: "{}",
    budget_billable: Math.max(0, Math.round(t.budget_billable ?? 0)),
    estimate_billable: 0,
    created_at: now(),
    updated_at: now(),
  };
  db.prepare(
    "INSERT INTO tasks (id, owner_id, channel_id, title, description, status, assignee_agent_id, reviewer_agent_id, blocked_approval_id, created_by, acceptance_criteria, depends_on, model_tier, source_doc_ids, project_id, revision_count, usage_json, budget_billable, estimate_billable, created_at, updated_at) VALUES (@id, @owner_id, @channel_id, @title, @description, @status, @assignee_agent_id, @reviewer_agent_id, @blocked_approval_id, @created_by, @acceptance_criteria, @depends_on, @model_tier, @source_doc_ids, @project_id, @revision_count, @usage_json, @budget_billable, @estimate_billable, @created_at, @updated_at)"
  ).run(task);
  return task;
}
export function updateTask(
  id: string,
  fields: Partial<
    Pick<
      Task,
      | "title"
      | "description"
      | "status"
      | "assignee_agent_id"
      | "reviewer_agent_id"
      | "blocked_approval_id"
      | "channel_id"
      | "acceptance_criteria"
      | "revision_count"
      | "budget_billable"
      | "estimate_billable"
    >
  >
): Task | undefined {
  const cur = getTask(id);
  if (!cur) return undefined;
  const next: Task = { ...cur, ...fields, updated_at: now() };
  db.prepare(
    "UPDATE tasks SET title = @title, description = @description, status = @status, assignee_agent_id = @assignee_agent_id, reviewer_agent_id = @reviewer_agent_id, blocked_approval_id = @blocked_approval_id, channel_id = @channel_id, acceptance_criteria = @acceptance_criteria, revision_count = @revision_count, budget_billable = @budget_billable, estimate_billable = @estimate_billable, updated_at = @updated_at WHERE id = @id"
  ).run(next);
  return next;
}
/** 任务级用量累计：每次 streamRun（工作/返工/验收）结束时叠加。跨返工不清零——预算护栏与成本展示都以此为准。 */
export function addTaskUsage(
  taskId: string,
  u: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }
): Task | undefined {
  const cur = getTask(taskId);
  if (!cur) return undefined;
  const acc = readUsage(cur.usage_json);
  const merged = JSON.stringify({
    input_tokens: acc.input + (u.input_tokens || 0),
    output_tokens: acc.output + (u.output_tokens || 0),
    cache_read_tokens: acc.cacheRead + (u.cache_read_tokens || 0),
    cache_creation_tokens: acc.cacheCreation + (u.cache_creation_tokens || 0),
  });
  db.prepare("UPDATE tasks SET usage_json = ?, updated_at = ? WHERE id = ? AND owner_id = ?").run(merged, now(), taskId, cur.owner_id);
  return getTask(taskId);
}

/** 任务已消耗的加权计费 token（预算/估价的统一口径）。 */
export function taskSpentBillable(task: Task): number {
  return readUsage(task.usage_json).billable;
}

/** 开工估价：最近 20 个已交付（review/done）同档任务实际消耗的中位数；无历史返 0（不硬编造）。 */
export function estimateTaskBillable(tier: Task["model_tier"]): number {
  const rows = db
    .prepare(
      "SELECT usage_json FROM tasks WHERE owner_id = ? AND model_tier = ? AND status IN ('review','done') AND usage_json != '{}' ORDER BY updated_at DESC LIMIT 20"
    )
    .all(currentOwner(), tier) as { usage_json: string }[];
  const spent = rows.map((r) => readUsage(r.usage_json).billable).filter((b) => b > 0).sort((a, b) => a - b);
  if (spent.length === 0) return 0;
  return spent[Math.floor(spent.length / 2)];
}

export function taskDependsOn(task: Task): string[] {
  try {
    const arr = JSON.parse(task.depends_on);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function listTaskEvents(taskId?: string): TaskEvent[] {
  const owner = currentOwner();
  if (taskId) {
    return db
      .prepare("SELECT * FROM task_events WHERE owner_id = ? AND task_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(owner, taskId) as TaskEvent[];
  }
  return db
    .prepare("SELECT * FROM task_events WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 500")
    .all(owner) as TaskEvent[];
}
export function createTaskEvent(e: {
  task_id: string;
  channel_id?: string | null;
  project_id?: string | null;
  agent_id?: string | null;
  type: TaskEvent["type"];
  summary: string;
  metadata?: unknown;
}): TaskEvent {
  const event: TaskEvent = {
    id: nanoid(10),
    owner_id: currentOwner(),
    task_id: e.task_id,
    channel_id: e.channel_id ?? null,
    project_id: e.project_id ?? null,
    agent_id: e.agent_id ?? null,
    type: e.type,
    summary: e.summary,
    metadata_json: JSON.stringify(e.metadata ?? {}),
    created_at: now(),
  };
  db.prepare(
    "INSERT INTO task_events (id, owner_id, task_id, channel_id, project_id, agent_id, type, summary, metadata_json, created_at) VALUES (@id, @owner_id, @task_id, @channel_id, @project_id, @agent_id, @type, @summary, @metadata_json, @created_at)"
  ).run(event);
  return event;
}

// ---- projects（每用户私有）----
export function listProjects(): Project[] {
  return db.prepare("SELECT * FROM projects WHERE owner_id = ? ORDER BY created_at DESC").all(currentOwner()) as Project[];
}
export function getProject(id: string): Project | undefined {
  return db.prepare("SELECT * FROM projects WHERE id = ? AND owner_id = ?").get(id, currentOwner()) as Project | undefined;
}
export function createProject(p: {
  channel_id?: string | null;
  lead_agent_id?: string | null;
  title: string;
  goal?: string;
  status?: Project["status"];
  autonomy?: Project["autonomy"];
}): Project {
  const project: Project = {
    id: nanoid(10),
    owner_id: currentOwner(),
    channel_id: p.channel_id ?? null,
    lead_agent_id: p.lead_agent_id ?? null,
    title: p.title,
    goal: p.goal ?? "",
    status: p.status ?? "running",
    autonomy: p.autonomy ?? "auto",
    summary_doc_id: null,
    created_at: now(),
    updated_at: now(),
  };
  db.prepare(
    "INSERT INTO projects (id, owner_id, channel_id, lead_agent_id, title, goal, status, autonomy, summary_doc_id, created_at, updated_at) VALUES (@id, @owner_id, @channel_id, @lead_agent_id, @title, @goal, @status, @autonomy, @summary_doc_id, @created_at, @updated_at)"
  ).run(project);
  return project;
}
export function updateProject(
  id: string,
  fields: Partial<Pick<Project, "status" | "summary_doc_id" | "title" | "goal">>
): Project | undefined {
  const cur = getProject(id);
  if (!cur) return undefined;
  const next: Project = { ...cur, ...fields, updated_at: now() };
  db.prepare(
    "UPDATE projects SET title = @title, goal = @goal, status = @status, summary_doc_id = @summary_doc_id, updated_at = @updated_at WHERE id = @id"
  ).run(next);
  return next;
}
/**
 * 项目级批量关单（human-only 的关闭动作，一次决策关掉整个项目）：
 * 只把该项目的"待评审"任务置 done；已取消任务保持 cancelled，避免伪装成交付验收。
 * 路由层负责阻止仍含待办/进行中/阻塞任务的项目进入本函数。
 * 返回被改动的任务（供前端/SSE 增量更新）与项目。
 */
export function closeProject(projectId: string): { project: Project | undefined; tasks: Task[] } {
  return db.transaction(() => {
    const project = getProject(projectId);
    if (!project) return { project: undefined, tasks: [] };
    const open = db
      .prepare("SELECT * FROM tasks WHERE owner_id = ? AND project_id = ? AND status = 'review'")
      .all(currentOwner(), projectId) as Task[];
    const updated: Task[] = [];
    for (const t of open) {
      const next = updateTask(t.id, { status: "done" });
      if (next) updated.push(next);
    }
    const nextProject = updateProject(projectId, { status: "done" });
    return { project: nextProject, tasks: updated };
  })();
}

// ---- approvals（每用户私有）----
export function listApprovals(): Approval[] {
  return db.prepare("SELECT * FROM approvals WHERE owner_id = ? ORDER BY created_at DESC").all(currentOwner()) as Approval[];
}
export function getApproval(id: string): Approval | undefined {
  return db.prepare("SELECT * FROM approvals WHERE id = ? AND owner_id = ?").get(id, currentOwner()) as Approval | undefined;
}
export function createApproval(a: {
  channel_id?: string | null;
  agent_id: string;
  title: string;
  payload?: string;
  kind?: Approval["kind"];
  ref_id?: string | null;
}): Approval {
  const approval: Approval = {
    id: nanoid(10),
    owner_id: currentOwner(),
    channel_id: a.channel_id ?? null,
    agent_id: a.agent_id,
    title: a.title,
    payload: a.payload ?? "",
    kind: a.kind ?? "action",
    ref_id: a.ref_id ?? null,
    status: "pending",
    created_at: now(),
    resolved_at: null,
    consumed_at: null,
  };
  db.prepare(
    "INSERT INTO approvals (id, owner_id, channel_id, agent_id, title, payload, kind, ref_id, status, created_at, resolved_at, consumed_at) VALUES (@id, @owner_id, @channel_id, @agent_id, @title, @payload, @kind, @ref_id, @status, @created_at, @resolved_at, @consumed_at)"
  ).run(approval);
  return approval;
}
export function resolveApproval(id: string, approve: boolean): Approval | undefined {
  return resolveApprovalOnce(id, approve)?.approval;
}

/**
 * 原子落定审批。只有第一个 pending→final 的请求 changed=true；
 * 并发/重复请求只能读到最终状态，不会再次触发恢复、外呼或消息副作用。
 */
export function resolveApprovalOnce(
  id: string,
  approve: boolean,
): { approval: Approval; changed: boolean } | undefined {
  const resolvedAt = now();
  const status: Approval["status"] = approve ? "approved" : "rejected";
  const result = db.prepare(
    "UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND owner_id = ? AND status = 'pending'"
  ).run(status, resolvedAt, id, currentOwner());
  const approval = getApproval(id);
  if (!approval) return undefined;
  return { approval, changed: result.changes === 1 };
}

export function updateApprovalPayload(id: string, payload: string): Approval | undefined {
  const cur = getApproval(id);
  if (!cur) return undefined;
  const next: Approval = { ...cur, payload };
  db.prepare("UPDATE approvals SET payload = ? WHERE id = ? AND owner_id = ?").run(payload, id, currentOwner());
  return next;
}

/** 原子关闭一次性授权；多进程/重复调用下只有第一个 approved+未关闭请求能成功。 */
export function consumeApproval(id: string): boolean {
  const consumedAt = now();
  const result = db.prepare(
    "UPDATE approvals SET consumed_at = ? WHERE id = ? AND owner_id = ? AND status = 'approved' AND consumed_at IS NULL"
  ).run(consumedAt, id, currentOwner());
  return result.changes === 1;
}

/**
 * 停止/取消/改派任务时原子关闭全部尚未结束的 network 审批：
 * pending → rejected，approved+未消费 → consumed，避免旧审批或旧授权稍后复活。
 */
export function invalidateNetworkApprovalsForTask(taskId: string): number {
  const closedAt = now();
  const result = db.prepare(`
    UPDATE approvals
    SET
      status = CASE WHEN status = 'pending' THEN 'rejected' ELSE status END,
      resolved_at = CASE WHEN status = 'pending' THEN ? ELSE resolved_at END,
      consumed_at = CASE
        WHEN status = 'approved' AND consumed_at IS NULL THEN ?
        ELSE consumed_at
      END
    WHERE owner_id = ?
      AND ref_id = ?
      AND kind = 'network'
      AND (
        status = 'pending'
        OR (status = 'approved' AND consumed_at IS NULL)
      )
  `).run(closedAt, closedAt, currentOwner(), taskId);
  return result.changes;
}

/**
 * network MCP 审批的服务端签发点：审批插入和 doing→blocked 必须同一事务完成。
 * 任务已停止、改派、重复阻塞或状态已变化时不创建孤立审批。
 */
export function createBlockingNetworkApproval(a: {
  task_id: string;
  agent_id: string;
  channel_id?: string | null;
  title: string;
  payload: string;
}): { approval: Approval; task: Task } | undefined {
  const owner = currentOwner();
  const run = db.transaction(() => {
    const task = db.prepare(
      "SELECT * FROM tasks WHERE id = ? AND owner_id = ?"
    ).get(a.task_id, owner) as Task | undefined;
    if (
      !task ||
      task.status !== "doing" ||
      task.assignee_agent_id !== a.agent_id ||
      task.blocked_approval_id !== null
    ) return undefined;

    const approval = createApproval({
      channel_id: a.channel_id ?? task.channel_id,
      agent_id: a.agent_id,
      title: a.title,
      payload: a.payload,
      kind: "network",
      ref_id: task.id,
    });
    const updatedAt = now();
    const changed = db.prepare(
      "UPDATE tasks SET status = 'blocked', blocked_approval_id = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND status = 'doing' AND assignee_agent_id = ? AND blocked_approval_id IS NULL"
    ).run(approval.id, updatedAt, task.id, owner, a.agent_id);
    if (changed.changes !== 1) throw new Error("network approval task state changed");
    return {
      approval,
      task: { ...task, status: "blocked" as const, blocked_approval_id: approval.id, updated_at: updatedAt },
    };
  });
  try {
    return run();
  } catch (err) {
    if (err instanceof Error && err.message === "network approval task state changed") return undefined;
    throw err;
  }
}

// ---- documents（每用户私有）----
export interface Doc {
  id: string;
  owner_id: string;
  channel_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  title: string;
  content: string;
  /** report=Markdown 报告；slides=Marp 演示(--- 分页)；sheet=CSV/表格；html=单文件网页；source=上传来源文档(定向润色用)；template=上传 .pptx 模板(就地改图文) */
  kind: "report" | "slides" | "sheet" | "html" | "source" | "template";
  /** 版本号（1 起）；同 (task_id,kind) 返工再写即递增 */
  version: number;
  /** 被哪条新版取代的 doc id；NULL = 当前版 */
  superseded_by: string | null;
  /** kind=template 专用：来源二进制格式（如 'pptx'）；其余文档为 null */
  binary_format?: string | null;
  /** kind=template 专用：原 .pptx 二进制的 owner 隔离磁盘路径（绝不挂 static）；其余为 null */
  original_blob_path?: string | null;
  /** kind=template 专用：槽位清单等元信息 JSON(TemplateMeta)；其余为 null */
  template_meta?: string | null;
  created_at: number;
  updated_at: number;
}
/** 默认只返回当前版（superseded_by IS NULL），把返工产生的旧版从主列表收起。 */
export function listDocuments(): Doc[] {
  return db.prepare("SELECT * FROM documents WHERE owner_id = ? AND superseded_by IS NULL ORDER BY created_at DESC").all(currentOwner()) as Doc[];
}
/** 某任务（可指定 kind）的全部历史版本，含已被取代的旧版，按版本号降序，供「查看历史版本」用。
 *  按 owner 隔离（fail-closed，防跨租户翻版本历史）。 */
export function listDocumentVersions(taskId: string, kind?: Doc["kind"]): Doc[] {
  const owner = currentOwner();
  const sql = kind
    ? "SELECT * FROM documents WHERE owner_id = ? AND task_id = ? AND kind = ? ORDER BY version DESC"
    : "SELECT * FROM documents WHERE owner_id = ? AND task_id = ? ORDER BY kind, version DESC";
  return db.prepare(sql).all(...(kind ? [owner, taskId, kind] : [owner, taskId])) as Doc[];
}
/** 一次性回填：把存量同 (task_id,kind) 的多个「当前版」按时间链成版本（幂等，只处理多当前版的组）。 */
export function backfillDocVersions(): number {
  const groups = db
    .prepare(
      "SELECT task_id, kind FROM documents WHERE task_id IS NOT NULL AND superseded_by IS NULL GROUP BY task_id, kind HAVING COUNT(*) > 1"
    )
    .all() as { task_id: string; kind: Doc["kind"] }[];
  if (groups.length === 0) return 0;
  const tx = db.transaction(() => {
    for (const g of groups) {
      const rows = db
        .prepare("SELECT id FROM documents WHERE task_id = ? AND kind = ? AND superseded_by IS NULL ORDER BY created_at ASC, id ASC")
        .all(g.task_id, g.kind) as { id: string }[];
      for (let i = 0; i < rows.length; i++) {
        const supersededBy = i < rows.length - 1 ? rows[i + 1].id : null;
        db.prepare("UPDATE documents SET version = ?, superseded_by = ? WHERE id = ?").run(i + 1, supersededBy, rows[i].id);
      }
    }
  });
  tx();
  return groups.length;
}
export function getDocument(id: string): Doc | undefined {
  return db.prepare("SELECT * FROM documents WHERE id = ? AND owner_id = ?").get(id, currentOwner()) as Doc | undefined;
}
export function createDocument(d: {
  channel_id?: string | null;
  task_id?: string | null;
  agent_id?: string | null;
  title: string;
  content: string;
  kind?: Doc["kind"];
  binary_format?: string | null;
  original_blob_path?: string | null;
  template_meta?: string | null;
}): Doc {
  const kind = d.kind ?? "report";
  const taskId = d.task_id ?? null;
  const owner = currentOwner();
  // 版本感知：带 task_id 时，同 (owner,task_id,kind) 的现存当前版会被本次新版取代（不再并列堆叠）。
  const insert = db.transaction((): Doc => {
    let version = 1;
    let prevCurrentId: string | null = null;
    if (taskId) {
      const prev = db
        .prepare("SELECT id, version FROM documents WHERE owner_id = ? AND task_id = ? AND kind = ? AND superseded_by IS NULL ORDER BY version DESC LIMIT 1")
        .get(owner, taskId, kind) as { id: string; version: number } | undefined;
      if (prev) {
        version = prev.version + 1;
        prevCurrentId = prev.id;
      }
    }
    const doc: Doc = {
      id: nanoid(10),
      owner_id: owner,
      channel_id: d.channel_id ?? null,
      task_id: taskId,
      agent_id: d.agent_id ?? null,
      title: d.title,
      content: d.content,
      kind,
      version,
      superseded_by: null,
      binary_format: d.binary_format ?? null,
      original_blob_path: d.original_blob_path ?? null,
      template_meta: d.template_meta ?? null,
      created_at: now(),
      updated_at: now(),
    };
    db.prepare(
      "INSERT INTO documents (id, owner_id, channel_id, task_id, agent_id, title, content, kind, version, superseded_by, binary_format, original_blob_path, template_meta, created_at, updated_at) VALUES (@id, @owner_id, @channel_id, @task_id, @agent_id, @title, @content, @kind, @version, @superseded_by, @binary_format, @original_blob_path, @template_meta, @created_at, @updated_at)"
    ).run(doc);
    if (prevCurrentId) db.prepare("UPDATE documents SET superseded_by = ? WHERE id = ?").run(doc.id, prevCurrentId);
    return doc;
  });
  return insert();
}
/** 启动自愈：把上次遗留的 streaming 中断态 agent 消息收口为 error，
 *  避免插件挂死/服务重启后界面永久卡在「正在输入」。返回收口条数。 */
export function finalizeStaleStreaming(): number {
  const rows = db
    .prepare("SELECT id, content FROM messages WHERE author_type = 'agent' AND status = 'streaming'")
    .all() as { id: string; content: string }[];
  const stmt = db.prepare("UPDATE messages SET status = 'error', content = ? WHERE id = ?");
  for (const r of rows) {
    const note = "⚠️ 运行已中断（插件超时或服务重启），消息未完成。";
    stmt.run(r.content ? `${r.content}\n\n${note}` : note, r.id);
  }
  return rows.length;
}

// ---- users（standalone 多用户登录）----
export interface User {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: "admin" | "member";
  created_at: number;
}
export function countUsers(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}
export function getUserByEmail(email: string): User | undefined {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase().trim()) as User | undefined;
}
export function getUserById(id: string): User | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined;
}
export function listUsers(): Omit<User, "password_hash">[] {
  return db.prepare("SELECT id, email, display_name, role, created_at FROM users ORDER BY created_at ASC").all() as Omit<User, "password_hash">[];
}
export function createUser(u: { email: string; password_hash: string; display_name: string; role: "admin" | "member" }): User {
  const user: User = {
    id: nanoid(12),
    email: u.email.toLowerCase().trim(),
    password_hash: u.password_hash,
    display_name: u.display_name,
    role: u.role,
    created_at: now(),
  };
  db.prepare("INSERT INTO users (id, email, password_hash, display_name, role, created_at) VALUES (@id, @email, @password_hash, @display_name, @role, @created_at)").run(user);
  return user;
}
export function setUserRole(id: string, role: "admin" | "member"): User | undefined {
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
  return getUserById(id);
}

export function deleteDocument(id: string): void {
  db.prepare("DELETE FROM documents WHERE id = ? AND owner_id = ?").run(id, currentOwner());
}
/** kind=template 专用：创建后回填原二进制磁盘路径（文件名含 docId，故须先建文档再落盘再回填）。 */
export function setDocumentBlobPath(id: string, blobPath: string): void {
  db.prepare("UPDATE documents SET original_blob_path = ?, updated_at = ? WHERE id = ? AND owner_id = ?").run(blobPath, now(), id, currentOwner());
}
export function updateDocument(id: string, fields: { title?: string; content?: string }): Doc | undefined {
  const cur = getDocument(id);
  if (!cur) return undefined;
  const next: Doc = { ...cur, ...fields, updated_at: now() };
  db.prepare("UPDATE documents SET title = ?, content = ?, updated_at = ? WHERE id = ?").run(
    next.title, next.content, next.updated_at, id
  );
  return next;
}

// ---- routines（例行任务，每用户私有）----
export interface Routine {
  id: string;
  owner_id: string;
  channel_id: string;
  agent_id: string;
  /** 每日触发时刻 "HH:MM"（Asia/Shanghai） */
  time: string;
  instruction: string;
  last_run_date: string | null;
  created_at: number;
}
export function listRoutines(): Routine[] {
  return db.prepare("SELECT * FROM routines WHERE owner_id = ? ORDER BY time").all(currentOwner()) as Routine[];
}
export function createRoutine(r: { channel_id: string; agent_id: string; time: string; instruction: string }): Routine {
  const routine: Routine = {
    id: nanoid(10),
    owner_id: currentOwner(),
    channel_id: r.channel_id,
    agent_id: r.agent_id,
    time: r.time,
    instruction: r.instruction,
    last_run_date: null,
    created_at: now(),
  };
  db.prepare(
    "INSERT INTO routines (id, owner_id, channel_id, agent_id, time, instruction, last_run_date, created_at) VALUES (@id, @owner_id, @channel_id, @agent_id, @time, @instruction, @last_run_date, @created_at)"
  ).run(routine);
  return routine;
}
export function deleteRoutine(id: string) {
  db.prepare("DELETE FROM routines WHERE id = ? AND owner_id = ?").run(id, currentOwner());
}
export function markRoutineRun(id: string, date: string) {
  // 防御性 owner 约束：调度器已在 withOwner 上下文内调用，避免任何路径下跨 owner 误更新
  db.prepare("UPDATE routines SET last_run_date = ? WHERE id = ? AND owner_id = ?").run(date, id, currentOwner());
}

// ---------------------------------------------------------------------------
// 系统级清扫（跨 owner，不受 AsyncLocalStorage 约束）：仅供调度器/重启恢复使用。
// 调用方拿到行后必须用 withOwner(row.owner_id, ...) 重建上下文再处理。
// ---------------------------------------------------------------------------
/** 全部 owner 的"运行中"任务（服务重启恢复用）。 */
export function listInFlightTasksAllOwners(): Task[] {
  return db.prepare("SELECT * FROM tasks WHERE status = 'doing' AND assignee_agent_id IS NOT NULL").all() as Task[];
}
/** 全部 owner 的例行任务（定时调度用）。 */
export function listRoutinesAllOwners(): Routine[] {
  return db.prepare("SELECT * FROM routines").all() as Routine[];
}

/** 今日各 Agent 的消息用量（tokens）与交付数（当前 owner），供团队视图使用 */
export function agentDailyStats(sinceTs: number): Map<string, { input: number; output: number; billable: number; delivered: number }> {
  const owner = currentOwner();
  const stats = new Map<string, { input: number; output: number; billable: number; delivered: number }>();
  const rows = db
    .prepare("SELECT author_id, usage_json FROM messages WHERE owner_id = ? AND author_type = 'agent' AND created_at >= ?")
    .all(owner, sinceTs) as { author_id: string; usage_json: string | null }[];
  for (const r of rows) {
    if (!r.author_id || !r.usage_json) continue;
    const s = stats.get(r.author_id) ?? { input: 0, output: 0, billable: 0, delivered: 0 };
    const u = readUsage(r.usage_json);
    s.input += u.promptTotal; // 展示口径：总输入 token
    s.output += u.output;
    s.billable += u.billable; // 预算口径：加权计费 token
    stats.set(r.author_id, s);
  }
  const delivered = db
    .prepare(
      "SELECT assignee_agent_id AS id, COUNT(*) AS n FROM tasks WHERE owner_id = ? AND assignee_agent_id IS NOT NULL AND status IN ('review','done') AND updated_at >= ? GROUP BY assignee_agent_id"
    )
    .all(owner, sinceTs) as { id: string; n: number }[];
  for (const d of delivered) {
    const s = stats.get(d.id) ?? { input: 0, output: 0, billable: 0, delivered: 0 };
    s.delivered = d.n;
    stats.set(d.id, s);
  }
  return stats;
}

// ---- memory（按 agent_id；agent 已是 owner 私有且 id 不可猜，故天然隔离）----
export function getMemory(agentId: string): string {
  const row = db.prepare("SELECT content FROM agent_memory WHERE agent_id = ?").get(agentId) as
    | { content: string }
    | undefined;
  return row?.content ?? "";
}
export function clearMemory(agentId: string) {
  db.prepare("DELETE FROM agent_memory WHERE agent_id = ?").run(agentId);
}
export function appendMemory(agentId: string, note: string) {
  const cur = getMemory(agentId);
  let next = (cur ? cur + "\n" : "") + `- ${note}`;
  // 记忆上限：保留最近的条目，鼓励"蒸馏规则"而非无限流水账
  const MAX = 4000;
  if (next.length > MAX) {
    const lines = next.split("\n");
    while (lines.length > 1 && lines.join("\n").length > MAX) lines.shift();
    next = lines.join("\n");
  }
  db.prepare(
    "INSERT INTO agent_memory (agent_id, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at"
  ).run(agentId, next, now());
}

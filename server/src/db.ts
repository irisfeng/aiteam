import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });

export const db = new Database(join(dataDir, "aiteam.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  emoji TEXT NOT NULL DEFAULT '🤖',
  role TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'claude-opus-4-8',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
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
  channel_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  assignee_agent_id TEXT,
  created_by TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  channel_id TEXT,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS agent_memory (
  agent_id TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
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
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  time TEXT NOT NULL,
  instruction TEXT NOT NULL,
  last_run_date TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  channel_id TEXT,
  lead_agent_id TEXT,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  summary_doc_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

// 轻量迁移：旧库补新列
function addColumnIfMissing(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumnIfMissing("tasks", "acceptance_criteria", "acceptance_criteria TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("tasks", "depends_on", "depends_on TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("tasks", "project_id", "project_id TEXT");
addColumnIfMissing("tasks", "revision_count", "revision_count INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("agents", "provider_id", "provider_id TEXT");
addColumnIfMissing("providers", "web_tools", "web_tools INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("projects", "autonomy", "autonomy TEXT NOT NULL DEFAULT 'auto'");
addColumnIfMissing("approvals", "kind", "kind TEXT NOT NULL DEFAULT 'action'");
addColumnIfMissing("approvals", "ref_id", "ref_id TEXT");
addColumnIfMissing("documents", "kind", "kind TEXT NOT NULL DEFAULT 'report'");
addColumnIfMissing("providers", "light_model", "light_model TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("tasks", "model_tier", "model_tier TEXT NOT NULL DEFAULT 'standard'");

export interface Agent {
  id: string;
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
  is_official: number;
  created_at: number;
}
export interface Channel {
  id: string;
  name: string;
  kind: "channel" | "dm";
  dm_agent_id: string | null;
  created_at: number;
  agent_ids?: string[];
}
export interface Message {
  id: string;
  channel_id: string;
  author_type: "user" | "agent" | "system";
  author_id: string | null;
  content: string;
  status: "streaming" | "complete" | "error";
  reply_depth: number;
  usage_json: string | null;
  created_at: number;
}
export interface Task {
  id: string;
  channel_id: string | null;
  title: string;
  description: string;
  status: "todo" | "doing" | "review" | "done";
  assignee_agent_id: string | null;
  created_by: string;
  acceptance_criteria: string;
  /** JSON: 依赖的任务 id 数组；全部交付（review/done）后本任务才会自动开工 */
  depends_on: string;
  /** 模型档位：standard = 全力模型；light = 轻量低成本模型（重复性/格式化/单一明确的执行） */
  model_tier: "standard" | "light";
  project_id: string | null;
  revision_count: number;
  created_at: number;
  updated_at: number;
}
export interface Project {
  id: string;
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
  channel_id: string | null;
  agent_id: string;
  title: string;
  payload: string;
  /** action = 高风险动作审批；plan = 项目计划把关 */
  kind: "action" | "plan";
  /** plan 类审批关联的 project id */
  ref_id: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: number;
  resolved_at: number | null;
}

const now = () => Date.now();

// ---- agents ----
export function listAgents(): Agent[] {
  return db.prepare("SELECT * FROM agents ORDER BY created_at, rowid").all() as Agent[];
}
export function getAgent(id: string): Agent | undefined {
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Agent | undefined;
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
    name: a.name,
    emoji: a.emoji,
    role: a.role,
    system_prompt: a.system_prompt,
    model: a.model || "claude-opus-4-8",
    provider_id: a.provider_id ?? null,
    created_at: now(),
  };
  db.prepare(
    "INSERT INTO agents (id, name, emoji, role, system_prompt, model, provider_id, created_at) VALUES (@id, @name, @emoji, @role, @system_prompt, @model, @provider_id, @created_at)"
  ).run(agent);
  return agent;
}

// ---- providers（模型供应商 / BYOM）----
export function listProviders(): Provider[] {
  return db.prepare("SELECT * FROM providers ORDER BY created_at").all() as Provider[];
}
export function getProvider(id: string): Provider | undefined {
  return db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as Provider | undefined;
}
export function createProvider(p: {
  name: string;
  base_url?: string;
  api_key?: string;
  default_model?: string;
  light_model?: string;
  max_tokens?: number;
  web_tools?: boolean;
}): Provider {
  const provider: Provider = {
    id: nanoid(10),
    name: p.name,
    base_url: p.base_url ?? "",
    api_key: p.api_key ?? "",
    default_model: p.default_model ?? "",
    light_model: p.light_model ?? "",
    max_tokens: p.max_tokens && p.max_tokens > 0 ? p.max_tokens : 16000,
    web_tools: p.web_tools ? 1 : 0,
    is_official: 0,
    created_at: now(),
  };
  db.prepare(
    "INSERT INTO providers (id, name, base_url, api_key, default_model, light_model, max_tokens, web_tools, is_official, created_at) VALUES (@id, @name, @base_url, @api_key, @default_model, @light_model, @max_tokens, @web_tools, @is_official, @created_at)"
  ).run(provider);
  return provider;
}
export function updateProvider(
  id: string,
  fields: Partial<Pick<Provider, "name" | "base_url" | "default_model" | "light_model" | "max_tokens" | "web_tools">> & {
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
    "UPDATE providers SET name = @name, base_url = @base_url, api_key = @api_key, default_model = @default_model, light_model = @light_model, max_tokens = @max_tokens, web_tools = @web_tools WHERE id = @id"
  ).run(next);
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
    is_official: p.is_official,
    has_key: Boolean(p.api_key),
  };
}

// ---- channels ----
export function listChannels(): Channel[] {
  const channels = db.prepare("SELECT * FROM channels ORDER BY created_at, rowid").all() as Channel[];
  const members = db
    .prepare(
      "SELECT ca.channel_id, ca.agent_id FROM channel_agents ca JOIN agents a ON a.id = ca.agent_id ORDER BY a.created_at, a.rowid"
    )
    .all() as { channel_id: string; agent_id: string }[];
  for (const c of channels) {
    c.agent_ids = members.filter((m) => m.channel_id === c.id).map((m) => m.agent_id);
  }
  return channels;
}
export function getChannel(id: string): Channel | undefined {
  const c = db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as Channel | undefined;
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
  const channel: Channel = { id: nanoid(10), name, kind, dm_agent_id: dmAgentId ?? null, created_at: now() };
  db.prepare("INSERT INTO channels (id, name, kind, dm_agent_id, created_at) VALUES (?, ?, ?, ?, ?)").run(
    channel.id, channel.name, channel.kind, channel.dm_agent_id, channel.created_at
  );
  const ins = db.prepare("INSERT OR IGNORE INTO channel_agents (channel_id, agent_id) VALUES (?, ?)");
  for (const id of agentIds) ins.run(channel.id, id);
  channel.agent_ids = agentIds;
  return channel;
}
export function findDm(agentId: string): Channel | undefined {
  const c = db.prepare("SELECT * FROM channels WHERE kind = 'dm' AND dm_agent_id = ?").get(agentId) as
    | Channel
    | undefined;
  if (c) c.agent_ids = [agentId];
  return c;
}

// ---- messages ----
export function listMessages(channelId: string, limit = 200): Message[] {
  return db
    .prepare("SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(channelId, limit)
    .reverse() as Message[];
}
export function insertMessage(m: {
  channel_id: string;
  author_type: Message["author_type"];
  author_id?: string | null;
  content?: string;
  status?: Message["status"];
  reply_depth?: number;
}): Message {
  const msg: Message = {
    id: nanoid(12),
    channel_id: m.channel_id,
    author_type: m.author_type,
    author_id: m.author_id ?? null,
    content: m.content ?? "",
    status: m.status ?? "complete",
    reply_depth: m.reply_depth ?? 0,
    usage_json: null,
    created_at: now(),
  };
  db.prepare(
    "INSERT INTO messages (id, channel_id, author_type, author_id, content, status, reply_depth, usage_json, created_at) VALUES (@id, @channel_id, @author_type, @author_id, @content, @status, @reply_depth, @usage_json, @created_at)"
  ).run(msg);
  return msg;
}
export function updateMessage(id: string, fields: { content?: string; status?: Message["status"]; usage_json?: string | null }) {
  const cur = db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Message | undefined;
  if (!cur) return;
  db.prepare("UPDATE messages SET content = ?, status = ?, usage_json = ? WHERE id = ?").run(
    fields.content ?? cur.content,
    fields.status ?? cur.status,
    fields.usage_json !== undefined ? fields.usage_json : cur.usage_json,
    id
  );
}

// ---- tasks ----
export function listTasks(channelId?: string): Task[] {
  if (channelId)
    return db.prepare("SELECT * FROM tasks WHERE channel_id = ? ORDER BY created_at DESC").all(channelId) as Task[];
  return db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as Task[];
}
export function getTask(id: string): Task | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
}
export function createTask(t: {
  channel_id?: string | null;
  title: string;
  description?: string;
  status?: Task["status"];
  assignee_agent_id?: string | null;
  created_by?: string;
  acceptance_criteria?: string;
  depends_on?: string[];
  model_tier?: Task["model_tier"];
  project_id?: string | null;
}): Task {
  const task: Task = {
    id: nanoid(10),
    channel_id: t.channel_id ?? null,
    title: t.title,
    description: t.description ?? "",
    status: t.status ?? "todo",
    assignee_agent_id: t.assignee_agent_id ?? null,
    created_by: t.created_by ?? "user",
    acceptance_criteria: t.acceptance_criteria ?? "",
    depends_on: JSON.stringify(t.depends_on ?? []),
    model_tier: t.model_tier === "light" ? "light" : "standard",
    project_id: t.project_id ?? null,
    revision_count: 0,
    created_at: now(),
    updated_at: now(),
  };
  db.prepare(
    "INSERT INTO tasks (id, channel_id, title, description, status, assignee_agent_id, created_by, acceptance_criteria, depends_on, model_tier, project_id, revision_count, created_at, updated_at) VALUES (@id, @channel_id, @title, @description, @status, @assignee_agent_id, @created_by, @acceptance_criteria, @depends_on, @model_tier, @project_id, @revision_count, @created_at, @updated_at)"
  ).run(task);
  return task;
}
export function updateTask(
  id: string,
  fields: Partial<
    Pick<
      Task,
      "title" | "description" | "status" | "assignee_agent_id" | "channel_id" | "acceptance_criteria" | "revision_count"
    >
  >
): Task | undefined {
  const cur = getTask(id);
  if (!cur) return undefined;
  const next: Task = { ...cur, ...fields, updated_at: now() };
  db.prepare(
    "UPDATE tasks SET title = @title, description = @description, status = @status, assignee_agent_id = @assignee_agent_id, channel_id = @channel_id, acceptance_criteria = @acceptance_criteria, revision_count = @revision_count, updated_at = @updated_at WHERE id = @id"
  ).run(next);
  return next;
}
export function taskDependsOn(task: Task): string[] {
  try {
    const arr = JSON.parse(task.depends_on);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// ---- projects ----
export function listProjects(): Project[] {
  return db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as Project[];
}
export function getProject(id: string): Project | undefined {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project | undefined;
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
    "INSERT INTO projects (id, channel_id, lead_agent_id, title, goal, status, autonomy, summary_doc_id, created_at, updated_at) VALUES (@id, @channel_id, @lead_agent_id, @title, @goal, @status, @autonomy, @summary_doc_id, @created_at, @updated_at)"
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

// ---- approvals ----
export function listApprovals(): Approval[] {
  return db.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all() as Approval[];
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
    channel_id: a.channel_id ?? null,
    agent_id: a.agent_id,
    title: a.title,
    payload: a.payload ?? "",
    kind: a.kind ?? "action",
    ref_id: a.ref_id ?? null,
    status: "pending",
    created_at: now(),
    resolved_at: null,
  };
  db.prepare(
    "INSERT INTO approvals (id, channel_id, agent_id, title, payload, kind, ref_id, status, created_at, resolved_at) VALUES (@id, @channel_id, @agent_id, @title, @payload, @kind, @ref_id, @status, @created_at, @resolved_at)"
  ).run(approval);
  return approval;
}
export function resolveApproval(id: string, approve: boolean): Approval | undefined {
  const cur = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Approval | undefined;
  if (!cur || cur.status !== "pending") return cur;
  const next: Approval = { ...cur, status: approve ? "approved" : "rejected", resolved_at: now() };
  db.prepare("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?").run(next.status, next.resolved_at, id);
  return next;
}

// ---- documents ----
export interface Doc {
  id: string;
  channel_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  title: string;
  content: string;
  /** report = Markdown 报告；slides = Marp 风格演示文稿（--- 分页）；sheet = CSV/表格数据 */
  kind: "report" | "slides" | "sheet";
  created_at: number;
  updated_at: number;
}
export function listDocuments(): Doc[] {
  return db.prepare("SELECT * FROM documents ORDER BY created_at DESC").all() as Doc[];
}
export function getDocument(id: string): Doc | undefined {
  return db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Doc | undefined;
}
export function createDocument(d: {
  channel_id?: string | null;
  task_id?: string | null;
  agent_id?: string | null;
  title: string;
  content: string;
  kind?: Doc["kind"];
}): Doc {
  const doc: Doc = {
    id: nanoid(10),
    channel_id: d.channel_id ?? null,
    task_id: d.task_id ?? null,
    agent_id: d.agent_id ?? null,
    title: d.title,
    content: d.content,
    kind: d.kind ?? "report",
    created_at: now(),
    updated_at: now(),
  };
  db.prepare(
    "INSERT INTO documents (id, channel_id, task_id, agent_id, title, content, kind, created_at, updated_at) VALUES (@id, @channel_id, @task_id, @agent_id, @title, @content, @kind, @created_at, @updated_at)"
  ).run(doc);
  return doc;
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

// ---- routines（例行任务）----
export interface Routine {
  id: string;
  channel_id: string;
  agent_id: string;
  /** 每日触发时刻 "HH:MM"（Asia/Shanghai） */
  time: string;
  instruction: string;
  last_run_date: string | null;
  created_at: number;
}
export function listRoutines(): Routine[] {
  return db.prepare("SELECT * FROM routines ORDER BY time").all() as Routine[];
}
export function createRoutine(r: { channel_id: string; agent_id: string; time: string; instruction: string }): Routine {
  const routine: Routine = {
    id: nanoid(10),
    channel_id: r.channel_id,
    agent_id: r.agent_id,
    time: r.time,
    instruction: r.instruction,
    last_run_date: null,
    created_at: now(),
  };
  db.prepare(
    "INSERT INTO routines (id, channel_id, agent_id, time, instruction, last_run_date, created_at) VALUES (@id, @channel_id, @agent_id, @time, @instruction, @last_run_date, @created_at)"
  ).run(routine);
  return routine;
}
export function deleteRoutine(id: string) {
  db.prepare("DELETE FROM routines WHERE id = ?").run(id);
}
export function markRoutineRun(id: string, date: string) {
  db.prepare("UPDATE routines SET last_run_date = ? WHERE id = ?").run(date, id);
}

/** 今日各 Agent 的消息用量（tokens）与交付数，供团队视图使用 */
export function agentDailyStats(sinceTs: number): Map<string, { input: number; output: number; delivered: number }> {
  const stats = new Map<string, { input: number; output: number; delivered: number }>();
  const rows = db
    .prepare("SELECT author_id, usage_json FROM messages WHERE author_type = 'agent' AND created_at >= ?")
    .all(sinceTs) as { author_id: string; usage_json: string | null }[];
  for (const r of rows) {
    if (!r.author_id || !r.usage_json) continue;
    const s = stats.get(r.author_id) ?? { input: 0, output: 0, delivered: 0 };
    try {
      const u = JSON.parse(r.usage_json);
      s.input += u.input_tokens ?? 0;
      s.output += u.output_tokens ?? 0;
    } catch { /* ignore */ }
    stats.set(r.author_id, s);
  }
  const delivered = db
    .prepare(
      "SELECT assignee_agent_id AS id, COUNT(*) AS n FROM tasks WHERE assignee_agent_id IS NOT NULL AND status IN ('review','done') AND updated_at >= ? GROUP BY assignee_agent_id"
    )
    .all(sinceTs) as { id: string; n: number }[];
  for (const d of delivered) {
    const s = stats.get(d.id) ?? { input: 0, output: 0, delivered: 0 };
    s.delivered = d.n;
    stats.set(d.id, s);
  }
  return stats;
}

// ---- memory ----
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

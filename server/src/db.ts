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
`);

export interface Agent {
  id: string;
  name: string;
  emoji: string;
  role: string;
  system_prompt: string;
  model: string;
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
  created_at: number;
  updated_at: number;
}
export interface Approval {
  id: string;
  channel_id: string | null;
  agent_id: string;
  title: string;
  payload: string;
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
export function createAgent(a: { name: string; emoji: string; role: string; system_prompt: string; model?: string }): Agent {
  const agent: Agent = {
    id: nanoid(10),
    name: a.name,
    emoji: a.emoji,
    role: a.role,
    system_prompt: a.system_prompt,
    model: a.model || "claude-opus-4-8",
    created_at: now(),
  };
  db.prepare(
    "INSERT INTO agents (id, name, emoji, role, system_prompt, model, created_at) VALUES (@id, @name, @emoji, @role, @system_prompt, @model, @created_at)"
  ).run(agent);
  return agent;
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
}): Task {
  const task: Task = {
    id: nanoid(10),
    channel_id: t.channel_id ?? null,
    title: t.title,
    description: t.description ?? "",
    status: t.status ?? "todo",
    assignee_agent_id: t.assignee_agent_id ?? null,
    created_by: t.created_by ?? "user",
    created_at: now(),
    updated_at: now(),
  };
  db.prepare(
    "INSERT INTO tasks (id, channel_id, title, description, status, assignee_agent_id, created_by, created_at, updated_at) VALUES (@id, @channel_id, @title, @description, @status, @assignee_agent_id, @created_by, @created_at, @updated_at)"
  ).run(task);
  return task;
}
export function updateTask(
  id: string,
  fields: Partial<Pick<Task, "title" | "description" | "status" | "assignee_agent_id" | "channel_id">>
): Task | undefined {
  const cur = getTask(id);
  if (!cur) return undefined;
  const next: Task = { ...cur, ...fields, updated_at: now() };
  db.prepare(
    "UPDATE tasks SET title = @title, description = @description, status = @status, assignee_agent_id = @assignee_agent_id, channel_id = @channel_id, updated_at = @updated_at WHERE id = @id"
  ).run(next);
  return next;
}

// ---- approvals ----
export function listApprovals(): Approval[] {
  return db.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all() as Approval[];
}
export function createApproval(a: { channel_id?: string | null; agent_id: string; title: string; payload?: string }): Approval {
  const approval: Approval = {
    id: nanoid(10),
    channel_id: a.channel_id ?? null,
    agent_id: a.agent_id,
    title: a.title,
    payload: a.payload ?? "",
    status: "pending",
    created_at: now(),
    resolved_at: null,
  };
  db.prepare(
    "INSERT INTO approvals (id, channel_id, agent_id, title, payload, status, created_at, resolved_at) VALUES (@id, @channel_id, @agent_id, @title, @payload, @status, @created_at, @resolved_at)"
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
}): Doc {
  const doc: Doc = {
    id: nanoid(10),
    channel_id: d.channel_id ?? null,
    task_id: d.task_id ?? null,
    agent_id: d.agent_id ?? null,
    title: d.title,
    content: d.content,
    created_at: now(),
    updated_at: now(),
  };
  db.prepare(
    "INSERT INTO documents (id, channel_id, task_id, agent_id, title, content, created_at, updated_at) VALUES (@id, @channel_id, @task_id, @agent_id, @title, @content, @created_at, @updated_at)"
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

// ---- memory ----
export function getMemory(agentId: string): string {
  const row = db.prepare("SELECT content FROM agent_memory WHERE agent_id = ?").get(agentId) as
    | { content: string }
    | undefined;
  return row?.content ?? "";
}
export function appendMemory(agentId: string, note: string) {
  const cur = getMemory(agentId);
  const next = (cur ? cur + "\n" : "") + `- ${note}`;
  db.prepare(
    "INSERT INTO agent_memory (agent_id, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at"
  ).run(agentId, next, now());
}

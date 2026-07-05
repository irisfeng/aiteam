import type { Agent, Approval, Channel, Doc, Message, Project, Provider, QualitySummary, Task, TaskEvent, Verdict } from "./types";

// 统一入口下 AiTeam 挂在 /aiteam/，BASE_URL 即 "/aiteam/"。
// 导出供少数绕过 req() 直接 fetch 的组件（MCP/技能/用量/团队等）复用，确保都带 /aiteam 前缀。
export const API_BASE = `${import.meta.env.BASE_URL}api`;

/** usage_json 累计字段；解析失败或缺省字段一律按 0 处理（兼容空 "{}"、老数据）。 */
export interface TaskUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}
export function parseTaskUsage(json: string | null | undefined): TaskUsage {
  let u: any = {};
  try {
    u = json ? JSON.parse(json) : {};
  } catch { /* 忽略损坏数据 */ }
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_tokens: u.cache_read_tokens ?? 0,
    cache_creation_tokens: u.cache_creation_tokens ?? 0,
  };
}
// 计费口径需与 server/src/db.ts 的 readUsage 保持一致：缓存写≈1.25倍、缓存读≈0.1倍，取整。
export function billableTokens(u: TaskUsage): number {
  return Math.round(u.input_tokens + u.output_tokens + u.cache_creation_tokens * 1.25 + u.cache_read_tokens * 0.1);
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface AuthUser {
  id: string;
  email?: string;
  display_name?: string;
  name?: string;
  role: "admin" | "member";
}
export type AuthInfo =
  | { authed: true; user: AuthUser }
  | { authed: false; allow_signup: boolean; needs_setup: boolean };

export interface Bootstrap {
  user: { id: string; name: string; role: "admin" | "member" };
  mock_mode: boolean;
  agents: Agent[];
  channels: Channel[];
  tasks: Task[];
  task_events: TaskEvent[];
  approvals: Approval[];
  documents: Doc[];
  projects: Project[];
  providers: Provider[];
}

export interface ProviderInput {
  name: string;
  base_url: string;
  /** 编辑时留空 = 保持原 key */
  api_key: string;
  default_model?: string;
  light_model?: string;
  max_tokens?: number;
  web_tools?: boolean;
  is_strong?: boolean;
  price_input_per_million?: number;
  price_output_per_million?: number;
  price_currency?: string;
}

export interface ScenarioStartResult {
  project: Project;
  tasks: Task[];
  reused?: boolean;
}

export interface LinkCheckStartResult {
  project: Project;
}

export interface ScenarioInfo {
  id: string;
  title: string;
  desc: string;
}

export interface ProviderTestResult {
  ok: true;
  protocol: "anthropic-compatible" | "openai-compatible";
  model: string;
  latency_ms: number;
  sample: string;
}

export interface ProviderTaskTestResult {
  ok: boolean;
  provider: Provider;
  model: string;
  latency_ms: number;
  task: Task;
  docs: Doc[];
  events: TaskEvent[];
  checks: {
    completed: boolean;
    delivered: boolean;
    tool_observed: boolean;
    verified: boolean;
    usage_tracked: boolean;
  };
  usage_summary: {
    input: number;
    output: number;
    billable: number;
    estimated_cost: number | null;
    price_currency: string;
  };
}

export interface McpTaskTestResult {
  ok: boolean;
  server: {
    id: string;
    name: string;
    kind: "http" | "stdio";
    safety: "local" | "network" | "exec";
    enabled: number;
    has_token: boolean;
  };
  task: Task;
  docs: Doc[];
  events: TaskEvent[];
  checks: {
    connected: boolean;
    tools: number;
    converted: boolean;
    source_document_created: boolean;
  };
  latency_ms: number;
  sample: string;
}

export interface SkillTaskTestResult {
  ok: boolean;
  skill: {
    id: string;
    name: string;
    enabled: number;
    body: string;
    content: string;
  };
  task: Task;
  docs: Doc[];
  events: TaskEvent[];
  checks: {
    enabled: boolean;
    indexed: boolean;
    read_hint: boolean;
    body_loaded: boolean;
    delivered: boolean;
  };
}

export interface ImageProviderInfo {
  base_url: string;
  model: string;
  has_key: boolean;
  default_base_url?: string;
}

export interface AgentTemplateInfo {
  id: string;
  name: string;
  emoji: string;
  role: string;
  desc: string;
  category: string;
  installed: boolean;
}

export const api = {
  // ---- 鉴权（standalone 登录）----
  authInfo: async (): Promise<AuthInfo> => {
    const res = await fetch(`${API_BASE}/auth/me`);
    const body = await res.json().catch(() => ({}));
    return res.ok
      ? { authed: true, user: body as AuthUser }
      : { authed: false, allow_signup: !!(body as any).allow_signup, needs_setup: !!(body as any).needs_setup };
  },
  login: (email: string, password: string) =>
    req<AuthUser>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  register: (email: string, password: string, display_name: string) =>
    req<AuthUser>("/auth/register", { method: "POST", body: JSON.stringify({ email, password, display_name }) }),
  logout: () => req<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  listAgentTemplates: () => req<AgentTemplateInfo[]>("/agent-templates"),
  createAgentFromTemplate: (template_id: string) =>
    req<Agent>("/agents/from-template", { method: "POST", body: JSON.stringify({ template_id }) }),
  bootstrap: () => req<Bootstrap>("/bootstrap"),
  messages: (channelId: string) => req<Message[]>(`/channels/${channelId}/messages`),
  send: (channelId: string, content: string, replyTo?: string | null) =>
    req<Message>(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, reply_to: replyTo ?? undefined }),
    }),
  createChannel: (name: string, agent_ids: string[]) =>
    req<Channel>("/channels", { method: "POST", body: JSON.stringify({ name, agent_ids }) }),
  openDm: (agent_id: string) => req<Channel>("/dms", { method: "POST", body: JSON.stringify({ agent_id }) }),
  renameChannel: (id: string, name: string) =>
    req<Channel>(`/channels/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  updateChannel: (id: string, patch: { name?: string; agent_ids?: string[] }) =>
    req<Channel>(`/channels/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteChannel: (id: string) => req<{ ok: boolean }>(`/channels/${id}`, { method: "DELETE" }),
  stopChannel: (id: string) => req<{ ok: boolean; stopped: boolean }>(`/channels/${id}/stop`, { method: "POST" }),
  clearMessages: (id: string) => req<{ ok: boolean }>(`/channels/${id}/messages`, { method: "DELETE" }),
  createAgent: (data: {
    name: string;
    emoji: string;
    role: string;
    system_prompt: string;
    model?: string;
    provider_id?: string | null;
  }) => req<Agent>("/agents", { method: "POST", body: JSON.stringify(data) }),
  createProvider: (data: ProviderInput) => req<Provider>("/providers", { method: "POST", body: JSON.stringify(data) }),
  updateProvider: (id: string, data: ProviderInput) =>
    req<Provider>(`/providers/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  testProvider: (id: string) => req<ProviderTestResult>(`/providers/${id}/test`, { method: "POST" }),
  startLinkCheck: (data: { channel_id?: string | null } = {}) =>
    req<LinkCheckStartResult>("/link-checks", { method: "POST", body: JSON.stringify(data) }),
  runProviderTaskTest: (id: string, data: { channel_id?: string | null; project_id?: string | null } = {}) =>
    req<ProviderTaskTestResult>(`/providers/${id}/task-test`, { method: "POST", body: JSON.stringify(data) }),
  deleteProvider: (id: string) => req<{ ok: boolean }>(`/providers/${id}`, { method: "DELETE" }),
  getImageProvider: () => req<ImageProviderInfo>("/image-provider"),
  saveImageProvider: (data: { base_url?: string; api_key?: string; model?: string }) =>
    req<ImageProviderInfo>("/image-provider", { method: "PUT", body: JSON.stringify(data) }),
  listSkills: () => req<{ id: string; name: string; desc: string; enabled: number; builtin: number }[]>("/skills"),
  toggleSkill: (id: string, enabled: boolean) =>
    req(`/skills/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  runMcpTaskTest: (id: string, data: { channel_id?: string | null; project_id?: string | null } = {}) =>
    req<McpTaskTestResult>(`/mcp-servers/${id}/task-test`, { method: "POST", body: JSON.stringify(data) }),
  runSkillTaskTest: (id: string, data: { channel_id?: string | null; project_id?: string | null } = {}) =>
    req<SkillTaskTestResult>(`/skills/${id}/task-test`, { method: "POST", body: JSON.stringify(data) }),
  createTask: (data: {
    title: string;
    description?: string;
    channel_id?: string | null;
    assignee_agent_id?: string | null;
    reviewer_agent_id?: string | null;
    budget_billable?: number;
  }) =>
    req<Task>("/tasks", { method: "POST", body: JSON.stringify(data) }),
  listScenarios: () => req<ScenarioInfo[]>("/scenarios"),
  startScenario: (id: string, data: { channel_id?: string | null; acceptance?: boolean }) =>
    req<ScenarioStartResult>(`/scenarios/${id}/start`, { method: "POST", body: JSON.stringify(data) }),
  taskEvents: (id: string) => req<TaskEvent[]>(`/tasks/${id}/events`),
  taskVerdicts: (id: string) => req<Verdict[]>(`/tasks/${id}/verdicts`),
  quality: () => req<QualitySummary>("/quality"),
  updateTask: (id: string, data: Partial<Pick<Task, "title" | "description" | "status" | "assignee_agent_id" | "reviewer_agent_id" | "budget_billable">>) =>
    req<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  requestRevision: (id: string, reason: string) =>
    req<Task>(`/tasks/${id}/revise`, { method: "POST", body: JSON.stringify({ reason }) }),
  resolveApproval: (id: string, approve: boolean, response?: string) =>
    req<Approval>(`/approvals/${id}/resolve`, { method: "POST", body: JSON.stringify({ approve, response }) }),
  closeProject: (id: string) =>
    req<{ project: Project; tasks: Task[] }>(`/projects/${id}/close`, { method: "POST" }),
  docVersions: (id: string) => req<Doc[]>(`/documents/${id}/versions`),
  deleteDocument: (id: string) =>
    req<{ ok: boolean; deleted: string[] }>(`/documents/${id}`, { method: "DELETE" }),
  // 上传来源文档：用 FormData（绕过 req() 的 application/json），让浏览器自带 multipart 边界；同源 cookie 自动带上。
  uploadDoc: async (file: File): Promise<Doc> => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${API_BASE}/uploads`, { method: "POST", body: fd });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string })?.error ?? `HTTP ${res.status}`);
    return res.json() as Promise<Doc>;
  },
  // 上传 .pptx 作为「模板」（就地改图文）：解析槽位 + 持久化原件，返回 kind=template 文档（含 template_meta）。
  uploadTemplate: async (file: File): Promise<Doc> => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${API_BASE}/templates`, { method: "POST", body: fd });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string })?.error ?? `HTTP ${res.status}`);
    return res.json() as Promise<Doc>;
  },
  // AI 按来源为模板槽位产替换文案（逐槽确认前的建议）。
  proposeTemplateEdits: (id: string, body: { sourceDocIds?: string[]; brief?: string }) =>
    req<{ suggestions: { idx: number; slideIdx: number; shapeIdx: number; paraIdx: number; original: string; suggestion: string }[] }>(
      `/documents/${id}/template-propose`, { method: "POST", body: JSON.stringify(body) }
    ),
  // 模板就地改文本/换图 → 导出可编辑 .pptx（返回二进制 Blob，组件负责触发下载）。
  templateExport: async (
    id: string,
    edits: { slideIdx: number; shapeIdx: number; paraIdx: number; newText: string }[],
    imageEdits: { slideIdx: number; imageIdx: number; dataBase64: string; ext: string }[] = []
  ): Promise<Blob> => {
    const res = await fetch(`${API_BASE}/documents/${id}/template-export`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ edits, imageEdits }),
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string })?.error ?? `HTTP ${res.status}`);
    return res.blob();
  },
  // 为模板图片位生成配图（Seedream），返回 base64 供预览 + 随导出嵌入。
  generateTemplateImage: (id: string, prompt: string, size?: string) =>
    req<{ dataBase64: string; ext: string; assetUrl: string }>(
      `/documents/${id}/template-image-generate`, { method: "POST", body: JSON.stringify({ prompt, size }) }
    ),
};

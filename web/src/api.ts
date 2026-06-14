import type { Agent, Approval, Channel, Doc, Message, Project, Provider, Task } from "./types";

// 统一入口下 AiTeam 挂在 /aiteam/，BASE_URL 即 "/aiteam/"。
// 导出供少数绕过 req() 直接 fetch 的组件（MCP/技能/用量/团队等）复用，确保都带 /aiteam 前缀。
export const API_BASE = `${import.meta.env.BASE_URL}api`;

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
  deleteProvider: (id: string) => req<{ ok: boolean }>(`/providers/${id}`, { method: "DELETE" }),
  getImageProvider: () => req<ImageProviderInfo>("/image-provider"),
  saveImageProvider: (data: { base_url?: string; api_key?: string; model?: string }) =>
    req<ImageProviderInfo>("/image-provider", { method: "PUT", body: JSON.stringify(data) }),
  listSkills: () => req<{ id: string; name: string; desc: string; enabled: number; builtin: number }[]>("/skills"),
  toggleSkill: (id: string, enabled: boolean) =>
    req(`/skills/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  createTask: (data: { title: string; description?: string; channel_id?: string | null; assignee_agent_id?: string | null }) =>
    req<Task>("/tasks", { method: "POST", body: JSON.stringify(data) }),
  updateTask: (id: string, data: Partial<Pick<Task, "title" | "description" | "status" | "assignee_agent_id">>) =>
    req<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  resolveApproval: (id: string, approve: boolean) =>
    req<Approval>(`/approvals/${id}/resolve`, { method: "POST", body: JSON.stringify({ approve }) }),
  closeProject: (id: string) =>
    req<{ project: Project; tasks: Task[] }>(`/projects/${id}/close`, { method: "POST" }),
  docVersions: (id: string) => req<Doc[]>(`/documents/${id}/versions`),
  deleteDocument: (id: string) =>
    req<{ ok: boolean; deleted: string[] }>(`/documents/${id}`, { method: "DELETE" }),
};

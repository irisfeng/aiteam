import type { Agent, Approval, Channel, Doc, Message, Project, Provider, Task } from "./types";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface Bootstrap {
  user: { id: string; name: string };
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
  deleteChannel: (id: string) => req<{ ok: boolean }>(`/channels/${id}`, { method: "DELETE" }),
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
  createTask: (data: { title: string; description?: string; channel_id?: string | null; assignee_agent_id?: string | null }) =>
    req<Task>("/tasks", { method: "POST", body: JSON.stringify(data) }),
  updateTask: (id: string, data: Partial<Pick<Task, "title" | "description" | "status" | "assignee_agent_id">>) =>
    req<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  resolveApproval: (id: string, approve: boolean) =>
    req<Approval>(`/approvals/${id}/resolve`, { method: "POST", body: JSON.stringify({ approve }) }),
  closeProject: (id: string) =>
    req<{ project: Project; tasks: Task[] }>(`/projects/${id}/close`, { method: "POST" }),
};

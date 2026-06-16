export interface Agent {
  id: string;
  name: string;
  emoji: string;
  role: string;
  system_prompt: string;
  model: string;
  provider_id: string | null;
  created_at: number;
}
export interface Provider {
  id: string;
  name: string;
  base_url: string;
  default_model: string;
  light_model: string;
  max_tokens: number;
  web_tools: number;
  is_strong: number;
  is_official: number;
  has_key: boolean;
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
  model?: string;
  reply_to?: string | null;
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
  depends_on: string;
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
  status: "planned" | "running" | "review" | "done";
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
  kind: "action" | "plan";
  ref_id: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: number;
  resolved_at: number | null;
}
export interface Doc {
  id: string;
  channel_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  title: string;
  content: string;
  kind: "report" | "slides" | "sheet" | "html" | "source";
  version: number;
  superseded_by: string | null;
  created_at: number;
  updated_at: number;
}
export interface Skill {
  id: string;
  name: string;
  desc: string;
  content: string;
  kind: "method" | "capability";
  trigger: string;
  when_to_use: string;
  body: string;
  resources_json: string;
  version: number;
  enabled: number;
  builtin: number;
}
export interface McpPreset {
  key: string;
  name: string;
  kind: "http" | "stdio";
  command?: string;
  args?: string[];
  url?: string;
  desc: string;
  scenario: "office-doc" | "data-viz" | "code-mvp" | "research" | "general";
  runtime_china: "yes" | "degrade" | "no";
  install_china: "yes" | "degrade" | "no";
  safety: "local" | "network" | "exec";
  install: string;
  phase: "P1-install" | "P1" | "P2";
  env_keys?: string[];
}
export interface AgentStatus {
  agent_id: string;
  channel_id: string;
  state: "thinking" | "tool" | "responding" | "idle";
  detail?: string;
}
export type View =
  | { kind: "channel"; id: string }
  | { kind: "tasks" }
  | { kind: "inbox" }
  | { kind: "docs" }
  | { kind: "team" }
  | { kind: "usage" };

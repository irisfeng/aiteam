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
export interface AgentStatus {
  agent_id: string;
  channel_id: string;
  state: "thinking" | "tool" | "responding" | "idle";
  detail?: string;
}
export type View = { kind: "channel"; id: string } | { kind: "tasks" } | { kind: "inbox" };

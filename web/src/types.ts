export interface Agent {
  id: string;
  name: string;
  emoji: string;
  role: string;
  system_prompt: string;
  model: string;
  provider_id: string | null;
  fallback_model: string;
  fallback_provider_id: string | null;
  strong_model: string;
  strong_provider_id: string | null;
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
  price_input_per_million: number;
  price_output_per_million: number;
  price_currency: string;
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
  status: "todo" | "doing" | "review" | "blocked" | "done" | "cancelled";
  assignee_agent_id: string | null;
  reviewer_agent_id: string | null;
  blocked_approval_id: string | null;
  created_by: string;
  acceptance_criteria: string;
  depends_on: string;
  model_tier: "standard" | "light";
  source_doc_ids: string;
  project_id: string | null;
  revision_count: number;
  /** 累计用量 JSON（跨返工/验收不清零）：{input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens} */
  usage_json: string;
  /** 任务级预算（billable 加权 token）；0 = 不设上限 */
  budget_billable: number;
  /** 开工时按历史同档任务中位数写入的估价（billable）；0 = 无历史可估 */
  estimate_billable: number;
  created_at: number;
  updated_at: number;
}
/** 真实模型质量基准的人工关单证据；五项必须全部确认，note 记录可决策理由。 */
export interface HumanQualityAudit {
  decision_useful: boolean;
  evidence_traceable: boolean;
  no_fabrication: boolean;
  workflow_actionable: boolean;
  no_padding: boolean;
  note: string;
}
export type TaskUpdateInput = Partial<Pick<Task,
  "title" | "description" | "acceptance_criteria" | "status" | "assignee_agent_id" | "reviewer_agent_id" | "budget_billable"
>> & { human_audit?: HumanQualityAudit };
/** 单次验收裁决（D1 质量闭环落表） */
export interface Verdict {
  id: string;
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
/** 工作区质量汇总（质量面板数据源） */
export interface QualitySummary {
  agents: { agent_id: string; tasks: number; first_pass: number; revises: number }[];
  coverage: { delivered: number; verified: number };
  recent_revises: { task_id: string; reasons: string; source: string; created_at: number }[];
}
export interface TaskEvent {
  id: string;
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
  kind: "action" | "network" | "plan" | "clarification" | "budget";
  ref_id: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: number;
  resolved_at: number | null;
  /** network grant used or invalidated */
  consumed_at: number | null;
}
export interface Doc {
  id: string;
  channel_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  title: string;
  content: string;
  kind: "report" | "slides" | "sheet" | "html" | "source" | "template";
  version: number;
  superseded_by: string | null;
  /** kind=template：来源格式(如 'pptx')、原二进制路径、槽位清单 JSON(TemplateMeta)；其余为 null/缺省 */
  binary_format?: string | null;
  original_blob_path?: string | null;
  template_meta?: string | null;
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
  | { kind: "workline" }
  | { kind: "tasks" }
  | { kind: "inbox" }
  | { kind: "docs" }
  | { kind: "team" }
  | { kind: "usage" };

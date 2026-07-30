import {
  getAgent,
  getApproval,
  insertMessage,
  resolveApprovalOnce,
  updateApprovalPayload,
  type Approval,
} from "./db.js";
import { broadcast } from "./bus.js";
import {
  onBudgetResolved,
  onClarificationResolved,
  onNetworkApprovalResolved,
  onPlanResolved,
  triggerAgent,
} from "./agents/engine.js";

export interface ResolveApprovalInput {
  id: string;
  approve: boolean;
  response?: string;
  resolvedBy?: string;
}

export type ResolveApprovalResult =
  | { outcome: "not_found" }
  | { outcome: "conflict"; approval: Approval }
  | { outcome: "resolved" | "replayed"; approval: Approval };

function mergeClarificationResponse(payload: string, response: string): string {
  try {
    const parsed = JSON.parse(payload || "{}") as Record<string, unknown>;
    const proposed =
      typeof parsed.proposed_default === "string" ? parsed.proposed_default : "";
    const userResponse = response.trim() || proposed.trim();
    return JSON.stringify({ ...parsed, user_response: userResponse }, null, 2);
  } catch {
    return JSON.stringify(
      { question: payload, user_response: response.trim() },
      null,
      2,
    );
  }
}

/**
 * The single side-effect coordinator for every approval entry point.
 *
 * The database transition is atomic; only its first pending -> final transition
 * may resume a task, broadcast state, or append audit messages. Replaying the
 * same decision is safe, while an opposite decision is a conflict.
 */
export function resolveApprovalWithSideEffects(
  input: ResolveApprovalInput,
): ResolveApprovalResult {
  const before = getApproval(input.id);
  if (
    before?.status === "pending" &&
    before.kind === "clarification" &&
    input.approve
  ) {
    updateApprovalPayload(
      before.id,
      mergeClarificationResponse(before.payload, input.response ?? ""),
    );
  }

  const resolved = resolveApprovalOnce(input.id, input.approve);
  if (!resolved) return { outcome: "not_found" };
  const { approval, changed } = resolved;
  const requestedStatus = input.approve ? "approved" : "rejected";
  if (!changed && approval.status !== requestedStatus) {
    return { outcome: "conflict", approval };
  }
  if (!changed) return { outcome: "replayed", approval };

  const wasApproved = approval.status === "approved";
  if (approval.kind === "network") {
    onNetworkApprovalResolved(approval, input.resolvedBy);
  }
  broadcast({ type: "approval:upsert", payload: approval });
  if (approval.channel_id) {
    const agent = getAgent(approval.agent_id);
    const actor = input.resolvedBy
      ? "Coworker 中的有权限用户"
      : "用户";
    const sys = insertMessage({
      channel_id: approval.channel_id,
      author_type: "system",
      content: `${wasApproved ? "✅" : "❌"} ${actor}${wasApproved ? "批准了" : "拒绝了"} ${agent?.name ?? "AI"} 的审批请求「${approval.title}」`,
    });
    broadcast({ type: "message:new", payload: sys });
    if (approval.kind === "plan" && approval.ref_id) {
      onPlanResolved(approval.ref_id, wasApproved);
    } else if (approval.kind === "action") {
      triggerAgent(approval.agent_id, approval.channel_id);
    }
  }
  if (approval.kind === "clarification") {
    onClarificationResolved(approval, wasApproved);
  }
  if (approval.kind === "budget") {
    onBudgetResolved(approval, wasApproved);
  }
  return { outcome: "resolved", approval };
}

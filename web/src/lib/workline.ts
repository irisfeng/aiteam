import type { Agent, Approval, Task } from "../types";

// 「运行线」共享聚合：范围过滤、计数、"需要你处理"清单的选择顺序与文案。
// 工作台总览与频道侧栏共用这一份，状态机或优先级调整只改这里。

export interface AttentionItem {
  id: string;
  tone: "block" | "review" | "approval";
  label: string;
  title: string;
  meta: string;
  /** 有关联任务 → 打开任务详情；否则调用方应跳转收件箱 */
  task?: Task;
  approval?: Approval;
}

export interface WorklineSnapshot {
  tasks: Task[];
  approvals: Approval[];
  running: Task[];
  blocked: Task[];
  blockedWithoutPendingApproval: Task[];
  review: Task[];
  todo: Task[];
  done: Task[];
  active: Task[];
  unassigned: Task[];
  attention: AttentionItem[];
}

export function approvalKindLabel(kind: Approval["kind"]) {
  if (kind === "plan") return "计划审批";
  if (kind === "clarification") return "等待输入";
  return "风险动作";
}

function approvalMeta(kind: Approval["kind"]) {
  if (kind === "clarification") return "回应后任务自动恢复执行";
  if (kind === "plan") return "批准后项目开工";
  return "处理后 AI 才能继续";
}

export function computeWorkline({
  tasks,
  approvals,
  channelId,
  agentById,
  attentionLimit = 5,
}: {
  tasks: Task[];
  approvals: Approval[];
  channelId?: string;
  agentById: (id: string | null) => Agent | undefined;
  attentionLimit?: number;
}): WorklineSnapshot {
  const scopedTasks = channelId ? tasks.filter((t) => t.channel_id === channelId) : tasks;
  const taskIds = new Set(scopedTasks.map((t) => t.id));
  const scopedApprovals = approvals.filter((a) => {
    if (a.status !== "pending") return false;
    if (!channelId) return true;
    return a.channel_id === channelId || (a.ref_id ? taskIds.has(a.ref_id) : false);
  });

  const running = scopedTasks.filter((t) => t.status === "doing");
  const blocked = scopedTasks.filter((t) => t.status === "blocked");
  const approvalTaskIds = new Set(scopedApprovals.map((a) => a.ref_id).filter(Boolean));
  const blockedWithoutPendingApproval = blocked.filter((t) => !approvalTaskIds.has(t.id));
  const review = scopedTasks.filter((t) => t.status === "review");
  const todo = scopedTasks.filter((t) => t.status === "todo");
  const done = scopedTasks.filter((t) => t.status === "done");
  const active = scopedTasks.filter((t) => t.status !== "done");
  const unassigned = scopedTasks.filter((t) => t.status === "todo" && !t.assignee_agent_id);

  const attention: AttentionItem[] = [
    ...scopedApprovals.map((approval) => {
      const linkedTask = approval.ref_id ? scopedTasks.find((t) => t.id === approval.ref_id) : undefined;
      return {
        id: `approval:${approval.id}`,
        tone: (approval.kind === "clarification" ? "block" : "approval") as AttentionItem["tone"],
        label: approvalKindLabel(approval.kind),
        title: linkedTask?.title ?? approval.title,
        meta: approvalMeta(approval.kind),
        task: linkedTask,
        approval,
      };
    }),
    ...blockedWithoutPendingApproval.map((task) => ({
      id: `blocked:${task.id}`,
      tone: "block" as const,
      label: "任务阻塞",
      title: task.title,
      meta: task.blocked_approval_id ? "收件箱确认后恢复" : "等待补充事实、权限或选择",
      task,
    })),
    ...review.map((task) => ({
      id: `review:${task.id}`,
      tone: "review" as const,
      label: "待复核",
      title: task.title,
      meta: task.reviewer_agent_id
        ? `${agentById(task.reviewer_agent_id)?.name ?? "复核人"} 负责验收`
        : "复核后由你确认关单",
      task,
    })),
  ].slice(0, attentionLimit);

  return {
    tasks: scopedTasks,
    approvals: scopedApprovals,
    running,
    blocked,
    blockedWithoutPendingApproval,
    review,
    todo,
    done,
    active,
    unassigned,
    attention,
  };
}

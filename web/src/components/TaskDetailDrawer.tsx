import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "../store";
import type { Approval, Doc, Task, TaskEvent, Verdict } from "../types";
import { api, billableTokens, parseTaskUsage } from "../api";

const EVENT_LABEL: Record<TaskEvent["type"], string> = {
  created: "创建",
  claim: "认领",
  start: "开工",
  tool: "工具",
  blocked: "阻塞",
  handoff: "交接",
  delivery: "交付",
  verification: "复核",
  approval: "审批",
  user_close: "关闭",
  failure: "失败",
};

const VERDICT_SOURCE_LABEL: Record<Verdict["source"], string> = {
  auto: "机器验收",
  solo: "自检",
  fallback: "兜底",
  human: "人工退回",
};

function fmtNum(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmt(ts: number) {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function parseIds(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

function parseClarificationPayload(payload: string) {
  try {
    const p = JSON.parse(payload) as { question?: string; context?: string; proposed_default?: string; user_response?: string };
    return {
      question: p.question ? String(p.question) : "",
      context: p.context ? String(p.context) : "",
      proposedDefault: p.proposed_default ? String(p.proposed_default) : "",
      userResponse: p.user_response ? String(p.user_response) : "",
    };
  } catch {
    return null;
  }
}

function approvalQuestion(a: Approval) {
  if (a.kind !== "clarification") return a.payload;
  const parsed = parseClarificationPayload(a.payload);
  if (!parsed) return a.payload;
  return [
    parsed.question,
    parsed.context,
    parsed.proposedDefault ? `建议默认：${parsed.proposedDefault}` : "",
    parsed.userResponse ? `你的输入：${parsed.userResponse}` : "",
  ].filter(Boolean).join("\n");
}

function approvalKindLabel(kind: Approval["kind"]) {
  if (kind === "plan") return "计划";
  if (kind === "clarification") return "输入";
  return "审批";
}

function splitAcceptanceCriteria(raw: string) {
  return raw
    .split(/\n|；|;|。/)
    .map((item) => item.replace(/^[-*•\d.、)\s]+/, "").trim())
    .filter(Boolean);
}

function nextActionHint(task: Task, pendingApprovals: Approval[], docs: Doc[], dependencies: Task[], assignee?: { name: string } | undefined) {
  if (pendingApprovals.length > 0) {
    const clarification = pendingApprovals.some((a) => a.kind === "clarification");
    return {
      tone: "attention" as const,
      label: clarification ? "需要你输入" : "需要你审批",
      body: clarification
        ? "先确认或保持阻塞；确认后 AI 会恢复执行，活动日志会继续更新。"
        : "先批准或拒绝风险动作，任务才会继续推进。",
    };
  }
  if (task.status === "blocked") {
    return { tone: "attention" as const, label: "任务已阻塞", body: "等待补充事实、权限或选择；不要把 blocked 手工推成已交付。" };
  }
  if (task.status === "review") {
    return {
      tone: "review" as const,
      label: "待复核",
      body: docs.length > 0 ? "先打开交付物核对验收标准；通过后由你确认关闭，未过则退回返工。" : "任务已提交评审，但还没有可见交付物，建议先退回返工。",
    };
  }
  if (task.status === "doing") {
    return { tone: "run" as const, label: "AI 正在执行", body: "观察最近工具和活动日志；如出现审批或输入请求，会在这里直接处理。" };
  }
  if (task.status === "todo") {
    if (!task.assignee_agent_id) return { tone: "idle" as const, label: "等待认领", body: "先指定负责人，或让合适的 AI 同事通过 claim_task 认领。" };
    const blockedDeps = dependencies.filter((d) => d.status !== "review" && d.status !== "done");
    if (blockedDeps.length > 0) return { tone: "idle" as const, label: "等待依赖", body: `${blockedDeps.length} 个前置任务未交付；依赖完成后 ${assignee?.name ?? "负责人"} 会继续。` };
    return { tone: "run" as const, label: "准备开工", body: `${assignee?.name ?? "负责人"} 已归属；任务会按调度进入执行。` };
  }
  return { tone: "done" as const, label: "已关闭", body: "任务已由人类确认关闭；保留交付物、审批和活动日志供复盘。" };
}

export function TaskDetailDrawer({
  task,
  onClose,
  onOpenDoc,
  onOpenTask,
}: {
  task: Task;
  onClose: () => void;
  onOpenDoc?: (doc: Doc) => void;
  onOpenTask?: (task: Task) => void;
}) {
  const ws = useWorkspace();
  const [closing, setClosing] = useState(false);
  const [revising, setRevising] = useState(false);
  const [resolvingApprovalId, setResolvingApprovalId] = useState("");
  const [approvalResponses, setApprovalResponses] = useState<Record<string, string>>({});
  const [savingRole, setSavingRole] = useState<"" | "assignee" | "reviewer">("");
  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  const [expandedVerdicts, setExpandedVerdicts] = useState<Record<string, boolean>>({});
  const [budgetInput, setBudgetInput] = useState("");
  const [savingBudget, setSavingBudget] = useState(false);

  useEffect(() => {
    let alive = true;
    // 抽屉切换任务时不卸载：先清上一个任务的裁决链，避免请求返回前闪现旧数据
    setVerdicts([]);
    setExpandedVerdicts({});
    api.taskVerdicts(task.id).then((v) => alive && setVerdicts(v)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [task.id]);

  useEffect(() => {
    setBudgetInput(task.budget_billable > 0 ? String(task.budget_billable) : "");
  }, [task.id, task.budget_billable]);
  const assignee = ws.agentById(task.assignee_agent_id);
  const reviewer = ws.agentById(task.reviewer_agent_id);
  const creator = task.created_by === "user" ? null : ws.agentById(task.created_by);
  const project = ws.projects.find((p) => p.id === task.project_id);
  const dependencies = useMemo(() => parseIds(task.depends_on).map((id) => ws.tasks.find((t) => t.id === id)).filter(Boolean) as Task[], [task.depends_on, ws.tasks]);
  const dependents = useMemo(() => ws.tasks.filter((t) => parseIds(t.depends_on).includes(task.id)), [task.id, ws.tasks]);
  const sourceDocs = useMemo(() => parseIds(task.source_doc_ids ?? "[]").map((id) => ws.documents.find((d) => d.id === id)).filter(Boolean) as Doc[], [task.source_doc_ids, ws.documents]);
  const docs = ws.documents.filter((d) => d.task_id === task.id).sort((a, b) => b.created_at - a.created_at);
  const latestDoc = docs[0];
  const events = ws.taskEvents.filter((e) => e.task_id === task.id).sort((a, b) => a.created_at - b.created_at);
  const tools = events.filter((e) => e.type === "tool").slice(-6).reverse();
  const acceptanceItems = splitAcceptanceCriteria(task.acceptance_criteria);
  const deliveryEvidence = docs.length > 0;
  const selfCheckEvidence = docs.some((d) => /自查表|验收标准|是否满足|证据位置/.test(d.content));
  const verificationEvidence = events.some((e) => e.type === "verification");
  const approvals = ws.approvals
    .filter((a) => a.ref_id === task.id || a.id === task.blocked_approval_id)
    .sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") || b.created_at - a.created_at);
  const pendingApprovals = approvals.filter((a) => a.status === "pending");
  const actionHint = nextActionHint(task, pendingApprovals, docs, dependencies, assignee);
  const closeDisabled = task.status === "done" || closing || pendingApprovals.length > 0;

  async function closeTask() {
    if (closeDisabled) return;
    // 未交付评审的任务保留人类关闭权（唯一的取消/清理路径），但要显式确认这是"取消归档"而非验收通过。
    if (task.status !== "review" &&
      !window.confirm(`任务「${task.title}」尚未交付评审。\n确认关闭 = 取消并归档该任务（不代表验收通过）。`)) return;
    setClosing(true);
    try {
      await ws.moveTask(task, "done");
    } finally {
      setClosing(false);
    }
  }

  async function requestRevision() {
    if (task.status !== "review" || revising) return;
    const reason = window.prompt("退回返工原因", "请按验收标准补全缺口后重新交付。");
    if (reason === null) return;
    setRevising(true);
    try {
      await api.requestRevision(task.id, reason);
      await ws.refreshWorkspace();
    } finally {
      setRevising(false);
    }
  }

  async function resolveTaskApproval(approval: Approval, approve: boolean, response?: string) {
    if (approval.status !== "pending" || resolvingApprovalId) return;
    setResolvingApprovalId(approval.id);
    try {
      await ws.resolveApproval(approval.id, approve, response);
    } finally {
      setResolvingApprovalId("");
    }
  }

  async function saveBudget() {
    if (savingBudget) return;
    const n = Math.max(0, Math.round(Number(budgetInput) || 0));
    setSavingBudget(true);
    try {
      await ws.updateTask(task.id, { budget_billable: n });
    } finally {
      setSavingBudget(false);
    }
  }

  async function updateRole(kind: "assignee" | "reviewer", agentId: string) {
    if (savingRole) return;
    setSavingRole(kind);
    try {
      await ws.updateTask(
        task.id,
        kind === "assignee"
          ? { assignee_agent_id: agentId || null }
          : { reviewer_agent_id: agentId || null },
      );
    } finally {
      setSavingRole("");
    }
  }

  const usage = useMemo(() => parseTaskUsage(task.usage_json), [task.usage_json]);
  const billable = useMemo(() => billableTokens(usage), [usage]);
  const hasUsage = billable > 0;
  const hasBudget = task.budget_billable > 0;
  const budgetPct = hasBudget ? Math.round((billable / task.budget_billable) * 100) : 0;
  const budgetTone = !hasBudget ? "" : budgetPct >= 100 ? "bg-red-500" : budgetPct >= 90 ? "bg-amber-500" : "bg-accent";
  const budgetTextTone = !hasBudget ? "text-ink-2" : budgetPct >= 100 ? "text-red-600" : budgetPct >= 90 ? "text-amber-600" : "text-ink-2";
  const hasEstimate = task.estimate_billable > 0;

  const pendingApprovalCount = pendingApprovals.length;
  const hintToneClass =
    actionHint.tone === "attention"
      ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300"
      : actionHint.tone === "review"
        ? "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/20 dark:text-blue-300"
        : actionHint.tone === "run"
          ? "border-accent/30 bg-accent-soft text-accent"
          : actionHint.tone === "done"
            ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300"
            : "border-line bg-sel text-ink-2";
  const hintActions = [
    ...(pendingApprovalCount > 0 ? [{ label: "处理", onClick: () => ws.setView({ kind: "inbox" }), disabled: false }] : []),
    ...((task.status === "review" || task.status === "done") && latestDoc && onOpenDoc
      ? [{ label: task.status === "review" ? "看交付物" : "看归档", onClick: () => onOpenDoc(latestDoc), disabled: false }]
      : []),
    ...(task.status === "review"
      ? [{ label: revising ? "退回中…" : "退回返工", onClick: () => void requestRevision(), disabled: revising }]
      : []),
  ];

  return (
    <div className="fixed inset-0 z-40">
      <button className="absolute inset-0 cursor-default bg-black/20" onClick={onClose} aria-label="关闭任务详情" />
      <aside className="absolute inset-y-0 right-0 flex w-[430px] max-w-[96vw] flex-col border-l border-line bg-paper shadow-2xl">
        <header className="border-b border-line px-4 py-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-1.5">
                <span className="rounded bg-sel px-1.5 py-px font-mono text-[10px] text-ink-3">{task.status}</span>
                {project && <span className="truncate rounded bg-accent-soft px-1.5 py-px text-[10.5px] text-ink-2">{project.title}</span>}
              </div>
              <h2 className="text-[15px] font-semibold leading-snug">{task.title}</h2>
            </div>
            <button onClick={onClose} className="rounded px-2 py-1 text-[13px] text-ink-3 hover:bg-sel hover:text-ink" title="关闭">
              ×
            </button>
          </div>
          {task.description && <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-2">{task.description}</p>}
          <div className={`mt-3 rounded-lg border px-3 py-2 ${hintToneClass}`}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-semibold">{actionHint.label}</div>
                <div className="mt-0.5 text-[11.5px] leading-relaxed opacity-85">{actionHint.body}</div>
              </div>
              {hintActions.length > 0 && (
                <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                  {hintActions.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      onClick={action.onClick}
                      disabled={action.disabled}
                      className="rounded-md bg-panel/80 px-2 py-1 text-[11.5px] font-medium text-ink-2 shadow-sm hover:bg-panel hover:text-ink disabled:opacity-40"
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
          <section>
            <h3 className="mb-2 text-[12px] font-semibold text-ink-2">责任链</h3>
            <div className="grid grid-cols-2 gap-2 text-[12px]">
              <label className="block">
                <span className="text-ink-3">负责人</span>
                <select
                  value={task.assignee_agent_id ?? ""}
                  onChange={(e) => void updateRole("assignee", e.target.value)}
                  disabled={!!savingRole || task.status === "done"}
                  className="mt-1 w-full rounded-md border border-line bg-panel px-2 py-1 text-[12px] outline-none hover:bg-sel disabled:opacity-50"
                  title="更换负责人会写入任务活动日志；未分配任务可由 AI 同事认领"
                >
                  <option value="">未分配</option>
                  {ws.agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.emoji} {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-ink-3">复核人</span>
                <select
                  value={task.reviewer_agent_id ?? ""}
                  onChange={(e) => void updateRole("reviewer", e.target.value)}
                  disabled={!!savingRole || task.status === "done"}
                  className="mt-1 w-full rounded-md border border-line bg-panel px-2 py-1 text-[12px] outline-none hover:bg-sel disabled:opacity-50"
                  title="显式复核人优先于系统自动路由，并写入任务活动日志"
                >
                  <option value="">自动选择</option>
                  {ws.agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.emoji} {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <div><span className="text-ink-3">创建者</span><div className="mt-0.5">{creator ? `${creator.emoji} ${creator.name}` : "用户"}</div></div>
              <div><span className="text-ink-3">返工次数</span><div className="mt-0.5">{task.revision_count}</div></div>
            </div>
            {savingRole && <div className="mt-1.5 text-[11px] text-ink-3">正在更新{savingRole === "assignee" ? "负责人" : "复核人"}…</div>}
          </section>

          {task.acceptance_criteria && (
            <section>
              <h3 className="mb-2 text-[12px] font-semibold text-ink-2">验收标准</h3>
              <div className="whitespace-pre-wrap rounded-md bg-sel px-3 py-2 text-[12px] leading-relaxed text-ink-2">{task.acceptance_criteria}</div>
            </section>
          )}

          {(task.acceptance_criteria || task.status === "review" || docs.length > 0) && (
            <section>
              <h3 className="mb-2 text-[12px] font-semibold text-ink-2">人工复核清单</h3>
              <div className="rounded-lg border border-line bg-panel">
                <div className="grid grid-cols-2 gap-0 border-b border-line text-[11.5px] text-ink-2">
                  <div className="border-r border-line px-3 py-2">
                    <span className="text-ink-3">交付物</span>
                    <div className={`mt-0.5 font-medium ${deliveryEvidence ? "text-emerald-600" : "text-amber-600"}`}>
                      {deliveryEvidence ? `${docs.length} 个可核对` : "未看到交付"}
                    </div>
                  </div>
                  <div className="px-3 py-2">
                    <span className="text-ink-3">自查表</span>
                    <div className={`mt-0.5 font-medium ${selfCheckEvidence ? "text-emerald-600" : "text-amber-600"}`}>
                      {selfCheckEvidence ? "已在交付物中出现" : "未检出，复核时重点检查"}
                    </div>
                  </div>
                  <div className="border-r border-t border-line px-3 py-2">
                    <span className="text-ink-3">复核事件</span>
                    <div className={`mt-0.5 font-medium ${verificationEvidence ? "text-emerald-600" : "text-ink-3"}`}>
                      {verificationEvidence ? "已有复核留痕" : "暂无复核留痕"}
                    </div>
                  </div>
                  <div className="border-t border-line px-3 py-2">
                    <span className="text-ink-3">审批/输入</span>
                    <div className={`mt-0.5 font-medium ${pendingApprovalCount > 0 ? "text-amber-600" : "text-emerald-600"}`}>
                      {pendingApprovalCount > 0 ? `${pendingApprovalCount} 个待处理` : "无待处理项"}
                    </div>
                  </div>
                </div>
                {acceptanceItems.length > 0 && (
                  <div className="px-3 py-2">
                    <div className="mb-1.5 text-[11px] font-medium text-ink-3">逐条核对</div>
                    <div className="space-y-1.5">
                      {acceptanceItems.map((item, idx) => (
                        <div key={`${idx}-${item}`} className="flex gap-2 text-[12px] leading-snug">
                          <span className="mt-0.5 h-4 min-w-4 rounded bg-sel text-center font-mono text-[10px] text-ink-3">{idx + 1}</span>
                          <span className="min-w-0 flex-1 text-ink-2">{item}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-2 text-[12px] font-semibold text-ink-2">成本</h3>
            <div className="rounded-lg border border-line bg-panel p-3 text-[12px]">
              {(hasUsage || hasEstimate) && (
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  {hasUsage && (
                    <div>
                      <span className="text-ink-3">累计消耗</span>{" "}
                      <span className="font-mono font-semibold text-ink" title="按 input + output + 缓存写×1.25 + 缓存读×0.1 取整的加权计费 token">
                        {fmtNum(billable)}
                      </span>{" "}
                      <span className="text-ink-3">billable</span>
                    </div>
                  )}
                  {hasEstimate && (
                    <div>
                      <span className="text-ink-3">开工预估</span>{" "}
                      <span className="font-mono text-ink-2">~{fmtNum(task.estimate_billable)}</span>
                      {hasUsage && (
                        <span className={`ml-1 ${billable > task.estimate_billable ? "text-amber-600" : "text-emerald-600"}`}>
                          （{billable > task.estimate_billable ? "超出" : "低于"} {fmtNum(Math.abs(billable - task.estimate_billable))}）
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
              {hasUsage && (
                <div className="mt-2 grid grid-cols-4 gap-1 text-center text-[10.5px] text-ink-3">
                  <span className="rounded bg-sel px-1 py-1" title="纯输入 token">输入 {fmtNum(usage.input_tokens)}</span>
                  <span className="rounded bg-sel px-1 py-1" title="输出 token">输出 {fmtNum(usage.output_tokens)}</span>
                  <span className="rounded bg-sel px-1 py-1" title="缓存读取 token（按 0.1 倍计费）">缓存读 {fmtNum(usage.cache_read_tokens)}</span>
                  <span className="rounded bg-sel px-1 py-1" title="缓存写入 token（按 1.25 倍计费）">缓存写 {fmtNum(usage.cache_creation_tokens)}</span>
                </div>
              )}
              <div className="mt-2.5 border-t border-line pt-2.5">
                {hasBudget && (
                  <>
                    <div className={`mb-1 flex items-center justify-between text-[11px] ${budgetTextTone}`}>
                      <span>预算 {fmtNum(billable)}/{fmtNum(task.budget_billable)}</span>
                      <span>{budgetPct}%</span>
                    </div>
                    <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-sel">
                      <div className={`h-full rounded-full ${budgetTone}`} style={{ width: `${Math.min(100, budgetPct)}%` }} />
                    </div>
                  </>
                )}
                <label className="flex items-center gap-1.5 text-[11px] text-ink-3">
                  设置预算（billable，0=不限）
                  <input
                    value={budgetInput}
                    onChange={(e) => setBudgetInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void saveBudget()}
                    inputMode="numeric"
                    placeholder="不限"
                    className="w-20 rounded-md border border-line bg-paper px-1.5 py-0.5 text-[11.5px] font-mono text-ink outline-none focus:border-accent/50"
                  />
                  <button
                    onClick={() => void saveBudget()}
                    disabled={savingBudget}
                    className="rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:bg-sel disabled:opacity-40"
                  >
                    {savingBudget ? "保存中…" : "保存"}
                  </button>
                </label>
              </div>
            </div>
          </section>

          {verdicts.length > 0 && (
            <section>
              <h3 className="mb-2 text-[12px] font-semibold text-ink-2">验收记录</h3>
              <div className="flex flex-col gap-1.5">
                {verdicts.map((v) => {
                  const expanded = expandedVerdicts[v.id];
                  return (
                    <div key={v.id} className="rounded-md bg-sel px-2.5 py-1.5 text-[12px]">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[10px] text-ink-3">第 {v.attempt + 1} 轮</span>
                        <span
                          className={`rounded px-1.5 py-px font-medium ${
                            v.result === "pass"
                              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
                              : "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300"
                          }`}
                        >
                          {v.result === "pass" ? "通过" : "退回返工"}
                        </span>
                        <span className="rounded bg-panel px-1.5 py-px font-mono text-[10px] text-ink-3">
                          {VERDICT_SOURCE_LABEL[v.source] ?? v.source}
                        </span>
                        <span className="ml-auto font-mono text-[10.5px] text-ink-3">{fmt(v.created_at)}</span>
                      </div>
                      {v.reasons && (
                        <button
                          onClick={() => setExpandedVerdicts((s) => ({ ...s, [v.id]: !s[v.id] }))}
                          className="mt-1 text-left text-[11px] text-ink-3 hover:text-ink"
                        >
                          {expanded ? "▾ 收起理由" : "▸ 展开理由"}
                        </button>
                      )}
                      {v.reasons && expanded && (
                        <div className="mt-1 whitespace-pre-wrap rounded bg-panel px-2 py-1.5 text-ink-2">{v.reasons}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <section className="grid grid-cols-2 gap-3">
            <div>
              <h3 className="mb-2 text-[12px] font-semibold text-ink-2">依赖</h3>
              {dependencies.length === 0 ? <div className="text-[12px] text-ink-3">无前置依赖</div> : dependencies.map((d) => (
                <button
                  key={d.id}
                  onClick={() => onOpenTask?.(d)}
                  className="mb-1 block w-full rounded-md bg-sel px-2 py-1 text-left text-[12px] hover:text-accent"
                  title="打开前置任务"
                >
                  <span className="font-mono text-[10px] text-ink-3">[{d.status}]</span> {d.title}
                </button>
              ))}
              {dependents.length > 0 && (
                <div className="mt-2">
                  <div className="mb-1 text-[11px] font-medium text-ink-3">后续</div>
                  {dependents.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => onOpenTask?.(d)}
                      className="mb-1 block w-full rounded-md bg-accent-soft px-2 py-1 text-left text-[12px] hover:text-accent"
                      title="打开后续任务"
                    >
                      <span className="font-mono text-[10px] text-ink-3">[{d.status}]</span> {d.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-[12px] font-semibold text-ink-2">来源</h3>
              {sourceDocs.length === 0 ? <div className="text-[12px] text-ink-3">未绑定来源文档</div> : sourceDocs.map((d) => (
                <button key={d.id} onClick={() => onOpenDoc?.(d)} className="mb-1 block w-full rounded-md bg-sel px-2 py-1 text-left text-[12px] hover:text-accent">{d.title}</button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-[12px] font-semibold text-ink-2">交付物</h3>
            {docs.length === 0 ? <div className="text-[12px] text-ink-3">尚未交付</div> : docs.map((d) => (
              <button key={d.id} onClick={() => onOpenDoc?.(d)} className="mb-1 flex w-full items-center justify-between rounded-md bg-accent-soft px-2 py-1.5 text-left text-[12px] hover:text-accent">
                <span className="truncate">{d.title}</span>
                <span className="ml-2 shrink-0 font-mono text-[10px] text-ink-3">v{d.version}</span>
              </button>
            ))}
          </section>

          {approvals.length > 0 && (
            <section>
              <h3 className="mb-2 text-[12px] font-semibold text-ink-2">审批与输入</h3>
              {approvals.map((a) => {
                const clarification = a.kind === "clarification" ? parseClarificationPayload(a.payload) : null;
                const responseValue = approvalResponses[a.id] ?? clarification?.proposedDefault ?? "";
                return (
                <div key={a.id} className="mb-2 rounded-md bg-sel px-3 py-2 text-[12px]">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-panel px-1.5 py-px font-mono text-[10px] text-ink-3">{approvalKindLabel(a.kind)}</span>
                    <span className="min-w-0 flex-1 font-medium">{a.title}</span>
                    <span className={`ml-auto shrink-0 rounded px-1.5 py-px font-mono text-[10px] ${
                      a.status === "pending" ? "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300" : "bg-panel text-ink-3"
                    }`}>
                      {a.status}
                    </span>
                  </div>
                  <div className="mt-1 whitespace-pre-wrap text-ink-3">{approvalQuestion(a)}</div>
                  {a.status === "pending" && a.kind === "clarification" && (
                    <label className="mt-2 block text-[11px] font-medium text-ink-2">
                      给 AI 同事的具体输入
                      <textarea
                        value={responseValue}
                        onChange={(ev) => setApprovalResponses((prev) => ({ ...prev, [a.id]: ev.target.value }))}
                        className="mt-1 min-h-20 w-full resize-y rounded-md border border-line bg-panel px-2 py-1.5 text-[12px] font-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
                        placeholder="写下选择、约束、口径或授权范围；留空会采用建议默认。"
                      />
                    </label>
                  )}
                  {a.status === "pending" && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        onClick={() => void resolveTaskApproval(a, true, a.kind === "clarification" ? responseValue : undefined)}
                        disabled={!!resolvingApprovalId}
                        className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-40"
                        title={a.kind === "clarification" ? "确认后任务会恢复执行" : "批准该请求"}
                      >
                        {resolvingApprovalId === a.id ? "处理中…" : a.kind === "clarification" ? "确认并恢复" : "批准"}
                      </button>
                      <button
                        onClick={() => void resolveTaskApproval(a, false)}
                        disabled={!!resolvingApprovalId}
                        className="rounded-md border border-line bg-panel px-2.5 py-1 text-[12px] font-medium text-ink-2 hover:bg-sel disabled:opacity-40"
                        title={a.kind === "clarification" ? "任务保持阻塞，等待后续输入" : "拒绝该请求"}
                      >
                        {a.kind === "clarification" ? "保持阻塞" : "拒绝"}
                      </button>
                    </div>
                  )}
                </div>
                );
              })}
            </section>
          )}

          <section>
            <h3 className="mb-2 text-[12px] font-semibold text-ink-2">最近工具</h3>
            {tools.length === 0 ? <div className="text-[12px] text-ink-3">暂无工具记录</div> : tools.map((e) => (
              <div key={e.id} className="mb-1 rounded-md bg-sel px-2 py-1 font-mono text-[11px] text-ink-3">{fmt(e.created_at)} · {e.summary}</div>
            ))}
          </section>

          <section>
            <h3 className="mb-2 text-[12px] font-semibold text-ink-2">活动日志</h3>
            {events.length === 0 ? <div className="text-[12px] text-ink-3">暂无活动</div> : events.map((e) => (
              <div key={e.id} className="relative border-l border-line pb-3 pl-3 last:pb-0">
                <span className="absolute -left-[3px] top-1 h-1.5 w-1.5 rounded-full bg-accent" />
                <div className="flex items-center gap-2 text-[11px] text-ink-3">
                  <span>{fmt(e.created_at)}</span>
                  <span className="rounded bg-sel px-1.5 py-px font-mono text-[10px]">{EVENT_LABEL[e.type]}</span>
                </div>
                <div className="mt-0.5 text-[12.5px] leading-snug">{e.summary}</div>
              </div>
            ))}
          </section>
        </div>

        <footer className="flex items-center gap-2 border-t border-line px-4 py-3">
          {pendingApprovalCount > 0 && (
            <button
              onClick={() => ws.setView({ kind: "inbox" })}
              className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-[13px] font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300"
              title="打开收件箱处理该任务相关审批或输入"
            >
              处理输入 {pendingApprovalCount}
            </button>
          )}
          {task.status === "review" && (
            <button
              onClick={requestRevision}
              disabled={revising}
              className="rounded-lg border border-line px-3 py-1.5 text-[13px] font-medium text-ink-2 hover:bg-sel disabled:opacity-40"
              title="退回给负责人修订，并记录复核事件"
            >
              {revising ? "退回中…" : "退回返工"}
            </button>
          )}
          <button
            onClick={closeTask}
            disabled={closeDisabled}
            className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
            title={pendingApprovalCount > 0 ? "先处理该任务的审批或输入，再关闭任务" : "关单是 human-only 操作"}
          >
            {task.status === "done" ? "已关闭" : closing ? "关闭中…" : "确认关闭任务"}
          </button>
          <button onClick={onClose} className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink-2 hover:bg-sel">
            返回
          </button>
        </footer>
      </aside>
    </div>
  );
}

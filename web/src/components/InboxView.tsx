import { Suspense, lazy, useEffect, useState } from "react";
import { useWorkspace } from "../store";
import { AgentAvatar } from "./Avatar";
import type { Approval, Doc, Task } from "../types";
import { TaskDetailDrawer } from "./TaskDetailDrawer";
import { parseNetworkApprovalPayload } from "../lib/approvals";

const DocViewerModal = lazy(() => import("./DocsView").then((m) => ({ default: m.DocViewerModal })));

function fmt(ts: number) {
  const d = new Date(ts);
  return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
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

function ApprovalPayload({ approval }: { approval: Approval }) {
  if (!approval.payload) return null;
  if (approval.kind === "clarification") {
    const parsed = parseClarificationPayload(approval.payload);
    if (parsed) {
      return (
        <div className="mt-2 rounded-lg bg-sel p-3 text-[13px] text-ink-2">
          {parsed.question && (
            <div>
              <div className="text-[11px] font-medium text-ink-3">需要你确认</div>
              <div className="mt-0.5 whitespace-pre-wrap">{parsed.question}</div>
            </div>
          )}
          {parsed.context && (
            <div className="mt-2">
              <div className="text-[11px] font-medium text-ink-3">阻塞原因</div>
              <div className="mt-0.5 whitespace-pre-wrap">{parsed.context}</div>
            </div>
          )}
          {parsed.proposedDefault && (
            <div className="mt-2 rounded-md bg-panel px-2 py-1.5">
              <span className="text-[11px] font-medium text-ink-3">建议默认：</span>
              <span className="whitespace-pre-wrap">{parsed.proposedDefault}</span>
            </div>
          )}
          {parsed.userResponse && (
            <div className="mt-2 rounded-md bg-panel px-2 py-1.5">
              <span className="text-[11px] font-medium text-ink-3">你的输入：</span>
              <span className="whitespace-pre-wrap">{parsed.userResponse}</span>
            </div>
          )}
        </div>
      );
    }
  }
  if (approval.kind === "network") {
    const parsed = parseNetworkApprovalPayload(approval.payload);
    if (parsed) {
      return (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-[13px] text-ink-2 dark:border-amber-900/60 dark:bg-amber-950/20">
          <div className="text-[11px] font-semibold text-amber-800 dark:text-amber-300">一次性网络外发</div>
          {parsed.details && <div className="mt-1 whitespace-pre-wrap">{parsed.details}</div>}
          <dl className="mt-2 grid gap-1.5">
            <div>
              <dt className="inline text-[11px] font-medium text-ink-3">目标：</dt>
              <dd className="inline">
                {parsed.serverName} <span className="font-mono text-[11.5px]">({parsed.serverTarget})</span>
              </dd>
            </div>
            <div>
              <dt className="inline text-[11px] font-medium text-ink-3">工具：</dt>
              <dd className="inline font-mono text-[11.5px]">{parsed.tool}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium text-ink-3">完整参数：</dt>
              <dd>
                <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap wrap-anywhere rounded-md bg-panel px-2 py-1.5 font-mono text-[11.5px]">
                  {JSON.stringify(parsed.input, null, 2)}
                </pre>
              </dd>
            </div>
          </dl>
          <div className="mt-2 text-[11.5px] text-amber-800 dark:text-amber-300">
            仅允许以上目标配置、工具和参数执行一次；修改任一项都必须重新审批。
          </div>
        </div>
      );
    }
  }
  return (
    <pre className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg bg-sel p-3 text-[13px] text-ink-2">
      {approval.payload}
    </pre>
  );
}

export function InboxView({
  focusApprovalId,
  onFocusConsumed,
}: {
  focusApprovalId?: string | null;
  onFocusConsumed?: () => void;
}) {
  const ws = useWorkspace();
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [openDoc, setOpenDoc] = useState<Doc | null>(null);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [resolvingId, setResolvingId] = useState("");
  const byFocus = (a: { id: string }, b: { id: string }) => Number(b.id === focusApprovalId) - Number(a.id === focusApprovalId);
  const pending = ws.approvals.filter((a) => a.status === "pending").sort(byFocus);
  const resolved = ws.approvals.filter((a) => a.status !== "pending").sort(byFocus);
  useEffect(() => {
    if (focusApprovalId && ws.approvals.some((a) => a.id === focusApprovalId)) onFocusConsumed?.();
  }, [focusApprovalId, onFocusConsumed, ws.approvals]);

  async function resolveInboxApproval(approval: Approval, approve: boolean, response?: string) {
    if (resolvingId) return;
    setResolvingId(approval.id);
    try {
      await ws.resolveApproval(approval.id, approve, response);
      if (approval.ref_id) {
        await ws.refreshWorkspace();
        const linkedTask = ws.tasks.find((t) => t.id === approval.ref_id);
        if (linkedTask) setOpenTask(linkedTask);
      }
    } finally {
      setResolvingId("");
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3">
        <h1 className="text-[15px] font-semibold">收件箱</h1>
        <span className="text-[12px] text-ink-3">高风险动作、单次网络调用、项目计划和任务阻塞输入在这里等待你处理</span>
      </header>
      <div className="flex-1 overflow-y-auto p-5">
        {pending.length === 0 && (
          <div className="py-10 text-center text-[13px] text-ink-3">没有待处理的审批请求。</div>
        )}
        <div className="mx-auto flex max-w-2xl flex-col gap-3">
          {pending.map((a) => {
            const agent = ws.agentById(a.agent_id);
            const linkedTask = a.ref_id ? ws.tasks.find((t) => t.id === a.ref_id) : undefined;
            const clarification = a.kind === "clarification" ? parseClarificationPayload(a.payload) : null;
            const responseValue = responses[a.id] ?? clarification?.proposedDefault ?? "";
            return (
              <div
                key={a.id}
                className={`rounded-xl border bg-panel p-4 shadow-sm ${a.id === focusApprovalId ? "border-accent ring-2 ring-accent/20" : "border-line"}`}
              >
                <div className="flex items-center gap-2">
                  <AgentAvatar agent={agent} size={24} />
                  <span className="text-[13.5px] font-semibold">{agent?.name ?? "AI"}</span>
                  {a.kind === "plan" && (
                    <span className="rounded bg-accent-soft px-1.5 py-px text-[11px] font-medium text-ink-2">
                      🧩 项目计划
                    </span>
                  )}
                  {a.kind === "clarification" && (
                    <span className="rounded bg-sel px-1.5 py-px text-[11px] font-medium text-ink-2">
                      ⏸ 需要输入
                    </span>
                  )}
                  {a.kind === "network" && (
                    <span className="rounded bg-amber-50 px-1.5 py-px text-[11px] font-medium text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                      🌐 单次外发
                    </span>
                  )}
                  <span className="text-[12px] text-ink-3">
                    {a.kind === "plan"
                      ? "批准后自动开工"
                      : a.kind === "clarification"
                        ? "确认后恢复任务"
                        : a.kind === "network"
                          ? "批准后仅执行列明调用一次"
                          : "请求批准"} · {fmt(a.created_at)}
                  </span>
                </div>
                <div className="mt-2 text-[14px] font-medium">{a.title}</div>
                <ApprovalPayload approval={a} />
                {a.kind === "clarification" && (
                  <label className="mt-3 block text-[12px] font-medium text-ink-2">
                    给 AI 同事的具体输入
                    <textarea
                      value={responseValue}
                      onChange={(ev) => setResponses((prev) => ({ ...prev, [a.id]: ev.target.value }))}
                      className="mt-1 min-h-24 w-full resize-y rounded-lg border border-line bg-paper px-3 py-2 text-[13px] font-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
                      placeholder="写下选择、约束、口径或授权范围；留空会采用建议默认。"
                    />
                  </label>
                )}
                {linkedTask && (
                  <button
                    type="button"
                    onClick={() => setOpenTask(linkedTask)}
                    className="mt-2 flex w-full items-center justify-between rounded-lg border border-line bg-paper px-3 py-2 text-left text-[12.5px] hover:border-accent/50 hover:bg-sel"
                    title="打开关联任务，查看责任链、审批、交付物和活动日志"
                  >
                    <span className="min-w-0 truncate">关联任务：{linkedTask.title}</span>
                    <span className="ml-2 shrink-0 rounded bg-sel px-1.5 py-px font-mono text-[10px] text-ink-3">{linkedTask.status}</span>
                  </button>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => void resolveInboxApproval(a, true, a.kind === "clarification" ? responseValue : undefined)}
                    disabled={!!resolvingId}
                    className="rounded-lg bg-accent px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
                  >
                    {resolvingId === a.id
                      ? "处理中…"
                      : a.kind === "clarification"
                        ? "确认并恢复"
                        : a.kind === "network"
                          ? "批准一次并恢复"
                          : "批准"}
                  </button>
                  <button
                    onClick={() => void resolveInboxApproval(a, false)}
                    disabled={!!resolvingId}
                    className="rounded-lg border border-line px-4 py-1.5 text-[13px] font-medium text-ink-2 hover:bg-sel disabled:opacity-40"
                  >
                    {resolvingId === a.id
                      ? "处理中…"
                      : a.kind === "clarification" || a.kind === "network"
                        ? "拒绝并保持阻塞"
                        : "拒绝"}
                  </button>
                  {linkedTask && (
                    <button
                      type="button"
                      onClick={() => setOpenTask(linkedTask)}
                      className="rounded-lg border border-line px-4 py-1.5 text-[13px] font-medium text-ink-2 hover:bg-sel"
                    >
                      查看任务详情
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {resolved.length > 0 && (
            <>
              <div className="mt-4 text-[12px] font-medium text-ink-3">已处理</div>
              {resolved.map((a) => {
                const agent = ws.agentById(a.agent_id);
                const linkedTask = a.ref_id ? ws.tasks.find((t) => t.id === a.ref_id) : undefined;
                return (
                  <div
                    key={a.id}
                    className={`rounded-xl border bg-sel/50 p-3 opacity-70 ${a.id === focusApprovalId ? "border-accent ring-2 ring-accent/20" : "border-line"}`}
                  >
                    <div className="flex items-center gap-2 text-[13px]">
                      <span>{a.status === "approved" ? "✅" : "❌"}</span>
                      <span className="font-medium">{a.title}</span>
                      <span className="ml-auto text-[12px] text-ink-3">
                        {agent?.name} · {a.resolved_at ? fmt(a.resolved_at) : ""}
                      </span>
                      {linkedTask && (
                        <button
                          type="button"
                          onClick={() => setOpenTask(linkedTask)}
                          className="rounded border border-line px-2 py-0.5 text-[11.5px] text-ink-2 hover:bg-panel"
                        >
                          任务
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
      {openDoc && (
        <Suspense fallback={null}>
          <DocViewerModal doc={openDoc} onClose={() => setOpenDoc(null)} />
        </Suspense>
      )}
      {openTask && (
        <TaskDetailDrawer
          task={ws.tasks.find((t) => t.id === openTask.id) ?? openTask}
          onClose={() => setOpenTask(null)}
          onOpenDoc={setOpenDoc}
          onOpenTask={setOpenTask}
        />
      )}
    </div>
  );
}

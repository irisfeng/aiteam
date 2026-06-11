import { useWorkspace } from "../store";
import { AgentAvatar } from "./Avatar";

function fmt(ts: number) {
  const d = new Date(ts);
  return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function InboxView() {
  const ws = useWorkspace();
  const pending = ws.approvals.filter((a) => a.status === "pending");
  const resolved = ws.approvals.filter((a) => a.status !== "pending");

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3">
        <h1 className="text-[15px] font-semibold">收件箱</h1>
        <span className="text-[12px] text-ink-3">AI 同事的高风险动作在这里等待你的批准 — 批准是 human-only 操作</span>
      </header>
      <div className="flex-1 overflow-y-auto p-5">
        {pending.length === 0 && (
          <div className="py-10 text-center text-[13px] text-ink-3">没有待处理的审批请求。</div>
        )}
        <div className="mx-auto flex max-w-2xl flex-col gap-3">
          {pending.map((a) => {
            const agent = ws.agentById(a.agent_id);
            return (
              <div key={a.id} className="rounded-xl border border-line bg-white p-4 shadow-sm">
                <div className="flex items-center gap-2">
                  <AgentAvatar agent={agent} size={24} />
                  <span className="text-[13.5px] font-semibold">{agent?.name ?? "AI"}</span>
                  {a.kind === "plan" && (
                    <span className="rounded bg-accent-soft px-1.5 py-px text-[11px] font-medium text-ink-2">
                      🧩 项目计划
                    </span>
                  )}
                  <span className="text-[12px] text-ink-3">
                    {a.kind === "plan" ? "批准后自动开工" : "请求批准"} · {fmt(a.created_at)}
                  </span>
                </div>
                <div className="mt-2 text-[14px] font-medium">{a.title}</div>
                {a.payload && (
                  <pre className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg bg-panel p-3 text-[13px] text-ink-2">
                    {a.payload}
                  </pre>
                )}
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => void ws.resolveApproval(a.id, true)}
                    className="rounded-lg bg-accent px-4 py-1.5 text-[13px] font-medium text-white"
                  >
                    批准
                  </button>
                  <button
                    onClick={() => void ws.resolveApproval(a.id, false)}
                    className="rounded-lg border border-line px-4 py-1.5 text-[13px] font-medium text-ink-2 hover:bg-panel"
                  >
                    拒绝
                  </button>
                </div>
              </div>
            );
          })}

          {resolved.length > 0 && (
            <>
              <div className="mt-4 text-[12px] font-medium text-ink-3">已处理</div>
              {resolved.map((a) => {
                const agent = ws.agentById(a.agent_id);
                return (
                  <div key={a.id} className="rounded-xl border border-line bg-panel/60 p-3 opacity-70">
                    <div className="flex items-center gap-2 text-[13px]">
                      <span>{a.status === "approved" ? "✅" : "❌"}</span>
                      <span className="font-medium">{a.title}</span>
                      <span className="ml-auto text-[12px] text-ink-3">
                        {agent?.name} · {a.resolved_at ? fmt(a.resolved_at) : ""}
                      </span>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

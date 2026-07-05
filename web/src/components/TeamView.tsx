import { useEffect, useState } from "react";
import { useWorkspace } from "../store";
import { api, API_BASE } from "../api";
import type { QualitySummary } from "../types";
import { AgentAvatar } from "./Avatar";

interface Member {
  agent_id: string;
  state: "working" | "idle";
  current_task: { id: string; title: string } | null;
  queued: number;
  delivered_today: number;
  tokens_today: { input: number; output: number };
}
interface Routine {
  id: string;
  channel_id: string;
  agent_id: string;
  time: string;
  instruction: string;
}

type TeamTab = "members" | "quality";

const SOURCE_LABEL: Record<string, string> = {
  auto: "机器验收",
  solo: "自检",
  fallback: "兜底",
  human: "人工退回",
};

function fmtWhen(ts: number) {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 质量面板（D1 质量闭环落表）：一次通过率、验收覆盖率、近期返工原因。 */
function QualityPanel({ onOpenTask }: { onOpenTask?: (taskId: string) => void }) {
  const ws = useWorkspace();
  const [summary, setSummary] = useState<QualitySummary | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.quality().then((d) => alive && setSummary(d)).catch(() => undefined);
    load();
    const timer = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (!summary) return <div className="py-6 text-center text-[12.5px] text-ink-3">加载中…</div>;

  const coveragePct = summary.coverage.delivered > 0 ? Math.round((summary.coverage.verified / summary.coverage.delivered) * 100) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="rounded-xl border border-line bg-panel p-4 shadow-sm">
        <div className="mb-1 text-[13px] font-semibold">验收覆盖率</div>
        <div className="mb-2 text-[11.5px] text-ink-3">已交付任务中经过机器验收的占比</div>
        {summary.coverage.delivered === 0 ? (
          <div className="text-[12.5px] text-ink-3">还没有已交付任务</div>
        ) : (
          <>
            <div className="mb-1 flex items-center gap-2 text-[12px]">
              <span className="font-mono font-semibold text-ink">{coveragePct}%</span>
              <span className="text-ink-3">
                {summary.coverage.verified}/{summary.coverage.delivered} 已交付任务
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-sel">
              <div className="h-full rounded-full bg-accent" style={{ width: `${coveragePct}%` }} />
            </div>
          </>
        )}
      </div>

      <div className="rounded-xl border border-line bg-panel p-4 shadow-sm">
        <div className="mb-2 text-[13px] font-semibold">同事质量</div>
        {summary.agents.length === 0 ? (
          <div className="text-[12.5px] text-ink-3">还没有验收裁决记录</div>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-ink-3">
                <th className="py-1 pr-3 font-medium">同事</th>
                <th className="py-1 pr-3 text-right font-medium">参与任务</th>
                <th className="py-1 pr-3 text-right font-medium">一次通过率</th>
                <th className="py-1 text-right font-medium">返工次数</th>
              </tr>
            </thead>
            <tbody>
              {summary.agents.map((row) => {
                const agent = ws.agentById(row.agent_id);
                const rate = row.tasks > 0 ? `${Math.round((row.first_pass / row.tasks) * 100)}%` : "—";
                return (
                  <tr key={row.agent_id} className="border-t border-line/60">
                    <td className="whitespace-nowrap py-1.5 pr-3">{agent ? `${agent.emoji} ${agent.name}` : row.agent_id}</td>
                    <td className="py-1.5 pr-3 text-right font-mono text-[11px]">{row.tasks}</td>
                    <td className="py-1.5 pr-3 text-right font-mono text-[11px]">{rate}</td>
                    <td className="py-1.5 text-right font-mono text-[11px]">{row.revises}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-xl border border-line bg-panel p-4 shadow-sm">
        <div className="mb-2 text-[13px] font-semibold">近期返工原因</div>
        {summary.recent_revises.length === 0 ? (
          <div className="text-[12.5px] text-ink-3">还没有返工记录</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {summary.recent_revises.map((r, i) => (
              <button
                key={`${r.task_id}-${i}`}
                onClick={() => onOpenTask?.(r.task_id)}
                disabled={!onOpenTask}
                className="rounded-md bg-sel px-2.5 py-1.5 text-left text-[12px] hover:text-accent disabled:cursor-default disabled:hover:text-inherit"
                title={onOpenTask ? "打开任务详情" : undefined}
              >
                <div className="mb-0.5 flex items-center gap-2 text-[11px] text-ink-3">
                  <span className="font-mono">{fmtWhen(r.created_at)}</span>
                  <span className="rounded bg-panel px-1.5 py-px font-mono text-[10px]">{SOURCE_LABEL[r.source] ?? r.source}</span>
                </div>
                <div className="line-clamp-2 text-ink-2">{r.reasons || "（未记录理由）"}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function TeamView({
  onOpenProfile,
  onOpenTask,
}: {
  onOpenProfile: (a: import("../types").Agent) => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const ws = useWorkspace();
  const [members, setMembers] = useState<Member[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [tab, setTab] = useState<TeamTab>("members");

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${API_BASE}/team`)
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return;
          setMembers(d.members ?? []);
          setRoutines(d.routines ?? []);
        })
        .catch(() => undefined);
    load();
    const timer = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  async function removeRoutine(id: string) {
    await fetch(`${API_BASE}/routines/${id}`, { method: "DELETE" });
    setRoutines((rs) => rs.filter((r) => r.id !== id));
  }

  const tabBtn = (key: TeamTab, label: string) => (
    <button
      onClick={() => setTab(key)}
      className={`rounded-lg px-3 py-1 text-[13px] ${tab === key ? "bg-sel font-medium text-ink" : "text-ink-2 hover:bg-sel/60"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3">
        <h1 className="text-[15px] font-semibold">团队</h1>
        <span className="text-[12px] text-ink-3">每位 AI 同事此刻在忙什么、今天交付了多少</span>
        <div className="ml-auto flex gap-1">
          {tabBtn("members", "同事")}
          {tabBtn("quality", "质量")}
        </div>
      </header>
      {tab === "quality" ? (
        <div className="flex-1 overflow-y-auto p-5">
          <QualityPanel onOpenTask={onOpenTask} />
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto grid max-w-3xl grid-cols-2 gap-3">
          {members.map((m) => {
            const agent = ws.agentById(m.agent_id);
            if (!agent) return null;
            const working = m.state === "working";
            return (
              <div
                key={m.agent_id}
                onClick={() => onOpenProfile(agent)}
                className="cursor-pointer rounded-xl border border-line bg-panel p-4 shadow-sm transition-colors hover:border-accent/40"
                title="点击查看档案（身份/模型/记忆）"
              >
                <div className="flex items-center gap-2.5">
                  <AgentAvatar agent={agent} size={36} state={working ? "thinking" : "idle"} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[14px] font-semibold">{agent.name}</span>
                      <span
                        className={`h-2 w-2 rounded-full ${working ? "bg-accent" : "bg-green-500"}`}
                        title={working ? "工作中" : "空闲"}
                      />
                    </div>
                    <div className="truncate text-[12px] text-ink-3">{agent.role}</div>
                    <span
                      className="mt-0.5 inline-block max-w-full truncate rounded border border-line bg-sel px-1 font-mono text-[10px] leading-4 text-ink-2"
                      title={agent.provider_id ? "自定义供应商通道" : "官方/工作区默认通道"}
                    >
                      {agent.model}
                    </span>
                  </div>
                </div>
                <div className="mt-3 text-[12.5px]">
                  {working && m.current_task ? (
                    <div className="rounded-lg bg-accent-soft px-2.5 py-1.5 text-ink-2">
                      🔨 正在做：<span className="font-medium">{m.current_task.title}</span>
                      {m.queued > 0 && <span className="text-ink-3">（队列还有 {m.queued} 个）</span>}
                    </div>
                  ) : (
                    <div className="rounded-lg bg-sel px-2.5 py-1.5 text-ink-3">☕ 空闲中，可以指派任务</div>
                  )}
                </div>
                <div className="mt-2.5 flex gap-4 text-[12px] text-ink-2">
                  <span>
                    今日交付 <span className="font-mono font-semibold text-ink">{m.delivered_today}</span>
                  </span>
                  <span>
                    今日用量{" "}
                    <span className="font-mono font-semibold text-ink">
                      {(m.tokens_today.input + m.tokens_today.output).toLocaleString()}
                    </span>{" "}
                    tokens
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mx-auto mt-6 max-w-3xl">
          <div className="mb-2 text-[13px] font-semibold">例行任务</div>
          {routines.length === 0 ? (
            <div className="rounded-xl border border-line bg-sel/50 p-4 text-[12.5px] text-ink-3">
              还没有例行任务。在频道里告诉某位同事，例如：“@产品经理 以后每天 09:30 在这里发一份昨日进展与今日计划的站会汇总”。
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {routines.map((r) => {
                const agent = ws.agentById(r.agent_id);
                return (
                  <div key={r.id} className="flex items-center gap-3 rounded-xl border border-line bg-panel p-3 text-[13px]">
                    <span className="rounded bg-sel px-2 py-0.5 font-mono text-[12px]">{r.time}</span>
                    <span>{agent?.emoji} {agent?.name}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-2" title={r.instruction}>
                      {r.instruction}
                    </span>
                    <button
                      onClick={() => void removeRoutine(r.id)}
                      className="rounded px-1.5 text-ink-3 hover:bg-sel hover:text-ink"
                      title="删除例行任务"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

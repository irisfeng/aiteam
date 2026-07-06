import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../store";
import { api, API_BASE, billableTokens, parseTaskUsage } from "../api";
import type { Agent, Project, Task, TaskEvent, Verdict } from "../types";
import { AgentAvatar, memberColor } from "./Avatar";
import { TaskDetailDrawer } from "./TaskDetailDrawer";

// 「剧场」：Decision Theatre 风格的观察舱——不是新的操作台，只是把已有 tasks/projects/agents
// 数据换一种「活地图」的方式看。所有写操作仍走 TaskDetailDrawer / 其它既有视图。

interface TeamMember {
  agent_id: string;
  state: "working" | "idle";
  current_task: { id: string; title: string } | null;
  queued: number;
  delivered_today: number;
  tokens_today: { input: number; output: number };
}

const STATUS_LABEL: Record<Task["status"], string> = {
  todo: "待办",
  doing: "进行中",
  review: "待复核",
  blocked: "阻塞",
  done: "已完成",
};

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function isAgentWorking(agentId: string, members: TeamMember[], liveWorkingIds: Set<string>): boolean {
  if (liveWorkingIds.has(agentId)) return true;
  return members.find((m) => m.agent_id === agentId)?.state === "working";
}

function statusVisual(status: Task["status"]) {
  switch (status) {
    case "todo":
      return { icon: "○", border: "border-line border-dashed", bg: "bg-panel/50" };
    case "doing":
      return { icon: "⚙", border: "border-accent", bg: "bg-accent-soft/60" };
    case "review":
      return { icon: "◎", border: "border-amber-400/80", bg: "bg-amber-50/60 dark:bg-amber-950/15" };
    case "blocked":
      return { icon: "⛔", border: "border-red-400/80", bg: "bg-red-50/60 dark:bg-red-950/15" };
    case "done":
      return { icon: "✓", border: "border-emerald-400/80", bg: "bg-emerald-50/60 dark:bg-emerald-950/15" };
  }
}

/** ✓=已有交付/验收留痕、○=阻塞或失败、◐=进行中的中间态；仅用于剧场节点迷你面板的快速视觉扫读 */
function eventGlyph(type: TaskEvent["type"]): string {
  if (type === "delivery" || type === "verification" || type === "user_close") return "✓";
  if (type === "blocked" || type === "failure") return "○";
  return "◐";
}

/** 简化版验收标准拆条，口径与 TaskDetailDrawer 一致，只用于节点迷你展开面板的前两条摘要 */
function splitAcceptance(raw: string): string[] {
  return raw
    .split(/\n|；|;|。/)
    .map((item) => item.replace(/^[-*•\d.、)\s]+/, "").trim())
    .filter(Boolean);
}

function parseDepIds(raw: string): string[] {
  try {
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

// ---- 决策树活地图布局：按依赖深度分层横向排列，每列一层，列内竖排 ----
const CARD_W = 208;
const CARD_H = 92;
const COL_GAP = 72;
const ROW_GAP = 28;
const PAD = 28;
const COL_PITCH = CARD_W + COL_GAP;
const ROW_PITCH = CARD_H + ROW_GAP;

interface DagNode {
  task: Task;
  x: number;
  y: number;
}
interface DagEdge {
  from: Task;
  to: Task;
}
interface DagLayout {
  nodes: DagNode[];
  edges: DagEdge[];
  posById: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

/** 无前置依赖 = 第 0 列；出现依赖环时按 0 层兜底渲染，不阻塞画布。 */
function layoutDag(tasks: Task[]): DagLayout {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depsOf = (t: Task) => parseDepIds(t.depends_on).filter((id) => byId.has(id));
  const depthCache = new Map<string, number>();
  const visiting = new Set<string>();
  function depth(id: string): number {
    if (depthCache.has(id)) return depthCache.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const t = byId.get(id);
    const deps = t ? depsOf(t) : [];
    const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(depth));
    visiting.delete(id);
    depthCache.set(id, d);
    return d;
  }

  const columns = new Map<number, Task[]>();
  for (const t of tasks) {
    const d = depth(t.id);
    const list = columns.get(d);
    if (list) list.push(t);
    else columns.set(d, [t]);
  }
  for (const list of columns.values()) list.sort((a, b) => a.created_at - b.created_at);

  const sortedCols = [...columns.keys()].sort((a, b) => a - b);
  const nodes: DagNode[] = [];
  const posById = new Map<string, { x: number; y: number }>();
  sortedCols.forEach((colIdx, ci) => {
    const list = columns.get(colIdx)!;
    list.forEach((t, ri) => {
      const pos = { x: PAD + ci * COL_PITCH, y: PAD + ri * ROW_PITCH };
      nodes.push({ task: t, ...pos });
      posById.set(t.id, pos);
    });
  });

  const edges: DagEdge[] = [];
  for (const t of tasks) {
    for (const depId of depsOf(t)) {
      const dep = byId.get(depId);
      if (dep) edges.push({ from: dep, to: t });
    }
  }

  const maxRows = sortedCols.length > 0 ? Math.max(...sortedCols.map((c) => columns.get(c)!.length)) : 0;
  const width = PAD * 2 + Math.max(1, sortedCols.length) * COL_PITCH - COL_GAP;
  const height = PAD * 2 + Math.max(1, maxRows) * ROW_PITCH - ROW_GAP;
  return { nodes, edges, posById, width, height };
}

// ---- 世界事件横幅：WS task:event 到达时排队播报，交付/验收通过=FORTUNE，验收退回/阻塞/失败=OMEN ----
interface BannerItem {
  id: string;
  tone: "fortune" | "omen";
  tag: string;
  text: string;
}

function toBannerItem(e: TaskEvent): BannerItem | null {
  let meta: Record<string, unknown> = {};
  try {
    meta = e.metadata_json ? JSON.parse(e.metadata_json) : {};
  } catch {
    /* 忽略损坏的 metadata，按无结果处理 */
  }
  if (e.type === "delivery") return { id: e.id, tone: "fortune", tag: "交付", text: e.summary };
  if (e.type === "verification") {
    if (meta.result === "pass") return { id: e.id, tone: "fortune", tag: "验收", text: e.summary };
    if (meta.result === "revise" || meta.result === "gap") return { id: e.id, tone: "omen", tag: "验收", text: e.summary };
    return null; // 指定复核人等非裁决类 verification 子事件不弹幕
  }
  if (e.type === "blocked") return { id: e.id, tone: "omen", tag: "受阻", text: e.summary };
  if (e.type === "failure") return { id: e.id, tone: "omen", tag: "受阻", text: e.summary };
  return null;
}

function EventBanner({ item }: { item: BannerItem }) {
  const fortune = item.tone === "fortune";
  return (
    <div
      className={`theatre-banner pointer-events-none absolute inset-x-0 top-2 z-20 mx-auto flex max-w-md items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] shadow-lg backdrop-blur-sm ${
        fortune
          ? "border-emerald-300/70 bg-emerald-50/95 text-emerald-800 dark:border-emerald-800/70 dark:bg-emerald-950/85 dark:text-emerald-200"
          : "border-red-300/70 bg-red-50/95 text-red-800 dark:border-red-800/70 dark:bg-red-950/85 dark:text-red-200"
      }`}
    >
      <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider opacity-70">{fortune ? "fortune" : "omen"}</span>
      <span className="shrink-0 rounded-full bg-white/50 px-1.5 py-px text-[10px] font-medium dark:bg-black/20">{item.tag}</span>
      <span className="min-w-0 flex-1 truncate">{item.text}</span>
    </div>
  );
}

// ---- 中央：决策树活地图节点 ----
function TaskNode({
  task,
  x,
  y,
  assignee,
  dimmed,
  events,
  onOpen,
}: {
  task: Task;
  x: number;
  y: number;
  assignee?: Agent;
  dimmed: boolean;
  events: TaskEvent[];
  onOpen: () => void;
}) {
  const visual = statusVisual(task.status);
  const billable = billableTokens(parseTaskUsage(task.usage_json));
  const hasBudget = task.budget_billable > 0;
  const isDoing = task.status === "doing";
  const acceptance = isDoing ? splitAcceptance(task.acceptance_criteria).slice(0, 2) : [];
  const recentEvents = isDoing ? events.slice(-2) : [];

  return (
    <div
      className={`absolute transition-opacity duration-200 ${dimmed ? "opacity-35" : "opacity-100"}`}
      style={{ left: x, top: y, width: CARD_W }}
    >
      {isDoing && <div className="theatre-pulse absolute -inset-1.5 rounded-2xl bg-accent blur-md" aria-hidden />}
      <button
        type="button"
        onClick={onOpen}
        className={`relative block w-full rounded-xl border ${visual.border} ${visual.bg} px-2.5 py-2 text-left shadow-sm hover:shadow-md`}
        title={task.title}
      >
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] leading-none">{visual.icon}</span>
          <span className="rounded bg-panel/70 px-1 py-px font-mono text-[9.5px] text-ink-3">{STATUS_LABEL[task.status]}</span>
          {task.revision_count > 0 && (
            <span className="ml-auto shrink-0 rounded bg-sel px-1 py-px font-mono text-[9.5px] text-ink-3">↩×{task.revision_count}</span>
          )}
        </div>
        <div className="mt-1 line-clamp-2 text-[12px] font-medium leading-snug text-ink">{task.title}</div>
        <div className="mt-1.5 flex items-center justify-between gap-1 text-[10.5px] text-ink-3">
          <span className="min-w-0 truncate">{assignee ? `${assignee.emoji} ${assignee.name}` : "未分配"}</span>
          {hasBudget && (
            <span className="shrink-0 font-mono" title="累计消耗/预算（billable）">
              {fmtNum(billable)}/{fmtNum(task.budget_billable)}
            </span>
          )}
        </div>
        {isDoing && (acceptance.length > 0 || recentEvents.length > 0) && (
          <div className="mt-2 space-y-1 border-t border-line/60 pt-1.5">
            {acceptance.map((item, i) => (
              <div key={i} className="truncate text-[10px] text-ink-3">▸ {item}</div>
            ))}
            {recentEvents.map((e) => (
              <div key={e.id} className="truncate text-[10px] text-ink-2">
                {eventGlyph(e.type)} {e.summary}
              </div>
            ))}
          </div>
        )}
      </button>
    </div>
  );
}

function EmptyCanvas({ hasAnyProject }: { hasAnyProject: boolean }) {
  const ws = useWorkspace();
  return (
    <div className="theatre-hexbg flex flex-1 items-center justify-center">
      <div className="max-w-sm rounded-xl border border-dashed border-line bg-panel/80 px-6 py-8 text-center shadow-sm">
        <div className="mb-2 text-[26px]">🎭</div>
        <div className="text-[13px] font-semibold text-ink">观察舱暂无信号</div>
        <div className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
          {hasAnyProject ? "当前范围内还没有任务，换一个项目试试。" : "还没有运行中的项目；先去工作台立项，剧场才有决策树可看。"}
        </div>
        <button
          onClick={() => ws.setView({ kind: "workline" })}
          className="mt-3 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90"
        >
          去立项
        </button>
      </div>
    </div>
  );
}

function DecisionTreeCanvas({
  tasks,
  agentById,
  eventsByTaskId,
  selectedAgentId,
  onOpenTask,
  hasAnyProject,
}: {
  tasks: Task[];
  agentById: (id: string | null) => Agent | undefined;
  eventsByTaskId: Map<string, TaskEvent[]>;
  selectedAgentId: string | null;
  onOpenTask: (t: Task) => void;
  hasAnyProject: boolean;
}) {
  const dag = useMemo(() => layoutDag(tasks), [tasks]);
  if (tasks.length === 0) return <EmptyCanvas hasAnyProject={hasAnyProject} />;
  return (
    <div className="theatre-hexbg relative min-h-0 flex-1 overflow-auto">
      <div className="relative" style={{ width: dag.width, height: dag.height }}>
        <svg className="pointer-events-none absolute inset-0" width={dag.width} height={dag.height}>
          {dag.edges.map((edge, i) => {
            const from = dag.posById.get(edge.from.id);
            const to = dag.posById.get(edge.to.id);
            if (!from || !to) return null;
            const x1 = from.x + CARD_W;
            const y1 = from.y + CARD_H / 2;
            const x2 = to.x;
            const y2 = to.y + CARD_H / 2;
            const cp = Math.max(24, (x2 - x1) * 0.5);
            const delivered = edge.from.status === "review" || edge.from.status === "done";
            const related =
              !selectedAgentId || edge.from.assignee_agent_id === selectedAgentId || edge.to.assignee_agent_id === selectedAgentId;
            return (
              <path
                key={`${edge.from.id}-${edge.to.id}-${i}`}
                d={`M${x1},${y1} C${x1 + cp},${y1} ${x2 - cp},${y2} ${x2},${y2}`}
                fill="none"
                stroke="var(--t-line)"
                strokeWidth={1.6}
                strokeDasharray={delivered ? undefined : "6 5"}
                opacity={related ? 0.95 : 0.25}
              />
            );
          })}
        </svg>
        {dag.nodes.map((n) => (
          <TaskNode
            key={n.task.id}
            task={n.task}
            x={n.x}
            y={n.y}
            assignee={agentById(n.task.assignee_agent_id)}
            dimmed={Boolean(selectedAgentId) && n.task.assignee_agent_id !== selectedAgentId}
            events={eventsByTaskId.get(n.task.id) ?? []}
            onOpen={() => onOpenTask(n.task)}
          />
        ))}
      </div>
    </div>
  );
}

// ---- 左栏：同事状态卡（桌面竖排 / 移动端横滑 chip） ----
function MemberColumn({
  agents,
  members,
  liveWorkingIds,
  selectedAgentId,
  onSelect,
}: {
  agents: Agent[];
  members: TeamMember[];
  liveWorkingIds: Set<string>;
  selectedAgentId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <aside className="hidden w-[240px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-line bg-paper/60 p-3 md:flex">
      <div className="px-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">同事</div>
      {agents.length === 0 && (
        <div className="rounded-lg bg-sel/50 px-3 py-4 text-center text-[12px] text-ink-3">还没有 AI 同事</div>
      )}
      {agents.map((agent) => {
        const member = members.find((m) => m.agent_id === agent.id);
        const working = isAgentWorking(agent.id, members, liveWorkingIds);
        const active = selectedAgentId === agent.id;
        const phrase = working ? (member?.current_task ? `⚙ ${truncate(member.current_task.title, 14)}` : "⚙ 执行中") : "待命";
        const tokensToday = (member?.tokens_today.input ?? 0) + (member?.tokens_today.output ?? 0);
        return (
          <button
            key={agent.id}
            type="button"
            onClick={() => onSelect(active ? null : agent.id)}
            className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${
              active ? "border-accent bg-accent-soft" : "border-line bg-panel hover:border-accent/40"
            }`}
          >
            <div className="flex items-center gap-2">
              <AgentAvatar agent={agent} size={30} state={working ? "thinking" : "idle"} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-semibold text-ink">{agent.name}</div>
                <div className="truncate text-[10.5px] text-ink-3">{agent.role}</div>
              </div>
            </div>
            <div className={`mt-1.5 truncate rounded-md px-2 py-1 text-[11px] ${working ? "bg-accent-soft text-ink-2" : "bg-sel text-ink-3"}`}>
              {phrase}
            </div>
            <div className="mt-1.5 flex gap-3 text-[10px] text-ink-3">
              <span>
                交付 <span className="font-mono text-ink-2">{member?.delivered_today ?? 0}</span>
              </span>
              <span>
                tokens <span className="font-mono text-ink-2">{fmtNum(tokensToday)}</span>
              </span>
            </div>
          </button>
        );
      })}
    </aside>
  );
}

function MemberChipBar({
  agents,
  members,
  liveWorkingIds,
  selectedAgentId,
  onSelect,
}: {
  agents: Agent[];
  members: TeamMember[];
  liveWorkingIds: Set<string>;
  selectedAgentId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <div className="flex gap-1.5 overflow-x-auto border-b border-line bg-panel px-3 py-2 md:hidden">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={`shrink-0 rounded-full border px-2.5 py-1 text-[11.5px] ${
          !selectedAgentId ? "border-accent bg-accent-soft text-ink" : "border-line text-ink-2"
        }`}
      >
        全员
      </button>
      {agents.map((agent) => {
        const working = isAgentWorking(agent.id, members, liveWorkingIds);
        const active = selectedAgentId === agent.id;
        return (
          <button
            key={agent.id}
            type="button"
            onClick={() => onSelect(active ? null : agent.id)}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] ${
              active ? "border-accent bg-accent-soft text-ink" : "border-line bg-panel text-ink-2"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${working ? "bg-accent" : "bg-ink-3/50"}`} />
            <span className="max-w-[84px] truncate">
              {agent.emoji} {agent.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---- 右栏：同事详情 / 项目总览 ----
function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-2 py-2 text-center">
      <div className="font-mono text-[16px] font-semibold text-ink">{value}</div>
      <div className="mt-0.5 text-[10px] text-ink-3">{label}</div>
    </div>
  );
}

function AgentDetailPanel({
  agent,
  member,
  onOpenTask,
  onClose,
}: {
  agent: Agent;
  member?: TeamMember;
  onOpenTask: (t: Task) => void;
  onClose?: () => void;
}) {
  const ws = useWorkspace();
  const agentTasks = useMemo(() => ws.tasks.filter((t) => t.assignee_agent_id === agent.id), [ws.tasks, agent.id]);
  const doingTasks = agentTasks.filter((t) => t.status === "doing");
  const focusTask =
    (member?.current_task && ws.tasks.find((t) => t.id === member.current_task!.id)) ??
    doingTasks[0] ??
    [...agentTasks].sort((a, b) => b.updated_at - a.updated_at)[0];

  // 只拉选中同事「当前/最近一个」任务的验收记录，不做 N+1
  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  useEffect(() => {
    let alive = true;
    setVerdicts([]);
    if (!focusTask) return;
    api.taskVerdicts(focusTask.id).then((v) => alive && setVerdicts(v)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [focusTask?.id]);

  const docs = useMemo(
    () => ws.documents.filter((d) => d.agent_id === agent.id).sort((a, b) => b.created_at - a.created_at).slice(0, 5),
    [ws.documents, agent.id],
  );

  const usage = focusTask ? parseTaskUsage(focusTask.usage_json) : null;
  const billable = usage ? billableTokens(usage) : 0;
  const hasBudget = Boolean(focusTask && focusTask.budget_billable > 0);
  const budgetPct = hasBudget && focusTask ? Math.min(100, Math.round((billable / focusTask.budget_billable) * 100)) : 0;
  const tokensIn = member?.tokens_today.input ?? 0;
  const tokensOut = member?.tokens_today.output ?? 0;
  const tokensTotal = tokensIn + tokensOut || 1;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div
        className="flex items-center gap-3 px-4 py-4"
        style={{ background: `linear-gradient(135deg, ${memberColor(agent.id, 0.22)}, transparent)` }}
      >
        <AgentAvatar agent={agent} size={52} state={doingTasks.length > 0 ? "thinking" : "idle"} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-ink">{agent.name}</div>
          <div className="truncate text-[12px] text-ink-3">{agent.role}</div>
        </div>
        {onClose && (
          <button onClick={onClose} className="shrink-0 rounded px-2 py-1 text-ink-3 hover:bg-sel hover:text-ink" title="关闭">
            ×
          </button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 px-4">
        <StatTile label="今日交付" value={member?.delivered_today ?? 0} />
        <StatTile label="进行中" value={doingTasks.length} />
        <StatTile label="队列" value={member?.queued ?? 0} />
      </div>

      <div className="mt-4 px-4">
        <div className="mb-1.5 text-[11.5px] font-semibold text-ink-2">账本</div>
        <div className="rounded-lg border border-line bg-panel p-2.5 text-[11px]">
          <div className="mb-1 flex items-center justify-between text-ink-3">
            <span>今日 tokens</span>
            <span className="font-mono">{fmtNum(tokensIn + tokensOut)}</span>
          </div>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-sel">
            <div className="h-full bg-accent" style={{ width: `${(tokensIn / tokensTotal) * 100}%` }} title={`输入 ${fmtNum(tokensIn)}`} />
            <div className="h-full bg-emerald-400" style={{ width: `${(tokensOut / tokensTotal) * 100}%` }} title={`输出 ${fmtNum(tokensOut)}`} />
          </div>
          {focusTask && hasBudget && (
            <>
              <div className="mt-2 flex items-center justify-between text-ink-3">
                <span>当前任务预算</span>
                <span className="font-mono">
                  {fmtNum(billable)}/{fmtNum(focusTask.budget_billable)}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-sel">
                <div
                  className={`h-full rounded-full ${budgetPct >= 100 ? "bg-red-500" : budgetPct >= 90 ? "bg-amber-500" : "bg-accent"}`}
                  style={{ width: `${budgetPct}%` }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {focusTask && (
        <div className="mt-4 px-4">
          <div className="mb-1.5 text-[11.5px] font-semibold text-ink-2">CURRENT FOCUS</div>
          <button
            onClick={() => onOpenTask(focusTask)}
            className="block w-full rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 text-left text-[12.5px] text-ink hover:opacity-90"
          >
            <div className="line-clamp-2 font-medium">{focusTask.title}</div>
            <div className="mt-0.5 text-[10.5px] text-ink-3">{STATUS_LABEL[focusTask.status]}</div>
          </button>
        </div>
      )}

      <div className="mt-4 px-4 pb-4">
        <div className="mb-1.5 text-[11.5px] font-semibold text-ink-2">编年史</div>
        {docs.length === 0 ? (
          <div className="text-[11.5px] text-ink-3">暂无交付物</div>
        ) : (
          <div className="space-y-1.5">
            {docs.map((d) => {
              const relatedTask = d.task_id ? ws.tasks.find((t) => t.id === d.task_id) : undefined;
              const verdict = d.task_id === focusTask?.id ? verdicts.find((v) => v.doc_id === d.id) : undefined;
              return (
                <button
                  key={d.id}
                  onClick={() => relatedTask && onOpenTask(relatedTask)}
                  disabled={!relatedTask}
                  className="flex w-full items-center gap-2 rounded-md bg-sel px-2 py-1.5 text-left text-[11.5px] hover:bg-sel/70 disabled:cursor-default"
                >
                  <span className="min-w-0 flex-1 truncate">{d.title}</span>
                  {verdict && (
                    <span
                      className={`shrink-0 rounded px-1 py-px font-mono text-[9.5px] ${
                        verdict.result === "pass"
                          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
                          : "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300"
                      }`}
                    >
                      {verdict.result === "pass" ? "通过" : "返工"}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectOverviewPanel({ tasks, project }: { tasks: Task[]; project?: Project }) {
  const total = tasks.length;
  const delivered = tasks.filter((t) => t.status === "review" || t.status === "done").length;
  const totalBillable = tasks.reduce((n, t) => n + billableTokens(parseTaskUsage(t.usage_json)), 0);
  const counts: Record<Task["status"], number> = { todo: 0, doing: 0, review: 0, blocked: 0, done: 0 };
  for (const t of tasks) counts[t.status]++;
  return (
    <div className="flex h-full flex-col overflow-y-auto px-4 py-4">
      <div className="text-[13px] font-semibold text-ink">{project ? project.title : "全部任务"}</div>
      <div className="mt-0.5 text-[11.5px] text-ink-3">未选中同事时的项目总览</div>
      <div className="mt-3 rounded-lg border border-line bg-panel p-3">
        <div className="mb-1 flex items-center justify-between text-[11.5px] text-ink-3">
          <span>完成进度</span>
          <span className="font-mono">
            {delivered}/{total}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-sel">
          <div className="h-full rounded-full bg-accent" style={{ width: `${total > 0 ? Math.round((delivered / total) * 100) : 0}%` }} />
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {(Object.keys(STATUS_LABEL) as Task["status"][]).map((s) => (
          <div key={s} className="rounded-lg border border-line bg-panel px-2.5 py-2 text-center">
            <div className="font-mono text-[15px] font-semibold text-ink">{counts[s]}</div>
            <div className="mt-0.5 text-[10px] text-ink-3">{STATUS_LABEL[s]}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-lg border border-line bg-panel px-3 py-2.5 text-[11.5px]">
        <span className="text-ink-3">项目总 billable</span>{" "}
        <span className="font-mono font-semibold text-ink">{fmtNum(totalBillable)}</span>
      </div>
      {total === 0 && (
        <div className="mt-4 rounded-lg border border-dashed border-line bg-sel/40 px-3 py-4 text-center text-[12px] leading-relaxed text-ink-3">
          选择左上角一个项目，或去工作台立项，剧场才会有活动可看。
        </div>
      )}
    </div>
  );
}

const ALL_TASKS_OPTION = "__all__";

export function TheatreView() {
  const ws = useWorkspace();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [openTask, setOpenTask] = useState<Task | null>(null);

  // 同事状态：5s 轮询兜底 + agent:status WS 即时刷（store 已把 WS 状态写进 ws.statuses）
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${API_BASE}/team`)
        .then((r) => r.json())
        .then((d) => {
          if (alive) setMembers(d.members ?? []);
        })
        .catch(() => undefined);
    load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const liveWorkingIds = useMemo(() => {
    const s = new Set<string>();
    for (const channelStatuses of Object.values(ws.statuses)) {
      for (const agentId of Object.keys(channelStatuses)) s.add(agentId);
    }
    return s;
  }, [ws.statuses]);

  // 世界事件横幅：不改 store，仅在组件内对比 ws.taskEvents 的增量，挂载前已存在的事件不弹幕
  const seenEventIds = useRef<Set<string> | null>(null);
  const [bannerQueue, setBannerQueue] = useState<BannerItem[]>([]);
  const [bannerItem, setBannerItem] = useState<BannerItem | null>(null);
  useEffect(() => {
    if (seenEventIds.current === null) {
      seenEventIds.current = new Set(ws.taskEvents.map((e) => e.id));
      return;
    }
    const fresh = ws.taskEvents.filter((e) => !seenEventIds.current!.has(e.id));
    if (fresh.length === 0) return;
    for (const e of fresh) seenEventIds.current.add(e.id);
    const items = fresh.map(toBannerItem).filter((x): x is BannerItem => x !== null);
    if (items.length > 0) setBannerQueue((q) => [...q, ...items]);
  }, [ws.taskEvents]);
  useEffect(() => {
    if (bannerItem || bannerQueue.length === 0) return;
    const [next, ...rest] = bannerQueue;
    setBannerQueue(rest);
    setBannerItem(next);
    const timer = setTimeout(() => setBannerItem(null), 4000);
    return () => clearTimeout(timer);
  }, [bannerQueue, bannerItem]);

  const projectsForPicker = useMemo(
    () => ws.projects.filter((p) => p.status === "running" || p.status === "review").sort((a, b) => b.updated_at - a.updated_at),
    [ws.projects],
  );
  const defaultProject = projectsForPicker.find((p) => p.status === "running") ?? projectsForPicker[0];
  const isAllMode = selectedProjectId === ALL_TASKS_OPTION;
  const effectiveProjectId = isAllMode ? "" : selectedProjectId || defaultProject?.id || "";
  const currentProject = isAllMode ? undefined : ws.projects.find((p) => p.id === effectiveProjectId);
  const sceneTasks = useMemo(() => {
    if (isAllMode) return ws.tasks.filter((t) => !t.project_id);
    if (!effectiveProjectId) return [];
    return ws.tasks.filter((t) => t.project_id === effectiveProjectId);
  }, [isAllMode, effectiveProjectId, ws.tasks]);

  const eventsByTaskId = useMemo(() => {
    const m = new Map<string, TaskEvent[]>();
    for (const e of ws.taskEvents) {
      if (!e.task_id) continue;
      const arr = m.get(e.task_id);
      if (arr) arr.push(e);
      else m.set(e.task_id, [e]);
    }
    return m;
  }, [ws.taskEvents]);

  const selectedAgent = ws.agentById(selectedAgentId);
  const selectedMember = members.find((m) => m.agent_id === selectedAgentId);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
        <h1 className="text-[15px] font-semibold">🎭 剧场</h1>
        <select
          value={selectedProjectId}
          onChange={(e) => setSelectedProjectId(e.target.value)}
          className="min-w-0 rounded-lg border border-line bg-panel px-2 py-1.5 text-[12.5px] text-ink-2 outline-none"
          title="选择要观察的项目"
        >
          <option value="">{defaultProject ? `🔴 ${defaultProject.title}（最新）` : "暂无运行中项目"}</option>
          {projectsForPicker
            .filter((p) => p.id !== defaultProject?.id)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.status === "running" ? "🔴" : "🟡"} {p.title}
              </option>
            ))}
          <option value={ALL_TASKS_OPTION}>📋 全部任务（非项目）</option>
        </select>
        <span className="hidden text-[12px] text-ink-3 sm:inline">决策树活地图 · 观察舱视图</span>
        <div className="ml-auto flex items-center gap-1.5 text-[11.5px]">
          <span className="font-mono text-[9px] uppercase tracking-wider text-ink-3">now viewing</span>
          <span className="rounded-full bg-sel px-2 py-0.5 font-medium text-ink-2">
            {selectedAgent ? `${selectedAgent.emoji} ${selectedAgent.name}` : "全员总览"}
          </span>
        </div>
      </header>

      <MemberChipBar
        agents={ws.agents}
        members={members}
        liveWorkingIds={liveWorkingIds}
        selectedAgentId={selectedAgentId}
        onSelect={setSelectedAgentId}
      />

      <div className="flex min-h-0 flex-1">
        <MemberColumn
          agents={ws.agents}
          members={members}
          liveWorkingIds={liveWorkingIds}
          selectedAgentId={selectedAgentId}
          onSelect={setSelectedAgentId}
        />

        <div className="relative flex min-h-0 flex-1 flex-col">
          {bannerItem && <EventBanner item={bannerItem} />}
          <DecisionTreeCanvas
            tasks={sceneTasks}
            agentById={ws.agentById}
            eventsByTaskId={eventsByTaskId}
            selectedAgentId={selectedAgentId}
            onOpenTask={setOpenTask}
            hasAnyProject={projectsForPicker.length > 0}
          />
        </div>

        <aside className="hidden w-[300px] shrink-0 flex-col border-l border-line bg-paper/60 md:flex">
          {selectedAgent ? (
            <AgentDetailPanel agent={selectedAgent} member={selectedMember} onOpenTask={setOpenTask} />
          ) : (
            <ProjectOverviewPanel tasks={sceneTasks} project={currentProject} />
          )}
        </aside>
      </div>

      {selectedAgent && (
        <div className="fixed inset-x-0 bottom-0 z-30 max-h-[75vh] overflow-y-auto rounded-t-2xl border-t border-line bg-paper shadow-2xl md:hidden">
          <AgentDetailPanel
            agent={selectedAgent}
            member={selectedMember}
            onOpenTask={setOpenTask}
            onClose={() => setSelectedAgentId(null)}
          />
        </div>
      )}

      {openTask && (
        <TaskDetailDrawer
          task={ws.tasks.find((t) => t.id === openTask.id) ?? openTask}
          onClose={() => setOpenTask(null)}
          onOpenTask={setOpenTask}
        />
      )}
    </div>
  );
}

import { Suspense, lazy, useEffect, useState } from "react";
import { useWorkspace } from "../store";
import type { Doc, Task } from "../types";
import { API_BASE } from "../api";
import { TaskDetailDrawer } from "./TaskDetailDrawer";

const DocViewerModal = lazy(() => import("./DocsView").then((m) => ({ default: m.DocViewerModal })));

const COLUMNS: { key: Task["status"]; label: string }[] = [
  { key: "todo", label: "待办" },
  { key: "doing", label: "进行中" },
  { key: "blocked", label: "等待输入" },
  { key: "review", label: "待评审" },
  { key: "done", label: "完成" },
  { key: "cancelled", label: "已取消" },
];
const COLUMN_LABEL: Record<Task["status"], string> = {
  todo: "待办",
  doing: "进行中",
  blocked: "等待输入",
  review: "待评审",
  done: "完成",
  cancelled: "已取消",
};
const PROJECT_STATUS_TONE: Record<Task["status"], string> = {
  todo: "bg-slate-400",
  doing: "bg-accent",
  blocked: "bg-red-500",
  review: "bg-blue-500",
  done: "bg-emerald-500",
  cancelled: "bg-slate-600",
};

function prevStatus(task: Task): Task["status"] | null {
  if (task.status === "doing" || task.status === "review") return "todo";
  if (task.status === "done") return "review";
  if (task.status === "cancelled") return "todo";
  return null;
}

function nextStatus(task: Task): Task["status"] | null {
  if (task.status === "doing") return "review";
  if (task.status === "review") return "done";
  return null;
}

function TaskCard({ task, onOpenDoc, onOpenTask }: { task: Task; onOpenDoc: (doc: Doc) => void; onOpenTask: (task: Task) => void }) {
  const ws = useWorkspace();
  const creator = task.created_by === "user" ? null : ws.agentById(task.created_by);
  const doc = ws.documents.find((d) => d.task_id === task.id);
  const prev = prevStatus(task);
  const next = nextStatus(task);
  const project = ws.projects.find((p) => p.id === task.project_id);
  const events = ws.taskEvents.filter((e) => e.task_id === task.id);
  const latest = events.at(-1);
  const hasPendingApproval = ws.approvals.some(
    (a) => a.status === "pending" && (a.ref_id === task.id || a.id === task.blocked_approval_id),
  );
  const terminal = task.status === "done" || task.status === "cancelled";
  let depCount = 0;
  try {
    depCount = (JSON.parse(task.depends_on) as string[]).length;
  } catch { /* 旧数据无该字段 */ }

  return (
    <div className="rounded-lg border border-line bg-panel p-3 shadow-sm">
      {(project || depCount > 0 || task.revision_count > 0 || task.model_tier === "light") && (
        <div className="mb-1 flex flex-wrap items-center gap-1">
          {project && (
            <span className="rounded bg-accent-soft px-1.5 py-px text-[10.5px] text-ink-2" title={project.goal}>
              🧩 {project.title}
            </span>
          )}
          {depCount > 0 && (
            <span className="rounded bg-sel px-1.5 py-px text-[10.5px] text-ink-3" title="依赖交付后自动开工">
              ⛓ 依赖 {depCount}
            </span>
          )}
          {task.revision_count > 0 && (
            <span className="rounded bg-sel px-1.5 py-px text-[10.5px] text-ink-3" title="验收未通过的返工次数">
              ↩ 返工 {task.revision_count}
            </span>
          )}
          {task.model_tier === "light" && (
            <span className="rounded bg-sel px-1.5 py-px text-[10.5px] text-ink-3" title="轻量模型通道（低成本）">
              ⚡ 轻量
            </span>
          )}
        </div>
      )}
      <div className="text-[13.5px] font-medium leading-snug">{task.title}</div>
      {task.acceptance_criteria && (
        <div className="mt-1 line-clamp-2 text-[11.5px] text-ink-3" title={task.acceptance_criteria}>
          验收：{task.acceptance_criteria}
        </div>
      )}
      {task.description && (
        <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-[12.5px] text-ink-2">{task.description}</div>
      )}
      {latest && (
        <button
          onClick={() => onOpenTask(task)}
          className="mt-2 flex w-full items-center gap-1.5 rounded-md bg-sel/80 px-2 py-1 text-left text-[11.5px] text-ink-3 hover:text-ink"
          title={latest.summary}
        >
          <span className="shrink-0 font-mono text-[10px]">{events.length} evt</span>
          <span className="min-w-0 flex-1 truncate">{latest.summary}</span>
        </button>
      )}
      <div className="mt-2 space-y-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          <select
            value={task.assignee_agent_id ?? ""}
            onChange={(e) => void ws.updateTask(task.id, { assignee_agent_id: e.target.value || null })}
            disabled={terminal}
            className="min-w-0 rounded-full border border-line bg-sel px-1.5 py-0.5 text-[11.5px] text-ink-2 outline-none disabled:opacity-50"
            title="指派给 AI 同事后会自动开工"
          >
            <option value="">未分配</option>
            {ws.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.emoji} {a.name}
              </option>
            ))}
          </select>
          <select
            value={task.reviewer_agent_id ?? ""}
            onChange={(e) => void ws.updateTask(task.id, { reviewer_agent_id: e.target.value || null })}
            disabled={terminal}
            className="min-w-0 rounded-full border border-line bg-sel px-1.5 py-0.5 text-[11.5px] text-ink-2 outline-none disabled:opacity-50"
            title="指定复核人；留空则系统按交付物类型自动选择"
          >
            <option value="">自动复核</option>
            {ws.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.emoji} {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-h-6 items-center gap-1.5">
          {creator && (
            <span className="truncate text-[11px] text-ink-3" title={`由 ${creator.name} 创建`}>
              {creator.emoji} 创建
            </span>
          )}
          <span className="ml-auto flex shrink-0 gap-0.5">
          {task.status === "blocked" && (
            <button
              onClick={() => onOpenTask(task)}
              className="rounded bg-red-50 px-1.5 font-medium text-red-600 hover:bg-red-100 dark:bg-red-950/30 dark:text-red-300 dark:hover:bg-red-950/50"
              title="打开详情，在「审批与输入」区回应后任务自动恢复"
            >
              去处理
            </button>
          )}
          {task.status === "doing" && (
            <button
              onClick={() => void fetch(`${API_BASE}/tasks/${task.id}/stop`, { method: "POST" })}
              className="rounded px-1 text-ink-3 hover:bg-sel hover:text-red-500"
              title="停止：运行中的工作在下一个步骤边界停下，任务退回待办"
            >
              ⏹
            </button>
          )}
          <button
            onClick={() => onOpenTask(task)}
            className="rounded px-1 text-ink-3 hover:bg-sel hover:text-ink"
            title="打开任务详情"
          >
            详情
          </button>
          {prev && (
            <button
              onClick={() => void ws.moveTask(task, prev)}
              className="rounded px-1 text-ink-3 hover:bg-sel hover:text-ink"
              title={`移到「${COLUMN_LABEL[prev]}」`}
            >
              ←
            </button>
          )}
          {next && (
            <button
              onClick={() => void ws.moveTask(task, next)}
              disabled={next === "done" && hasPendingApproval}
              className="rounded px-1 text-ink-3 hover:bg-sel hover:text-ink disabled:opacity-40"
              title={
                next === "done" && hasPendingApproval
                  ? "先在收件箱处理该任务的审批/输入，再关闭"
                  : `移到「${COLUMN_LABEL[next]}」${next === "done" ? "（关单是 human-only）" : ""}`
              }
            >
              →
            </button>
          )}
          </span>
        </div>
      </div>
      {doc && (
        <button
          onClick={() => onOpenDoc(doc)}
          className="mt-2 flex w-full items-center gap-1.5 rounded-md bg-accent-soft px-2 py-1 text-left text-[12px] text-ink-2 hover:text-ink"
        >
          📄 <span className="truncate">交付物：{doc.title}</span>
        </button>
      )}
    </div>
  );
}

/**
 * 项目级折叠卡：把同一项目在某列里的子任务收成一张可展开的组卡，给看板封顶。
 * 当项目全部任务都已交付（project-wide 都在 review）时，在「待评审」列露出
 * 「✅ 确认关闭项目」——一次决策批量关单，守住 human-only 签核又不必逐卡点。
 */
function ProjectGroup({
  projectId,
  columnTasks,
  column,
  onOpenDoc,
  onOpenTask,
}: {
  projectId: string;
  columnTasks: Task[];
  column: Task["status"];
  onOpenDoc: (doc: Doc) => void;
  onOpenTask: (task: Task) => void;
}) {
  const ws = useWorkspace();
  const project = ws.projects.find((p) => p.id === projectId);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const allTasks = ws.tasks.filter((t) => t.project_id === projectId);
  const projectDocs = ws.documents
    .filter((d) => d.task_id && allTasks.some((t) => t.id === d.task_id))
    .sort((a, b) => b.created_at - a.created_at);
  const summaryDoc = project?.summary_doc_id ? ws.documents.find((d) => d.id === project.summary_doc_id) : undefined;
  const featuredDoc = summaryDoc ?? projectDocs[0];
  const taskIds = new Set(allTasks.map((t) => t.id));
  const pendingApprovals = ws.approvals.filter(
    (a) => a.status === "pending" && (a.ref_id === projectId || (a.ref_id ? taskIds.has(a.ref_id) : false)),
  );
  const projectEvents = ws.taskEvents
    .filter((e) => e.task_id && taskIds.has(e.task_id))
    .sort((a, b) => a.created_at - b.created_at);
  const revisionTotal = allTasks.reduce((sum, t) => sum + (t.revision_count ?? 0), 0);
  const delivered = allTasks.filter((t) => t.status === "review" || t.status === "done").length;
  const allDelivered = allTasks.length > 0 && allTasks.every((t) => t.status === "review" || t.status === "done");
  const closeBlockedByApproval = column === "review" && allDelivered && pendingApprovals.length > 0 && project?.status !== "done";
  const canClose = column === "review" && allDelivered && pendingApprovals.length === 0 && project?.status !== "done";
  const statusCounts = Object.fromEntries(COLUMNS.map((c) => [c.key, allTasks.filter((t) => t.status === c.key).length])) as Record<Task["status"], number>;
  const progressPct = allTasks.length > 0 ? Math.round((delivered / allTasks.length) * 100) : 0;
  const nextHint =
    statusCounts.blocked > 0
      ? `${statusCounts.blocked} 个任务等待输入`
      : statusCounts.review > 0
        ? `${statusCounts.review} 个交付待复核/关闭`
        : statusCounts.doing > 0
          ? `${statusCounts.doing} 个任务正在执行`
          : statusCounts.todo > 0
            ? `${statusCounts.todo} 个任务待认领或依赖解锁`
            : project?.status === "done"
              ? "项目已关闭"
              : "等待最终关闭";

  async function close() {
    if (closing) return;
    if (!window.confirm(
      `确认关闭项目「${project?.title ?? "项目"}」？\n` +
      `将把 ${allTasks.length} 个已交付任务归入「完成」。\n` +
      `交付物 ${projectDocs.length} 个，返工 ${revisionTotal} 次，活动事件 ${projectEvents.length} 条。`
    )) return;
    setClosing(true);
    try {
      await ws.closeProject(projectId);
    } finally {
      setClosing(false);
    }
  }

  return (
    <div className="rounded-lg border border-line bg-panel/70 shadow-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left"
        title={project?.goal}
      >
        <span className="text-[11px] text-ink-3">{open ? "▾" : "▸"}</span>
        <span className="truncate text-[12.5px] font-semibold">🧩 {project?.title ?? "项目"}</span>
        <span className="ml-auto shrink-0 rounded bg-sel px-1.5 py-px text-[10.5px] text-ink-3">
          {column === "review" ? `${delivered}/${allTasks.length} 已交付` : `${columnTasks.length} 卡`}
        </span>
      </button>
      {allTasks.length > 0 && (
        <div className="px-2.5 pb-2">
          <div className="mb-1 flex items-center gap-2 text-[10.5px] text-ink-3">
            <span className="font-mono">{progressPct}%</span>
            <span className="min-w-0 flex-1 truncate">{nextHint}</span>
          </div>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-sel" title={`项目进度：${delivered}/${allTasks.length} 已交付`}>
            {COLUMNS.map((c) => {
              const count = statusCounts[c.key];
              if (count === 0) return null;
              return (
                <span
                  key={c.key}
                  className={PROJECT_STATUS_TONE[c.key]}
                  style={{ flex: count }}
                  title={`${c.label}: ${count}`}
                />
              );
            })}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {COLUMNS.filter((c) => statusCounts[c.key] > 0).map((c) => (
              <span key={c.key} className="rounded bg-sel px-1.5 py-px text-[10px] text-ink-3">
                {c.label} {statusCounts[c.key]}
              </span>
            ))}
          </div>
          {featuredDoc && (
            <button
              onClick={() => onOpenDoc(featuredDoc)}
              className="mt-2 flex w-full items-center justify-between rounded-md bg-accent-soft px-2 py-1.5 text-left text-[11.5px] text-ink-2 hover:text-accent"
              title={featuredDoc.title}
            >
              <span className="min-w-0 truncate">{summaryDoc ? "最终汇总" : "最新交付物"}：{featuredDoc.title}</span>
              <span className="ml-2 shrink-0 rounded bg-panel px-1 py-px font-mono text-[10px] text-ink-3">
                {projectDocs.length}
              </span>
            </button>
          )}
          {allDelivered && (
            <div className="mt-2 rounded-md border border-line bg-paper/70 px-2 py-1.5">
              <div className="mb-1 flex items-center justify-between gap-2 text-[11px] font-medium text-ink-2">
                <span>验收摘要</span>
                <span className={pendingApprovals.length > 0 ? "text-amber-600" : "text-emerald-600"}>
                  {pendingApprovals.length > 0 ? "仍有待处理" : "可人工关单"}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-1 text-center text-[10.5px] text-ink-3">
                <span className="rounded bg-sel px-1 py-1" title="当前版本交付物数量">
                  交付 {projectDocs.length}
                </span>
                <span className="rounded bg-sel px-1 py-1" title="复核退回累计次数">
                  返工 {revisionTotal}
                </span>
                <span className={`rounded px-1 py-1 ${pendingApprovals.length > 0 ? "bg-amber-50 text-amber-700 dark:bg-amber-950/20 dark:text-amber-300" : "bg-sel"}`}>
                  审批 {pendingApprovals.length}
                </span>
                <span className="rounded bg-sel px-1 py-1" title="结构化任务活动日志数量">
                  事件 {projectEvents.length}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
      {closeBlockedByApproval && (
        <div className="px-2.5 pb-2">
          <button
            onClick={() => ws.setView({ kind: "inbox" })}
            className="w-full rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[12px] font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300"
            title="项目还有待处理审批或输入，必须先处理后才能关闭"
          >
            先处理 {pendingApprovals.length} 个审批/输入
          </button>
        </div>
      )}
      {canClose && (
        <div className="px-2.5 pb-2">
          <button
            onClick={close}
            disabled={closing}
            className="w-full rounded-md bg-accent px-2 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            title="一次性把本项目全部已交付任务关单并归档"
          >
            {closing ? "关闭中…" : "✅ 确认关闭项目"}
          </button>
        </div>
      )}
      {open && (
        <div className="flex flex-col gap-2 border-t border-line p-2">
          {columnTasks.map((t) => (
            <TaskCard key={t.id} task={t} onOpenDoc={onOpenDoc} onOpenTask={onOpenTask} />
          ))}
        </div>
      )}
    </div>
  );
}

export function TasksBoard({
  deepTaskId,
  onDeepTaskConsumed,
}: {
  deepTaskId?: string | null;
  onDeepTaskConsumed?: () => void;
}) {
  const ws = useWorkspace();
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [openDoc, setOpenDoc] = useState<Doc | null>(null);
  const [openTask, setOpenTask] = useState<Task | null>(null);

  useEffect(() => {
    if (!deepTaskId) return;
    const task = ws.tasks.find((t) => t.id === deepTaskId);
    if (!task) return;
    setOpenTask(task);
    onDeepTaskConsumed?.();
  }, [deepTaskId, onDeepTaskConsumed, ws.tasks]);

  async function addTask() {
    const t = title.trim();
    if (!t) return;
    await ws.createTask({ title: t, assignee_agent_id: assignee || null });
    setTitle("");
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
        <h1 className="text-[15px] font-semibold">任务</h1>
        <span className="min-w-0 flex-1 text-[12px] text-ink-3">指派给 AI 同事即自动开工：调研 → 交付文档 → 转待评审</span>
        <div className="flex w-full flex-wrap items-center gap-2 lg:ml-auto lg:w-auto">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void addTask()}
            placeholder="快速新建任务…"
            className="min-w-0 flex-1 rounded-lg border border-line bg-panel px-3 py-1.5 text-[13px] outline-none focus:border-accent/50 sm:flex-none sm:w-52"
          />
          <select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            className="min-w-28 flex-1 rounded-lg border border-line bg-panel px-2 py-1.5 text-[13px] text-ink-2 outline-none sm:flex-none"
          >
            <option value="">不指派</option>
            {ws.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.emoji} {a.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => void addTask()}
            disabled={!title.trim()}
            className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
          >
            新建
          </button>
        </div>
      </header>
      <div className="grid flex-1 grid-cols-[repeat(6,minmax(190px,1fr))] gap-3 overflow-auto p-4">
        {COLUMNS.map((col) => {
          const tasks = ws.tasks.filter((t) => t.status === col.key);
          // 同一项目的子任务收进折叠组卡；无项目的单任务平铺。保留列内出现顺序。
          const groups: string[] = [];
          const grouped = new Map<string, Task[]>();
          const loose: Task[] = [];
          for (const t of tasks) {
            if (t.project_id) {
              if (!grouped.has(t.project_id)) {
                grouped.set(t.project_id, []);
                groups.push(t.project_id);
              }
              grouped.get(t.project_id)!.push(t);
            } else {
              loose.push(t);
            }
          }
          return (
            <div key={col.key} className="flex min-w-0 flex-col rounded-xl bg-sel/60 p-2">
              <div className="flex items-center gap-1.5 px-2 py-1.5">
                <span className="text-[13px] font-semibold">{col.label}</span>
                <span className="text-[12px] text-ink-3">{tasks.length}</span>
              </div>
              <div className="flex flex-col gap-2 overflow-y-auto p-1">
                {groups.map((pid) => (
                  <ProjectGroup
                    key={pid}
                    projectId={pid}
                    columnTasks={grouped.get(pid)!}
                    column={col.key}
                    onOpenDoc={setOpenDoc}
                    onOpenTask={setOpenTask}
                  />
                ))}
                {loose.map((t) => (
                  <TaskCard key={t.id} task={t} onOpenDoc={setOpenDoc} onOpenTask={setOpenTask} />
                ))}
                {tasks.length === 0 && <div className="px-2 py-4 text-center text-[12px] text-ink-3">空</div>}
              </div>
            </div>
          );
        })}
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

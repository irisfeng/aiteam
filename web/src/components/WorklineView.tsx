import { Suspense, lazy, useMemo, useState } from "react";
import { useWorkspace } from "../store";
import type { Doc, Task } from "../types";
import { TaskDetailDrawer } from "./TaskDetailDrawer";
import { WorklineOverview } from "./WorklineOverview";
import type { SettingsTab } from "./Modals";

const DocViewerModal = lazy(() => import("./DocsView").then((m) => ({ default: m.DocViewerModal })));

const ACCEPTANCE_PROJECT_PREFIX = "闭环验收";

/** 工作台：登录默认页。任务运行线总控（需要你处理 / 场景启动 / 启动前检查 / 最新活动），看板在「任务」视图。 */
export function WorklineView({ onOpenSettings }: { onOpenSettings?: (tab: SettingsTab) => void }) {
  const ws = useWorkspace();
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [openDoc, setOpenDoc] = useState<Doc | null>(null);
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [scenarioBusy, setScenarioBusy] = useState(false);
  const [activeScenarioId, setActiveScenarioId] = useState("");
  const [scenarioError, setScenarioError] = useState("");
  const [acceptanceProjectId, setAcceptanceProjectId] = useState<string | null>(null);

  async function addTask() {
    const t = title.trim();
    if (!t) return;
    await ws.createTask({ title: t, assignee_agent_id: assignee || null });
    setTitle("");
  }

  const latestAcceptanceProject = [...ws.projects]
    .filter((p) => p.title.startsWith(ACCEPTANCE_PROJECT_PREFIX))
    .sort((a, b) => {
      const aOpen = a.status === "done" ? 0 : 1;
      const bOpen = b.status === "done" ? 0 : 1;
      return bOpen - aOpen || b.updated_at - a.updated_at;
    })[0];
  const acceptanceProject = (acceptanceProjectId ? ws.projects.find((p) => p.id === acceptanceProjectId) : undefined) ?? latestAcceptanceProject;
  const acceptanceTasks = useMemo(
    () => (acceptanceProject ? ws.tasks.filter((t) => t.project_id === acceptanceProject.id) : []),
    [acceptanceProject, ws.tasks],
  );
  const acceptanceDelivered = acceptanceTasks.filter((t) => t.status === "review" || t.status === "done").length;
  const acceptanceDone = acceptanceTasks.filter((t) => t.status === "done").length;
  const acceptanceRun = acceptanceProject
    ? {
        title: acceptanceProject.title,
        total: acceptanceTasks.length,
        delivered: acceptanceDelivered,
        done: acceptanceDone,
        status: (acceptanceTasks.length > 0 && acceptanceDone === acceptanceTasks.length
          ? "done"
          : acceptanceTasks.length > 0 && acceptanceDelivered === acceptanceTasks.length
            ? "review"
            : "running") as "running" | "review" | "done",
      }
    : null;

  function openAcceptanceReview() {
    const task = acceptanceTasks.find((t) => t.status === "review") ?? acceptanceTasks.find((t) => t.status === "done") ?? acceptanceTasks[0];
    if (task) setOpenTask(task);
  }

  async function closeAcceptanceProject() {
    if (!acceptanceProject) return;
    const ids = new Set(acceptanceTasks.map((t) => t.id));
    const blockedByApproval = ws.approvals.some(
      (a) => a.status === "pending" && (a.ref_id === acceptanceProject.id || (a.ref_id ? ids.has(a.ref_id) : false)),
    );
    if (blockedByApproval) {
      window.alert("该验收项目还有待处理的审批/输入，请先在收件箱处理后再关闭。");
      return;
    }
    if (!window.confirm(`确认关闭验收项目「${acceptanceProject.title}」？\n这会把本轮验收任务归档为完成。`)) return;
    await ws.closeProject(acceptanceProject.id);
  }

  async function runOrOpenAcceptance() {
    if (acceptanceRun && acceptanceRun.status !== "done") {
      openAcceptanceReview();
      return;
    }
    await startCoreScenario("helio-core", "acceptance");
  }

  async function startCoreScenario(id = "helio-core", mode: "normal" | "acceptance" = "normal") {
    if (scenarioBusy) return;
    const view = ws.view;
    const channel =
      view.kind === "channel"
        ? ws.channels.find((c) => c.id === view.id)
        : ws.channels.find((c) => c.kind === "channel") ?? ws.channels[0];
    if (!channel) return;
    setScenarioBusy(true);
    setActiveScenarioId(mode === "acceptance" ? "acceptance" : id);
    setScenarioError("");
    try {
      const result = await ws.startScenario(id, { channel_id: channel.id, ...(mode === "acceptance" ? { acceptance: true } : {}) });
      if (mode === "acceptance") {
        setAcceptanceProjectId(result.project.id);
        const taskToReview = result.tasks.find((t) => t.status === "review") ?? result.tasks.find((t) => t.status === "done") ?? result.tasks[0];
        if (taskToReview) setOpenTask(taskToReview);
      }
    } catch (e: any) {
      setScenarioError(e?.message ?? "启动失败");
    } finally {
      setScenarioBusy(false);
      setActiveScenarioId("");
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
        <h1 className="text-[15px] font-semibold">工作台</h1>
        <span className="min-w-0 flex-1 text-[12px] text-ink-3">派任务、处理审批与复核、启动核心场景；看板明细在「任务」</span>
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
          <button
            onClick={() => ws.setView({ kind: "tasks" })}
            className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink-2 hover:bg-sel hover:text-ink"
            title="打开任务看板"
          >
            看板
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5">
        <WorklineOverview
          onOpenTask={setOpenTask}
          onStartScenario={(id) => void startCoreScenario(id)}
          onRunAcceptance={() => void runOrOpenAcceptance()}
          acceptanceRun={acceptanceRun}
          onOpenAcceptanceReview={openAcceptanceReview}
          onCloseAcceptanceProject={() => void closeAcceptanceProject()}
          activeScenarioId={activeScenarioId}
          scenarioBusy={scenarioBusy}
          scenarioError={scenarioError}
          onOpenSettings={onOpenSettings}
        />
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

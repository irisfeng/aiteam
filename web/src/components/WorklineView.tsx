import { Suspense, lazy, useMemo, useState } from "react";
import { useWorkspace } from "../store";
import type { Doc, Task } from "../types";
import { TaskDetailDrawer } from "./TaskDetailDrawer";
import { WorklineOverview } from "./WorklineOverview";
import type { SettingsTab } from "./Modals";
import { TaskBriefComposer } from "./TaskBriefComposer";

const DocViewerModal = lazy(() => import("./DocsView").then((m) => ({ default: m.DocViewerModal })));

const ACCEPTANCE_PROJECT_PREFIX = "闭环验收";

/** 工作台：登录默认页。任务运行线总控（需要你处理 / 场景启动 / 启动前检查 / 最新活动），看板在「任务」视图。 */
export function WorklineView({ onOpenSettings }: { onOpenSettings?: (tab: SettingsTab) => void }) {
  const ws = useWorkspace();
  const [briefOpen, setBriefOpen] = useState(false);
  const [openDoc, setOpenDoc] = useState<Doc | null>(null);
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [scenarioBusy, setScenarioBusy] = useState(false);
  const [activeScenarioId, setActiveScenarioId] = useState("");
  const [scenarioError, setScenarioError] = useState("");
  const [acceptanceProjectId, setAcceptanceProjectId] = useState<string | null>(null);
  const [scenarioChannelId, setScenarioChannelId] = useState("");

  const teamChannels = ws.channels.filter((c) => c.kind === "channel");
  const scenarioChannel = teamChannels.find((c) => c.id === scenarioChannelId) ?? teamChannels[0] ?? ws.channels[0];

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
  const acceptanceCancelled = acceptanceTasks.filter((t) => t.status === "cancelled").length;
  const acceptanceTerminal = acceptanceTasks.length > 0 && acceptanceTasks.every(
    (t) => t.status === "review" || t.status === "done" || t.status === "cancelled",
  );
  const acceptanceRun = acceptanceProject
    ? {
        title: acceptanceProject.title,
        total: acceptanceTasks.length,
        delivered: acceptanceDelivered,
        done: acceptanceDone,
        cancelled: acceptanceCancelled,
        status: (acceptanceProject.status === "done"
          ? "done"
          : acceptanceTerminal
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
    const reviewCount = acceptanceTasks.filter((task) => task.status === "review").length;
    const doneCount = acceptanceTasks.filter((task) => task.status === "done").length;
    if (!window.confirm(
      `确认关闭验收项目「${acceptanceProject.title}」？\n` +
      `将把 ${reviewCount} 个待评审任务归入「完成」；` +
      `${doneCount} 个已完成任务保持「完成」；${acceptanceCancelled} 个已取消任务保持「已取消」。`,
    )) return;
    try {
      await ws.closeProject(acceptanceProject.id);
    } catch (error) {
      window.alert(`关闭验收项目失败：${error instanceof Error ? error.message : String(error)}`);
    }
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
    const channel = scenarioChannel;
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
        <span className="min-w-0 flex-1 text-[12px] text-ink-3">用任务简报明确输出，再处理执行、审批与复核；看板明细在「任务」</span>
        <div className="flex w-full flex-wrap items-center gap-2 lg:ml-auto lg:w-auto">
          <button
            onClick={() => setBriefOpen(true)}
            className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
          >
            新建任务简报
          </button>
          <select
            value={scenarioChannel?.id ?? ""}
            onChange={(e) => setScenarioChannelId(e.target.value)}
            className="min-w-28 flex-1 rounded-lg border border-line bg-panel px-2 py-1.5 text-[13px] text-ink-2 outline-none sm:flex-none"
            title="核心场景与端到端验收的任务将挂到这个频道"
          >
            {teamChannels.length === 0 && <option value="">无团队频道</option>}
            {teamChannels.map((c) => (
              <option key={c.id} value={c.id}>
                场景 → #{c.name}
              </option>
            ))}
          </select>
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
      <TaskBriefComposer open={briefOpen} onClose={() => setBriefOpen(false)} onCreated={setOpenTask} />
    </div>
  );
}

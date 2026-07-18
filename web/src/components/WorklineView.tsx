import { Suspense, lazy, useMemo, useState } from "react";
import { useWorkspace } from "../store";
import type { Doc, Task } from "../types";
import { TaskDetailDrawer } from "./TaskDetailDrawer";
import { WorklineOverview } from "./WorklineOverview";
import type { SettingsTab } from "./Modals";
import { TaskBriefComposer } from "./TaskBriefComposer";
import { FocusWorkspace } from "./FocusWorkspace";
import { ChevronRight } from "lucide-react";

const DocViewerModal = lazy(() => import("./DocsView").then((m) => ({ default: m.DocViewerModal })));

const ACCEPTANCE_PROJECT_PREFIX = "闭环验收";

/** 工作台：一个目标输入 + 少量当前任务；完整运行线与验收工具按需展开。 */
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
      <div className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(circle_at_50%_18%,color-mix(in_srgb,var(--t-accent)_8%,transparent),transparent_44%)]">
        <FocusWorkspace onOpenTask={setOpenTask} onOpenFullBrief={() => setBriefOpen(true)} />

        <div className="mx-auto w-full max-w-[960px] px-4 pb-10 sm:px-8">
          <details className="group border-t border-line/70">
            <summary className="flex cursor-pointer list-none items-center gap-3 px-1 py-3.5 text-[12px] font-medium text-ink-3 hover:text-ink [&::-webkit-details-marker]:hidden">
              <span className="flex-1">运行与验收工具</span>
              <span className="text-[11.5px] font-normal text-ink-3">配置、自检与完整任务运行线</span>
              <ChevronRight size={16} strokeWidth={1.8} className="text-ink-3 transition-transform group-open:rotate-90" />
            </summary>
            <div className="border-t border-line py-3">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-ink-3">验收任务进入频道</span>
                <select
                  value={scenarioChannel?.id ?? ""}
                  onChange={(e) => setScenarioChannelId(e.target.value)}
                  className="min-w-32 rounded-lg border border-line bg-paper px-2 py-1.5 text-[12.5px] text-ink-2 outline-none"
                  title="核心场景与端到端验收的任务将挂到这个频道"
                >
                  {teamChannels.length === 0 && <option value="">无团队频道</option>}
                  {teamChannels.map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.name}
                    </option>
                  ))}
                </select>
              </div>
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
          </details>
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
      <TaskBriefComposer open={briefOpen} onClose={() => setBriefOpen(false)} onCreated={setOpenTask} />
    </div>
  );
}

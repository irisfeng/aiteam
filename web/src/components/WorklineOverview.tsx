import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "../store";
import { API_BASE, api, billableTokens, parseTaskUsage, type ScenarioInfo } from "../api";
import type { Task, TaskEvent } from "../types";
import { computeWorkline } from "../lib/workline";
import type { SettingsTab } from "./Modals";
import { INTEGRATIONS_UPDATED_EVENT } from "./IntegrationsTabs";
import {
  providerBenchmarkBatchConfirmation,
  providerBenchmarkRunInput,
} from "../lib/providerBenchmark";

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
  cancelled: "取消",
  failure: "失败",
};
const LINK_CHECK_PROJECT_PREFIX = "配置链路验收";

function fmt(ts: number) {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function StatButton({
  label,
  value,
  hint,
  tone,
  onClick,
}: {
  label: string;
  value: number;
  hint: string;
  tone: "run" | "block" | "review" | "approval";
  onClick?: () => void;
}) {
  const toneClass =
    tone === "block"
      ? "border-red-200 bg-red-50/70 text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300"
      : tone === "review"
        ? "border-blue-200 bg-blue-50/70 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/20 dark:text-blue-300"
        : tone === "approval"
          ? "border-amber-200 bg-amber-50/70 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300"
          : "border-accent/30 bg-accent-soft text-accent";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-[74px] min-w-0 rounded-lg border px-3 py-2 text-left transition-colors hover:border-accent/50 ${toneClass}`}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[22px] font-semibold leading-none">{value}</span>
        <span className="text-[12px] font-medium">{label}</span>
      </div>
      <div className="mt-1.5 line-clamp-2 text-[11.5px] leading-snug opacity-80">{hint}</div>
    </button>
  );
}

function FlowStep({
  index,
  label,
  value,
  state,
  onClick,
}: {
  index: number;
  label: string;
  value: string;
  state: "done" | "active" | "idle" | "alert";
  onClick?: () => void;
}) {
  const stateClass =
    state === "alert"
      ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300"
      : state === "active"
        ? "border-accent/40 bg-accent-soft text-accent"
        : state === "done"
          ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300"
          : "border-line bg-panel text-ink-3";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`flex min-h-[58px] min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors disabled:cursor-default sm:min-w-[116px] ${stateClass} ${onClick ? "hover:border-accent/50" : ""}`}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/70 font-mono text-[11px] dark:bg-black/20">
        {index}
      </span>
      <span className="min-w-0">
        <span className="block text-[12px] font-semibold leading-tight">{label}</span>
        <span className="mt-0.5 block truncate text-[10.5px] opacity-75">{value}</span>
      </span>
    </button>
  );
}

interface McpServerInfo {
  id: string;
  name: string;
  safety: "local" | "network" | "exec";
  enabled: number;
}

interface SkillListItem {
  id: string;
  name: string;
  enabled: number;
}

interface LinkCheckResult {
  id: string;
  label: string;
  status: "passed" | "failed" | "waiting" | "skipped";
  detail: string;
  taskId?: string;
}

function formatTokenCount(value: unknown) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatEstimatedCost(value: unknown, currency: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  const unit = typeof currency === "string" && currency.trim() ? currency.trim().toUpperCase() : "USD";
  const amount = value < 0.01 ? value.toFixed(4) : value.toFixed(2);
  return ` · ≈${unit} ${amount}`;
}

function ReadinessItem({
  ok,
  label,
  detail,
  action,
  actionLabel = "配置",
}: {
  ok: boolean;
  label: string;
  detail: string;
  action?: () => void;
  actionLabel?: string;
}) {
  const content = (
    <>
      <span className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-500"}`} />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-ink-2">{label}</div>
        <div className="line-clamp-1 text-[11px] text-ink-3">{detail}</div>
      </div>
      {action && <span className="shrink-0 rounded bg-sel px-1.5 py-px text-[10.5px] text-ink-3">{actionLabel}</span>}
    </>
  );
  if (action) {
    return (
      <button
        type="button"
        onClick={action}
        className="flex min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-sel/70"
      >
        {content}
      </button>
    );
  }
  return (
    <div className="flex min-w-0 items-start gap-2 px-2 py-1.5">{content}</div>
  );
}

const FALLBACK_SCENARIOS: ScenarioInfo[] = [
  { id: "helio-core", title: "协作演练", desc: "三步跑通认领、依赖推进、复核和人类关闭。" },
];

export function WorklineOverview({
  channelId,
  onOpenTask,
  onStartScenario,
  onRunAcceptance,
  acceptanceRun,
  onOpenAcceptanceReview,
  onCloseAcceptanceProject,
  activeScenarioId = "",
  scenarioBusy = false,
  scenarioError = "",
  className = "",
  onOpenSettings,
}: {
  channelId?: string;
  onOpenTask: (task: Task) => void;
  onStartScenario?: (id: string) => void;
  onRunAcceptance?: () => void;
  acceptanceRun?: {
    title: string;
    total: number;
    delivered: number;
    done: number;
    cancelled: number;
    status: "running" | "review" | "done";
  } | null;
  onOpenAcceptanceReview?: () => void;
  onCloseAcceptanceProject?: () => void;
  activeScenarioId?: string;
  scenarioBusy?: boolean;
  scenarioError?: string;
  className?: string;
  onOpenSettings?: (tab: SettingsTab) => void;
}) {
  const ws = useWorkspace();
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [linkCheckBusy, setLinkCheckBusy] = useState(false);
  const [linkCheckResults, setLinkCheckResults] = useState<LinkCheckResult[]>([]);
  const [linkCheckProjectId, setLinkCheckProjectId] = useState<string | null>(null);
  const [closingProjectId, setClosingProjectId] = useState<string | null>(null);
  // null = 场景目录加载中（渲染骨架，避免加载完成前只显示硬编码的单个场景卡）
  const [scenarios, setScenarios] = useState<ScenarioInfo[] | null>(null);

  async function refreshReadiness() {
    const [skillItems, serverItems] = await Promise.all([
      api.listSkills().catch(() => skills),
      fetch(`${API_BASE}/mcp-servers`)
        .then((r) => r.json())
        .then((servers) => (Array.isArray(servers) ? servers : mcpServers))
        .catch(() => mcpServers),
    ]);
    setSkills(skillItems);
    setMcpServers(serverItems);
    return { skills: skillItems, mcpServers: serverItems as McpServerInfo[] };
  }

  useEffect(() => {
    api.listScenarios()
      .then((items) => setScenarios(items.length > 0 ? items : FALLBACK_SCENARIOS))
      .catch(() => setScenarios(FALLBACK_SCENARIOS));
    void refreshReadiness();
    const onFocus = () => void refreshReadiness();
    const onIntegrationsUpdated = () => void refreshReadiness();
    window.addEventListener("focus", onFocus);
    window.addEventListener(INTEGRATIONS_UPDATED_EVENT, onIntegrationsUpdated);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(INTEGRATIONS_UPDATED_EVENT, onIntegrationsUpdated);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const wl = computeWorkline({ tasks: ws.tasks, approvals: ws.approvals, channelId, agentById: ws.agentById });
  const scopedTasks = wl.tasks;
  const taskIds = useMemo(() => new Set(scopedTasks.map((t) => t.id)), [scopedTasks]);
  const scopedApprovals = wl.approvals;
  const events = ws.taskEvents
    .filter((e) => !channelId || (e.task_id && taskIds.has(e.task_id)) || e.channel_id === channelId)
    .slice(-8)
    .reverse();
  const firstByStatus = (status: Task["status"]) => scopedTasks.find((t) => t.status === status);
  const { running, blocked, blockedWithoutPendingApproval, review, todo, done, active, unassigned } = wl;
  const cancelled = scopedTasks.filter((task) => task.status === "cancelled");
  const inputOrApprovalCount = scopedApprovals.length + blockedWithoutPendingApproval.length;
  const claimed = scopedTasks.filter((t) => t.assignee_agent_id);
  const attentionItems = wl.attention.map((item) => ({
    ...item,
    onClick: () => (item.task ? onOpenTask(item.task) : ws.setView({ kind: "inbox" })),
  }));
  const modelReady = !ws.mockMode;
  const channelReady = ws.channels.some((c) => c.kind === "channel");
  const enabledMcp = mcpServers.filter((s) => s.enabled);
  const networkMcpReady = enabledMcp.some((s) => s.safety === "network");
  const enabledSkills = skills.filter((s) => s.enabled);
  const skillReady = enabledSkills.length > 0;
  const firstTodo = firstByStatus("todo");
  const firstDoing = firstByStatus("doing");
  const firstReview = firstByStatus("review");
  const firstDone = firstByStatus("done");
  const firstTask = scopedTasks[0];
  const claimTask = unassigned[0] ?? claimed[0] ?? firstTask;
  const noActiveTasks = scopedTasks.length > 0 && active.length === 0;
  const closableProject = [...ws.projects]
    .filter((project) => project.status !== "done" && (!channelId || project.channel_id === channelId))
    .sort((a, b) => b.updated_at - a.updated_at)
    .find((project) => {
      const tasks = scopedTasks.filter((task) => task.project_id === project.id);
      if (tasks.length === 0) return false;
      const ids = new Set(tasks.map((task) => task.id));
      const hasPendingApproval = ws.approvals.some((approval) =>
        approval.status === "pending" &&
        (approval.ref_id === project.id || (approval.ref_id ? ids.has(approval.ref_id) : false))
      );
      return !hasPendingApproval && tasks.every(
        (task) => task.status === "review" || task.status === "done" || task.status === "cancelled",
      );
    });
  const closableProjectTasks = closableProject ? scopedTasks.filter((task) => task.project_id === closableProject.id) : [];
  const closableReviewCount = closableProjectTasks.filter((task) => task.status === "review").length;
  const closableDoneCount = closableProjectTasks.filter((task) => task.status === "done").length;
  const closableCancelledCount = closableProjectTasks.filter((task) => task.status === "cancelled").length;
  const latestLinkCheckProject = [...ws.projects]
    .filter((p) => p.title.startsWith(LINK_CHECK_PROJECT_PREFIX) && (!channelId || p.channel_id === channelId))
    .sort((a, b) => {
      const aOpen = a.status === "done" ? 0 : 1;
      const bOpen = b.status === "done" ? 0 : 1;
      return bOpen - aOpen || b.updated_at - a.updated_at;
    })[0];
  const selectedLinkCheckProject = linkCheckProjectId ? ws.projects.find((p) => p.id === linkCheckProjectId) : undefined;
  const linkCheckProject =
    selectedLinkCheckProject && (!channelId || selectedLinkCheckProject.channel_id === channelId)
      ? selectedLinkCheckProject
      : latestLinkCheckProject;
  const linkCheckTasks = linkCheckProject ? ws.tasks.filter((t) => t.project_id === linkCheckProject.id) : [];
  const linkCheckDelivered = linkCheckTasks.filter((t) => t.status === "review" || t.status === "done").length;
  const linkCheckCancelled = linkCheckTasks.filter((t) => t.status === "cancelled").length;
  const linkCheckReady = linkCheckTasks.length > 0 && linkCheckTasks.every(
    (task) => task.status === "review" || task.status === "done" || task.status === "cancelled",
  );
  const linkCheckClosed = linkCheckProject?.status === "done";
  const linkCheckOpen = Boolean(linkCheckProject && linkCheckProject.status !== "done");
  const parseEventMeta = (event: TaskEvent) => {
    try {
      return JSON.parse(event.metadata_json || "{}") as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const persistedLinkCheckResults: LinkCheckResult[] = linkCheckTasks.map((task) => {
    const isProvider = task.title.startsWith("真实模型质量基准：") || task.title.startsWith("模型任务演练：");
    const isMcp = task.title.startsWith("MCP 能力演练：");
    const isSkill = task.title.startsWith("技能演练：");
    const taskEvents = ws.taskEvents.filter((event) => event.task_id === task.id);
    const eventTypes = new Set(taskEvents.map((event) => event.type));
    const eventMetas = taskEvents.map(parseEventMeta);
    const resultMeta = [...eventMetas].reverse().find((meta) => meta.provider_task_test === true);
    const benchmarkMeta = eventMetas.find((meta) => typeof meta.benchmark_id === "string");
    const verdictMeta = [...eventMetas].reverse().find((meta) => meta.result === "pass" || meta.result === "revise" || meta.result === "gap");
    const resultChecks =
      resultMeta && typeof resultMeta.checks === "object" && resultMeta.checks
        ? (resultMeta.checks as Record<string, unknown>)
        : null;
    const usageSummary =
      resultMeta && typeof resultMeta.usage_summary === "object" && resultMeta.usage_summary
        ? (resultMeta.usage_summary as Record<string, unknown>)
        : null;
    const metaWithModel = eventMetas.find((meta) => typeof meta.model === "string");
    const model = typeof metaWithModel?.model === "string" ? metaWithModel.model : "";
    const latency = typeof resultMeta?.latency_ms === "number" ? ` · ${Math.round(resultMeta.latency_ms)}ms` : "";
    const liveBillable = billableTokens(parseTaskUsage(task.usage_json));
    const measuredBillable = typeof usageSummary?.billable === "number" ? usageSummary.billable : liveBillable;
    const billable = measuredBillable > 0 ? ` · ${formatTokenCount(measuredBillable)} billable` : "";
    const estimatedCost = formatEstimatedCost(usageSummary?.estimated_cost, usageSummary?.price_currency);
    const toolObserved = eventTypes.has("tool");
    const delivered = eventTypes.has("delivery") || task.status === "review" || task.status === "done";
    const verified = eventTypes.has("verification");
    const usageTracked = typeof resultChecks?.usage_tracked === "boolean" ? resultChecks.usage_tracked : null;
    const qualityContract = resultChecks?.quality_contract === true || benchmarkMeta?.rubric_count === 7;
    const documentContract = resultChecks?.document_contract === true;
    const independentReviewer = resultChecks?.independent_reviewer === true || Boolean(task.reviewer_agent_id && task.reviewer_agent_id !== task.assignee_agent_id);
    const verdictRecorded = resultChecks?.verdict_recorded === true || verdictMeta?.result === "pass";
    const withinBudget = resultChecks?.within_budget === true || (task.budget_billable > 0 && liveBillable <= task.budget_billable);
    const sourceTraceClean = resultChecks?.source_trace_clean !== false;
    const pendingApproval = task.status === "blocked" && ws.approvals.some((approval) => approval.ref_id === task.id && approval.status === "pending");
    const status: LinkCheckResult["status"] =
      pendingApproval
        ? "waiting"
        : task.status === "review" || task.status === "done"
          ? verdictRecorded && sourceTraceClean ? "passed" : "failed"
          : eventTypes.has("failure")
        ? "failed"
          : "skipped";
    const label = isProvider
      ? `模型 · ${task.title.replace(/^真实模型质量基准：AiTeam 产品落地决策简报（|^模型任务演练：/, "").replace(/）$/, "")}`
      : isMcp
        ? `MCP · ${task.title.replace("MCP 能力演练：", "")}`
        : isSkill
          ? `Skills · ${task.title.replace("技能演练：", "")}`
          : task.title;
    const detail =
      isProvider && model
        ? `${model}${latency}${billable}${estimatedCost} · ${delivered ? "交付" : "未交付"} / ${toolObserved ? "工具" : "无工具"} / ${qualityContract ? "7项契约" : "契约缺失"} / ${documentContract ? "机器预检" : "结构缺项"} / ${independentReviewer ? "独立复核" : "复核冲突"} / ${verdictRecorded ? "pass" : pendingApproval ? "待复核" : verified ? "未通过" : "未验收"} / ${sourceTraceClean ? "来源可追溯" : "来源冲突"} / ${pendingApproval ? "复核预算待批" : withinBudget ? "预算内" : "已触线"} / ${usageTracked === null ? "用量未知" : usageTracked ? "用量" : "无用量"}`
        : task.status === "review" || task.status === "done"
          ? `${task.status} · 已有可复核交付证据`
        : task.status === "blocked"
          ? "blocked · 等待输入或审批"
          : `${task.status} · 等待演练完成`;
    return { id: `persisted:${task.id}`, label, status, detail, taskId: task.id };
  });
  const visibleLinkCheckResults = linkCheckResults.length > 0 ? linkCheckResults : persistedLinkCheckResults;
  const providerCheckResults = visibleLinkCheckResults.filter((item) => item.id.startsWith("provider:") || item.label.startsWith("模型 · "));
  const providerPassed = providerCheckResults.filter((item) => item.status === "passed").length;
  const providerFailed = providerCheckResults.filter((item) => item.status === "failed").length;
  const providerWaiting = providerCheckResults.filter((item) => item.status === "waiting").length;
  const providerBest = providerCheckResults.find((item) => item.status === "passed");
  const linkCheckButtonLabel = linkCheckBusy
    ? "自检中…"
    : ws.user.role !== "admin"
      ? "需管理员"
      : linkCheckOpen
        ? linkCheckReady
          ? "打开自检"
          : "查看自检"
        : linkCheckClosed
          ? "重新自检"
          : "链路自检";
  const linkCheckButtonTitle =
    ws.user.role !== "admin"
      ? "链路自检需要管理员权限"
      : linkCheckOpen
        ? "打开当前配置验收项目的任务证据；不重复创建新项目"
        : "先显示并确认每个模型通道的实际预算，再运行质量基准与 MCP/Skills 演练；取消不会调用模型";
  const acceptanceButtonLabel =
    scenarioBusy && activeScenarioId === "acceptance"
      ? "验收中…"
      : acceptanceRun?.status === "running"
        ? "查看验收"
        : acceptanceRun?.status === "review"
          ? "打开验收"
          : acceptanceRun?.status === "done"
            ? "重新验收"
            : "端到端验收";
  const acceptanceButtonTitle =
    acceptanceRun && acceptanceRun.status !== "done"
      ? "打开当前验收项目的任务证据；不重复创建新项目"
      : "创建一条自检项目线：启动、认领、交付、复核，最后仍由人确认关单";
  const nextAction =
    scopedApprovals.length > 0
      ? `先处理 ${scopedApprovals.length} 个审批/输入，任务才会继续。`
      : blockedWithoutPendingApproval.length > 0
        ? `回应 ${blockedWithoutPendingApproval.length} 个阻塞任务，避免 AI 空转。`
        : closableProject
          ? `项目「${closableProject.title}」已全部进入终态：${closableReviewCount} 个待评审，${closableDoneCount} 个已完成，${closableCancelledCount} 个已取消；确认后归档项目。`
        : review.length > 0
          ? `复核 ${review.length} 个交付；通过后由你关单，未过则退回返工。`
          : running.length > 0
            ? `${running.length} 个任务正在执行，观察活动日志和工具调用。`
            : unassigned.length > 0
              ? `给 ${unassigned.length} 个待办任务指定 AI 同事或让它认领。`
              : todo.length > 0
                ? `${todo.length} 个任务等待依赖解锁或自动开工。`
                : noActiveTasks
                  ? `当前无活跃任务：${done.length} 个完成，${cancelled.length} 个取消。${done.length > 0 ? "可查看已完成任务的交付物。" : ""}`
                  : "先启动一个核心场景，生成带依赖、复核和关单的任务链。";
  const nextActionCta =
    scopedApprovals.length > 0
      ? { label: "处理输入", onClick: () => ws.setView({ kind: "inbox" }), primary: true, disabled: false }
      : blockedWithoutPendingApproval[0]
        ? { label: "打开阻塞任务", onClick: () => onOpenTask(blockedWithoutPendingApproval[0]), primary: true, disabled: false }
        : closableProject
          ? {
              label: closingProjectId === closableProject.id ? "关闭中…" : "确认关闭项目",
              onClick: () => void closeReadyProject(closableProject.id),
              primary: true,
              disabled: Boolean(closingProjectId),
            }
        : firstReview
          ? { label: "处理待复核", onClick: () => onOpenTask(firstReview), primary: true, disabled: false }
          : firstDoing
            ? { label: "查看执行", onClick: () => onOpenTask(firstDoing), primary: false, disabled: false }
            : unassigned[0]
              ? { label: "指定负责人", onClick: () => onOpenTask(unassigned[0]), primary: false, disabled: false }
              : firstTodo
                ? { label: "查看待办", onClick: () => onOpenTask(firstTodo), primary: false, disabled: false }
                : noActiveTasks && firstDone
                  ? { label: "查看归档", onClick: () => onOpenTask(firstDone), primary: false, disabled: false }
                  : onStartScenario
                    ? {
                        label: scenarioBusy ? "启动中…" : "启动协作演练",
                        onClick: () => onStartScenario("helio-core"),
                        primary: true,
                        disabled: scenarioBusy || !channelReady,
                      }
                    : null;

  async function closeReadyProject(projectId: string) {
    if (closingProjectId) return;
    const project = ws.projects.find((p) => p.id === projectId);
    const tasks = ws.tasks.filter((task) => task.project_id === projectId);
    if (!project || tasks.length === 0) return;
    const reviewCount = tasks.filter((task) => task.status === "review").length;
    const doneCount = tasks.filter((task) => task.status === "done").length;
    const cancelledCount = tasks.filter((task) => task.status === "cancelled").length;
    if (!window.confirm(
      `确认关闭项目「${project.title}」？\n` +
      `将把 ${reviewCount} 个待评审任务归入「完成」；` +
      `${doneCount} 个已完成任务保持「完成」；${cancelledCount} 个已取消任务保持「已取消」。`,
    )) return;
    setClosingProjectId(projectId);
    try {
      await ws.closeProject(projectId);
    } catch (error) {
      window.alert(`关闭项目失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setClosingProjectId(null);
    }
  }

  async function runLinkCheck() {
    if (linkCheckBusy) return;
    if (ws.user.role !== "admin") {
      setLinkCheckResults([{ id: "admin", label: "权限", status: "skipped", detail: "链路自检会触发组织级配置演练，需要管理员执行" }]);
      return;
    }
    if (linkCheckOpen && linkCheckTasks.length > 0) {
      openLinkCheckProjectTask();
      return;
    }
    setLinkCheckBusy(true);
    setLinkCheckResults([]);
    const results: LinkCheckResult[] = [];
    const channelArg = channelId ? { channel_id: channelId } : {};
    const latest = await refreshReadiness();
    const providersToTest = ws.providers.filter((p) => p.has_key && (p.default_model || p.light_model));
    const mcp = latest.mcpServers.filter((s) => s.enabled)[0];
    const skill = latest.skills.filter((s) => s.enabled)[0];
    try {
      const approvedProviderPlans = new Map<string, Awaited<ReturnType<typeof api.providerTaskTestPlan>>>();
      const availablePlans = (await Promise.all(providersToTest.map(async (provider) => {
        try {
          return await api.providerTaskTestPlan(provider.id);
        } catch (error) {
          results.push({
            id: `provider:${provider.id}`,
            label: `模型 · ${provider.name}`,
            status: "failed",
            detail: `预算预检失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 160),
          });
          return null;
        }
      }))).filter((plan): plan is NonNullable<typeof plan> => Boolean(plan));
      const approvedProviderRun = availablePlans.length > 0 && window.confirm(providerBenchmarkBatchConfirmation(availablePlans));
      if (approvedProviderRun) {
        for (const plan of availablePlans) approvedProviderPlans.set(plan.provider.id, plan);
      } else if (availablePlans.length > 0) {
        for (const plan of availablePlans) {
          results.push({
            id: `provider:${plan.provider.id}`,
            label: `模型 · ${plan.provider.name}`,
            status: "skipped",
            detail: "用户取消预算确认 · 未调用模型、未创建基准任务",
          });
        }
      }
      const runnable = Boolean(approvedProviderPlans.size > 0 || mcp || skill);
      const project = linkCheckOpen ? linkCheckProject ?? null : runnable ? (await api.startLinkCheck(channelArg)).project : null;
      if (project) {
        setLinkCheckProjectId(project.id);
        await ws.refreshWorkspace();
      }
      const runArg = project ? { ...channelArg, project_id: project.id } : channelArg;
      if (providersToTest.length === 0) {
        results.push({ id: "provider", label: "模型", status: "skipped", detail: "未找到已保存 key 的模型供应商" });
      } else if (approvedProviderPlans.size > 0) {
        for (const provider of providersToTest) {
          const plan = approvedProviderPlans.get(provider.id);
          if (!plan) continue;
          try {
            const out = await ws.runProviderTaskTest(provider.id, providerBenchmarkRunInput(plan, runArg));
            results.push({
              id: `provider:${provider.id}`,
              label: `模型 · ${provider.name}`,
              status: out.run_status === "passed" ? "passed" : out.run_status === "pending_approval" ? "waiting" : "failed",
              detail: `${out.models.worker}→${out.models.reviewer} · ${Math.round(out.latency_ms)}ms · ${formatTokenCount(out.usage_summary?.billable)} billable${formatEstimatedCost(out.usage_summary?.estimated_cost, out.usage_summary?.price_currency)} · ${out.checks.delivered ? "交付" : "未交付"} / ${out.checks.quality_contract ? "7项契约" : "契约缺失"} / ${out.checks.document_contract ? "机器预检" : "结构缺项"} / ${out.checks.independent_reviewer ? "独立复核" : "复核冲突"} / ${out.checks.verdict_recorded ? "pass" : out.checks.pending_approval ? "待复核" : "未通过"} / ${out.checks.source_trace_clean ? "来源可追溯" : "来源冲突"} / ${out.checks.pending_approval ? "复核预算待批" : out.checks.within_budget ? "预算内" : "已触线"}`,
              taskId: out.task.id,
            });
          } catch (e: any) {
            results.push({
              id: `provider:${provider.id}`,
              label: `模型 · ${provider.name}`,
              status: "failed",
              detail: String(e?.message ?? e).slice(0, 120),
            });
          }
          setLinkCheckResults([...results]);
        }
      }
      setLinkCheckResults([...results]);

      if (!mcp) {
        results.push({ id: "mcp", label: "MCP", status: "skipped", detail: "未启用 MCP；调研类场景建议配置搜索或文档转换插件" });
      } else {
        try {
          const out = await ws.runMcpTaskTest(mcp.id, runArg);
          results.push({
            id: "mcp",
            label: "MCP",
            status: out.ok ? "passed" : "failed",
            detail: `${out.server.name} · ${out.checks.connected ? `${out.checks.tools} 工具` : "未连接"} / ${out.task.status}`,
            taskId: out.task.id,
          });
        } catch (e: any) {
          results.push({ id: "mcp", label: "MCP", status: "failed", detail: String(e?.message ?? e).slice(0, 120) });
        }
      }
      setLinkCheckResults([...results]);

      if (!skill) {
        results.push({ id: "skill", label: "Skills", status: "skipped", detail: "未启用技能；建议启用来源约束、交付自查等窄技能" });
      } else {
        try {
          const out = await ws.runSkillTaskTest(skill.id, runArg);
          results.push({
            id: "skill",
            label: "Skills",
            status: out.ok ? "passed" : "failed",
            detail: `${out.skill.name} · ${out.checks.read_hint ? "索引" : "无索引"} / ${out.checks.body_loaded ? "正文" : "无正文"} / ${out.task.status}`,
            taskId: out.task.id,
          });
        } catch (e: any) {
          results.push({ id: "skill", label: "Skills", status: "failed", detail: String(e?.message ?? e).slice(0, 120) });
        }
      }
      setLinkCheckResults([...results]);
    } finally {
      setLinkCheckBusy(false);
    }
  }

  async function openLinkCheckTask(taskId?: string) {
    if (!taskId) return;
    const existing = ws.tasks.find((t) => t.id === taskId);
    if (existing) {
      onOpenTask(existing);
      return;
    }
    const fresh = await api.bootstrap();
    const task = fresh.tasks.find((t) => t.id === taskId);
    if (task) onOpenTask(task);
    await ws.refreshWorkspace();
  }

  function openLinkCheckProjectTask() {
    const task = linkCheckTasks.find((t) => t.status === "review") ?? linkCheckTasks.find((t) => t.status === "done") ?? linkCheckTasks[0];
    if (task) onOpenTask(task);
  }

  async function closeLinkCheckProject() {
    if (!linkCheckProject || !linkCheckReady) return;
    const reviewCount = linkCheckTasks.filter((task) => task.status === "review").length;
    const doneCount = linkCheckTasks.filter((task) => task.status === "done").length;
    if (!window.confirm(
      `确认关闭配置验收项目「${linkCheckProject.title}」？\n` +
      `将把 ${reviewCount} 个待评审任务归入「完成」；` +
      `${doneCount} 个已完成任务保持「完成」；${linkCheckCancelled} 个已取消任务保持「已取消」。`,
    )) return;
    try {
      await ws.closeProject(linkCheckProject.id);
    } catch (error) {
      window.alert(`关闭配置验收项目失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <section className={`grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_360px] ${className}`}>
      <div className="min-w-0 overflow-hidden rounded-lg border border-line bg-panel p-3 shadow-sm">
        <div className="mb-3 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold">任务运行线</div>
            <div className="mt-0.5 text-[12px] text-ink-3">
              同一频道、同一任务、同一审计轨迹；AI 可以认领和交付，人类处理审批并最终关单。
            </div>
          </div>
          <div className="shrink-0 rounded-md bg-sel px-2 py-1 font-mono text-[11px] text-ink-3">
            active {active.length}
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <StatButton
            label="正在执行"
            value={running.length}
            hint="AI 同事已接手，过程会写回频道和任务事件。"
            tone="run"
            onClick={() => {
              const t = firstByStatus("doing");
              if (t) onOpenTask(t);
            }}
          />
          <StatButton
            label="等待输入"
            value={blocked.length}
            hint="事实、权限或安全边界不足，等待你在收件箱回应。"
            tone="block"
            onClick={() => {
              const t = firstByStatus("blocked");
              if (t) onOpenTask(t);
            }}
          />
          <StatButton
            label="待复核"
            value={review.length}
            hint="交付已产出，需复核或由你确认关闭。"
            tone="review"
            onClick={() => {
              const t = firstByStatus("review");
              if (t) onOpenTask(t);
            }}
          />
          <StatButton
            label="待审批"
            value={scopedApprovals.length}
            hint="高风险动作、项目计划和澄清请求集中处理。"
            tone="approval"
            onClick={() => ws.setView({ kind: "inbox" })}
          />
        </div>
        <div className="mt-3 rounded-lg border border-line bg-paper/70 p-2.5">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="text-[12.5px] font-semibold">当前推进路径</div>
            <div className="min-w-0 flex-1 truncate text-right text-[11.5px] text-ink-3 sm:min-w-[180px]" title={nextAction}>
              下一步：{nextAction}
            </div>
            {nextActionCta && (
              <button
                type="button"
                onClick={nextActionCta.onClick}
                disabled={nextActionCta.disabled}
                className={`shrink-0 rounded-md px-2.5 py-1 text-[12px] font-medium disabled:opacity-40 ${
                  nextActionCta.primary
                    ? "bg-accent text-white hover:opacity-90"
                    : "border border-line bg-panel text-ink-2 hover:bg-sel hover:text-ink"
                }`}
                title={nextAction}
              >
                {nextActionCta.label}
              </button>
            )}
          </div>
          <div className="grid gap-2 md:grid-cols-3 2xl:grid-cols-6">
            <FlowStep
              index={1}
              label="立项"
              value={scopedTasks.length > 0 ? `${scopedTasks.length} 个任务` : "未启动"}
              state={scopedTasks.length > 0 ? "done" : "active"}
              onClick={firstTask ? () => onOpenTask(firstTask) : undefined}
            />
            <FlowStep
              index={2}
              label="认领"
              value={claimed.length > 0 ? `${claimed.length} 已归属` : unassigned.length > 0 ? `${unassigned.length} 未分配` : "等待任务"}
              state={unassigned.length > 0 ? "active" : claimed.length > 0 ? "done" : "idle"}
              onClick={claimTask ? () => onOpenTask(claimTask) : undefined}
            />
            <FlowStep
              index={3}
              label="执行"
              value={running.length > 0 ? `${running.length} 进行中` : "无运行任务"}
              state={running.length > 0 ? "active" : done.length > 0 || review.length > 0 ? "done" : "idle"}
              onClick={firstDoing ? () => onOpenTask(firstDoing) : undefined}
            />
            <FlowStep
              index={4}
              label="输入/审批"
              value={inputOrApprovalCount > 0 ? `${inputOrApprovalCount} 待处理` : "无阻塞"}
              state={inputOrApprovalCount > 0 ? "alert" : scopedTasks.length > 0 ? "done" : "idle"}
              onClick={
                scopedApprovals.length > 0
                  ? () => ws.setView({ kind: "inbox" })
                  : blockedWithoutPendingApproval[0]
                    ? () => onOpenTask(blockedWithoutPendingApproval[0])
                    : undefined
              }
            />
            <FlowStep
              index={5}
              label="复核"
              value={review.length > 0 ? `${review.length} 待评审` : "未到复核"}
              state={review.length > 0 ? "active" : done.length > 0 ? "done" : "idle"}
              onClick={firstReview ? () => onOpenTask(firstReview) : undefined}
            />
            <FlowStep
              index={6}
              label="关单"
              value={closableProject ? "待确认关单" : noActiveTasks ? `${done.length} 完成 · ${cancelled.length} 取消` : active.length > 0 ? `${active.length} 未关闭` : "等待交付"}
              state={closableProject ? "active" : noActiveTasks ? "done" : review.length > 0 ? "active" : "idle"}
              onClick={firstReview ? () => onOpenTask(firstReview) : firstDone ? () => onOpenTask(firstDone) : undefined}
            />
          </div>
        </div>
        <div className="mt-3 border-t border-line pt-3">
          <div className="mb-2 flex items-center gap-2">
            <div className="text-[12.5px] font-semibold">启动前检查</div>
            <div className="ml-auto text-[11px] text-ink-3">多模型 → MCP → Skills → 场景</div>
            <button
              type="button"
              onClick={() => void runLinkCheck()}
              disabled={linkCheckBusy || ws.user.role !== "admin"}
              className="rounded-md border border-line bg-panel px-2 py-1 text-[11.5px] font-medium text-ink-2 hover:bg-sel hover:text-ink disabled:opacity-40"
              title={linkCheckButtonTitle}
            >
              {linkCheckButtonLabel}
            </button>
          </div>
          <div className="grid gap-2 md:grid-cols-4">
            <ReadinessItem
              ok={modelReady}
              label="模型通道"
              detail={modelReady ? `${ws.providers.filter((p) => p.has_key).length} 个真实模型；配置验收会逐个演练` : "当前 Mock，可先去设置接入 DeepSeek / SiliconFlow / 百炼"}
              action={onOpenSettings ? () => onOpenSettings("providers") : undefined}
              actionLabel={modelReady ? "测试" : "接入"}
            />
            <ReadinessItem
              ok={networkMcpReady}
              label="联网 MCP"
              detail={networkMcpReady ? `${enabledMcp.length} 个插件启用` : "调研类任务建议接入搜索 MCP"}
              action={onOpenSettings ? () => onOpenSettings("mcp") : undefined}
              actionLabel={networkMcpReady ? "查看" : "配置"}
            />
            <ReadinessItem
              ok={skillReady}
              label="工作方法"
              detail={skillReady ? `${enabledSkills.length} 个技能已启用` : "建议启用交付自查、来源约束等窄技能"}
              action={onOpenSettings ? () => onOpenSettings("skills") : undefined}
              actionLabel={skillReady ? "管理" : "启用"}
            />
            <ReadinessItem
              ok={channelReady}
              label="协作频道"
              detail={channelReady ? "已有团队频道，可启动演练" : "先创建一个团队频道"}
              action={() => ws.setView({ kind: "team" })}
              actionLabel="团队"
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {onRunAcceptance && (
              <button
                onClick={onRunAcceptance}
                disabled={scenarioBusy || (!channelReady && !acceptanceRun)}
                className="rounded-lg bg-ink px-3 py-1.5 text-[13px] font-medium text-paper hover:opacity-90 disabled:opacity-40"
                title={acceptanceButtonTitle}
              >
                {acceptanceButtonLabel}
              </button>
            )}
            {onStartScenario && scenarios === null &&
              [0, 1, 2].map((i) => (
                <span key={i} className="inline-block h-[34px] w-24 animate-pulse rounded-lg bg-sel" aria-hidden />
              ))}
            {onStartScenario && (scenarios ?? []).map((s) => {
              const active = scenarioBusy && activeScenarioId === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => onStartScenario(s.id)}
                  disabled={scenarioBusy || !channelReady}
                  className={`rounded-lg px-3 py-1.5 text-[13px] font-medium disabled:opacity-40 ${
                    s.id === "helio-core"
                      ? "bg-accent text-white hover:opacity-90"
                      : "border border-line text-ink-2 hover:bg-sel hover:text-ink"
                  }`}
                  title={s.desc}
                >
                  {active ? "启动中…" : s.title}
                </button>
              );
            })}
            <button
              onClick={() => ws.setView({ kind: "team" })}
              className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink-2 hover:bg-sel hover:text-ink"
            >
              查看团队
            </button>
            <button
              onClick={() => ws.setView({ kind: "inbox" })}
              className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink-2 hover:bg-sel hover:text-ink"
            >
              处理审批
            </button>
            {scenarioError && <span className="text-[12px] text-red-500">{scenarioError}</span>}
          </div>
          {acceptanceRun && (
            <div className="mt-3 rounded-lg border border-line bg-paper/70 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-semibold">闭环验收：{acceptanceRun.title}</div>
                  <div className="mt-0.5 text-[11.5px] text-ink-3">
                    {acceptanceRun.status === "done"
                      ? "项目已由人确认关闭。"
                      : acceptanceRun.status === "review"
                        ? `所有任务已进入终态：${acceptanceRun.delivered} 个已交付，${acceptanceRun.cancelled} 个已取消；等待人类复核并关单。`
                        : "AI 同事正在认领、执行和交付；完成后会进入待复核。"}
                  </div>
                </div>
                <span className="rounded bg-sel px-2 py-1 font-mono text-[11px] text-ink-3">
                  {acceptanceRun.delivered}/{acceptanceRun.total} delivered
                  {acceptanceRun.cancelled > 0 ? ` · ${acceptanceRun.cancelled} cancelled` : ""}
                </span>
                {acceptanceRun.status === "review" && (
                  <>
                    <button
                      type="button"
                      onClick={onOpenAcceptanceReview}
                      className="rounded-md border border-line bg-panel px-2.5 py-1 text-[12px] font-medium text-ink-2 hover:bg-sel hover:text-ink"
                    >
                      打开待复核
                    </button>
                    <button
                      type="button"
                      onClick={onCloseAcceptanceProject}
                      className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90"
                    >
                      确认关闭项目
                    </button>
                  </>
                )}
                {acceptanceRun.status === "done" && (
                  <button
                    type="button"
                    onClick={onOpenAcceptanceReview}
                    className="rounded-md border border-line bg-panel px-2.5 py-1 text-[12px] font-medium text-ink-2 hover:bg-sel hover:text-ink"
                  >
                    查看归档
                  </button>
                )}
              </div>
            </div>
          )}
          {visibleLinkCheckResults.length > 0 && (
            <div className="mt-3">
              {providerCheckResults.length > 0 && (
                <div className="mb-2 rounded-lg border border-line bg-panel px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-[12.5px] font-semibold">模型对比摘要</div>
                      <div className="mt-0.5 text-[11.5px] text-ink-3">
                        {providerCheckResults.length} 个模型通道已启动同构质量基准；{providerPassed} 通过，{providerFailed} 失败{providerWaiting > 0 ? `，${providerWaiting} 个等待审批` : ""}。
                        {providerBest
                          ? ` 当前可优先复核：${providerBest.label.replace("模型 · ", "")}。`
                          : providerWaiting > 0
                            ? " 先处理预算审批，再等待独立复核完成。"
                            : " 暂无通过项，先打开失败任务看错误。"}
                      </div>
                    </div>
                    <span className="rounded bg-sel px-2 py-1 font-mono text-[11px] text-ink-3">
                      {providerPassed}/{providerCheckResults.length} passed
                    </span>
                  </div>
                </div>
              )}
              <div className="grid gap-2 md:grid-cols-3">
                {visibleLinkCheckResults.map((item) => (
                  <div key={item.id} className="rounded-md border border-line bg-paper/70 px-2.5 py-2">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        item.status === "passed" ? "bg-emerald-500" : item.status === "failed" ? "bg-red-500" : "bg-amber-500"
                      }`}
                    />
                    <span className="text-[12px] font-medium">{item.label}</span>
                    <span className="ml-auto font-mono text-[10px] text-ink-3">{item.status}</span>
                  </div>
                  <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-ink-3" title={item.detail}>
                    {item.detail}
                  </div>
                  {item.taskId && (
                    <button
                      type="button"
                      onClick={() => void openLinkCheckTask(item.taskId)}
                      className="mt-1.5 rounded px-1.5 py-0.5 text-[11.5px] font-medium text-accent hover:bg-accent-soft"
                      title="打开该自检产生的任务详情、活动日志和交付物"
                    >
                      打开任务
                    </button>
                  )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {linkCheckProject && (
            <div className="mt-3 rounded-lg border border-line bg-paper/70 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-semibold">配置链路验收：{linkCheckProject.title}</div>
                  <div className="mt-0.5 text-[11.5px] text-ink-3">
                    {linkCheckClosed
                      ? "项目已由人确认关闭。"
                      : linkCheckReady
                        ? `模型/MCP/Skills 演练已进入终态：${linkCheckDelivered} 个已交付，${linkCheckCancelled} 个已取消；可人工关单。`
                        : "正在把所有已配置模型、MCP、Skills 演练任务收敛到同一项目。"}
                  </div>
                </div>
                <span className="rounded bg-sel px-2 py-1 font-mono text-[11px] text-ink-3">
                  {linkCheckDelivered}/{linkCheckTasks.length} delivered
                  {linkCheckCancelled > 0 ? ` · ${linkCheckCancelled} cancelled` : ""}
                </span>
                {linkCheckTasks.length > 0 && (
                  <button
                    type="button"
                    onClick={openLinkCheckProjectTask}
                    className="rounded-md border border-line bg-panel px-2.5 py-1 text-[12px] font-medium text-ink-2 hover:bg-sel hover:text-ink"
                  >
                    打开证据
                  </button>
                )}
                {linkCheckReady && !linkCheckClosed && (
                  <button
                    type="button"
                    onClick={() => void closeLinkCheckProject()}
                    className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90"
                  >
                    确认关闭配置验收
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-col gap-3">
        <div className="rounded-lg border border-line bg-panel p-3 shadow-sm">
          <div className="mb-2 flex items-center gap-2">
            <div className="text-[13px] font-semibold">需要你处理</div>
            <div className="ml-auto font-mono text-[10.5px] text-ink-3">{attentionItems.length}</div>
          </div>
          <div className="flex max-h-[182px] flex-col gap-1.5 overflow-y-auto pr-1">
            {attentionItems.length === 0 && (
              <div className="rounded-md bg-sel/60 px-3 py-4 text-center text-[12px] leading-relaxed text-ink-3">
                当前没有等待你处理的任务。AI 同事可继续认领、执行、交付，最终关单仍由你确认。
              </div>
            )}
            {attentionItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={item.onClick}
                className="rounded-md bg-sel/70 px-2.5 py-2 text-left hover:bg-sel"
              >
                <div className="flex items-center gap-1.5 text-[10.5px] text-ink-3">
                  <span
                    className={`rounded px-1.5 py-px font-medium ${
                      item.tone === "block"
                        ? "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300"
                        : item.tone === "review"
                          ? "bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300"
                          : "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300"
                    }`}
                  >
                    {item.label}
                  </span>
                  <span className="truncate">{item.meta}</span>
                </div>
                <div className="mt-1 line-clamp-2 text-[12.5px] font-medium leading-snug text-ink-2">{item.title}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-line bg-panel p-3 shadow-sm">
          <div className="mb-2 flex items-center gap-2">
            <div className="text-[13px] font-semibold">最新活动</div>
            <div className="ml-auto font-mono text-[10.5px] text-ink-3">{events.length}</div>
          </div>
          <div className="flex max-h-[148px] flex-col gap-1.5 overflow-y-auto pr-1">
            {events.length === 0 && <div className="py-4 text-center text-[12px] text-ink-3">暂无任务活动</div>}
            {events.map((e) => {
              const task = ws.tasks.find((t) => t.id === e.task_id);
              const agent = ws.agentById(e.agent_id);
              return (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => task && onOpenTask(task)}
                  className="rounded-md bg-sel/70 px-2 py-1.5 text-left hover:bg-sel"
                >
                  <div className="flex items-center gap-1.5 text-[10.5px] text-ink-3">
                    <span>{fmt(e.created_at)}</span>
                    <span className="rounded bg-panel px-1 font-mono">{EVENT_LABEL[e.type]}</span>
                    {agent && <span className="truncate">{agent.emoji} {agent.name}</span>}
                  </div>
                  <div className="mt-0.5 line-clamp-1 text-[12px] text-ink-2">
                    {task ? `${task.title}：` : ""}{e.summary}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

import { useMemo, useState } from "react";
import { ChevronRight, FileText, Paperclip, Search, Send, Workflow } from "lucide-react";
import { useWorkspace } from "../store";
import type { Task } from "../types";
import { computeWorkline } from "../lib/workline";
import { AgentAvatar } from "./Avatar";

type FocusIntent = "decision" | "document" | "project";

const FOCUS_SHORTCUTS: Array<{
  id: FocusIntent;
  label: string;
  prompt: string;
  icon: typeof Search;
}> = [
  {
    id: "decision",
    label: "调研并给出决策建议",
    prompt: "调研这个主题，给出有来源、可直接用于决策的结论和建议：",
    icon: Search,
  },
  {
    id: "document",
    label: "写一份可交付文档",
    prompt: "写一份可直接评审和交付的文档，主题是：",
    icon: FileText,
  },
  {
    id: "project",
    label: "规划并推进一个项目",
    prompt: "把这个目标拆成可执行计划，明确负责人、依赖、验收标准和下一步：",
    icon: Workflow,
  },
];

const ACCEPTANCE_BY_INTENT: Record<FocusIntent, string> = {
  decision: [
    "交付物：一份可直接支持决策的研究报告（report）",
    "1. 结论先行，明确推荐决策及适用边界",
    "2. 关键事实和数字给出可访问来源及检索日期",
    "3. 区分已核实事实、合理推断和待验证项",
    "4. 给出风险、备选方案与下一步负责人",
  ].join("\n"),
  document: [
    "交付物：一份可直接评审和使用的正式文档（report）",
    "1. 开头说明目标读者、使用场景和核心结论",
    "2. 结构完整，关键观点有任务内证据或来源",
    "3. 明确假设、范围边界、风险和待确认项",
    "4. 文末提供可执行的下一步和逐条自查",
  ].join("\n"),
  project: [
    "交付物：一份可直接启动执行的项目推进方案（report）",
    "1. 明确目标、非目标、阶段成果和优先级",
    "2. 每项行动包含负责人、依赖、退出条件和验收指标",
    "3. 标出需要人类输入或审批的节点",
    "4. 给出首个可执行动作、风险和停止条件",
  ].join("\n"),
};

function compactTitle(value: string) {
  const firstLine = value.split("\n").map((line) => line.trim()).find(Boolean) ?? "新任务";
  return firstLine.replace(/[：:，,。.!！?？]+$/g, "").slice(0, 64) || "新任务";
}

function ageLabel(createdAt: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - createdAt) / 60_000));
  if (minutes < 1) return "刚刚创建";
  if (minutes < 60) return `创建于 ${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `创建于 ${hours} 小时前`;
  return `创建于 ${Math.floor(hours / 24)} 天前`;
}

function taskState(task: Task, pendingApproval: boolean) {
  if (pendingApproval || task.status === "blocked") {
    return { label: "需要你处理", dot: "bg-amber-400", text: "text-amber-500" };
  }
  if (task.status === "review") {
    return { label: "等待你复核", dot: "bg-blue-400", text: "text-blue-400" };
  }
  if (task.status === "doing") {
    return { label: "AI 正在推进", dot: "bg-blue-400", text: "text-blue-400" };
  }
  return { label: "等待开工", dot: "bg-slate-400", text: "text-ink-3" };
}

export function FocusWorkspace({
  onOpenTask,
  onOpenFullBrief,
}: {
  onOpenTask: (task: Task) => void;
  onOpenFullBrief: () => void;
}) {
  const ws = useWorkspace();
  const [intent, setIntent] = useState<FocusIntent>("decision");
  const [goal, setGoal] = useState("");
  const [agentId, setAgentId] = useState(() => {
    const productAgent = ws.agents.find((agent) => /产品|研究|策略/.test(`${agent.name} ${agent.role}`));
    return productAgent?.id ?? ws.agents[0]?.id ?? "";
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const teamChannels = ws.channels.filter((channel) => channel.kind === "channel");
  const defaultChannelId = teamChannels[0]?.id ?? null;
  const selectedAgent = ws.agentById(agentId);
  const activeShortcut = FOCUS_SHORTCUTS.find((shortcut) => shortcut.id === intent);
  const goalReady = goal.trim().length >= 4 && goal.trim() !== activeShortcut?.prompt.trim();
  const snapshot = computeWorkline({
    tasks: ws.tasks,
    approvals: ws.approvals,
    agentById: ws.agentById,
    attentionLimit: 3,
  });
  const pendingApprovalTaskIds = new Set(snapshot.approvals.map((approval) => approval.ref_id).filter(Boolean));
  const visibleTasks = useMemo(() => {
    const priority = (task: Task) => {
      if (pendingApprovalTaskIds.has(task.id) || task.status === "blocked") return 0;
      if (task.status === "review") return 1;
      if (task.status === "doing") return 2;
      return 3;
    };
    return [...snapshot.active]
      .sort((a, b) => priority(a) - priority(b) || b.updated_at - a.updated_at)
      .slice(0, 3);
  }, [snapshot.active, pendingApprovalTaskIds]);

  function applyShortcut(nextIntent: FocusIntent, prompt: string) {
    setIntent(nextIntent);
    setGoal(prompt);
    setError("");
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLTextAreaElement>("[data-focus-goal]");
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    });
  }

  async function submitGoal() {
    const description = goal.trim();
    if (!goalReady || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const task = await ws.createTask({
        title: compactTitle(description),
        description,
        acceptance_criteria: ACCEPTANCE_BY_INTENT[intent],
        channel_id: defaultChannelId,
        assignee_agent_id: selectedAgent?.id ?? null,
        reviewer_agent_id: null,
        budget_billable: 16_000,
      });
      setGoal("");
      onOpenTask(task);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col px-4 pb-10 pt-8 sm:px-8 sm:pt-16 lg:pt-24">
      <section className="mx-auto w-full max-w-[800px]">
        <div className="text-center">
          <h1 className="text-[30px] font-semibold tracking-[-0.03em] text-ink sm:text-[40px]">今天要推进什么？</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3 sm:text-[14px]">告诉 AI 同事你的目标，团队会按简报推进并留下可复核交付。</p>
        </div>

        <div className="mt-7 overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_18px_50px_rgba(0,0,0,0.12)] focus-within:border-accent/50 sm:mt-8">
          <textarea
            data-focus-goal
            value={goal}
            onChange={(event) => {
              setGoal(event.target.value);
              if (error) setError("");
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submitGoal();
            }}
            placeholder="描述目标、期望交付和截止时间…"
            aria-label="今天要推进的目标"
            className="block min-h-[132px] w-full resize-none bg-transparent px-5 py-5 text-[15px] leading-7 text-ink outline-none placeholder:text-ink-3 sm:min-h-[148px] sm:px-6 sm:py-6"
          />
          <div className="flex flex-wrap items-center gap-2 border-t border-line/70 px-3 py-3 sm:px-4">
            <button
              type="button"
              onClick={onOpenFullBrief}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-3 hover:bg-sel hover:text-ink"
              title="打开完整任务简报"
              aria-label="打开完整任务简报"
            >
              <Paperclip size={18} strokeWidth={1.8} />
            </button>
            <label className="min-w-0 flex-1 sm:flex-none">
              <span className="sr-only">选择 AI 同事</span>
              <select
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
                className="h-9 max-w-full rounded-full border border-line bg-paper px-3 text-[12.5px] font-medium text-ink-2 outline-none hover:bg-sel focus:border-accent/50"
              >
                {ws.agents.length === 0 && <option value="">暂不指派</option>}
                {ws.agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.name} · 自动组队</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void submitGoal()}
              disabled={!goalReady || submitting}
              className="ml-auto flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-[13px] font-semibold text-white shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
              title="发送目标（⌘/Ctrl + Enter）"
            >
              <Send size={16} strokeWidth={2} />
              {submitting ? "发送中…" : "发送"}
            </button>
          </div>
        </div>
        {error && <div role="alert" className="mt-2 text-[12px] text-red-500">创建失败：{error}</div>}

        <div className="mt-4 divide-y divide-line/80">
          {FOCUS_SHORTCUTS.map((shortcut) => {
            const Icon = shortcut.icon;
            return (
              <button
                key={shortcut.id}
                type="button"
                onClick={() => applyShortcut(shortcut.id, shortcut.prompt)}
                className="group flex w-full items-center gap-4 px-3 py-3.5 text-left text-[13.5px] text-ink-2 hover:bg-sel/60 hover:text-ink"
              >
                <Icon size={19} strokeWidth={1.7} className="text-ink-3 group-hover:text-accent" />
                <span className="flex-1">{shortcut.label}</span>
                <ChevronRight size={17} strokeWidth={1.8} className="text-ink-3" />
              </button>
            );
          })}
        </div>
      </section>

      <section className="mt-12 sm:mt-14" aria-labelledby="active-task-heading">
        <div className="flex items-center gap-3 border-b border-line pb-3">
          <h2 id="active-task-heading" className="text-[16px] font-semibold">进行中的任务</h2>
          <span className="text-[12px] text-ink-3">{snapshot.active.length}</span>
          <button
            type="button"
            onClick={() => ws.setView({ kind: "tasks" })}
            className="ml-auto text-[12.5px] font-medium text-ink-3 hover:text-accent"
          >
            查看全部
          </button>
        </div>

        {visibleTasks.length === 0 ? (
          <div className="py-7 text-center text-[13px] text-ink-3">还没有进行中的任务。写下一个目标，AI 团队就会从这里开始。</div>
        ) : (
          <div className="divide-y divide-line">
            {visibleTasks.map((task) => {
              const pendingApproval = pendingApprovalTaskIds.has(task.id);
              const state = taskState(task, pendingApproval);
              const agent = ws.agentById(task.assignee_agent_id);
              return (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => onOpenTask(task)}
                  className="grid w-full gap-3 px-3 py-4 text-left hover:bg-sel/50 sm:grid-cols-[minmax(0,1fr)_190px_170px_76px] sm:items-center"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[13.5px] font-medium text-ink">{task.title}</span>
                    <span className="mt-1 block text-[11.5px] text-ink-3">{ageLabel(task.created_at)}</span>
                  </span>
                  <span className={`flex items-center gap-2 text-[12.5px] ${state.text}`}>
                    <span className={`h-2 w-2 rounded-full ${state.dot}`} />
                    {state.label}
                  </span>
                  <span className="flex items-center gap-2 text-[12.5px] text-ink-2">
                    {agent ? <AgentAvatar agent={agent} size={28} /> : <span className="h-7 w-7 rounded-full border border-line bg-sel" />}
                    <span className="min-w-0 truncate">{agent?.name ?? "待指派"}</span>
                  </span>
                  <span className="justify-self-start rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-accent sm:justify-self-end">
                    {pendingApproval || task.status === "blocked" || task.status === "review" ? "处理" : "查看"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

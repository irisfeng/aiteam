import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "../store";
import type { Task } from "../types";

type BriefPreset = {
  id: string;
  label: string;
  context: string;
  deliverable: string;
  criteria: string;
};

const BRIEF_PRESETS: BriefPreset[] = [
  {
    id: "research",
    label: "深度调研",
    context: "说明调研对象、要回答的决策问题、范围边界，以及已有信息或限制。",
    deliverable: "一份可直接支持决策的研究报告（report）",
    criteria: "核心结论先行，并给出证据链\n关键事实与数字注明来源及检索日期\n明确区分已核实事实、合理推断和待核实项\n结尾给出建议、风险与下一步",
  },
  {
    id: "solution",
    label: "产品方案",
    context: "说明目标用户、现状问题、业务目标、范围边界和已知约束。",
    deliverable: "一份可进入评审的产品方案或 PRD（report）",
    criteria: "包含目标、用户场景、范围与非目标\n给出关键流程、方案取舍和验收口径\n风险、依赖和待确认项清晰可追踪\n结论可执行，并明确下一步负责人",
  },
  {
    id: "slides",
    label: "演示文稿",
    context: "说明受众、演示目的、使用场景、时长，以及必须传达的核心观点。",
    deliverable: "一份可直接演示并可导出 PPTX 的幻灯片（slides）",
    criteria: "叙事主线完整，开头明确核心结论\n每页只承载一个主要观点，关键数据有来源\n包含必要的图表、对比或架构表达\n无溢出、无空页，并提供讲者备注",
  },
];

function cleanLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function TaskBriefComposer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (task: Task) => void;
}) {
  const ws = useWorkspace();
  const [title, setTitle] = useState("");
  const [context, setContext] = useState("");
  const [deliverable, setDeliverable] = useState("");
  const [criteria, setCriteria] = useState("");
  const [assignee, setAssignee] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [channelId, setChannelId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const teamChannels = useMemo(() => ws.channels.filter((channel) => channel.kind === "channel"), [ws.channels]);

  useEffect(() => {
    if (!open || channelId || teamChannels.length === 0) return;
    setChannelId(teamChannels[0].id);
  }, [channelId, open, teamChannels]);

  if (!open) return null;

  const required = [title.trim(), context.trim(), deliverable.trim(), criteria.trim()];
  const readyCount = required.filter(Boolean).length;
  const ready = readyCount === required.length;

  function applyPreset(preset: BriefPreset) {
    setContext(preset.context);
    setDeliverable(preset.deliverable);
    setCriteria(preset.criteria);
    setError("");
  }

  function resetAndClose() {
    if (submitting) return;
    setTitle("");
    setContext("");
    setDeliverable("");
    setCriteria("");
    setAssignee("");
    setReviewer("");
    setError("");
    onClose();
  }

  async function submit() {
    if (!ready || submitting) return;
    if (assignee && reviewer && assignee === reviewer) {
      setError("负责人和复核人不能是同一位；可留空让系统自动选择复核人。");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const acceptance = [
        `交付物：${deliverable.trim()}`,
        ...cleanLines(criteria).map((line, index) => `${index + 1}. ${line.replace(/^\d+[.、)\s]+/, "")}`),
      ].join("\n");
      const task = await ws.createTask({
        title: title.trim(),
        description: context.trim(),
        acceptance_criteria: acceptance,
        channel_id: channelId || null,
        assignee_agent_id: assignee || null,
        reviewer_agent_id: reviewer || null,
      });
      onCreated?.(task);
      setTitle("");
      setContext("");
      setDeliverable("");
      setCriteria("");
      setAssignee("");
      setReviewer("");
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button className="absolute inset-0 cursor-default bg-black/30" onClick={resetAndClose} aria-label="关闭任务简报" />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-brief-title"
        className="relative flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-paper shadow-2xl"
      >
        <header className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <h2 id="task-brief-title" className="text-[16px] font-semibold">新建任务简报</h2>
              <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${ready ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300" : "bg-sel text-ink-3"}`}>
                {readyCount}/4 已明确
              </span>
            </div>
            <p className="text-[12px] leading-relaxed text-ink-3">先把目标和输出说清楚，再交给 AI 开工；交付后会按这些标准逐条验收。</p>
          </div>
          <button onClick={resetAndClose} className="rounded-md px-2 py-1 text-[14px] text-ink-3 hover:bg-sel hover:text-ink" title="关闭">×</button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <div className="mb-2 text-[11.5px] font-medium text-ink-3">从高质量模板开始</div>
            <div className="flex flex-wrap gap-2">
              {BRIEF_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className="rounded-full border border-line bg-panel px-3 py-1.5 text-[12px] font-medium text-ink-2 hover:border-accent/40 hover:bg-accent-soft hover:text-accent"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <label className="block">
            <span className="text-[12px] font-semibold text-ink-2">任务标题 <span className="text-red-500">*</span></span>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="一句话说明要完成什么"
              className="mt-1.5 w-full rounded-lg border border-line bg-panel px-3 py-2 text-[13px] outline-none focus:border-accent/50"
            />
          </label>

          <label className="block">
            <span className="text-[12px] font-semibold text-ink-2">目标、背景与边界 <span className="text-red-500">*</span></span>
            <textarea
              value={context}
              onChange={(event) => setContext(event.target.value)}
              placeholder="为什么做、给谁用、范围到哪里、有哪些已知限制？"
              rows={4}
              className="mt-1.5 w-full resize-y rounded-lg border border-line bg-panel px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-accent/50"
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-[12px] font-semibold text-ink-2">预期交付物 <span className="text-red-500">*</span></span>
              <textarea
                value={deliverable}
                onChange={(event) => setDeliverable(event.target.value)}
                placeholder="例如：一份可直接评审的研究报告（report）"
                rows={3}
                className="mt-1.5 w-full resize-y rounded-lg border border-line bg-panel px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-accent/50"
              />
            </label>
            <label className="block">
              <span className="text-[12px] font-semibold text-ink-2">验收标准 <span className="text-red-500">*</span></span>
              <textarea
                value={criteria}
                onChange={(event) => setCriteria(event.target.value)}
                placeholder={"每行一条可核验标准\n例如：关键数字有来源"}
                rows={3}
                className="mt-1.5 w-full resize-y rounded-lg border border-line bg-panel px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-accent/50"
              />
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="text-[12px] font-semibold text-ink-2">负责人</span>
              <select
                value={assignee}
                onChange={(event) => {
                  setAssignee(event.target.value);
                  if (event.target.value && event.target.value === reviewer) setReviewer("");
                }}
                className="mt-1.5 w-full rounded-lg border border-line bg-panel px-2 py-2 text-[12.5px] text-ink-2 outline-none focus:border-accent/50"
              >
                <option value="">稍后指派</option>
                {ws.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.emoji} {agent.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-[12px] font-semibold text-ink-2">复核人</span>
              <select
                value={reviewer}
                onChange={(event) => setReviewer(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-line bg-panel px-2 py-2 text-[12.5px] text-ink-2 outline-none focus:border-accent/50"
              >
                <option value="">系统自动选择</option>
                {ws.agents.filter((agent) => agent.id !== assignee).map((agent) => <option key={agent.id} value={agent.id}>{agent.emoji} {agent.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-[12px] font-semibold text-ink-2">工作频道</span>
              <select
                value={channelId}
                onChange={(event) => setChannelId(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-line bg-panel px-2 py-2 text-[12.5px] text-ink-2 outline-none focus:border-accent/50"
              >
                <option value="">不关联频道</option>
                {teamChannels.map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
              </select>
            </label>
          </div>

          {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300">创建失败：{error}</div>}
        </div>

        <footer className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3.5">
          <div className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-ink-3">
            {assignee ? "创建后立即开工；系统会生成交付物、独立复核，最终由你确认关闭。" : "创建后进入待办；选定负责人时才会自动开工。"}
          </div>
          <button type="button" onClick={resetAndClose} disabled={submitting} className="rounded-lg border border-line px-3 py-2 text-[12.5px] text-ink-2 hover:bg-sel disabled:opacity-50">取消</button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!ready || submitting}
            className="rounded-lg bg-accent px-4 py-2 text-[12.5px] font-semibold text-white hover:opacity-90 disabled:opacity-40"
          >
            {submitting ? "创建中…" : assignee ? "创建并开工" : "保存为待办"}
          </button>
        </footer>
      </section>
    </div>
  );
}

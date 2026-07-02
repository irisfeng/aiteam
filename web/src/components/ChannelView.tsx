import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useWorkspace } from "../store";
import { api } from "../api";
import type { Doc, Message, Task } from "../types";
import { MessageItem } from "./MessageItem";
import { Composer } from "./Composer";
import { AgentAvatar } from "./Avatar";
import { TaskDetailDrawer } from "./TaskDetailDrawer";
import { computeWorkline } from "../lib/workline";
import { DOC_KIND_ICON } from "../lib/docMeta";

const DocViewerModal = lazy(() => import("./DocsView").then((m) => ({ default: m.DocViewerModal })));

const STATUS_LABEL: Record<Task["status"], string> = { todo: "待办", doing: "进行", blocked: "等待", review: "待评审", done: "完成" };

/** 频道右侧任务面板（Hive 设计：进度/产出物贴着对话看，不用切视图） */
function ChannelPanel({ channelId, onOpenDoc, onOpenTask }: { channelId: string; onOpenDoc: (d: Doc) => void; onOpenTask: (t: Task) => void }) {
  const ws = useWorkspace();
  const wl = computeWorkline({ tasks: ws.tasks, approvals: ws.approvals, channelId, agentById: ws.agentById, attentionLimit: 4 });
  const tasks = wl.tasks;
  const docs = ws.documents.filter((d) => d.channel_id === channelId).slice(0, 10);
  const order: Task["status"][] = ["doing", "blocked", "review", "todo", "done"];
  const active = wl.active;
  const sorted = [...active].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const taskIds = new Set(tasks.map((t) => t.id));
  const pendingApprovals = wl.approvals;
  const latestByTask = new Map<string, (typeof ws.taskEvents)[number]>();
  for (const e of ws.taskEvents) {
    if (e.task_id && taskIds.has(e.task_id)) latestByTask.set(e.task_id, e);
  }
  const doingCount = wl.running.length;
  const blockedCount = wl.blocked.length;
  const reviewCount = wl.review.length;
  const attentionItems = wl.attention.map((item) => ({
    ...item,
    onClick: () => (item.task ? onOpenTask(item.task) : ws.setView({ kind: "inbox" })),
  }));
  const nextAction =
    attentionItems[0]?.tone === "block"
      ? "先补输入"
      : attentionItems[0]?.tone === "review"
        ? "先看交付"
        : pendingApprovals.length > 0
          ? "先批请求"
          : doingCount > 0
            ? "观察执行"
            : active.length > 0
              ? "继续推进"
              : "发起任务";

  return (
    <aside className="flex w-[264px] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel/50 px-3 py-3">
      <div className="mb-3 rounded-lg border border-line bg-panel p-2.5">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[12.5px] font-semibold">运行线</span>
          <button
            onClick={() => ws.setView({ kind: "inbox" })}
            className="ml-auto rounded bg-accent-soft px-1.5 py-px text-[10.5px] text-ink-2 hover:text-accent"
            title="打开收件箱"
          >
            审批 {pendingApprovals.length}
          </button>
        </div>
        <div className="grid grid-cols-3 gap-1 text-center">
          <div className="rounded bg-sel px-1 py-1">
            <div className="font-mono text-[13px]">{doingCount}</div>
            <div className="text-[10px] text-ink-3">进行</div>
          </div>
          <div className="rounded bg-red-50 px-1 py-1 text-red-700 dark:bg-red-950/20 dark:text-red-300">
            <div className="font-mono text-[13px]">{blockedCount}</div>
            <div className="text-[10px] opacity-80">等待</div>
          </div>
          <div className="rounded bg-blue-50 px-1 py-1 text-blue-700 dark:bg-blue-950/20 dark:text-blue-300">
            <div className="font-mono text-[13px]">{reviewCount}</div>
            <div className="text-[10px] opacity-80">复核</div>
          </div>
        </div>
        <div className="mt-2 rounded-md bg-sel/70 px-2 py-1.5 text-[11.5px] text-ink-3">
          下一步：<span className="font-medium text-ink-2">{nextAction}</span>
        </div>
      </div>
      {attentionItems.length > 0 && (
        <>
          <div className="mb-1.5 flex items-baseline gap-1.5 px-1">
            <span className="text-[12.5px] font-semibold">需要处理</span>
            <span className="font-mono text-[10.5px] text-ink-3">{attentionItems.length}</span>
          </div>
          <div className="mb-3 flex flex-col gap-1">
            {attentionItems.map((item) => (
              <button
                key={item.id}
                onClick={item.onClick}
                className="w-full rounded-lg border border-line bg-panel px-2 py-1.5 text-left hover:border-accent/40"
                title={item.meta}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={`rounded px-1 font-mono text-[9.5px] leading-4 ${
                      item.tone === "block"
                        ? "bg-red-50 text-red-600 dark:bg-red-950/20 dark:text-red-300"
                        : item.tone === "review"
                          ? "bg-blue-50 text-blue-700 dark:bg-blue-950/20 dark:text-blue-300"
                          : "bg-amber-50 text-amber-700 dark:bg-amber-950/20 dark:text-amber-300"
                    }`}
                  >
                    {item.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px]">{item.title}</span>
                </div>
                <div className="mt-1 truncate text-[10.5px] text-ink-3">{item.meta}</div>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="mb-1.5 flex items-baseline gap-1.5 px-1">
        <span className="text-[12.5px] font-semibold">任务</span>
        <span className="font-mono text-[10.5px] text-ink-3">{active.length}</span>
      </div>
      {sorted.length === 0 && <div className="px-1 py-2 text-[12px] text-ink-3">本频道暂无进行中的任务</div>}
      <div className="flex flex-col gap-1">
        {sorted.map((t) => {
          const assignee = ws.agentById(t.assignee_agent_id);
          const latest = latestByTask.get(t.id);
          return (
            <button key={t.id} onClick={() => onOpenTask(t)} className="w-full rounded-lg border border-line bg-panel px-2 py-1.5 text-left hover:border-accent/40">
              <div className="flex items-center gap-1.5">
                <span
                  className={`rounded px-1 font-mono text-[9.5px] leading-4 ${
                    t.status === "doing"
                      ? "bg-accent-soft text-accent"
                      : t.status === "blocked"
                        ? "bg-red-50 text-red-600"
                        : "bg-sel text-ink-3"
                  }`}
                >
                  {STATUS_LABEL[t.status]}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px]" title={t.title}>
                  {t.title}
                </span>
                {assignee && <AgentAvatar agent={assignee} size={16} />}
              </div>
              {latest && <div className="mt-1 truncate text-[10.5px] text-ink-3">{latest.summary}</div>}
            </button>
          );
        })}
      </div>

      <div className="mt-4 mb-1.5 flex items-baseline gap-1.5 px-1">
        <span className="text-[12.5px] font-semibold">交付物</span>
        <span className="font-mono text-[10.5px] text-ink-3">{docs.length}</span>
      </div>
      {docs.length === 0 && <div className="px-1 py-2 text-[12px] text-ink-3">还没有交付物</div>}
      <div className="flex flex-col gap-1">
        {docs.map((d) => (
          <button
            key={d.id}
            onClick={() => onOpenDoc(d)}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2 py-1.5 text-left hover:border-accent/40"
          >
            <span className="text-[12px]">{DOC_KIND_ICON[d.kind] ?? "📄"}</span>
            <span className="min-w-0 flex-1 truncate text-[12px]" title={d.title}>
              {d.title}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}

export function ChannelView({ channelId }: { channelId: string }) {
  const ws = useWorkspace();
  const channel = ws.channels.find((c) => c.id === channelId);
  const messages = ws.messages[channelId] ?? [];
  const statuses = Object.values(ws.statuses[channelId] ?? {});
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [panelOpen, setPanelOpen] = useState(() => localStorage.getItem("aiteam-panel") !== "off");
  const [openDoc, setOpenDoc] = useState<Doc | null>(null);
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [replyTarget, setReplyTarget] = useState<Message | null>(null);

  function togglePanel() {
    setPanelOpen((o) => {
      localStorage.setItem("aiteam-panel", o ? "off" : "on");
      return !o;
    });
  }

  // 新内容到达时：若用户停留在底部则跟随滚动
  useEffect(() => {
    if (pinned) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, statuses, pinned]);

  if (!channel) return null;
  const members = (channel.agent_ids ?? []).map((id) => ws.agentById(id)).filter(Boolean);
  // 上下文余量表（Osaurus）：估算下一轮注入的频道转写体量（最近 40 条，中文 ≈ 1 字/token 粗估 ÷1.6）
  const ctxChars = messages.slice(-40).reduce((n, m) => n + m.content.length, 0);
  const ctxEstimate = Math.round(ctxChars / 1.6);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-paper px-5 py-3">
        <h1 className="text-[15px] font-semibold">
          {channel.kind === "dm" ? `${ws.agentById(channel.dm_agent_id)?.emoji ?? ""} ${channel.name}` : `# ${channel.name}`}
        </h1>
        <div className="ml-auto flex items-center -space-x-1.5">
          {members.map((a) => (
            <div key={a!.id} title={`${a!.name} · ${a!.role}`} className="rounded-lg ring-2 ring-paper">
              <AgentAvatar agent={a} size={24} />
            </div>
          ))}
        </div>
        <span className="font-mono text-[11px] text-ink-3">{members.length + 1} 名成员</span>
        <button
          onClick={() => {
            if (window.confirm(`清空 ${channel.kind === "dm" ? "本私信" : `#${channel.name}`} 的全部对话记录？任务与文档不受影响，此操作不可恢复。`))
              void ws.clearMessages(channelId);
          }}
          className="rounded px-1.5 py-0.5 text-[12px] text-ink-3 hover:bg-sel hover:text-red-500"
          title="清空对话记录（任务与文档保留）"
        >
          🧹
        </button>
        {channel.kind === "channel" && (
          <button
            onClick={togglePanel}
            className={`rounded px-1.5 py-0.5 font-mono text-[12px] ${panelOpen ? "bg-sel text-ink" : "text-ink-3 hover:bg-sel"}`}
            title={panelOpen ? "收起任务面板" : "展开任务面板"}
          >
            ⫿
          </button>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
        className="relative flex-1 overflow-y-auto py-3"
      >
        {messages.length === 0 && (
          <div className="px-6 py-10 text-center text-[13px] text-ink-3">
            这里还没有消息。直接发消息，或用 @ 指定一位 AI 同事开始协作。
          </div>
        )}
        {messages.map((m) => (
          <MessageItem key={m.id} message={m} onReply={setReplyTarget} />
        ))}
      </div>

      {!pinned && (
        <div className="relative">
          <button
            onClick={() => {
              setPinned(true);
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
            }}
            className="absolute -top-10 right-5 rounded-full bg-accent px-3 py-1 text-[12px] font-medium text-white shadow"
          >
            跳到最新 ↓
          </button>
        </div>
      )}

      {statuses.length > 0 && (
        <div className="flex items-center gap-2 px-5 pb-1 text-[12.5px] text-ink-2">
          <span className="inline-flex gap-0.5">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:0ms]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:120ms]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:240ms]" />
          </span>
          <span className="min-w-0 truncate">
            {statuses
              .map((s) => {
                const name = ws.agentById(s.agent_id)?.name ?? "AI";
                const verb = s.state === "thinking" ? "正在思考…" : s.state === "tool" ? s.detail ?? "正在使用工具…" : "正在输入…";
                return `${name} ${verb}`;
              })
              .join("　")}
          </span>
          <button
            onClick={() => void api.stopChannel(channelId)}
            className="ml-auto shrink-0 rounded-md border border-line px-2 py-0.5 text-[11.5px] text-ink-3 transition-colors hover:border-red-300 hover:text-red-500"
            title="停止本频道正在跑的 AI 运行（含聊天回复）"
          >
            ⏹ 停止
          </button>
        </div>
      )}

      <Composer
        placeholder={channel.kind === "dm" ? `给 ${channel.name} 发私信` : `发送到 #${channel.name}`}
        agents={members as NonNullable<(typeof members)[number]>[]}
        onSend={async (content) => {
          await ws.send(channelId, content, replyTarget?.id ?? null);
          setReplyTarget(null);
        }}
        contextHint={ctxEstimate}
        replyTo={
          replyTarget
            ? {
                author: replyTarget.author_type === "user" ? ws.user.name : ws.agentById(replyTarget.author_id)?.name ?? "AI",
                snippet: replyTarget.content.slice(0, 60),
                onCancel: () => setReplyTarget(null),
              }
            : undefined
        }
      />
        </div>
        {panelOpen && channel.kind === "channel" && (
          <ChannelPanel channelId={channelId} onOpenDoc={setOpenDoc} onOpenTask={setOpenTask} />
        )}
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

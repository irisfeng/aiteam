import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "../store";
import type { Doc, Message, Task } from "../types";
import { MessageItem } from "./MessageItem";
import { Composer } from "./Composer";
import { AgentAvatar } from "./Avatar";
import { DocViewerModal, docKindMeta } from "./DocsView";

const STATUS_LABEL: Record<Task["status"], string> = { todo: "待办", doing: "进行", review: "待评审", done: "完成" };

/** 频道右侧任务面板（Hive 设计：进度/产出物贴着对话看，不用切视图） */
function ChannelPanel({ channelId, onOpenDoc }: { channelId: string; onOpenDoc: (d: Doc) => void }) {
  const ws = useWorkspace();
  const tasks = ws.tasks.filter((t) => t.channel_id === channelId);
  const docs = ws.documents.filter((d) => d.channel_id === channelId).slice(0, 10);
  const order: Task["status"][] = ["doing", "review", "todo", "done"];
  const active = tasks.filter((t) => t.status !== "done");
  const sorted = [...active].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));

  return (
    <aside className="flex w-[264px] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel/50 px-3 py-3">
      <div className="mb-1.5 flex items-baseline gap-1.5 px-1">
        <span className="text-[12.5px] font-semibold">任务</span>
        <span className="font-mono text-[10.5px] text-ink-3">{active.length}</span>
      </div>
      {sorted.length === 0 && <div className="px-1 py-2 text-[12px] text-ink-3">本频道暂无进行中的任务</div>}
      <div className="flex flex-col gap-1">
        {sorted.map((t) => {
          const assignee = ws.agentById(t.assignee_agent_id);
          return (
            <div key={t.id} className="rounded-lg border border-line bg-panel px-2 py-1.5">
              <div className="flex items-center gap-1.5">
                <span
                  className={`rounded px-1 font-mono text-[9.5px] leading-4 ${
                    t.status === "doing" ? "bg-accent-soft text-accent" : "bg-sel text-ink-3"
                  }`}
                >
                  {STATUS_LABEL[t.status]}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px]" title={t.title}>
                  {t.title}
                </span>
                {assignee && <AgentAvatar agent={assignee} size={16} />}
              </div>
            </div>
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
            <span className="text-[12px]">{docKindMeta(d.kind).icon}</span>
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
          {statuses
            .map((s) => {
              const name = ws.agentById(s.agent_id)?.name ?? "AI";
              const verb = s.state === "thinking" ? "正在思考…" : s.state === "tool" ? s.detail ?? "正在使用工具…" : "正在输入…";
              return `${name} ${verb}`;
            })
            .join("　")}
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
        {panelOpen && channel.kind === "channel" && <ChannelPanel channelId={channelId} onOpenDoc={setOpenDoc} />}
      </div>
      {openDoc && <DocViewerModal doc={openDoc} onClose={() => setOpenDoc(null)} />}
    </div>
  );
}

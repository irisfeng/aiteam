import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "../store";
import { MessageItem } from "./MessageItem";
import { Composer } from "./Composer";
import { AgentAvatar } from "./Avatar";

export function ChannelView({ channelId }: { channelId: string }) {
  const ws = useWorkspace();
  const channel = ws.channels.find((c) => c.id === channelId);
  const messages = ws.messages[channelId] ?? [];
  const statuses = Object.values(ws.statuses[channelId] ?? {});
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // 新内容到达时：若用户停留在底部则跟随滚动
  useEffect(() => {
    if (pinned) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, statuses, pinned]);

  if (!channel) return null;
  const members = (channel.agent_ids ?? []).map((id) => ws.agentById(id)).filter(Boolean);

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
        <span className="text-[12px] text-ink-3">{members.length + 1} 名成员</span>
      </header>

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
          <MessageItem key={m.id} message={m} />
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
        onSend={(content) => ws.send(channelId, content)}
      />
    </div>
  );
}

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "../types";
import { useWorkspace } from "../store";
import { AgentAvatar, AiBadge, UserAvatar } from "./Avatar";

function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function usageLabel(usageJson: string | null): string | null {
  if (!usageJson) return null;
  try {
    const u = JSON.parse(usageJson);
    if (!u.input_tokens && !u.output_tokens) return null;
    return `${u.input_tokens.toLocaleString()} in · ${u.output_tokens.toLocaleString()} out tokens`;
  } catch {
    return null;
  }
}

export const MessageItem = memo(function MessageItem({ message }: { message: Message }) {
  const ws = useWorkspace();

  if (message.author_type === "system") {
    return (
      <div className="my-2 px-4 text-center text-[12px] text-ink-3">
        {message.content} · {fmtTime(message.created_at)}
      </div>
    );
  }

  const isAgent = message.author_type === "agent";
  const agent = isAgent ? ws.agentById(message.author_id) : undefined;
  const name = isAgent ? agent?.name ?? "AI" : ws.user.name;
  const usage = usageLabel(message.usage_json);

  return (
    <div className="group flex gap-3 px-4 py-2 hover:bg-panel/60">
      {isAgent ? <AgentAvatar agent={agent} /> : <UserAvatar name={name} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[13.5px] font-semibold">{name}</span>
          {isAgent && <AiBadge />}
          <span className="text-[11.5px] text-ink-3">{fmtTime(message.created_at)}</span>
        </div>
        <div className={`md mt-0.5 text-[14px] ${message.status === "streaming" ? "stream-cursor" : ""}`}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        </div>
        {message.status === "error" && (
          <div className="mt-1 text-[12px] text-red-500">回复中断</div>
        )}
        {usage && (
          <div className="mt-1 text-[11px] text-ink-3 opacity-0 transition-opacity group-hover:opacity-100">
            {usage}
          </div>
        )}
      </div>
    </div>
  );
});

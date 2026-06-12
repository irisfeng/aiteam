import { useRef, useState } from "react";
import type { Agent } from "../types";

export function Composer({
  placeholder,
  agents,
  onSend,
}: {
  placeholder: string;
  agents: Agent[];
  onSend: (content: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const candidates =
    mentionQuery === null
      ? []
      : agents.filter((a) => a.name.toLowerCase().includes(mentionQuery.toLowerCase()));

  function detectMention(text: string, caret: number) {
    const before = text.slice(0, caret);
    const m = before.match(/@([^\s@]*)$/);
    setMentionQuery(m ? m[1] : null);
  }

  function pickMention(agent: Agent) {
    const el = textareaRef.current;
    if (!el) return;
    const caret = el.selectionStart;
    const before = value.slice(0, caret).replace(/@([^\s@]*)$/, `@${agent.name} `);
    const next = before + value.slice(caret);
    setValue(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = before.length;
    });
  }

  async function submit() {
    const content = value.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await onSend(content);
      setValue("");
      setMentionQuery(null);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="relative px-4 pb-4">
      {candidates.length > 0 && (
        <div className="absolute bottom-full left-4 z-10 mb-1 w-64 overflow-hidden rounded-lg border border-line bg-panel shadow-lg">
          {candidates.map((a) => (
            <button
              key={a.id}
              onMouseDown={(e) => {
                e.preventDefault();
                pickMention(a);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13.5px] hover:bg-accent-soft"
            >
              <span>{a.emoji}</span>
              <span className="font-medium">{a.name}</span>
              <span className="truncate text-[12px] text-ink-3">{a.role}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 rounded-xl border border-line bg-panel px-3 py-2 focus-within:border-accent/50">
        <textarea
          ref={textareaRef}
          value={value}
          rows={Math.min(6, Math.max(1, value.split("\n").length))}
          placeholder={placeholder}
          className="max-h-40 flex-1 resize-none bg-transparent py-1 text-[14px] outline-none placeholder:text-ink-3"
          onChange={(e) => {
            setValue(e.target.value);
            detectMention(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
            if (e.key === "Escape") setMentionQuery(null);
          }}
        />
        <button
          onClick={() => void submit()}
          disabled={!value.trim() || sending}
          className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
        >
          发送
        </button>
      </div>
      <div className="mt-1.5 px-1 text-[11.5px] text-ink-3">
        Enter 发送 · Shift+Enter 换行 · @ 指定 AI 同事
      </div>
    </div>
  );
}

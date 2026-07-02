import { useRef, useState, type ChangeEvent } from "react";
import { api } from "../api";
import type { Agent } from "../types";

export function Composer({
  placeholder,
  agents,
  onSend,
  contextHint,
  replyTo,
}: {
  placeholder: string;
  agents: Agent[];
  onSend: (content: string) => Promise<void>;
  /** 下一轮对话上下文的估算 tokens（Osaurus 式余量表） */
  contextHint?: number;
  /** 引用回复目标（预览条，可取消） */
  replyTo?: { author: string; snippet: string; onCancel: () => void };
}) {
  const [value, setValue] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许重复选同一文件
    if (file) await uploadSourceFile(file);
  }

  async function uploadSourceFile(file: File) {
    if (uploading) return;
    setUploading(true);
    try {
      const doc = await api.uploadDoc(file); // 抽文本 → 存为 source 文档（经 WS 自动进文档库，AI 可 read_document）
      // 回填引用：让用户补一句指令再发；不自动发，避免误触发 AI 运行
      setValue((v) => (v.trim() ? `${v.replace(/\s*$/, "")} [来源：《${doc.title}》] ` : `请基于来源文档《${doc.title}》：`));
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (err) {
      window.alert("上传失败：" + ((err as Error)?.message ?? err));
    } finally {
      setUploading(false);
    }
  }

  async function chooseSourceFile() {
    if (window.aiteamDesktop?.pickFile) {
      try {
        const picked = await window.aiteamDesktop.pickFile("source");
        if (!picked.canceled) {
          await uploadSourceFile(new File([new Uint8Array(picked.file.bytes)], picked.file.name));
        }
      } catch (err) {
        window.alert("选择文件失败：" + ((err as Error)?.message ?? err));
      }
      return;
    }
    fileRef.current?.click();
  }

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
      {replyTo && (
        <div className="mb-1 flex items-center gap-2 rounded-lg border border-line bg-sel/70 px-3 py-1.5 text-[12px] text-ink-2">
          <span className="font-mono text-ink-3">↩</span>
          <span className="min-w-0 flex-1 truncate">
            回复 <span className="font-medium">{replyTo.author}</span>：{replyTo.snippet}
          </span>
          <button onClick={replyTo.onCancel} className="rounded px-1 text-ink-3 hover:bg-sel hover:text-ink" title="取消引用">
            ✕
          </button>
        </div>
      )}
      <div className="flex items-end gap-2 rounded-xl border border-line bg-panel px-3 py-2 focus-within:border-accent/50">
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          accept=".txt,.md,.markdown,.csv,.tsv,.json,.log,.yaml,.yml,.xml,.pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.epub,.html,.htm"
          onChange={onPickFile}
        />
        <button
          type="button"
          onClick={() => void chooseSourceFile()}
          disabled={uploading}
          title="上传来源文档（PDF/Word/PPT/Excel/txt 等，自动转文本供 AI 读取；截图无法读取，请用文字描述）"
          className="shrink-0 rounded-lg px-1.5 py-1 text-[15px] leading-none text-ink-3 hover:bg-accent-soft hover:text-accent disabled:opacity-40"
        >
          {uploading ? "⏳" : "📎"}
        </button>
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
      <div className="mt-1.5 flex items-center px-1 text-[11.5px] text-ink-3">
        <span>Enter 发送 · Shift+Enter 换行 · @ 指定 AI 同事</span>
        {contextHint !== undefined && contextHint > 0 && (
          <span className="ml-auto font-mono text-[10.5px]" title="下一轮注入的频道上下文估算（窗口为最近 40 条）">
            ~{contextHint >= 1000 ? `${(contextHint / 1000).toFixed(1)}k` : contextHint} ctx
          </span>
        )}
      </div>
    </div>
  );
}

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useWorkspace } from "../store";
import type { Doc } from "../types";
import { AgentAvatar } from "./Avatar";

function fmt(ts: number) {
  return new Date(ts).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function DocViewerModal({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const ws = useWorkspace();
  const author = ws.agentById(doc.agent_id);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-6" onMouseDown={onClose}>
      <div
        className="flex max-h-full w-[760px] flex-col overflow-hidden rounded-xl border border-line bg-white shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <span className="text-[15px] font-semibold">{doc.title}</span>
          <span className="text-[12px] text-ink-3">
            {author ? `${author.emoji} ${author.name}` : "用户"} · {fmt(doc.created_at)}
          </span>
          <button onClick={onClose} className="ml-auto rounded px-1.5 text-ink-3 hover:bg-panel">✕</button>
        </div>
        <div className="md flex-1 overflow-y-auto px-6 py-4 text-[14px]">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.content}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

export function DocsView() {
  const ws = useWorkspace();
  const [openDoc, setOpenDoc] = useState<Doc | null>(null);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3">
        <h1 className="text-[15px] font-semibold">文档</h1>
        <span className="text-[12px] text-ink-3">AI 同事交付的正式产出都沉淀在这里</span>
      </header>
      <div className="flex-1 overflow-y-auto p-5">
        {ws.documents.length === 0 && (
          <div className="py-10 text-center text-[13px] text-ink-3">
            还没有文档。把任务指派给 AI 同事，交付物会自动出现在这里。
          </div>
        )}
        <div className="mx-auto flex max-w-2xl flex-col gap-2">
          {ws.documents.map((d) => {
            const author = ws.agentById(d.agent_id);
            const task = ws.tasks.find((t) => t.id === d.task_id);
            return (
              <button
                key={d.id}
                onClick={() => setOpenDoc(d)}
                className="flex items-center gap-3 rounded-xl border border-line bg-white p-3.5 text-left shadow-sm hover:border-accent/40"
              >
                <span className="text-lg">📄</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium">{d.title}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-[12px] text-ink-3">
                    {author && (
                      <span className="flex items-center gap-1">
                        <AgentAvatar agent={author} size={14} /> {author.name}
                      </span>
                    )}
                    {task && <span className="truncate">任务「{task.title}」</span>}
                    <span>{fmt(d.created_at)}</span>
                    <span>{d.content.length.toLocaleString()} 字</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
      {openDoc && <DocViewerModal doc={openDoc} onClose={() => setOpenDoc(null)} />}
    </div>
  );
}

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useWorkspace } from "../store";
import type { Doc } from "../types";
import { AgentAvatar } from "./Avatar";

function fmt(ts: number) {
  return new Date(ts).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function docKindMeta(kind: Doc["kind"]) {
  switch (kind) {
    case "slides":
      return { icon: "🖥️", label: "演示文稿", ext: ".md", mime: "text/markdown", hint: "Marp 格式，可直接生成 PPT" };
    case "sheet":
      return { icon: "📊", label: "数据表", ext: ".csv", mime: "text/csv", hint: "CSV，可导入 Excel" };
    default:
      return { icon: "📄", label: "报告", ext: ".md", mime: "text/markdown", hint: "Markdown" };
  }
}

function download(doc: Doc) {
  const meta = docKindMeta(doc.kind);
  const isCsv = doc.kind === "sheet" && !doc.content.trimStart().startsWith("|");
  const blob = new Blob([doc.content], { type: isCsv ? "text/csv" : "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = doc.title.replace(/[\\/:*?"<>|]/g, "_") + (isCsv ? ".csv" : meta.ext);
  a.click();
  URL.revokeObjectURL(url);
}

/** 简易 CSV 解析：支持双引号包裹与 "" 转义 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/** Marp 风格分页：--- 单独成行作为页分隔；跳过 frontmatter（全部为 key: value 的首段） */
function splitSlides(content: string): string[] {
  const pages = content.replace(/^\s*---\s*\n/, "").split(/\n\s*---\s*\n/).map((p) => p.trim());
  const isFrontmatter = (s: string) =>
    s !== "" && s.split("\n").every((line) => line.trim() === "" || /^[\w-]+\s*:/.test(line.trim()));
  return pages.filter((p, i) => p !== "" && !(i === 0 && isFrontmatter(p)));
}

function SheetTable({ content }: { content: string }) {
  if (content.trimStart().startsWith("|")) {
    // Markdown 表格直接走 md 渲染
    return (
      <div className="md text-[13.5px]">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    );
  }
  const rows = parseCsv(content).slice(0, 500);
  if (rows.length === 0) return <div className="text-[13px] text-ink-3">（空表）</div>;
  const [head, ...body] = rows;
  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-[13px]">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} className="border border-line bg-sel px-2.5 py-1.5 text-left font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>
              {r.map((cell, ci) => (
                <td key={ci} className="border border-line px-2.5 py-1.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SlidesPreview({ content }: { content: string }) {
  const pages = splitSlides(content);
  return (
    <div className="flex flex-col gap-4">
      {pages.map((page, i) => (
        <div key={i} className="relative aspect-video w-full overflow-hidden rounded-lg border border-line bg-panel shadow-sm">
          <div className="md h-full overflow-y-auto p-8 text-[14px]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{page}</ReactMarkdown>
          </div>
          <span className="absolute bottom-2 right-3 text-[11px] text-ink-3">
            {i + 1} / {pages.length}
          </span>
        </div>
      ))}
    </div>
  );
}

export function DocViewerModal({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const ws = useWorkspace();
  const author = ws.agentById(doc.agent_id);
  const meta = docKindMeta(doc.kind);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onMouseDown={onClose}>
      <div
        className="flex max-h-full w-[820px] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <span>{meta.icon}</span>
          <span className="text-[15px] font-semibold">{doc.title}</span>
          <span className="rounded bg-sel px-1.5 py-px text-[11px] text-ink-2" title={meta.hint}>
            {meta.label}
          </span>
          <span className="text-[12px] text-ink-3">
            {author ? `${author.emoji} ${author.name}` : "用户"} · {fmt(doc.created_at)}
          </span>
          <button
            onClick={() => download(doc)}
            className="ml-auto rounded-lg border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:bg-sel"
            title={meta.hint}
          >
            ⬇ 下载{doc.kind === "sheet" && !doc.content.trimStart().startsWith("|") ? " .csv" : " .md"}
          </button>
          <button onClick={onClose} className="rounded px-1.5 text-ink-3 hover:bg-sel">✕</button>
        </div>
        <div className={`flex-1 overflow-y-auto px-6 py-4 ${doc.kind === "slides" ? "bg-sel/40" : ""}`}>
          {doc.kind === "slides" ? (
            <SlidesPreview content={doc.content} />
          ) : doc.kind === "sheet" ? (
            <SheetTable content={doc.content} />
          ) : (
            <div className="md text-[14px]">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.content}</ReactMarkdown>
            </div>
          )}
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
        <span className="text-[12px] text-ink-3">AI 同事交付的报告、演示文稿与数据表都沉淀在这里</span>
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
            const meta = docKindMeta(d.kind);
            return (
              <button
                key={d.id}
                onClick={() => setOpenDoc(d)}
                className="flex items-center gap-3 rounded-xl border border-line bg-panel p-3.5 text-left shadow-sm hover:border-accent/40"
              >
                <span className="text-lg" title={meta.label}>{meta.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium">{d.title}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-[12px] text-ink-3">
                    <span className="rounded bg-panel px-1 text-[11px]">{meta.label}</span>
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

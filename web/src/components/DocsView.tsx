import { useRef, useState } from "react";
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

/** Word 兼容导出：HTML 包裹为 .doc，Word/WPS 直接打开且保留排版 */
function exportWord(title: string, bodyHtml: string) {
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta charset="utf-8"><title>${title}</title><style>
body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;font-size:11pt;line-height:1.7;color:#26241f;max-width:18cm;margin:auto;}
h1{font-size:20pt;border-bottom:2px solid #c28a1e;padding-bottom:6pt;}h2{font-size:15pt;margin-top:16pt;}h3{font-size:12.5pt;}
table{border-collapse:collapse;width:100%;margin:8pt 0;}th,td{border:1pt solid #d9d4c8;padding:4pt 8pt;font-size:10pt;}
th{background:#f3efe4;}code{background:#f3f1eb;padding:1pt 4pt;font-family:Consolas,monospace;font-size:9.5pt;}
pre{background:#f6f4ef;border:1pt solid #e6e3db;padding:8pt;font-family:Consolas,monospace;font-size:9pt;white-space:pre-wrap;}
blockquote{border-left:3pt solid #c28a1e;margin-left:0;padding-left:10pt;color:#6b675e;}
</style></head><body><h1>${title}</h1>${bodyHtml}</body></html>`;
  const blob = new Blob(["\ufeff", html], { type: "application/msword" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = title.replace(/[\\/:*?"<>|]/g, "_") + ".doc";
  a.click();
  URL.revokeObjectURL(url);
}

/** 打印/另存 PDF：新窗口注入排版样式后调起系统打印 */
function printDoc(title: string, bodyHtml: string, slides: boolean) {
  const w = window.open("", "_blank", "width=900,height=700");
  if (!w) return;
  w.document.write(`<html><head><meta charset="utf-8"><title>${title}</title><style>
body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;font-size:12px;line-height:1.75;color:#26241f;margin:2cm;}
h1,h2,h3{color:#26241f;}h1{border-bottom:2px solid #c28a1e;padding-bottom:6px;}
table{border-collapse:collapse;width:100%;}th,td{border:1px solid #d9d4c8;padding:4px 8px;}th{background:#f3efe4;}
pre{background:#f6f4ef;border:1px solid #e6e3db;padding:10px;white-space:pre-wrap;font-size:11px;}
${slides ? ".slide-page{page-break-after:always;border:none!important;box-shadow:none!important;aspect-ratio:auto!important;padding:1cm 0;}" : ""}
@media print { a { color: inherit; text-decoration: none; } }
</style></head><body>${slides ? "" : `<h1>${title}</h1>`}${bodyHtml}</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
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

function SheetChart({ rows }: { rows: string[][] }) {
  const [head, ...body] = rows;
  // 取第一列为标签，第一个"多数行可解析为数字"的列为数值
  let valueCol = -1;
  for (let c = 1; c < head.length; c++) {
    const ok = body.filter((r) => r[c] !== undefined && r[c] !== "" && !isNaN(parseFloat(String(r[c]).replace(/[%,￥$]/g, ""))));
    if (ok.length >= Math.max(1, body.length * 0.6)) { valueCol = c; break; }
  }
  if (valueCol === -1) return <div className="text-[12.5px] text-ink-3">没有可作图的数值列，请切回表格视图。</div>;
  const items = body.slice(0, 30).map((r) => ({
    label: r[0] ?? "",
    value: parseFloat(String(r[valueCol] ?? "0").replace(/[%,￥$]/g, "")) || 0,
  }));
  const max = Math.max(1, ...items.map((i) => Math.abs(i.value)));
  return (
    <div>
      <div className="mb-2 text-[12px] text-ink-3">{head[0]} × {head[valueCol]}（前 {items.length} 行）</div>
      <div className="flex flex-col gap-1.5">
        {items.map((it, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-36 shrink-0 truncate text-right text-[12px] text-ink-2" title={it.label}>{it.label}</span>
            <div className="h-4 rounded bg-accent/80" style={{ width: `${(Math.abs(it.value) / max) * 100}%`, minWidth: 2 }} />
            <span className="font-mono text-[11px] text-ink-2">{it.value.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SheetTable({ content }: { content: string }) {
  const [mode, setMode] = useState<"table" | "chart">("table");
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
    <div>
      <div className="mb-2 flex gap-1">
        {(["table", "chart"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`rounded px-2 py-0.5 text-[12px] ${mode === m ? "bg-sel font-medium text-ink" : "text-ink-3 hover:bg-sel/60"}`}
          >
            {m === "table" ? "表格" : "📊 图表"}
          </button>
        ))}
      </div>
      {mode === "chart" ? (
        <SheetChart rows={rows} />
      ) : (
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
      )}
    </div>
  );
}

function SlidesPreview({ content }: { content: string }) {
  const pages = splitSlides(content);
  return (
    <div className="flex flex-col gap-4">
      {pages.map((page, i) => (
        <div key={i} className="slide-page relative aspect-video w-full overflow-hidden rounded-lg border border-line bg-panel shadow-sm">
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
  const contentRef = useRef<HTMLDivElement>(null);
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
            ⬇{doc.kind === "sheet" && !doc.content.trimStart().startsWith("|") ? " .csv" : " .md"}
          </button>
          <button
            onClick={() => contentRef.current && exportWord(doc.title, contentRef.current.innerHTML)}
            className="rounded-lg border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:bg-sel"
            title="导出为 Word 可打开的 .doc（保留排版）"
          >
            Word
          </button>
          <button
            onClick={() => contentRef.current && printDoc(doc.title, contentRef.current.innerHTML, doc.kind === "slides")}
            className="rounded-lg border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:bg-sel"
            title="系统打印对话框中可另存为 PDF；演示文稿按页分页"
          >
            🖨 PDF
          </button>
          <button onClick={onClose} className="rounded px-1.5 text-ink-3 hover:bg-sel">✕</button>
        </div>
        <div ref={contentRef} className={`flex-1 overflow-y-auto px-6 py-4 ${doc.kind === "slides" ? "bg-sel/40" : ""}`}>
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

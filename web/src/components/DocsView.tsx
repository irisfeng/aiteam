import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts";
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

const num = (v: unknown) => parseFloat(String(v ?? "").replace(/[%,￥$\s]/g, ""));

function cssVar(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** ECharts 数据可视化：自动识别全部数值列（多系列），柱/折线/饼三种视图，跟随主题色 */
function SheetChart({ rows }: { rows: string[][] }) {
  const [head, ...allBody] = rows;
  const body = allBody.slice(0, 60);
  const [type, setType] = useState<"bar" | "line" | "pie">("bar");
  const ref = useRef<HTMLDivElement>(null);

  // 数值列 = 60% 以上行可解析为数字的列（第一列固定作为标签）
  const valueCols: number[] = [];
  for (let c = 1; c < head.length; c++) {
    const ok = body.filter((r) => r[c] !== undefined && r[c] !== "" && !isNaN(num(r[c])));
    if (ok.length >= Math.max(1, body.length * 0.6)) valueCols.push(c);
  }

  useEffect(() => {
    const el = ref.current;
    if (!el || valueCols.length === 0) return;
    const ink = cssVar("--t-ink", "#26241f");
    const dim = cssVar("--t-dim", "#8a877e");
    const line = cssVar("--t-line", "#e6e3db");
    const accent = cssVar("--t-accent", "#c28a1e");
    const palette = [accent, "#7c9a6d", "#5e87b0", "#b06a5e", "#8a7ab0", "#b0985e"];
    const labels = body.map((r) => r[0] ?? "");
    const chart = echarts.init(el);
    const axisStyle = {
      axisLabel: { color: dim, fontSize: 11 },
      axisLine: { lineStyle: { color: line } },
      splitLine: { lineStyle: { color: line } },
    };
    chart.setOption({
      color: palette,
      textStyle: { color: ink },
      tooltip: { trigger: type === "pie" ? "item" : "axis", textStyle: { fontSize: 12 } },
      legend: valueCols.length > 1 || type === "pie"
        ? { textStyle: { color: dim, fontSize: 11 }, top: 0 }
        : undefined,
      grid: type === "pie" ? undefined : { left: 8, right: 16, top: valueCols.length > 1 ? 32 : 16, bottom: 8, containLabel: true },
      xAxis: type === "pie" ? undefined : { type: "category", data: labels, ...axisStyle },
      yAxis: type === "pie" ? undefined : { type: "value", ...axisStyle },
      series:
        type === "pie"
          ? [{
              type: "pie",
              radius: ["32%", "68%"],
              label: { color: ink, fontSize: 11, formatter: "{b}: {c}" },
              data: body.map((r) => ({ name: r[0] ?? "", value: Math.abs(num(r[valueCols[0]])) || 0 })),
            }]
          : valueCols.map((c) => ({
              name: head[c],
              type,
              smooth: type === "line",
              barMaxWidth: 28,
              data: body.map((r) => num(r[c]) || 0),
            })),
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, rows]);

  if (valueCols.length === 0)
    return <div className="text-[12.5px] text-ink-3">没有可作图的数值列，请切回表格视图。</div>;
  return (
    <div>
      <div className="mb-2 flex items-center gap-1">
        {(["bar", "line", "pie"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={`rounded px-2 py-0.5 text-[12px] ${type === t ? "bg-sel font-medium text-ink" : "text-ink-3 hover:bg-sel/60"}`}
          >
            {t === "bar" ? "柱状" : t === "line" ? "折线" : "饼图"}
          </button>
        ))}
        <span className="ml-2 text-[11.5px] text-ink-3">
          {head[0]} × {type === "pie" ? head[valueCols[0]] : valueCols.map((c) => head[c]).join("、")}（前 {body.length} 行）
        </span>
      </div>
      <div ref={ref} style={{ height: Math.max(280, Math.min(460, body.length * 14 + 120)) }} />
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
          {doc.kind === "slides" && (
            <a
              href={`/api/documents/${doc.id}/pptx`}
              className="rounded-lg border border-accent/50 px-2.5 py-1 text-[12px] font-medium text-accent hover:bg-accent-soft"
              title="导出真 .pptx：可编辑文本、主题配色、讲者备注、嵌入配图，PowerPoint/WPS/Keynote 直接打开"
            >
              ⬇ .pptx
            </a>
          )}
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

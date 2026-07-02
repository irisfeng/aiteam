import { Suspense, lazy, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useWorkspace } from "../store";
import { api, API_BASE } from "../api";
import type { Doc } from "../types";
import { AgentAvatar } from "./Avatar";

const TemplateEditor = lazy(() => import("./TemplateEditor").then((m) => ({ default: m.TemplateEditor })));

function fmt(ts: number) {
  return new Date(ts).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function docKindMeta(kind: Doc["kind"]) {
  switch (kind) {
    case "slides":
      return { icon: "🖥️", label: "演示文稿", ext: ".md", mime: "text/markdown", hint: "Marp 格式，可直接生成 PPT" };
    case "sheet":
      return { icon: "📊", label: "数据表", ext: ".csv", mime: "text/csv", hint: "CSV，可导入 Excel" };
    case "html":
      return { icon: "🌐", label: "网页", ext: ".html", mime: "text/html", hint: "单文件 HTML，沙箱预览，可下载本地打开" };
    case "source":
      return { icon: "📎", label: "来源", ext: ".md", mime: "text/markdown", hint: "上传的来源文档（已转 Markdown），供 AI 同事定向润色时 grounding" };
    case "template":
      return { icon: "🪄", label: "模板", ext: ".pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", hint: "上传的 .pptx 模板：逐槽改图文、保留原设计后导出可编辑 pptx" };
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
  const mime = doc.kind === "html" ? "text/html" : isCsv ? "text/csv" : "text/markdown";
  const ext = isCsv ? ".csv" : meta.ext;
  const blob = new Blob([doc.content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = doc.title.replace(/[\\/:*?"<>|]/g, "_") + ext;
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
    let disposed = false;
    let chart: import("echarts").ECharts | null = null;
    const ink = cssVar("--t-ink", "#26241f");
    const dim = cssVar("--t-dim", "#8a877e");
    const line = cssVar("--t-line", "#e6e3db");
    const accent = cssVar("--t-accent", "#c28a1e");
    const palette = [accent, "#7c9a6d", "#5e87b0", "#b06a5e", "#8a7ab0", "#b0985e"];
    const labels = body.map((r) => r[0] ?? "");
    const axisStyle = {
      axisLabel: { color: dim, fontSize: 11 },
      axisLine: { lineStyle: { color: line } },
      splitLine: { lineStyle: { color: line } },
    };
    void import("echarts").then((echarts) => {
      if (disposed || !ref.current) return;
      chart = echarts.init(ref.current);
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
    });
    const onResize = () => chart?.resize();
    window.addEventListener("resize", onResize);
    return () => {
      disposed = true;
      window.removeEventListener("resize", onResize);
      chart?.dispose();
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
          {doc.kind === "template" ? (
            <span className="ml-auto text-[11.5px] text-ink-3">编辑与导出见下方面板</span>
          ) : (
            <button
              onClick={() => download(doc)}
              className="ml-auto rounded-lg border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:bg-sel"
              title={meta.hint}
            >
              ⬇{doc.kind === "html" ? " .html" : doc.kind === "sheet" && !doc.content.trimStart().startsWith("|") ? " .csv" : " .md"}
            </button>
          )}
          {doc.kind === "slides" && (
            <a
              href={`${API_BASE}/documents/${doc.id}/pptx`}
              className="rounded-lg border border-accent/50 px-2.5 py-1 text-[12px] font-medium text-accent hover:bg-accent-soft"
              title="导出真 .pptx：可编辑文本、主题配色、讲者备注、嵌入配图，PowerPoint/WPS/Keynote 直接打开"
            >
              ⬇ .pptx
            </a>
          )}
          {/* html 交付物内容是模型生成的不可信 HTML：禁走 exportWord/printDoc 的 document.write 同源路径（防存储型 XSS），只允许下载文件在 null 源打开。template 用专属编辑器导出，不走通用 Word/PDF。 */}
          {doc.kind !== "html" && doc.kind !== "template" && (
            <>
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
            </>
          )}
          <button onClick={onClose} className="rounded px-1.5 text-ink-3 hover:bg-sel">✕</button>
        </div>
        <div ref={contentRef} className={`flex-1 overflow-y-auto px-6 py-4 ${doc.kind === "slides" ? "bg-sel/40" : ""}`}>
          {doc.kind === "template" ? (
            <Suspense fallback={<div className="p-6 text-[13px] text-ink-3">加载模板编辑器…</div>}>
              <TemplateEditor doc={doc} />
            </Suspense>
          ) : doc.kind === "slides" ? (
            <SlidesPreview content={doc.content} />
          ) : doc.kind === "sheet" ? (
            <SheetTable content={doc.content} />
          ) : doc.kind === "html" ? (
            // 不可信 HTML 沙箱预览：sandbox 留空 = 脚本不执行、无同源、无父窗口访问（防存储型 XSS）。
            // 注：内联 <script> 在此不运行；纯展示型 HTML/CSS/SVG 正常渲染（与"禁外链/内联事件"校验配套）。
            <iframe
              srcDoc={doc.content}
              sandbox=""
              className="h-[64vh] w-full rounded border border-line bg-white"
              title={doc.title}
            />
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

/** Mock 演示残留：标题以 (Mock) / （Mock） 开头 */
function isMockDoc(d: Doc): boolean {
  return /^\s*[（(]\s*mock/i.test(d.title);
}

/** 单篇文档卡：显示当前版 + 版本号；version>1 时挂「历史版本」抽屉，点开按需拉取旧版。 */
function DocCard({ doc, onOpen }: { doc: Doc; onOpen: (d: Doc) => void }) {
  const ws = useWorkspace();
  const author = ws.agentById(doc.agent_id);
  const task = ws.tasks.find((t) => t.id === doc.task_id);
  const meta = docKindMeta(doc.kind);
  const [open, setOpen] = useState(false);
  const [olders, setOlders] = useState<Doc[] | null>(null);
  return (
    <div className="rounded-xl border border-line bg-panel shadow-sm">
      <button
        onClick={() => onOpen(doc)}
        className="flex w-full items-center gap-3 p-3.5 text-left hover:bg-sel/40"
      >
        <span className="text-lg" title={meta.label}>{meta.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14px] font-medium">{doc.title}</span>
            {doc.version > 1 && (
              <span className="shrink-0 rounded bg-accent-soft px-1 text-[10.5px] text-ink-2" title={`第 ${doc.version} 版`}>v{doc.version}</span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[12px] text-ink-3">
            <span className="rounded bg-panel px-1 text-[11px]">{meta.label}</span>
            {author && (
              <span className="flex items-center gap-1"><AgentAvatar agent={author} size={14} /> {author.name}</span>
            )}
            {task && <span className="truncate">任务「{task.title}」</span>}
            <span>{fmt(doc.created_at)}</span>
            <span>{doc.content.length.toLocaleString()} 字</span>
          </div>
        </div>
      </button>
      {doc.version > 1 && (
        <div className="border-t border-line px-3.5 py-1.5">
          <button
            onClick={async () => {
              setOpen((o) => !o);
              if (olders === null) {
                const all = await api.docVersions(doc.id);
                setOlders(all.filter((v) => v.id !== doc.id));
              }
            }}
            className="text-[11.5px] text-ink-3 hover:text-ink"
          >
            {open ? "▾" : "▸"} 历史版本 {doc.version - 1}
          </button>
          {open && olders && (
            <div className="mt-1 flex flex-col gap-1 pb-1">
              {olders.map((v) => (
                <button
                  key={v.id}
                  onClick={() => onOpen(v)}
                  className="flex items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] text-ink-3 hover:bg-sel"
                >
                  <span className="rounded bg-sel px-1 text-[10.5px]">v{v.version}</span>
                  <span className="truncate">{v.title}</span>
                  <span className="ml-auto shrink-0">{fmt(v.created_at)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 项目折叠组：同一项目的交付物收成一张可展开卡，已汇总(done)项目默认折叠成归档文件夹。 */
function DocProjectGroup({ project, docs, onOpen }: { project: { id: string; title: string; goal: string; status: string }; docs: Doc[]; onOpen: (d: Doc) => void }) {
  const [open, setOpen] = useState(project.status !== "done");
  return (
    <div className="rounded-xl border border-line bg-panel/60">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-1.5 px-3 py-2.5 text-left" title={project.goal}>
        <span className="text-[11px] text-ink-3">{open ? "▾" : "▸"}</span>
        <span className="truncate text-[13px] font-semibold">🧩 {project.title}</span>
        <span className="ml-auto shrink-0 rounded bg-sel px-1.5 py-px text-[10.5px] text-ink-3">
          {docs.length} 份交付物{project.status === "done" ? " · 已归档" : ""}
        </span>
      </button>
      {open && <div className="flex flex-col gap-2 border-t border-line p-2">{docs.map((d) => <DocCard key={d.id} doc={d} onOpen={onOpen} />)}</div>}
    </div>
  );
}

const DOC_KINDS: { k: "all" | Doc["kind"]; label: string }[] = [
  { k: "all", label: "全部" },
  { k: "report", label: "📄 报告" },
  { k: "slides", label: "🖥 演示" },
  { k: "sheet", label: "📊 数据表" },
  { k: "html", label: "🌐 网页" },
  { k: "source", label: "📎 来源" },
  { k: "template", label: "🪄 模板" },
];

export function DocsView() {
  const ws = useWorkspace();
  const [openDoc, setOpenDoc] = useState<Doc | null>(null);
  const [kind, setKind] = useState<"all" | Doc["kind"]>("all");
  const [q, setQ] = useState("");
  const [showMock, setShowMock] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadingTpl, setUploadingTpl] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const tplRef = useRef<HTMLInputElement>(null);

  async function onUpload(file: File) {
    setUploading(true);
    try {
      await api.uploadDoc(file); // 成功后经 WS doc:upsert 自动进文档列表
      setKind("source"); // 切到"来源"筛选，便于用户立刻看到刚上传的
    } catch (err) {
      window.alert("上传失败：" + ((err as Error)?.message ?? err));
    } finally {
      setUploading(false);
    }
  }

  async function onUploadTemplate(file: File) {
    setUploadingTpl(true);
    try {
      const doc = await api.uploadTemplate(file); // 解析槽位 + 持久化原件 → kind=template
      setKind("template");
      setOpenDoc(doc); // 直接打开模板编辑器
    } catch (err) {
      window.alert("模板上传失败：" + ((err as Error)?.message ?? err));
    } finally {
      setUploadingTpl(false);
    }
  }

  async function pickDesktopFile(mode: "source" | "template") {
    const picked = await window.aiteamDesktop?.pickFile(mode);
    if (!picked || picked.canceled) return null;
    return new File([new Uint8Array(picked.file.bytes)], picked.file.name);
  }

  async function chooseSource() {
    if (window.aiteamDesktop?.pickFile) {
      try {
        const file = await pickDesktopFile("source");
        if (file) await onUpload(file);
      } catch (err) {
        window.alert("选择文件失败：" + ((err as Error)?.message ?? err));
      }
      return;
    }
    fileRef.current?.click();
  }

  async function chooseTemplate() {
    if (window.aiteamDesktop?.pickFile) {
      try {
        const file = await pickDesktopFile("template");
        if (file) await onUploadTemplate(file);
      } catch (err) {
        window.alert("选择模板失败：" + ((err as Error)?.message ?? err));
      }
      return;
    }
    tplRef.current?.click();
  }

  const mockDocs = ws.documents.filter(isMockDoc);
  let visible = showMock ? ws.documents : ws.documents.filter((d) => !isMockDoc(d));
  if (kind !== "all") visible = visible.filter((d) => d.kind === kind);
  const query = q.trim().toLowerCase();
  if (query) {
    visible = visible.filter((d) => {
      const author = ws.agentById(d.agent_id);
      const task = ws.tasks.find((t) => t.id === d.task_id);
      return [d.title, author?.name, task?.title].filter(Boolean).join(" ").toLowerCase().includes(query);
    });
  }

  // 按项目分组：文档经 task_id → task.project_id 派生归属；无项目的散文档平铺
  const projIds: string[] = [];
  const grouped = new Map<string, Doc[]>();
  const loose: Doc[] = [];
  for (const d of visible) {
    const task = ws.tasks.find((t) => t.id === d.task_id);
    const pid = task?.project_id ?? null;
    if (pid && ws.projects.some((p) => p.id === pid)) {
      if (!grouped.has(pid)) { grouped.set(pid, []); projIds.push(pid); }
      grouped.get(pid)!.push(d);
    } else loose.push(d);
  }

  async function cleanMock() {
    if (!window.confirm(`清理 ${mockDocs.length} 篇 Mock 演示残留文档？此操作不可撤销。`)) return;
    for (const d of mockDocs) await ws.deleteDocument(d.id);
    setShowMock(false);
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <h1 className="text-[15px] font-semibold">文档</h1>
        <span className="hidden text-[12px] text-ink-3 lg:inline">AI 同事交付的报告、演示文稿与数据表都沉淀在这里</span>
        <button
          onClick={() => void chooseSource()}
          disabled={uploading}
          className="rounded-lg border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:bg-sel disabled:opacity-50"
          title="上传文档(PDF/Word/PPT/Excel/txt/md…)作为「来源」，供 AI 同事定向润色时 grounding"
        >
          {uploading ? "上传中…" : "📎 上传来源"}
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept=".txt,.md,.markdown,.csv,.tsv,.json,.log,.yaml,.yml,.xml,.pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.epub,.html,.htm,.png,.jpg,.jpeg,.gif,.webp"
          onChange={(e) => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (file) void onUpload(file); }}
        />
        <button
          onClick={() => void chooseTemplate()}
          disabled={uploadingTpl}
          className="rounded-lg border border-accent/50 px-2.5 py-1 text-[12px] font-medium text-accent hover:bg-accent-soft disabled:opacity-50"
          title="上传现成 .pptx 品牌模板：逐槽改里面的图文、保留原设计后导出可编辑 pptx"
        >
          {uploadingTpl ? "解析中…" : "🪄 上传模板"}
        </button>
        <input
          ref={tplRef}
          type="file"
          hidden
          accept=".pptx"
          onChange={(e) => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (file) void onUploadTemplate(file); }}
        />
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {DOC_KINDS.map(({ k, label }) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className={`rounded-full border px-2.5 py-1 text-[12px] ${kind === k ? "border-ink bg-ink text-white" : "border-line text-ink-2 hover:bg-sel"}`}
            >
              {label}
            </button>
          ))}
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索标题/作者/任务"
            className="w-44 rounded-full border border-line bg-sel px-3 py-1 text-[12px] outline-none focus:border-accent/50"
          />
        </div>
      </header>
      <div className="flex-1 overflow-y-auto p-5">
        {ws.documents.length === 0 && (
          <div className="py-10 text-center text-[13px] text-ink-3">
            还没有文档。把任务指派给 AI 同事，交付物会自动出现在这里。
          </div>
        )}
        <div className="mx-auto flex max-w-2xl flex-col gap-2">
          {mockDocs.length > 0 && !showMock && (
            <div className="flex items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft px-3.5 py-2.5 text-[12.5px] text-ink-2">
              <span>🧹 检测到 {mockDocs.length} 篇 Mock 演示残留</span>
              <button onClick={() => setShowMock(true)} className="rounded border border-line bg-panel px-2 py-0.5 hover:bg-sel">查看</button>
              <button onClick={cleanMock} className="ml-auto rounded bg-accent px-2 py-0.5 font-medium text-white hover:opacity-90">一键清理</button>
            </div>
          )}
          {projIds.map((pid) => {
            const project = ws.projects.find((p) => p.id === pid)!;
            return <DocProjectGroup key={pid} project={project} docs={grouped.get(pid)!} onOpen={setOpenDoc} />;
          })}
          {loose.map((d) => <DocCard key={d.id} doc={d} onOpen={setOpenDoc} />)}
          {visible.length === 0 && ws.documents.length > 0 && (
            <div className="py-8 text-center text-[12px] text-ink-3">没有匹配的文档。</div>
          )}
        </div>
      </div>
      {openDoc && <DocViewerModal doc={openDoc} onClose={() => setOpenDoc(null)} />}
    </div>
  );
}

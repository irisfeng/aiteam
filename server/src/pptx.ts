import PptxGenJSImport from "pptxgenjs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Doc } from "./db.js";
import { assetsDir } from "./agents/images.js";

// NodeNext 下 pptxgenjs 的 CJS 类型声明把默认导出解析成模块命名空间，
// 而运行时加载的 ESM 构建默认导出即类——统一兜底取类构造器
const PptxGenJS: new () => any = ((PptxGenJSImport as any).default ?? PptxGenJSImport) as any;

/** Hive 主题色（与产品视觉同源） */
const THEME = {
  bg: "F3F1EB",
  panel: "FFFFFF",
  ink: "26241F",
  dim: "8A877E",
  accent: "C28A1E",
  line: "E4DECF",
  zebra: "F3EFE4",
};

// CJK 字体：pptxgenjs 不传 fontFace 时不写字体块，CJK 回退不可控（macOS/Keynote/WPS 易错排）。
// 逐 run 指定即根因修复（pptxgenjs 会同时写 <a:latin>/<a:ea>/<a:cs>）。默认 PingFang SC 适配 Mac 本地演示；
// 面向 Windows/WPS 客户的部署可设环境变量 AITEAM_PPTX_FONT=Microsoft YaHei 覆盖。
const CJK_FONT = process.env.AITEAM_PPTX_FONT || "PingFang SC";

// 13.33×7.5 in (16:9) 舞台与内容区
const PAGE = { w: 13.33, h: 7.5 };
const MARGIN = 0.75;
const CONTENT_W = PAGE.w - MARGIN * 2; // 11.83
const CONTENT_TOP = 1.62;
const CONTENT_BOTTOM = 6.92;
const CONTENT_H = CONTENT_BOTTOM - CONTENT_TOP; // ~5.30

interface Stat {
  value: string;
  label: string;
}
interface SlideTable {
  header: string[];
  rows: string[][];
}
interface DiagramNode { id: string; group: string; label: string; items?: string[]; }
interface DiagramEdge { from: string; to: string; label: string; dashed: boolean; }
/** ```arch / ```diagram 围栏 → 原生形状架构图（分层/流程/中心辐射，三种确定式布局）。 */
interface SlideDiagram {
  type: "layered" | "flow" | "hub";
  dir: "down" | "right";
  title: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  droppedLinks: number; // 引用缺失节点而被丢弃的边数（manifest 暴露）
}
interface SlidePage {
  title: string;
  bullets: string[];
  paragraphs: string[];
  /** 大数字 / 关键指标卡（`值 :: 标签` 约定）→ 数字卡片 */
  stats: Stat[];
  /** 结构化表格（Markdown 表格 → 原生 pptx 表格，不再压成项目符号） */
  tables: SlideTable[];
  /** 围栏代码块（``` … ```）→ 等宽文本框 */
  code: string[];
  /** ```arch / ```diagram 架构图 → 原生形状 */
  diagrams: SlideDiagram[];
  /** 本地生成图（/assets/xxx.png）的磁盘路径 */
  images: string[];
  notes: string;
}

/** assets/xxx.png → 磁盘路径（仅本地生成图可嵌入 pptx；外链跳过）。
 *  新前缀为 /aiteam/assets/xxx.png；同时兼容历史 /assets/xxx.png 及 LLM 落进 Markdown
 *  时常改写成的相对路径 assets/xxx.png、./assets/xxx.png，否则配图嵌不进 pptx。 */
function localImagePath(src: string): string | null {
  const m = src.match(/^(?:\/aiteam\/|\.?\/?)assets\/([\w.-]+)$/);
  if (!m) return null;
  const file = join(assetsDir, m[1]);
  return existsSync(file) ? file : null;
}

/** 去掉常见 Markdown 行内标记（pptx 里不需要） */
function plain(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1")
    .trim();
}

/** `值 :: 标签` 大数字卡约定：值含数字/百分号/升降号、且较短才认作 stat（避免误伤普通含 :: 的句子）。 */
function matchStat(line: string): Stat | null {
  // 容错：模型常把整行用 markdown 行内代码反引号包起来（`值 :: 标签`），split 后反引号会粘在值/标签两端——先去掉整行包裹再匹配。
  const cleaned = line.trim().replace(/^`+/, "").replace(/`+$/, "").trim();
  const m = cleaned.match(/^(.{1,16}?)\s*::\s*(.{1,24})$/);
  if (!m) return null;
  const value = plain(m[1]).replace(/`/g, "").trim();
  const label = plain(m[2]).replace(/`/g, "").trim();
  if (!/[\d％%↑↓+＋]/.test(value)) return null; // 值必须像个指标
  if (!label) return null;
  return { value, label };
}

const idOfNode = (s: string) => plain(s).replace(/\s+/g, "");
/** 单个 `[x]` 包裹 → 去括号；否则原样。 */
function stripBrackets(s: string): string {
  const m = s.trim().match(/^\[(.+)\]$/);
  return (m ? m[1] : s).trim();
}
/** 把 `名 | 子 | [a] [b] [c]` 解析成 {label, items}：items 既支持 `| a | b`，也支持一段里多个 `[a] [b]`。 */
function parseNodeSpec(spec: string): { label: string; items: string[] } {
  const parts = spec.split("|").map((p) => plain(p).trim()).filter(Boolean);
  const label = stripBrackets(parts[0] || "");
  const items: string[] = [];
  for (const part of parts.slice(1)) {
    const brs = part.match(/\[([^\]]+)\]/g);
    if (brs && brs.length) brs.forEach((b) => items.push(b.slice(1, -1).trim()));
    else items.push(stripBrackets(part));
  }
  return { label, items: items.filter(Boolean) };
}

/**
 * 解析 ```arch / ```diagram 围栏块 → 结构化架构图。容错两种写法：
 *  - 旧：节点 `[组] 名`，边 `A -> B`，虚线 `A -. 标签 .-> B`；
 *  - 新（模型自然产出）：节点 `名 | 子项 | 子项`（子项渲进框内），边目标可带子项 `A -> B | 子项`。
 * 无显式 group 时按边的最长路径自动分层。边端点：已声明或带子项→建节点；裸名未声明→丢弃并计 droppedLinks（兼容旧严格语义）。
 */
function parseDiagram(buf: string[]): SlideDiagram | null {
  let type: SlideDiagram["type"] = "layered";
  let dir: SlideDiagram["dir"] = "down";
  let title = "";
  const nodesMap = new Map<string, DiagramNode>();
  const order: string[] = [];
  const declare = (label: string, group: string, items: string[]): string => {
    const id = idOfNode(label);
    if (!id) return "";
    let n = nodesMap.get(id);
    if (!n) { n = { id, group, label: plain(label), items: items.length ? items : undefined }; nodesMap.set(id, n); order.push(id); }
    else { if (group && !n.group) n.group = group; if (items.length && !(n.items && n.items.length)) n.items = items; }
    return id;
  };
  const edgeSpecs: { from: string; to: string; label: string; dashed: boolean }[] = [];
  for (const rawLine of buf) {
    const t = rawLine.trim();
    if (!t || t.startsWith("#")) continue;
    const hdr = t.match(/^(type|dir|title)\s*:\s*(.+)$/i);
    if (hdr) {
      const k = hdr[1].toLowerCase(), v = hdr[2].trim();
      if (k === "type") { const vv = v.toLowerCase(); type = vv === "flow" || vv === "hub" ? vv : "layered"; }
      else if (k === "dir") { dir = v.toLowerCase() === "right" ? "right" : "down"; }
      else if (k === "title") { title = plain(v); }
      continue;
    }
    if (/->/.test(t)) {
      // 边：兼容 `A -> B` 与 `A -. 标签 .-> B`；目标可带 `| 子项`（单正则切分，避免哨兵字符问题）
      const m = t.match(/^(.*?)\s*(?:-\.\s*(.+?)\s*\.-*>|-+>)\s*(.*)$/);
      if (m) {
        const leftSpec = parseNodeSpec(m[1]);
        const rightSpec = parseNodeSpec(m[3]);
        const label = m[2] ? plain(m[2]) : "";
        const dashed = /-\.|\.-/.test(t);
        if (leftSpec.items.length) declare(leftSpec.label, "", leftSpec.items);
        if (rightSpec.items.length) declare(rightSpec.label, "", rightSpec.items);
        if (leftSpec.label && rightSpec.label) edgeSpecs.push({ from: leftSpec.label, to: rightSpec.label, label, dashed });
      }
      continue;
    }
    // 节点行：旧 `[组] 名`（无 |）或 新 `名 | 子项…`
    const old = t.match(/^\[(.+?)\]\s+(.+)$/);
    if (old && !t.includes("|")) { declare(old[2], plain(old[1]), []); continue; }
    const spec = parseNodeSpec(t);
    declare(spec.label, "", spec.items);
  }
  const nodes = order.map((id) => nodesMap.get(id)!);
  if (!nodes.length) return null;
  // 边：端点须在 map 中（带子项的在上面已声明；裸名未声明→丢弃计数，兼容旧语义）
  const edges: DiagramEdge[] = [];
  let droppedLinks = 0;
  for (const es of edgeSpecs) {
    const from = idOfNode(es.from), to = idOfNode(es.to);
    if (!from || !to || !nodesMap.has(from) || !nodesMap.has(to)) { droppedLinks++; continue; }
    edges.push({ from, to, label: es.label, dashed: es.dashed });
  }
  // 无显式分组（新语法）→ 按边最长路径自动分层，供 layered 布局排行
  if (!nodes.some((n) => n.group) && edges.length) {
    const layer = new Map<string, number>(nodes.map((n) => [n.id, 0]));
    for (let it = 0; it < nodes.length; it++) {
      let changed = false;
      for (const e of edges) {
        const want = (layer.get(e.from) ?? 0) + 1;
        if ((layer.get(e.to) ?? 0) < want) { layer.set(e.to, want); changed = true; }
      }
      if (!changed) break;
    }
    nodes.forEach((n) => { n.group = "L" + (layer.get(n.id) ?? 0); });
  }
  return { type, dir, title, nodes, edges, droppedLinks };
}

/** 解析 Marp 风格 slides Markdown → 结构化页面 */
export function parseSlides(content: string): SlidePage[] {
  const raw = content
    .replace(/^\s*---\s*\n/, "")
    .split(/\n\s*---\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const isFrontmatter = (s: string) => {
    const lines = s.split("\n");
    const firstNonEmpty = (lines.find((l) => l.trim() !== "") ?? "").trim();
    if (!/^[\w-]+\s*:/.test(firstNonEmpty)) return false; // 首行非 `key:` → 不是 frontmatter（正文/标题页放行）
    // 允许 `key:` 行、空行、以及缩进续行（YAML 块标量，如 Marp 的 `style: |` 下的多行 CSS）
    return lines.every((line) => line.trim() === "" || /^[\w-]+\s*:/.test(line.trim()) || /^[ \t]/.test(line));
  };

  const pages: SlidePage[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (i === 0 && isFrontmatter(raw[i])) continue;
    const page: SlidePage = { title: "", bullets: [], paragraphs: [], stats: [], tables: [], code: [], diagrams: [], images: [], notes: "" };
    // 先在整块上剥离 HTML 注释（含跨行块）：`<!-- note: … -->` 转讲者备注，
    // 其余注释整块丢弃。按行解析做不到这点——多行注释的中间行不以 `-->` 收尾，
    // 会漏成正文渲染进幻灯片（实测出现在标题页 <a:t> 文本里）。
    // 1) 成对块状备注：<!-- note --> … <!-- end note -->（备注内容在两标记之间，而非注释内）。
    //    必须先于行内注释剥离处理，否则两个标记各自被当成空注释、中间内容漏成正文（实测讲者备注渲染上了幻灯片）。
    const paired = raw[i].replace(/<!--\s*note\s*-->([\s\S]*?)<!--\s*\/?\s*(?:end\s*note|\/note)\s*-->/gi, (_m, inner) => {
      const txt = String(inner).replace(/<\/?[a-zA-Z][^>]*>/g, "").trim();
      if (txt) page.notes += (page.notes ? "\n" : "") + txt;
      return "";
    });
    // 2) 行内注释：<!-- note: … -->（备注内容在注释内）转讲者备注，其余注释整块丢弃。
    const decommented = paired.replace(/<!--([\s\S]*?)-->/g, (_m, inner) => {
      const note = String(inner).match(/^\s*note(?::|\s)\s*([\s\S]*?)\s*$/i);
      if (note && note[1].trim()) page.notes += (page.notes ? "\n" : "") + note[1].trim();
      return "";
    });
    // 3) slides 不支持原始 HTML（那是 html 交付物的事）：剥离跨行 HTML 标签、只留内文，
    //    保护 ``` 代码围栏不动（否则会破坏含 <> 的代码）。防止模型误塞 <div>/<span> 渲成字面标签。
    const block = decommented
      .split(/(```[\s\S]*?```)/g)
      .map((seg, k) => (k % 2 === 1 ? seg : seg.replace(/<\/?[a-zA-Z][^>]*>/g, "")))
      .join("");
    const splitRow = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => plain(c.trim()));
    const isSeparator = (line: string | undefined) => Boolean(line && /-/.test(line) && /^[\s:|-]+$/.test(line.trim()));
    const lines = block.split("\n");
    let inCode = false;
    let codeBuf: string[] = [];
    let inDiagram = false;
    let diagramBuf: string[] = [];
    for (let li = 0; li < lines.length; li++) {
      const t = lines[li].trim();
      const fence = t.match(/^```(\w+)?/); // 捕获语言标签：arch/diagram → 架构图，其余 → 代码
      if (fence) {
        if (inCode) { if (codeBuf.length) page.code.push(codeBuf.join("\n")); codeBuf = []; inCode = false; continue; }
        if (inDiagram) { const d = parseDiagram(diagramBuf); if (d) page.diagrams.push(d); diagramBuf = []; inDiagram = false; continue; }
        const lang = (fence[1] || "").toLowerCase();
        if (lang === "arch" || lang === "diagram") inDiagram = true;
        else inCode = true;
        continue;
      }
      if (inDiagram) { diagramBuf.push(lines[li]); continue; }
      if (inCode) { codeBuf.push(lines[li]); continue; }
      // 表格块：连续 `|…|` 行；第二行是分隔行（含 -）才认作真表格
      if (/^\|/.test(t)) {
        let j = li;
        const grid: string[][] = [];
        while (j < lines.length && /^\s*\|/.test(lines[j])) { grid.push(splitRow(lines[j])); j++; }
        if (grid.length >= 2 && isSeparator(lines[li + 1])) {
          page.tables.push({ header: grid[0], rows: grid.slice(2) });
        } else {
          page.bullets.push(grid.map((r) => r.join(" · ")).join("　"));
        }
        li = j - 1;
        continue;
      }
      const img = t.match(/^!\[[^\]]*\]\(([^)\s]+)\)$/);
      if (img) {
        const file = localImagePath(img[1]);
        if (file) page.images.push(file);
        continue;
      }
      if (/^#{1,3}\s+/.test(t)) {
        const h = plain(t.replace(/^#{1,3}\s+/, ""));
        if (!page.title) page.title = h;
        else page.bullets.push(h);
      } else if (/^[-*]\s+/.test(t) || /^\d+[.)]\s+/.test(t)) {
        page.bullets.push(plain(t.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "")));
      } else if (t && !/^>/.test(t)) {
        const stat = matchStat(t);
        if (stat) page.stats.push(stat);
        else page.paragraphs.push(plain(t));
      }
    }
    if (inCode && codeBuf.length) page.code.push(codeBuf.join("\n"));
    if (inDiagram && diagramBuf.length) { const d = parseDiagram(diagramBuf); if (d) page.diagrams.push(d); }
    pages.push(page);
  }
  return pages;
}

/** 渲染产物清单：供验收/自查核对"声称 vs 实产"，并抓静默丢页。 */
export interface SlidesManifest {
  sourcePages: number;
  renderedSlides: number;
  continuationSlides: number;
  pagesWithNotes: number;
  tables: number;
  statCards: number;
  diagrams: number;
  droppedLinks: number;
  images: number;
}

// ── 高度估算（用于溢出分页）──
const cp = (s: string) => [...s].length; // 码点数（CJK 友好）
function estLines(s: string, perLine: number): number {
  return Math.max(1, Math.ceil(cp(s) / perLine));
}

type Block = { h: number; draw: (slide: any, y: number) => void };

// ── 架构图渲染（原生形状；pptxgenjs 不支持 shape 渐变填充→静默丢成透明框，故全程禁用，主节点用实色+阴影）──
const NODE_MAIN = { fill: { color: THEME.accent }, color: "FFFFFF", line: { color: THEME.accent, width: 1 },
  shadow: { type: "outer", color: "808080", blur: 4, offset: 2, angle: 90, opacity: 0.35 } };
const NODE_CHILD = { fill: { color: THEME.panel }, color: THEME.ink, line: { color: THEME.accent, width: 1.5 } };

function drawNodeBox(slide: any, x: number, y: number, w: number, h: number, label: string, style: any, fontPt: number, items?: string[]) {
  slide.addShape("roundRect", { x, y, w, h, rectRadius: 0.06, fill: style.fill, line: style.line, ...(style.shadow ? { shadow: style.shadow } : {}) });
  if (items && items.length) {
    // 标题(粗) + 子项("·"连接、稍小、弱色) 同框：架构层/组件框列出其模块。
    const sub = items.join(" · ");
    const subColor = style.shadow ? "F3ECD2" : THEME.dim; // 主节点(深底)用浅金，子节点用弱灰
    slide.addText(
      [
        { text: label, options: { fontSize: fontPt, bold: true, color: style.color, breakLine: true } },
        { text: sub, options: { fontSize: Math.max(8, fontPt - 3), color: subColor, breakLine: false } },
      ],
      { x: x + 0.08, y: y + 0.04, w: w - 0.16, h: h - 0.08, align: "center", valign: "middle", fontFace: CJK_FONT, wrap: true, lineSpacingMultiple: 1.05 }
    );
    return;
  }
  const perLine = Math.max(2, Math.floor((w - 0.16) / 0.2)); // CJK 约每 0.2in 一字
  let txt = label;
  if (cp(label) > perLine * 2) txt = [...label].slice(0, perLine * 2 - 1).join("") + "…"; // 最多两行，超则省略
  slide.addText(txt, { x: x + 0.06, y, w: w - 0.12, h, align: "center", valign: "middle", fontSize: fontPt, color: style.color, bold: !!style.shadow, fontFace: CJK_FONT, wrap: true });
}
function drawEdgeLabel(slide: any, x1: number, y1: number, x2: number, y2: number, label: string) {
  if (!label) return;
  slide.addText(label, { x: (x1 + x2) / 2 - 0.7, y: (y1 + y2) / 2 - 0.13, w: 1.4, h: 0.26, fontSize: 9, color: THEME.dim, align: "center", valign: "middle", fontFace: CJK_FONT });
}
function drawEdgeLine(slide: any, x1: number, y1: number, x2: number, y2: number, dashed: boolean, label: string) {
  slide.addShape("line", {
    x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1) || 0.01, h: Math.abs(y2 - y1) || 0.01,
    line: { color: THEME.dim, width: 1.25, endArrowType: "triangle", ...(dashed ? { dashType: "dash" } : {}) },
    flipH: x2 < x1, flipV: y2 < y1,
  });
  drawEdgeLabel(slide, x1, y1, x2, y2, label);
}
function drawEdgeElbow(slide: any, x1: number, y1: number, x2: number, y2: number, dashed: boolean, label: string) {
  const midY = (y1 + y2) / 2;
  const bx = Math.min(x1, x2), by = Math.min(y1, y2);
  const bw = Math.abs(x2 - x1) || 0.01, bh = Math.abs(y2 - y1) || 0.01;
  const P = (px: number, py: number, mv?: boolean) => ({ x: px - bx, y: py - by, ...(mv ? { moveTo: true } : {}) });
  slide.addShape("custGeom", {
    x: bx, y: by, w: bw, h: bh,
    line: { color: THEME.dim, width: 1.25, endArrowType: "triangle", ...(dashed ? { dashType: "dash" } : {}) },
    points: [P(x1, y1, true), P(x1, midY), P(x2, midY), P(x2, y2)],
  });
  if (label) slide.addText(label, { x: (x1 + x2) / 2 - 0.7, y: midY - 0.13, w: 1.4, h: 0.26, fontSize: 9, color: THEME.dim, align: "center", valign: "middle", fontFace: CJK_FONT });
}

/** 渲染一张架构图（layered/flow/hub 三种确定式布局）到 (y0..y0+H) 区域。 */
function drawDiagram(slide: any, y0: number, H: number, dg: SlideDiagram) {
  if (dg.title) {
    slide.addText(dg.title, { x: MARGIN, y: y0, w: CONTENT_W, h: 0.3, fontSize: 13, bold: true, color: THEME.ink, align: "center", fontFace: CJK_FONT });
    y0 += 0.36; H -= 0.36;
  }
  const pos = new Map<string, { x: number; y: number; w: number; h: number }>();
  const ctr = (id: string) => { const p = pos.get(id)!; return { cx: p.x + p.w / 2, cy: p.y + p.h / 2 }; };

  if (dg.type === "hub") {
    const cx = MARGIN + CONTENT_W / 2, cyC = y0 + H / 2;
    const cW = 1.9, cH = 0.74, oW = 1.8, oH = 0.66;
    const outer = dg.nodes.slice(1);
    // 椭圆布局：横向用满舞台、纵向受图高约束——避免外节点与中心重叠
    const Rx = Math.max(2.4, CONTENT_W / 2 - oW / 2 - 0.3);
    const Ry = Math.max(1.2, H / 2 - oH / 2 - 0.2);
    pos.set(dg.nodes[0].id, { x: cx - cW / 2, y: cyC - cH / 2, w: cW, h: cH });
    outer.forEach((n, i) => {
      const ang = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, outer.length);
      pos.set(n.id, { x: cx + Rx * Math.cos(ang) - oW / 2, y: cyC + Ry * Math.sin(ang) - oH / 2, w: oW, h: oH });
    });
    const edges = dg.edges.length ? dg.edges : outer.map((n) => ({ from: dg.nodes[0].id, to: n.id, label: "", dashed: false }));
    for (const e of edges) { if (!pos.has(e.from) || !pos.has(e.to)) continue; const a = ctr(e.from), b = ctr(e.to); drawEdgeLine(slide, a.cx, a.cy, b.cx, b.cy, e.dashed, e.label); }
    dg.nodes.forEach((n, i) => { const p = pos.get(n.id)!; drawNodeBox(slide, p.x, p.y, p.w, p.h, n.label, i === 0 ? NODE_MAIN : NODE_CHILD, i === 0 ? 14 : 12, n.items); });
    return;
  }

  if (dg.type === "flow") {
    const horiz = dg.dir !== "down";
    const n = dg.nodes.length, gap = 0.45;
    if (horiz) {
      const nodeW = Math.min(2.4, (CONTENT_W - gap * (n - 1)) / n), nodeH = Math.min(1.0, H * 0.5);
      const total = n * nodeW + (n - 1) * gap, sx = MARGIN + (CONTENT_W - total) / 2, cy = y0 + (H - nodeH) / 2;
      dg.nodes.forEach((nd, i) => pos.set(nd.id, { x: sx + i * (nodeW + gap), y: cy, w: nodeW, h: nodeH }));
    } else {
      const nodeW = Math.min(4.2, CONTENT_W * 0.5), nodeH = Math.min(0.7, (H - gap * (n - 1)) / n);
      const total = n * nodeH + (n - 1) * gap, sx = MARGIN + (CONTENT_W - nodeW) / 2, sy = y0 + (H - total) / 2;
      dg.nodes.forEach((nd, i) => pos.set(nd.id, { x: sx, y: sy + i * (nodeH + gap), w: nodeW, h: nodeH }));
    }
    const edges = dg.edges.length ? dg.edges : dg.nodes.slice(1).map((nd, i) => ({ from: dg.nodes[i].id, to: nd.id, label: "", dashed: false }));
    for (const e of edges) {
      const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) continue;
      if (horiz) drawEdgeLine(slide, a.x + a.w, a.y + a.h / 2, b.x, b.y + b.h / 2, e.dashed, e.label);
      else drawEdgeLine(slide, a.x + a.w / 2, a.y + a.h, b.x + b.w / 2, b.y, e.dashed, e.label);
    }
    dg.nodes.forEach((nd, i) => { const p = pos.get(nd.id)!; drawNodeBox(slide, p.x, p.y, p.w, p.h, nd.label, i === 0 ? NODE_MAIN : NODE_CHILD, 12, nd.items); });
    return;
  }

  // layered
  const down = dg.dir !== "right";
  const groups: string[] = [];
  for (const nd of dg.nodes) if (!groups.includes(nd.group)) groups.push(nd.group);
  const layers = groups.map((g) => dg.nodes.filter((nd) => nd.group === g));
  const k = Math.max(1, layers.length);
  const hasItems = dg.nodes.some((n) => n.items && n.items.length); // 有子项 → 框更高更宽，容下模块清单
  if (down) {
    const rowH = H / k, nodeH = Math.min(rowH * 0.82, hasItems ? 1.2 : 0.66);
    layers.forEach((layer, li) => {
      const m = layer.length, gap = 0.3, nodeW = Math.min(hasItems ? 4.9 : 2.6, (CONTENT_W - gap * (m + 1)) / m);
      const total = m * nodeW + (m - 1) * gap, sx = MARGIN + (CONTENT_W - total) / 2, cy = y0 + li * rowH + (rowH - nodeH) / 2;
      layer.forEach((nd, ni) => pos.set(nd.id, { x: sx + ni * (nodeW + gap), y: cy, w: nodeW, h: nodeH }));
    });
  } else {
    const colW = CONTENT_W / k, nodeW = Math.min(hasItems ? 3.0 : 2.4, colW * 0.82);
    layers.forEach((layer, li) => {
      const m = layer.length, gap = 0.3, nodeH = Math.min(hasItems ? 1.3 : 0.7, (H - gap * (m + 1)) / m);
      const total = m * nodeH + (m - 1) * gap, sy = y0 + (H - total) / 2, cx = MARGIN + li * colW + (colW - nodeW) / 2;
      layer.forEach((nd, ni) => pos.set(nd.id, { x: cx, y: sy + ni * (nodeH + gap), w: nodeW, h: nodeH }));
    });
  }
  const layerOf = new Map<string, number>();
  layers.forEach((layer, li) => layer.forEach((nd) => layerOf.set(nd.id, li)));
  for (const e of dg.edges) {
    const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) continue;
    const la = layerOf.get(e.from) ?? 0, lb = layerOf.get(e.to) ?? 0;
    if (down && lb > la) drawEdgeElbow(slide, a.x + a.w / 2, a.y + a.h, b.x + b.w / 2, b.y, e.dashed, e.label);
    else if (!down && lb > la) drawEdgeLine(slide, a.x + a.w, a.y + a.h / 2, b.x, b.y + b.h / 2, e.dashed, e.label);
    else drawEdgeLine(slide, a.x + a.w / 2, a.y + a.h / 2, b.x + b.w / 2, b.y + b.h / 2, e.dashed, e.label);
  }
  // 主节点：旧语法用关键词命中的组，新语法(自动分层)用第 0 层（根）作强调
  dg.nodes.forEach((nd) => { const p = pos.get(nd.id)!; const main = /核心|中心|中枢|中台|大脑|引擎|平台|底座/.test(nd.group) || (layerOf.get(nd.id) === 0); drawNodeBox(slide, p.x, p.y, p.w, p.h, nd.label, main ? NODE_MAIN : NODE_CHILD, 13, nd.items); });
}

function buildBlocks(page: SlidePage): Block[] {
  const blocks: Block[] = [];

  // 数字卡（最多 4 张一排）
  if (page.stats.length) {
    const stats = page.stats.slice(0, 4);
    blocks.push({
      h: 1.55,
      draw: (slide, y) => {
        const n = stats.length;
        const gap = 0.3;
        const cardW = (CONTENT_W - gap * (n - 1)) / n;
        const cardH = 1.4;
        stats.forEach((s, k) => {
          const x = MARGIN + k * (cardW + gap);
          slide.addShape("roundRect", {
            x, y, w: cardW, h: cardH, rectRadius: 0.08,
            fill: { color: THEME.panel }, line: { color: THEME.line, width: 1 },
          });
          slide.addText(s.value, {
            x: x + 0.1, y: y + 0.16, w: cardW - 0.2, h: 0.74,
            fontSize: 34, bold: true, color: THEME.accent, align: "center", valign: "middle", fontFace: CJK_FONT,
          });
          slide.addText(s.label, {
            x: x + 0.1, y: y + 0.92, w: cardW - 0.2, h: 0.4,
            fontSize: 13, color: THEME.dim, align: "center", valign: "top", fontFace: CJK_FONT,
          });
        });
      },
    });
  }

  // 引导段落（作为 lead 文本）
  for (const p of page.paragraphs) {
    const h = Math.max(0.42, estLines(p, 46) * 0.32) + 0.08;
    blocks.push({
      h,
      draw: (slide, y) => {
        slide.addText(p, {
          x: MARGIN, y, w: CONTENT_W, h: h - 0.08, valign: "top",
          fontSize: 16, color: THEME.ink, lineSpacingMultiple: 1.15, fontFace: CJK_FONT,
        });
      },
    });
  }

  // 要点（逐条成块，便于跨页续排）
  for (const b of page.bullets) {
    const h = Math.max(0.4, estLines(b, 40) * 0.32) + 0.06;
    blocks.push({
      h,
      draw: (slide, y) => {
        slide.addText(
          [{ text: b, options: { fontSize: 16, color: THEME.ink, bullet: { code: "2022", indent: 14 }, fontFace: CJK_FONT } }],
          { x: MARGIN, y, w: CONTENT_W, h: h - 0.06, valign: "top", lineSpacingMultiple: 1.12 }
        );
      },
    });
  }

  // 代码块
  for (const code of page.code) {
    const lines = code.split("\n").length;
    const h = Math.min(3.4, lines * 0.24 + 0.3);
    blocks.push({
      h: h + 0.12,
      draw: (slide, y) => {
        slide.addText(code, {
          x: MARGIN, y, w: CONTENT_W, h, valign: "top", align: "left",
          fontFace: "Consolas", fontSize: 11, color: THEME.ink, fill: { color: "F0EEE8" },
        });
      },
    });
  }

  // 原生表格：主题化表头 + 斑马纹
  for (const tbl of page.tables) {
    const h = (tbl.rows.length + 1) * 0.4 + 0.2;
    blocks.push({
      h,
      draw: (slide, y) => {
        const headRow = tbl.header.map((c) => ({
          text: c,
          options: { fill: { color: THEME.accent }, color: "FFFFFF", bold: true, align: "left", valign: "middle" },
        }));
        const bodyRows = tbl.rows.map((r, ri) =>
          (r.length < tbl.header.length ? [...r, ...Array(tbl.header.length - r.length).fill("")] : r).map((c) => ({
            text: c,
            options: { fill: { color: ri % 2 ? "FFFFFF" : THEME.zebra }, color: THEME.ink, align: "left", valign: "middle" },
          }))
        );
        slide.addTable([headRow, ...bodyRows], {
          x: MARGIN, y, w: CONTENT_W, fontSize: 12, fontFace: CJK_FONT, rowH: 0.34,
          border: { type: "solid", pt: 0.5, color: THEME.line },
        });
      },
    });
  }

  // 配图：1 张居中、多张 2 列网格（contain 保持比例，不再静默只画第一张）
  if (page.images.length) {
    const imgs = page.images;
    const cols = imgs.length === 1 ? 1 : 2;
    const gap = 0.3;
    const boxW = (CONTENT_W - gap * (cols - 1)) / cols;
    const boxH = Math.min(2.7, boxW * 0.5625);
    const rows = Math.ceil(imgs.length / cols);
    blocks.push({
      h: rows * (boxH + gap),
      draw: (slide, y) => {
        imgs.forEach((img, k) => {
          const r = Math.floor(k / cols), c = k % cols;
          const x = MARGIN + c * (boxW + gap);
          slide.addImage({ path: img, x, y: y + r * (boxH + gap), w: boxW, h: boxH, sizing: { type: "contain", w: boxW, h: boxH } });
        });
      },
    });
  }

  // 架构图（原生形状：分层/流程/中心辐射），单图高度上限 4.6in，超高由 packBlocks 独占一页
  for (const dg of page.diagrams) {
    const groups = new Set(dg.nodes.map((n) => n.group)).size;
    const H =
      dg.type === "hub" ? 4.4
      : dg.type === "flow" ? (dg.dir === "down" ? Math.min(4.4, dg.nodes.length * 0.9 + 0.4) : 2.2)
      : Math.min(4.6, groups * 1.15 + 0.6);
    blocks.push({ h: H + 0.2, draw: (slide, y) => drawDiagram(slide, y, H, dg) });
  }

  return blocks;
}

/** 按高度预算打包成多页（溢出自动续页）：先算需要几页，再按均匀目标分配，
 *  避免"首页塞满 + 续页只剩一条"的难看分页；单块超高也独占一页（硬上限优先）。 */
function packBlocks(blocks: Block[]): Block[][] {
  if (!blocks.length) return [[]];
  const unit = (b: Block) => b.h + 0.1;
  const totalH = blocks.reduce((a, b) => a + unit(b), 0);
  const pages = Math.max(1, Math.ceil(totalH / CONTENT_H));
  const target = totalH / pages; // 每页目标高度，求均衡
  const chunks: Block[][] = [];
  let cur: Block[] = [];
  let h = 0;
  for (const b of blocks) {
    const overCap = h + unit(b) > CONTENT_H;            // 硬上限：绝不溢出舞台
    const reachedTarget = h >= target && chunks.length < pages - 1; // 已达均衡目标且后面还有页
    if (cur.length && (overCap || reachedTarget)) {
      chunks.push(cur);
      cur = [];
      h = 0;
    }
    cur.push(b);
    h += unit(b);
  }
  if (cur.length) chunks.push(cur);
  return chunks.length ? chunks : [[]];
}

const isDivider = (p: SlidePage) =>
  Boolean(p.title) && !p.bullets.length && !p.paragraphs.length && !p.stats.length && !p.tables.length && !p.code.length && !p.diagrams.length && !p.images.length;

function drawHeader(slide: any, title: string) {
  slide.addText(title, {
    x: 0.7, y: 0.42, w: 12, h: 0.9, fontSize: 26, bold: true, color: THEME.ink, valign: "middle", fontFace: CJK_FONT,
  });
  slide.addShape("rect", { x: 0.74, y: 1.32, w: 1.2, h: 0.06, fill: { color: THEME.accent } });
}

function drawFooter(slide: any, deckTitle: string, n: number, total: number) {
  slide.addText(deckTitle, {
    x: 0.7, y: 7.04, w: 9, h: 0.34, fontSize: 9, color: THEME.dim, align: "left", valign: "middle", fontFace: CJK_FONT,
  });
  slide.addText(`${n} / ${total}`, {
    x: 11.6, y: 7.04, w: 1.0, h: 0.34, fontSize: 10, color: THEME.dim, align: "right", valign: "middle", fontFace: CJK_FONT,
  });
}

type Plan =
  | { type: "cover"; page: SlidePage }
  | { type: "divider"; page: SlidePage }
  | { type: "content"; page: SlidePage; blocks: Block[]; cont: boolean; notes: string };

function planSlides(pages: SlidePage[]): Plan[] {
  const plan: Plan[] = [];
  pages.forEach((page, i) => {
    if (i === 0) { plan.push({ type: "cover", page }); return; }
    if (isDivider(page)) { plan.push({ type: "divider", page }); return; }
    const chunks = packBlocks(buildBlocks(page));
    chunks.forEach((blocks, ci) =>
      plan.push({ type: "content", page, blocks, cont: ci > 0, notes: ci === 0 ? page.notes : "" })
    );
  });
  return plan;
}

/** 生成真 .pptx（可编辑文本、Hive 主题、数字卡、讲者备注、溢出续页），返回 Buffer */
export async function slidesToPptx(doc: Doc): Promise<Buffer> {
  const pages = parseSlides(doc.content);
  const plan = planSlides(pages);
  const total = plan.length;
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: PAGE.w, height: PAGE.h });
  pptx.layout = "WIDE";
  pptx.title = doc.title;

  plan.forEach((p, idx) => {
    const slide = pptx.addSlide();
    slide.background = { color: THEME.bg };

    if (p.type === "cover") {
      const page = p.page;
      if (page.notes) slide.addNotes(page.notes);
      slide.addShape("rect", { x: 5.92, y: 2.55, w: 1.5, h: 0.08, fill: { color: THEME.accent } });
      slide.addText(page.title || doc.title, {
        x: 0.8, y: 2.85, w: 11.7, h: 1.5, fontSize: 40, bold: true, color: THEME.ink, align: "center", valign: "middle", fontFace: CJK_FONT,
      });
      const sub = [...page.paragraphs, ...page.bullets].join("　");
      if (sub) {
        slide.addText(sub, { x: 1.5, y: 4.45, w: 10.33, h: 0.8, fontSize: 16, color: THEME.dim, align: "center", fontFace: CJK_FONT });
      }
      return;
    }

    if (p.type === "divider") {
      slide.addShape("rect", { x: 0.9, y: 3.05, w: 1.5, h: 0.09, fill: { color: THEME.accent } });
      slide.addText(p.page.title, {
        x: 0.9, y: 3.35, w: 11.5, h: 1.4, fontSize: 34, bold: true, color: THEME.ink, align: "left", valign: "middle", fontFace: CJK_FONT,
      });
      return;
    }

    // content
    if (p.notes) slide.addNotes(p.notes);
    drawHeader(slide, p.cont ? `${p.page.title}（续）` : p.page.title);
    let y = CONTENT_TOP;
    for (const b of p.blocks) {
      b.draw(slide, y);
      y += b.h + 0.1;
    }
    drawFooter(slide, doc.title, idx + 1, total);
  });

  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}

/** 渲染清单（不实际生成文件）：验收/自查据此核对页数与产出元素，抓"声称 vs 实产"偏差。 */
export function slidesManifest(content: string): SlidesManifest {
  const pages = parseSlides(content);
  const plan = planSlides(pages);
  return {
    sourcePages: pages.length,
    renderedSlides: plan.length,
    continuationSlides: plan.filter((p) => p.type === "content" && p.cont).length,
    pagesWithNotes: pages.filter((p) => p.notes).length,
    tables: pages.reduce((a, p) => a + p.tables.length, 0),
    statCards: pages.reduce((a, p) => a + p.stats.length, 0),
    diagrams: pages.reduce((a, p) => a + p.diagrams.length, 0),
    droppedLinks: pages.reduce((a, p) => a + p.diagrams.reduce((b, d) => b + d.droppedLinks, 0), 0),
    images: pages.reduce((a, p) => a + p.images.length, 0),
  };
}

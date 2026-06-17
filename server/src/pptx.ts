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
  const m = line.match(/^(.{1,16}?)\s*::\s*(.{1,24})$/);
  if (!m) return null;
  const value = plain(m[1]);
  const label = plain(m[2]);
  if (!/[\d％%↑↓+＋]/.test(value)) return null; // 值必须像个指标
  if (!label) return null;
  return { value, label };
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
    const page: SlidePage = { title: "", bullets: [], paragraphs: [], stats: [], tables: [], code: [], images: [], notes: "" };
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
    for (let li = 0; li < lines.length; li++) {
      const t = lines[li].trim();
      if (/^```/.test(t)) {
        if (inCode) { if (codeBuf.length) page.code.push(codeBuf.join("\n")); codeBuf = []; inCode = false; }
        else inCode = true;
        continue;
      }
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
  images: number;
}

// ── 高度估算（用于溢出分页）──
const cp = (s: string) => [...s].length; // 码点数（CJK 友好）
function estLines(s: string, perLine: number): number {
  return Math.max(1, Math.ceil(cp(s) / perLine));
}

type Block = { h: number; draw: (slide: any, y: number) => void };

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
  Boolean(p.title) && !p.bullets.length && !p.paragraphs.length && !p.stats.length && !p.tables.length && !p.code.length && !p.images.length;

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
    images: pages.reduce((a, p) => a + p.images.length, 0),
  };
}

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
};

interface SlidePage {
  title: string;
  bullets: string[];
  paragraphs: string[];
  /** 本地生成图（/assets/xxx.png）的磁盘路径 */
  images: string[];
  notes: string;
}

/** /aiteam/assets/xxx.png → 磁盘路径（仅本地生成图可嵌入 pptx；外链跳过） */
function localImagePath(src: string): string | null {
  const m = src.match(/^\/aiteam\/assets\/([\w.-]+)$/);
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

/** 解析 Marp 风格 slides Markdown → 结构化页面 */
export function parseSlides(content: string): SlidePage[] {
  const raw = content
    .replace(/^\s*---\s*\n/, "")
    .split(/\n\s*---\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const isFrontmatter = (s: string) =>
    s.split("\n").every((line) => line.trim() === "" || /^[\w-]+\s*:/.test(line.trim()));

  const pages: SlidePage[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (i === 0 && isFrontmatter(raw[i])) continue;
    const page: SlidePage = { title: "", bullets: [], paragraphs: [], images: [], notes: "" };
    for (const line of raw[i].split("\n")) {
      const t = line.trim();
      const note = t.match(/^<!--\s*(?:note:?\s*)?([\s\S]*?)\s*-->$/i);
      if (note) {
        page.notes += (page.notes ? "\n" : "") + note[1];
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
      } else if (t && !/^[|>]/.test(t)) {
        page.paragraphs.push(plain(t));
      } else if (/^\|/.test(t) && !/^\|[\s:-]+\|/.test(t)) {
        // 表格行扁平化为要点
        page.bullets.push(plain(t.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).join(" · ")));
      }
    }
    pages.push(page);
  }
  return pages;
}

/** 生成真 .pptx（可编辑文本、Hive 主题、讲者备注），返回 Buffer */
export async function slidesToPptx(doc: Doc): Promise<Buffer> {
  const pages = parseSlides(doc.content);
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
  pptx.layout = "WIDE";
  pptx.title = doc.title;

  pages.forEach((page, i) => {
    const slide = pptx.addSlide();
    slide.background = { color: THEME.bg };
    if (page.notes) slide.addNotes(page.notes);

    if (i === 0) {
      // 标题页：居中大标题 + 琥珀色饰条
      slide.addShape("rect", { x: 5.92, y: 2.6, w: 1.5, h: 0.08, fill: { color: THEME.accent } });
      slide.addText(page.title || doc.title, {
        x: 0.8, y: 2.9, w: 11.7, h: 1.4,
        fontSize: 40, bold: true, color: THEME.ink, align: "center",
      });
      const sub = [...page.paragraphs, ...page.bullets].join("　");
      if (sub) {
        slide.addText(sub, { x: 0.8, y: 4.4, w: 11.7, h: 0.8, fontSize: 16, color: THEME.dim, align: "center" });
      }
      if (page.images[0]) {
        slide.addImage({ path: page.images[0], x: 4.92, y: 5.0, w: 3.5, h: 1.97 });
      }
      return;
    }

    // 内容页：左上标题 + 琥珀下划饰条 + 正文/要点
    slide.addText(page.title || `第 ${i + 1} 页`, {
      x: 0.7, y: 0.45, w: 12, h: 0.9, fontSize: 28, bold: true, color: THEME.ink,
    });
    slide.addShape("rect", { x: 0.74, y: 1.35, w: 1.2, h: 0.06, fill: { color: THEME.accent } });

    const body: { text: string; options: Record<string, unknown> }[] = [];
    for (const p of page.paragraphs) {
      body.push({ text: p, options: { fontSize: 15, color: THEME.ink, breakLine: true, paraSpaceAfter: 8 } });
    }
    for (const b of page.bullets) {
      body.push({
        text: b,
        options: { fontSize: 16, color: THEME.ink, bullet: { code: "2022" }, breakLine: true, paraSpaceAfter: 6 },
      });
    }
    // 有配图时文字让出右侧：左文右图
    const hasImage = page.images.length > 0;
    if (body.length > 0) {
      slide.addText(body, { x: 0.75, y: 1.7, w: hasImage ? 7.3 : 11.9, h: 5.2, valign: "top" });
    }
    if (hasImage) {
      slide.addImage({ path: page.images[0], x: 8.35, y: 1.7, w: 4.3, h: 2.42 });
    }
    // 页码
    slide.addText(`${i + 1} / ${pages.length}`, {
      x: 12.1, y: 7.0, w: 1, h: 0.35, fontSize: 10, color: THEME.dim, align: "right",
    });
  });

  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}

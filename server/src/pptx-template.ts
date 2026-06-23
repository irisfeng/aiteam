// 上传 .pptx 模板「就地改图文」核心（方案① OOXML 就地编辑 · MVP）。
// 原则：只读/改 ppt/slides/slideN.xml 的文本，绝不动 ppt/slideMasters|slideLayouts|theme（母版/版式天然保留），
// 也不动 ppt/media/*（本迭代不换图）。.pptx = OOXML zip，纯 Node 解压→改 XML→重打包，无 Python、无重依赖。
// pptxgenjs 是纯写出库、打不开现有 pptx，故这里另用 jszip + @xmldom/xmldom 做就地编辑。
import JSZipImport from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { Element as XmlElement, Node as XmlNode } from "@xmldom/xmldom";

// NodeNext + esModuleInterop 下 jszip 默认导出即构造器；兜底取 .default。
const JSZip: typeof import("jszip") = ((JSZipImport as unknown as { default?: unknown }).default ?? JSZipImport) as typeof import("jszip");
type Zip = Awaited<ReturnType<typeof JSZip.loadAsync>>;

const ELEMENT_NODE = 1;

export interface TemplateSlot {
  /** 0 基的演示顺序页号 */
  slideIdx: number;
  /** 该页 spTree 内「含文本框的形状(p:sp)」在文档序中的下标（解析/回写用同一枚举，保证定位稳定） */
  shapeIdx: number;
  /** 形状 txBody 内段落(a:p)下标 */
  paraIdx: number;
  /** 合并后的段落文本（来自各 a:r/a:t） */
  text: string;
  /** ph=占位符（继承母版版式），sp=自由文本框 */
  kind: "ph" | "sp";
}

export interface TemplateMeta {
  slideCount: number;
  slots: TemplateSlot[];
  /** 高风险结构告警（表格/图表/SmartArt/组合形状）——本 MVP 不就地改，提示用户「保留原样/建议降级」 */
  warnings: string[];
}

export interface TemplateEdit {
  slideIdx: number;
  shapeIdx: number;
  paraIdx: number;
  newText: string;
}

// ── DOM 小工具（@xmldom/xmldom 的 nodeName 即带前缀的限定名，如 "p:sp"/"a:t"）──
function childElements(parent: XmlNode, tag?: string): XmlElement[] {
  const out: XmlElement[] = [];
  const kids = parent.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n.nodeType === ELEMENT_NODE && (!tag || n.nodeName === tag)) out.push(n as XmlElement);
  }
  return out;
}
function firstChild(parent: XmlNode, tag: string): XmlElement | null {
  return childElements(parent, tag)[0] ?? null;
}
function runTexts(para: XmlElement): XmlElement[] {
  // 仅取 a:r 内的 a:t（避开 a:fld 字段如页码/日期，防误改）
  const ts: XmlElement[] = [];
  const runs = childElements(para, "a:r");
  for (const r of runs) {
    const t = firstChild(r, "a:t");
    if (t) ts.push(t);
  }
  return ts;
}

/** 解析上传 .pptx 的演示顺序（presentation.xml sldIdLst → rels → slideN.xml 路径）；解析失败按文件名数字兜底。 */
async function orderedSlidePaths(zip: Zip): Promise<string[]> {
  const slideFiles = Object.keys(zip.files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p));
  const byNumber = () =>
    [...slideFiles].sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)![1]);
      const nb = Number(b.match(/slide(\d+)\.xml$/)![1]);
      return na - nb;
    });
  try {
    const presFile = zip.file("ppt/presentation.xml");
    const relsFile = zip.file("ppt/_rels/presentation.xml.rels");
    if (!presFile || !relsFile) return byNumber();
    const presXml = await presFile.async("string");
    const relsXml = await relsFile.async("string");
    const pres = new DOMParser().parseFromString(presXml, "text/xml");
    const rels = new DOMParser().parseFromString(relsXml, "text/xml");
    // rId → target（slides/slideN.xml）
    const relMap = new Map<string, string>();
    const relEls = rels.getElementsByTagName("Relationship");
    for (let i = 0; i < relEls.length; i++) {
      const r = relEls[i];
      const id = r.getAttribute("Id");
      const target = r.getAttribute("Target");
      if (id && target && /slides\/slide\d+\.xml$/.test(target)) {
        relMap.set(id, target.replace(/^\//, "").replace(/^\.\.\//, "").replace(/^ppt\//, ""));
      }
    }
    const sldIds = pres.getElementsByTagName("p:sldId");
    const ordered: string[] = [];
    for (let i = 0; i < sldIds.length; i++) {
      // r:id 属性
      const rid = sldIds[i].getAttribute("r:id");
      if (!rid) continue;
      const target = relMap.get(rid);
      if (!target) continue;
      const full = target.startsWith("ppt/") ? target : "ppt/" + target;
      if (zip.file(full)) ordered.push(full);
    }
    return ordered.length ? ordered : byNumber();
  } catch {
    return byNumber();
  }
}

function detectWarnings(spTree: XmlElement, slideIdx: number): string[] {
  const w: string[] = [];
  const has = (tag: string) => (spTree.getElementsByTagName(tag).length > 0);
  if (has("a:tbl")) w.push(`第${slideIdx + 1}页含表格，本迭代不就地改表格内文本，保留原样`);
  if (has("c:chart") || has("cx:chart")) w.push(`第${slideIdx + 1}页含图表，保留原样，建议降级方案②`);
  if (has("dgm:relIds")) w.push(`第${slideIdx + 1}页含 SmartArt，保留原样，建议降级方案②`);
  if (childElements(spTree, "p:grpSp").length) w.push(`第${slideIdx + 1}页含组合形状，组内文本本迭代不就地改`);
  return w;
}

/** 枚举一页 spTree 内「含 txBody 的 p:sp」(文档序)，解析与回写共用，保证 shapeIdx 稳定。 */
function textShapes(spTree: XmlElement): XmlElement[] {
  return childElements(spTree, "p:sp").filter((sp) => firstChild(sp, "p:txBody"));
}

function shapeKind(sp: XmlElement): "ph" | "sp" {
  // p:sp/p:nvSpPr/p:nvPr/p:ph 存在即占位符
  const nv = firstChild(sp, "p:nvSpPr");
  const nvPr = nv ? firstChild(nv, "p:nvPr") : null;
  return nvPr && firstChild(nvPr, "p:ph") ? "ph" : "sp";
}

/** 只读解析：产出槽位清单 + 高风险结构告警。不修改任何内容。 */
export async function parseTemplate(buf: Buffer): Promise<TemplateMeta> {
  const zip = await JSZip.loadAsync(buf);
  const paths = await orderedSlidePaths(zip);
  const slots: TemplateSlot[] = [];
  const warnings: string[] = [];
  for (let slideIdx = 0; slideIdx < paths.length; slideIdx++) {
    const xml = await zip.file(paths[slideIdx])!.async("string");
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const spTree = doc.getElementsByTagName("p:spTree")[0];
    if (!spTree) continue;
    warnings.push(...detectWarnings(spTree, slideIdx));
    const shapes = textShapes(spTree);
    for (let shapeIdx = 0; shapeIdx < shapes.length; shapeIdx++) {
      const sp = shapes[shapeIdx];
      const txBody = firstChild(sp, "p:txBody")!;
      const paras = childElements(txBody, "a:p");
      for (let paraIdx = 0; paraIdx < paras.length; paraIdx++) {
        const text = runTexts(paras[paraIdx]).map((t) => t.textContent ?? "").join("");
        if (text.trim()) slots.push({ slideIdx, shapeIdx, paraIdx, text, kind: shapeKind(sp) });
      }
    }
  }
  return { slideCount: paths.length, slots, warnings };
}

/**
 * 文本就地替换：按 (slideIdx,shapeIdx,paraIdx) 定位段落，把该段首个 a:r 的 a:t 设为 newText、
 * 其余 a:r 的 a:t 清空（保留首 run 的 rPr 字体/颜色，整段沿用首 run 样式）。
 * 只重写有改动的 slide xml，其余 zip 条目（含母版/版式/主题/图片）原样回写。
 */
export async function applyTemplateEdits(buf: Buffer, edits: TemplateEdit[]): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buf);
  const paths = await orderedSlidePaths(zip);
  const bySlide = new Map<number, TemplateEdit[]>();
  for (const e of edits) {
    if (e.slideIdx < 0 || e.slideIdx >= paths.length) continue;
    let arr = bySlide.get(e.slideIdx);
    if (!arr) { arr = []; bySlide.set(e.slideIdx, arr); }
    arr.push(e);
  }
  for (const [slideIdx, slideEdits] of bySlide) {
    const path = paths[slideIdx];
    const raw = await zip.file(path)!.async("string");
    const decl = raw.match(/^<\?xml[^>]*\?>/)?.[0] ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const doc = new DOMParser().parseFromString(raw, "text/xml");
    const spTree = doc.getElementsByTagName("p:spTree")[0];
    if (!spTree) continue;
    const shapes = textShapes(spTree);
    for (const e of slideEdits) {
      const sp = shapes[e.shapeIdx];
      if (!sp) continue;
      const txBody = firstChild(sp, "p:txBody");
      if (!txBody) continue;
      const para = childElements(txBody, "a:p")[e.paraIdx];
      if (!para) continue;
      const ts = runTexts(para);
      if (!ts.length) continue;
      ts[0].textContent = e.newText;
      for (let i = 1; i < ts.length; i++) ts[i].textContent = "";
    }
    let out = new XMLSerializer().serializeToString(doc);
    if (!out.startsWith("<?xml")) out = decl + (decl.endsWith("\n") ? "" : "\n") + out;
    zip.file(path, out);
  }
  const u8 = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return Buffer.from(u8);
}

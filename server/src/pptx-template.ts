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
  /** 合并后的段落文本（来自各 a:r/a:t）；空占位符为 "" */
  text: string;
  /** ph=占位符（继承母版版式），sp=自由文本框 */
  kind: "ph" | "sp";
  /** 空占位符的类型友好名（标题/正文/副标题…），供 UI/AI 提示该往里填什么；非空槽不带 */
  phType?: string;
}

/** 图片槽：模板里已有的图片(p:pic) 或带 xfrm 的空图片占位(p:sp ph=pic/obj)。可替换/填入生成或上传的图。 */
export interface ImageSlot {
  slideIdx: number;
  /** 该页所有"图片位"(p:pic + 空图片占位)在文档序中的下标；解析/回写共用，定位稳定 */
  imageIdx: number;
  /** pic=已有图片可替换；ph=空图片占位（需有 xfrm 才可填入，否则 fillable=false） */
  type: "pic" | "ph";
  label: string;
  /** 显示宽高(EMU)，供提示比例；可空 */
  cx?: number;
  cy?: number;
  /** 是否可被本迭代填/换（pic 恒可；空占位需自身带 xfrm 几何） */
  fillable: boolean;
}

export interface TemplateMeta {
  slideCount: number;
  slots: TemplateSlot[];
  /** 图片位清单（替换已有图 / 填入空图片占位） */
  images: ImageSlot[];
  /** 高风险结构告警（表格/图表/SmartArt/组合形状）——本 MVP 不就地改，提示用户「保留原样/建议降级」 */
  warnings: string[];
}

export interface TemplateEdit {
  slideIdx: number;
  shapeIdx: number;
  paraIdx: number;
  newText: string;
}

/** 图片编辑：把某图片位替换/填入为 base64 图片字节（png/jpeg）。 */
export interface ImageEdit {
  slideIdx: number;
  imageIdx: number;
  /** base64（不含 data: 前缀）图片数据 */
  dataBase64: string;
  /** 扩展名：png / jpg / jpeg（决定 media 文件名与 Content_Types） */
  ext: string;
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

function placeholderEl(sp: XmlElement): XmlElement | null {
  const nv = firstChild(sp, "p:nvSpPr");
  const nvPr = nv ? firstChild(nv, "p:nvPr") : null;
  return nvPr ? firstChild(nvPr, "p:ph") : null;
}
function shapeKind(sp: XmlElement): "ph" | "sp" {
  return placeholderEl(sp) ? "ph" : "sp";
}
const PH_TYPE_LABEL: Record<string, string> = {
  title: "标题", ctrTitle: "主标题", subTitle: "副标题", body: "正文", tx: "文本",
  ftr: "页脚", dt: "日期", sldNum: "页码", hdr: "页眉",
};
/** 空占位符的友好类型名（供提示该填什么）。p:ph 无 type 属性时多为正文，按 idx 兜底为「内容」。 */
function phTypeOf(sp: XmlElement): string {
  const ph = placeholderEl(sp);
  const t = ph?.getAttribute("type") || "";
  return PH_TYPE_LABEL[t] || (t ? t : "内容");
}

// ── 图片位（替换已有图 / 填入空图片占位）──
function getXfrm(el: XmlElement): { x: string; y: string; cx: string; cy: string } | null {
  const spPr = firstChild(el, "p:spPr");
  const xf = spPr ? firstChild(spPr, "a:xfrm") : null;
  if (!xf) return null;
  const off = firstChild(xf, "a:off"), ext = firstChild(xf, "a:ext");
  if (!off || !ext) return null;
  return { x: off.getAttribute("x") || "0", y: off.getAttribute("y") || "0", cx: ext.getAttribute("cx") || "0", cy: ext.getAttribute("cy") || "0" };
}
/** 一页内所有"图片位"(文档序)：已有图片 p:pic + 空图片占位 p:sp(ph type=pic/obj/clipArt)。解析/回写共用，下标稳定。 */
function imageElements(spTree: XmlElement): { el: XmlElement; type: "pic" | "ph" }[] {
  const out: { el: XmlElement; type: "pic" | "ph" }[] = [];
  for (const el of childElements(spTree)) {
    if (el.nodeName === "p:pic") out.push({ el, type: "pic" });
    else if (el.nodeName === "p:sp") {
      const ph = placeholderEl(el);
      const t = ph?.getAttribute("type") || "";
      if (ph && (t === "pic" || t === "obj" || t === "clipArt")) out.push({ el, type: "ph" });
    }
  }
  return out;
}
function safeImgExt(ext: string): string {
  return /^(png|jpg|jpeg|gif|webp)$/i.test(ext) ? ext.toLowerCase() : "png";
}
function mimeOf(ext: string): string {
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/png";
}
const REL_NS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
/** 往 zip 加一张图：写 ppt/media、在该 slide 的 .rels 注册新 rId、确保 [Content_Types] 有该扩展名 Default。返回 rId。 */
async function addImageMedia(zip: Zip, slidePath: string, dataBase64: string, ext: string): Promise<string> {
  const e = safeImgExt(ext);
  const mediaNames = Object.keys(zip.files).filter((p) => /^ppt\/media\/[^/]+$/.test(p));
  let maxN = 0;
  for (const p of mediaNames) { const m = p.match(/image(\d+)\./i); if (m) maxN = Math.max(maxN, Number(m[1])); }
  let n = maxN + 1;
  while (zip.file(`ppt/media/image${n}.${e}`)) n++; // 防与既有命名(如 pptxgenjs 的怪名)撞车
  const fileName = `image${n}.${e}`;
  zip.file(`ppt/media/${fileName}`, Buffer.from(dataBase64, "base64"));
  // rels：ppt/slides/slideN.xml → ppt/slides/_rels/slideN.xml.rels
  const relsPath = slidePath.replace(/(.*\/)([^/]+)$/, "$1_rels/$2.rels");
  const relsXml = (await zip.file(relsPath)?.async("string")) ||
    REL_NS + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const relsDoc = new DOMParser().parseFromString(relsXml, "text/xml");
  const relsRoot = relsDoc.getElementsByTagName("Relationships")[0];
  let maxRid = 0;
  const rels = relsRoot.getElementsByTagName("Relationship");
  for (let i = 0; i < rels.length; i++) { const m = (rels[i].getAttribute("Id") || "").match(/rId(\d+)/); if (m) maxRid = Math.max(maxRid, Number(m[1])); }
  const rId = `rId${maxRid + 1}`;
  const rel = relsDoc.createElement("Relationship");
  rel.setAttribute("Id", rId);
  rel.setAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image");
  rel.setAttribute("Target", `../media/${fileName}`);
  relsRoot.appendChild(rel);
  let relsOut = new XMLSerializer().serializeToString(relsDoc);
  if (!relsOut.startsWith("<?xml")) relsOut = REL_NS + relsOut;
  zip.file(relsPath, relsOut);
  // Content_Types：缺该扩展名 Default 就补
  const ctPath = "[Content_Types].xml";
  const ctXml = await zip.file(ctPath)?.async("string");
  if (ctXml && !new RegExp(`Extension="${e}"`, "i").test(ctXml)) {
    const ctDoc = new DOMParser().parseFromString(ctXml, "text/xml");
    const ctRoot = ctDoc.getElementsByTagName("Types")[0];
    const d = ctDoc.createElement("Default");
    d.setAttribute("Extension", e);
    d.setAttribute("ContentType", mimeOf(e));
    ctRoot.insertBefore(d, ctRoot.firstChild); // Default 应在 Override 之前
    let ctOut = new XMLSerializer().serializeToString(ctDoc);
    if (!ctOut.startsWith("<?xml")) ctOut = REL_NS + ctOut;
    zip.file(ctPath, ctOut);
  }
  return rId;
}
/** 用占位符几何新建一个 p:pic（填入空图片占位）。无 xfrm 返回 null（不乱猜位置）。 */
function buildPicFromPlaceholder(doc: any, sp: XmlElement, rId: string, picId: number): XmlElement | null {
  const xf = getXfrm(sp);
  if (!xf) return null;
  const ph = placeholderEl(sp);
  const E = (tag: string) => doc.createElement(tag) as XmlElement;
  const pic = E("p:pic");
  const nvPicPr = E("p:nvPicPr");
  const cNvPr = E("p:cNvPr"); cNvPr.setAttribute("id", String(picId)); cNvPr.setAttribute("name", "Picture " + picId);
  const cNvPicPr = E("p:cNvPicPr");
  const nvPr = E("p:nvPr"); if (ph) nvPr.appendChild(ph.cloneNode(true));
  nvPicPr.appendChild(cNvPr); nvPicPr.appendChild(cNvPicPr); nvPicPr.appendChild(nvPr);
  const blipFill = E("p:blipFill");
  const blip = E("a:blip"); blip.setAttribute("r:embed", rId);
  const stretch = E("a:stretch"); stretch.appendChild(E("a:fillRect"));
  blipFill.appendChild(blip); blipFill.appendChild(stretch);
  const spPr = E("p:spPr");
  const xfrm = E("a:xfrm");
  const off = E("a:off"); off.setAttribute("x", xf.x); off.setAttribute("y", xf.y);
  const ext = E("a:ext"); ext.setAttribute("cx", xf.cx); ext.setAttribute("cy", xf.cy);
  xfrm.appendChild(off); xfrm.appendChild(ext);
  const geom = E("a:prstGeom"); geom.setAttribute("prst", "rect"); geom.appendChild(E("a:avLst"));
  spPr.appendChild(xfrm); spPr.appendChild(geom);
  pic.appendChild(nvPicPr); pic.appendChild(blipFill); pic.appendChild(spPr);
  return pic;
}

/** 只读解析：产出槽位清单 + 高风险结构告警。不修改任何内容。 */
export async function parseTemplate(buf: Buffer): Promise<TemplateMeta> {
  const zip = await JSZip.loadAsync(buf);
  const paths = await orderedSlidePaths(zip);
  const slots: TemplateSlot[] = [];
  const images: ImageSlot[] = [];
  const warnings: string[] = [];
  for (let slideIdx = 0; slideIdx < paths.length; slideIdx++) {
    const xml = await zip.file(paths[slideIdx])!.async("string");
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const spTree = doc.getElementsByTagName("p:spTree")[0];
    if (!spTree) continue;
    warnings.push(...detectWarnings(spTree, slideIdx));
    // 图片位：已有图片(可换) + 空图片占位(有 xfrm 才可填)
    imageElements(spTree).forEach((im, imageIdx) => {
      const xf = getXfrm(im.el);
      images.push({
        slideIdx, imageIdx, type: im.type,
        label: im.type === "pic" ? "图片" : "空图片占位",
        cx: xf ? Number(xf.cx) : undefined, cy: xf ? Number(xf.cy) : undefined,
        fillable: im.type === "pic" || !!xf, // 已有图恒可换；空占位需自带几何
      });
    });
    const shapes = textShapes(spTree);
    for (let shapeIdx = 0; shapeIdx < shapes.length; shapeIdx++) {
      const sp = shapes[shapeIdx];
      const kind = shapeKind(sp);
      const txBody = firstChild(sp, "p:txBody")!;
      const paras = childElements(txBody, "a:p");
      let anyText = false;
      for (let paraIdx = 0; paraIdx < paras.length; paraIdx++) {
        const text = runTexts(paras[paraIdx]).map((t) => t.textContent ?? "").join("");
        if (text.trim()) { anyText = true; slots.push({ slideIdx, shapeIdx, paraIdx, text, kind }); }
      }
      // 空占位符（设计师留的空标题/正文框，无任何文字）：也列成一个可填槽，paraIdx=0，供「空模板生成图文」。
      // 仅占位符(p:ph)如此处理；空的自由文本框多为装饰，不打扰。
      if (!anyText && kind === "ph") slots.push({ slideIdx, shapeIdx, paraIdx: 0, text: "", kind, phType: phTypeOf(sp) });
    }
  }
  return { slideCount: paths.length, slots, images, warnings };
}

/**
 * 文本就地替换：按 (slideIdx,shapeIdx,paraIdx) 定位段落，把该段首个 a:r 的 a:t 设为 newText、
 * 其余 a:r 的 a:t 清空（保留首 run 的 rPr 字体/颜色，整段沿用首 run 样式）。
 * 只重写有改动的 slide xml，其余 zip 条目（含母版/版式/主题/图片）原样回写。
 */
export async function applyTemplateEdits(buf: Buffer, edits: TemplateEdit[], imageEdits: ImageEdit[] = []): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buf);
  const paths = await orderedSlidePaths(zip);
  const affected = new Set<number>();
  const bySlide = new Map<number, TemplateEdit[]>();
  for (const e of edits) {
    if (e.slideIdx < 0 || e.slideIdx >= paths.length) continue;
    let arr = bySlide.get(e.slideIdx);
    if (!arr) { arr = []; bySlide.set(e.slideIdx, arr); }
    arr.push(e);
    affected.add(e.slideIdx);
  }
  const imgBySlide = new Map<number, ImageEdit[]>();
  for (const e of imageEdits) {
    if (e.slideIdx < 0 || e.slideIdx >= paths.length || !e.dataBase64) continue;
    let arr = imgBySlide.get(e.slideIdx);
    if (!arr) { arr = []; imgBySlide.set(e.slideIdx, arr); }
    arr.push(e);
    affected.add(e.slideIdx);
  }
  let picSeq = 9000; // 新建 p:pic 的 cNvPr id（避开既有，唯一即可）
  for (const slideIdx of affected) {
    const slideEdits = bySlide.get(slideIdx) ?? [];
    const path = paths[slideIdx];
    const raw = await zip.file(path)!.async("string");
    const decl = raw.match(/^<\?xml[^>]*\?>/)?.[0] ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const doc = new DOMParser().parseFromString(raw, "text/xml");
    const spTree = doc.getElementsByTagName("p:spTree")[0];
    if (!spTree) continue;
    // 图片编辑（解析时同一 imageElements 枚举，下标稳定；replaceChild 保位置不改下标）
    const imgs = imageElements(spTree);
    for (const ie of imgBySlide.get(slideIdx) ?? []) {
      const slot = imgs[ie.imageIdx];
      if (!slot) continue;
      const rId = await addImageMedia(zip, path, ie.dataBase64, ie.ext);
      if (slot.type === "pic") {
        const blipFill = firstChild(slot.el, "p:blipFill");
        const blip = blipFill ? firstChild(blipFill, "a:blip") : null;
        if (blip) blip.setAttribute("r:embed", rId);
      } else {
        const pic = buildPicFromPlaceholder(doc, slot.el, rId, ++picSeq);
        if (pic && slot.el.parentNode) slot.el.parentNode.replaceChild(pic, slot.el);
      }
    }
    const shapes = textShapes(spTree);
    for (const e of slideEdits) {
      const sp = shapes[e.shapeIdx];
      if (!sp) continue;
      const txBody = firstChild(sp, "p:txBody");
      if (!txBody) continue;
      let para = childElements(txBody, "a:p")[e.paraIdx];
      if (!para) {
        // 空占位符可能 txBody 无 a:p：补一个，让文本能落进去
        para = doc.createElement("a:p");
        txBody.appendChild(para);
      }
      const ts = runTexts(para);
      if (ts.length) {
        ts[0].textContent = e.newText;
        for (let i = 1; i < ts.length; i++) ts[i].textContent = "";
      } else {
        // 空段落（无 a:r）：新建一个 run；不写具体 rPr，让其继承占位符/母版的字体与配色（保留模板设计）。
        // 插到 a:endParaRPr 之前（若有），否则追加到段末。
        const r = doc.createElement("a:r");
        const rPr = doc.createElement("a:rPr");
        rPr.setAttribute("lang", "zh-CN");
        const t = doc.createElement("a:t");
        t.textContent = e.newText;
        r.appendChild(rPr);
        r.appendChild(t);
        const endPr = firstChild(para, "a:endParaRPr");
        if (endPr) para.insertBefore(r, endPr); else para.appendChild(r);
      }
    }
    let out = new XMLSerializer().serializeToString(doc);
    if (!out.startsWith("<?xml")) out = decl + (decl.endsWith("\n") ? "" : "\n") + out;
    zip.file(path, out);
  }
  const u8 = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return Buffer.from(u8);
}

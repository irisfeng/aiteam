# SPEC：上传 .pptx 模板就地改图文（方案① OOXML 就地编辑 · MVP）

状态：已立项方向，待实现。
来源：评估工作流 wf_da4e0715-637（8 路侦察 + 3 路对抗校验 + 综合）。
决策：方案①（就地编 OOXML）/ 首迭代只换文本、图保留原图 / 用户逐槽确认。

## 1. 目标与边界

目标：用户上传一份现成 .pptx（品牌/企业模板），系统把其中**文字**结构化成「槽位清单」，用户逐槽确认/编辑（或让对口 AI 同事按来源产出替换文案），系统**只改 `ppt/slides/slideN.xml` 的文本、不动母版/版式/主题/图片**，重新打包导出一份保留原设计的可编辑 .pptx。

明确不做（本 MVP）：
- 不换图片（`ppt/media/*` 原样保留）——尺寸/裁剪框/rels/[Content_Types].xml 同步留到下一迭代。
- 不增减页（只编辑既有 slide，页数 = 模板页数，绕开页数不匹配问题）。
- 不保证 SmartArt / 图表 / 组合形状 / 复杂跨 run 富格式的像素级保真——检测到就**标注"保留原样/建议降级方案②"**，诚实呈现边界。

诚实红线（沿用既有）：上传原二进制按 owner 隔离落盘，**绝不挂 express.static**；HTML 预览继续 `sandbox=""`；导出 .pptx 跨端（PowerPoint/WPS/Keynote）保真无自动化校验，列为已知缺口、人工 QA。

## 2. 为什么是这条路（已被对抗校验钉死）

- pptxgenjs@4.0.1 是纯「写出」库，无 load/read/open API → **打不开现有 pptx**，就地编辑必须绕过它。（confirmed）
- 现管线对上传 .pptx 只做 markitdown 文本抽取、原二进制即用即删 → **今天做不到就地改**。（confirmed）
- `.pptx = OOXML zip`，只改 `ppt/slides/*` + `ppt/media/*`、不动 `ppt/slideMasters|slideLayouts|theme` → **母版/版式天然保留**；底层库 jszip(已在 node_modules)/pizzip + fast-xml-parser/@xmldom 均 MIT、大陆 npm 可达、纯 Node、无 Python。（partial：可行但需自研，无开箱即用免费库）

三大自研风险（实现时必须正面处理）：① 同段文字常被拆进多个 `<a:r>`/`<a:t>`，逐节点替换会漏/错 → **先按段(`<a:p>`)合并 run、替换、再归一**；② 占位符 `<p:ph>` vs 自由文本框 `<p:sp>` 定位方式不同 → 槽位用 (slideIdx, shapeIdx, paragraphIdx) 稳定定位；③ 大文件解析+重打可能超时 / 超 20MB multer 上限 → MVP 限模板大小，必要时后台任务化。

## 3. 切片（每片可独立验收）

### 切片 0 — 测试夹具
- 用现有 `slidesToPptx` 导出一份多页 deck 作为 `.pptx` 测试夹具（含标题/正文/表格/讲者备注/一张图），存 `server/test/fixtures/`。
- 验收：夹具可被 PowerPoint/WPS 正常打开。

### 切片 1 — 数据模型与持久化
- `db.ts`：documents 表 `addColumnIfMissing`：`binary_format TEXT`（如 'pptx'）、`original_blob_path TEXT`、`template_meta TEXT`（JSON 槽位清单）。新增 doc kind `"template"`。
- 原二进制存 owner 隔离目录（如 `server/data/templates/<owner>/<docId>.pptx`），权限仅服务端读取，**不进任何 static 路由**。
- 验收：上传 .pptx「作为模板」后，DB 有 kind=template 记录 + 原文件落盘 + 文本（markitdown）仍抽取供 AI 理解；普通「来源」上传路径不受影响（回归 UP1 仍过）。

### 切片 2 — OOXML 只读解析（槽位清单）
- 新模块 `server/src/pptx-template.ts`：`parseTemplate(buf) → { slides: [{ idx, shapes: [{ shapeIdx, kind: 'ph'|'sp', paragraphs: [{ paraIdx, text, runMerged: true }] }] }], warnings: ['slide3 含图表，建议降级'] }`。
- jszip 解压 → 遍历 `ppt/slides/slideN.xml`（按 `ppt/_rels/presentation.xml.rels` 定页序）→ fast-xml-parser 解析 → 按 `<a:p>` 合并 `<a:r>/<a:t>` 文本 → 产出槽位 + 高风险结构告警。
- 写入 `template_meta`，前端展示。
- 验收（回归 PTPL-PARSE）：解析切片 0 夹具，槽位数/原文与已知值一致；含图表/SmartArt 页进 warnings。

### 切片 3 — 文本就地替换 + 导出
- `pptx-template.ts`：`applyEdits(originalBuf, edits[]) → newBuf`。edits=[{slideIdx, shapeIdx, paraIdx, newText}]。jszip load 原文件 → 定位段 → **把该段首个 run 的 `<a:t>` 设为 newText、清空同段其余 run 文本（保留首 run 的字体/颜色 rPr）** → 不动 master/layout/theme/media → 重打包。
- 新导出端点 `GET /documents/:id/pptx`（模板 doc 走就地编辑分支）或 `:id/pptx-template`，复用既有导出按钮。
- 验收（回归 PTPL-EDIT）：替换夹具某页标题 → 重新 `parseTemplate` 新文件该槽文本已变、其余槽不变、`slideMasters/theme` 字节未变；导出包是合法 zip、可被 PowerPoint 打开。

### 切片 4 — AI 产文案 + 逐槽确认 UI
- 后端：AI 同事按「槽位清单 + 可选来源文档」逐槽产出替换文案，结构化 JSON 输出，复用未引用数字软门校验（防臆造数字）。可走新工具 `propose_template_edits` 或扩展现有任务路径。
- 前端：新「模板编辑」面板——左列槽位清单（页号+原文），右列 AI 建议/用户可改，勾选要替换的槽 → 提交 → 调切片 3 导出。逐槽确认是默认（不自动改品牌固定文案）。
- 验收：端到端——上传模板 → 看槽位 → AI 填/用户改 → 导出保真 .pptx。

### 切片 5 — 能力边界与降级
- 导出附「已替换 / 未替换（含原因）」清单；检测到 SmartArt/图表/复杂跨 run → 该槽标「保留原样，建议降级方案②（抽风格重建）」。
- 文案/技能：在「解决方案/售前方案法」「可编辑 PPTX 能力」里加一句指向「模板就地改」能力与其边界。

## 4. 依赖与约束

- 复用 jszip（已在 node_modules，随 pptxgenjs）；按需评估 pizzip（同步、更贴近原样回写，docxtemplater 即基于它——小样本回归对比 jszip 是否改变包内文件顺序/属性影响保真后再定）。新增 fast-xml-parser 或 @xmldom/xmldom（均 MIT、大陆可达）。**无 Python、无重依赖**，契合大陆腾讯云 VPS 部署。
- 不启用 pptx-native(ppt-master) MCP（高危 exec、默认关、且只生成不读上传件）。

## 5. 开放问题（实现中决策）

- jszip vs pizzip：保真回归对比后定。
- 大文件/超时：是否放宽 20MB、是否后台任务化（结合共用主机资源）。
- 国产模型结构化槽位 JSON 稳定性：小样本验证不破格/不漏槽/不臆造数字。
- 图片替换（下一迭代）：尺寸/裁剪框/r:embed/rels/[Content_Types].xml 同步方案。

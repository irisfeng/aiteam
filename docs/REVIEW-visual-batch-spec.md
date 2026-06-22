# 视觉质量批次 · 实现规格（slides 架构图 + html-deck 模板）

> 目标：把 AITeam 的 `slides`(pptx) 与 `html-deck` 视觉质量提到「中上等」。借鉴外部资产的版式语言，但全部落到本仓库约束内：不引入 Python / 重型系统依赖，优先用已装的 `pptxgenjs@4.0.1`（仓库根 `node_modules`，经 hoisting 解析）原生形状能力；html 模板必须过 `validateDocContent` + 脚本关闭可渲染 + 用项目 CJK 字体栈。
>
> 本规格已吸收对抗校验结论。**最重要的红线：`pptxgenjs` 不支持 shape 渐变填充，渐变会被静默丢弃成透明框——全程禁用 `fill:{type:'gradient',...}`，主节点用实色 + `shadow`(outerShdw)，子节点用白底 + 彩色描边。** 详见 §1.4。
>
> 关联文件：
> - 渲染器 `server/src/pptx.ts`
> - 模板注册 `server/src/registry.ts`
> - 校验 `server/src/agents/engine.ts`（`validateDocContent`）
> - 版本号 `server/src/seed.ts`（`BUILTIN_SKILL_PACK_VERSION`）

---

## 0. 校验结论速记（实现时的硬约束）

| 结论 | 状态 | 实现含义 |
|---|---|---|
| 原生形状词汇（roundRect / line+triangle 箭头 / custGeom moveTo / chevron / diamond / donut / rectRadius / flipH·flipV / dashType / outerShdw 阴影）覆盖分层·流程·中心辐射图，零新依赖 | ✅ 已验证（DrawingML 解包确认） | 架构图走原生形状路线（**必做**） |
| shape `fill:{type:'gradient',stops:[...]}` 被 PoC「验证」 | ❌ **假**，最大误判，**拒绝** | 渐变被静默丢弃→透明框。改用实色 + `shadow` + 白底彩描边 |
| ` ```arch ` / ` ```diagram ` 围栏约定在 `parseSlides` fence 拦截处接入、入 `page.diagrams`、`buildBlocks` 出块、`slidesManifest` 计数 | ✅ 接入点准确 | 注意 L137 当前**丢弃 info-string**，须改为捕获语言标签；`isDivider` 须把 `.diagrams` 计入 |
| SVG→PNG 光栅化对架构图**非必需**，`@resvg/resvg-wasm` 推迟到二期 | ✅ 正确降范围 | 原生形状是真矢量、可编辑，优于光栅；二期仅给原生几何表达不了的图形（桑基/词云） |
| 三套新 html-deck 模板过 `validateDocContent` + 脚本关闭可渲染 | ✅ 已用引擎正则实跑验证 | 按现有 `SKILL_TEMPLATES` 模式新增 const + 数组项即可 |
| 现有 TPL1（html-deck-horizontal）脚本关闭可渲染 / 可作回归基线 | ❌ **有缺陷** | `.slide{opacity:0}` 仅靠 JS `.active` 点亮；空 sandbox 下脚本不跑→预览全空白。**同批修复**，勿当回归金样 |

---

## 1. 架构图：Markdown 约定 + pptx.ts 解析与渲染

### 1.1 设计原则

- **DSL 严格正交**：只支持三种确定布局——`layered`（分层/堆叠）、`flow`（流程/链）、`hub`（中心辐射）。不做任意有向图自动布局（无轻量纯 JS 方案）。
- **模型按约定写、渲染器渲成框加箭头**：模型只写节点与边的语义，坐标布局完全由渲染器算。
- **CJK 一等公民**：节点框宽度用现有 `cp()`（码点数，L192）估，CJK 标签自动换行 / 超长省略，绝不溢出框。
- **与现有管线无缝集成**：新增 `page.diagrams` 字段，走现有 `Block`/`packBlocks` 溢出模型，并入 `slidesManifest`。

### 1.2 给模型用的 Markdown 约定（确定语法）

围栏块 ` ```arch ` 或 ` ```diagram `（二者等价，`arch` 为推荐别名）。块内首行是**指令头**，其余行是节点/边定义。

#### 语法（行级，宽松解析）

```text
​```arch
type: layered            # 三选一：layered | flow | hub（缺省 layered）
dir: down                # layered/flow 的主轴方向：down(默认) | right
title: 数据处理管线        # 可选，渲在图上方小标题（与页 header 区分）

# 节点：`[组] 节点名` 或 `节点名`；同组节点渲成同一层/同一环
[接入] 网关
[接入] 鉴权
[核心] 调度器
[存储] 主库
[存储] 缓存

# 边：`A -> B` 实线箭头；`A --> B` 虚线箭头；`A -- 标签 --> B` 带标签
网关 -> 调度器
鉴权 -> 调度器
调度器 -> 主库
调度器 -. 异步 .-> 缓存
​```
```

#### 三种 type 的语义与渲染形态

| type | 节点排布 | 组 `[..]` 的作用 | 边渲染 |
|---|---|---|---|
| `layered` | 按出现的**组顺序**分层；`dir:down` 时每组占一横排（层从上到下），`dir:right` 时每组占一竖列（层从左到右） | 组 = 层；同组节点在同层内均分 | 直角折线（custGeom elbow）连接层间节点，末端 triangle 箭头 |
| `flow` | 节点按出现顺序成一条链（`dir:right` 横排，`dir:down` 竖排）；忽略组只用顺序 | 仅作视觉分段色（可选） | 相邻节点用 chevron（箭头块）或带箭头直线串联 |
| `hub` | 第一个节点为中心，其余均匀环绕 | 忽略 | 中心→每个外节点的直线 + triangle 箭头 |

#### 边语法精确表

| 写法 | 含义 |
|---|---|
| `A -> B` | 实线，末端 triangle 箭头 |
| `A --> B` | 同上（`->` 与 `-->` 等价，容错） |
| `A -. B` 或 `A -.-> B` | 虚线（`dashType:'dash'`），末端 triangle 箭头 |
| `A -- 文字 --> B` | 实线带边标签（标签渲在折线中点小字） |
| `A -. 文字 .-> B` | 虚线带边标签 |

#### 容错与诚实红线（模型须知，也是渲染器行为）

- 节点名去空白后唯一；**重复节点名**只保留首次定义、渲染器 `console.warn` 一次（防 anchor-table 碰撞）。
- 边引用了未定义节点 → **静默跳过该边并计入 `droppedLinks`**（manifest 暴露），不报错、不渲染半截箭头。
- 节点 > 单层容量（layered 每层 > 6、hub 外节点 > 8）→ 自动缩小框 + 缩字；仍放不下则截断尾部节点并 warn。
- 节点标签超长（CJK 估宽 > 框宽）→ 先尝试两行换行，仍超则尾部省略号 `…`。

### 1.3 parseSlides 接入（pptx.ts，精确改动点）

> 所有行号以当前 `server/src/pptx.ts` 为准。

**(a) `SlidePage` 接口加字段（L43-56 区）**

```ts
interface DiagramNode { id: string; group: string; label: string; }
interface DiagramEdge { from: string; to: string; label: string; dashed: boolean; }
interface SlideDiagram {
  type: "layered" | "flow" | "hub";
  dir: "down" | "right";
  title: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  droppedLinks: number;   // 引用缺失节点而被丢弃的边数
}
interface SlidePage {
  // …现有字段…
  diagrams: SlideDiagram[];
}
```

**(b) init 对象补字段（L107）**：`{ …, diagrams: [], … }`。

**(c) fence 拦截改造（L137-142）**——当前 `if (/^```/.test(t))` **丢弃了 info-string**，须改成捕获语言标签并按标签分流到代码 / 架构图两条缓冲：

```ts
let inCode = false, codeBuf: string[] = [];
let inDiagram = false, diagramBuf: string[] = [];
// …循环内…
const fence = t.match(/^```(\w+)?/);
if (fence) {
  const lang = (fence[1] || "").toLowerCase();
  if (inCode) { if (codeBuf.length) page.code.push(codeBuf.join("\n")); codeBuf = []; inCode = false; continue; }
  if (inDiagram) { const d = parseDiagram(diagramBuf); if (d) page.diagrams.push(d); diagramBuf = []; inDiagram = false; continue; }
  if (lang === "arch" || lang === "diagram") inDiagram = true;
  else inCode = true;
  continue;
}
if (inDiagram) { diagramBuf.push(lines[li]); continue; }
if (inCode) { codeBuf.push(lines[li]); continue; }
```

**(d) 未闭合围栏兜底（L174）**：与 `inCode` 并列，加 `if (inDiagram && diagramBuf.length) { const d = parseDiagram(diagramBuf); if (d) page.diagrams.push(d); }`。

**(e) `isDivider`（L347）**：把 `.diagrams.length` 加进 AND 链，否则「标题 + 一张图」页会被误判为章节幕页（被当 divider 丢掉正文）：

```ts
const isDivider = (p) => Boolean(p.title) && !p.bullets.length && !p.paragraphs.length
  && !p.stats.length && !p.tables.length && !p.code.length && !p.images.length && !p.diagrams.length;
```

> HTML 剥离保护：L126-129 已按 ` /(```[\s\S]*?```)/g ` 分段、只对偶数段剥 HTML 标签，` ```arch ` 块落在奇数段被保护，块内含 `<>` 不会被吃。无需改动。

**(f) `parseDiagram(buf: string[]): SlideDiagram | null`（新函数，放在 `parseSlides` 上方）**

解析逻辑：
1. 逐行 trim；`#` 起头的行 = 注释，丢弃；空行丢弃。
2. `key: value` 头（`type` / `dir` / `title`）大小写不敏感，归一化；`type` 非三选一回退 `layered`，`dir` 非 `right` 回退 `down`。
3. 边行：正则 `/^(.+?)\s*-{1,2}\.?(?:\s*(.+?)\s*\.?)?-{0,2}>\s*(.+)$/` 不够稳，**改用两步法**——先判断含 `->`/`.->`：用 `.split(/\s*-\.?-?>?\s*/)` 风险高，**推荐显式匹配**：
   - dashed = 行内含 `-.`（如 `-.`、`-.->`）；
   - 用 `line.match(/^(.+?)\s*-{1,2}\.?-?(?:\s+(.+?)\s+)?\.?-{0,2}>\s*(.+)$/)` 提取 `from / label? / to`；解析失败的边行当普通节点行处理或丢弃并 warn。
   - **更稳替代**（推荐实现）：先 `if (!/-.*>/.test(line)) → 节点行`；否则按 `>` 右侧为 `to`，左侧再剥箭头符号与可选 `-- label --` 得 `from`/`label`。这样不依赖单条巨型正则，CJK 节点名含 `-` 也安全（节点名内连字符不常见，且 `>` 锚定右端）。
4. 节点行：`^\[(.+?)\]\s*(.+)$` → group + label；无 `[..]` → group 默认 `""`、label = 整行。`label = plain(label)`，`id = label`（去空白）。重复 id 跳过 + warn。
5. 边的 from/to 必须命中已知节点 id（边可引用尚未出现在节点行、但出现在其他边里的名字吗？**不**——只认显式节点行定义的 id；未命中 → `droppedLinks++`，跳过）。
   - 注意顺序：**先收集所有节点行，再解析边**，避免「边在前、节点在后」误判为 dropped。实现上两遍扫 buf（第一遍节点、第二遍边）。
6. 节点为空 → 返回 `null`（空图不渲染）。

### 1.4 渲染：buildBlocks 里新增 diagram Block（坐标布局算法）

在 `buildBlocks`（L199）里、配图块前后任意位置，新增对 `page.diagrams` 的遍历，每张图 push 一个 `Block`。

#### 主题与样式（复用现有 THEME，**禁渐变**）

```ts
// 主节点（核心/中心）：实色填充 + 阴影
const NODE_MAIN = {
  fill: { color: THEME.accent },
  color: "FFFFFF",
  line: { color: THEME.accent, width: 1 },
  shadow: { type: "outer", color: "808080", blur: 4, offset: 2, angle: 90, opacity: 0.35 },
};
// 子节点：白底 + 彩色描边（与现有 stat-card 同源风格，已验证 DrawingML 正确）
const NODE_CHILD = {
  fill: { color: THEME.panel },
  color: THEME.ink,
  line: { color: THEME.accent, width: 1.5 },
};
```

> ⚠️ **绝不写** `fill: { type: "gradient", stops: [...] }`：`pptxgenjs@4.0.1` 的 `ShapeFillProps`（types L1003）只声明 `color` / `transparency` / `type:'none'|'solid'`，渐变键被静默忽略，shape 输出无 `<a:gradFill>` 也无 `<a:solidFill>`→透明框。要双色带就叠两个实色 roundRect 伪造。深度只用已验证的 `shadow`(outerShdw)。

#### 节点框绘制（CJK 自适应）

```ts
const cp = (s) => [...s].length;                 // 复用 L192
function nodeBox(slide, x, y, w, h, label, style, fontPt = 13) {
  slide.addShape("roundRect", { x, y, w, h, rectRadius: 0.06, fill: style.fill, line: style.line,
    ...(style.shadow ? { shadow: style.shadow } : {}) });
  // 估单行容量：英文≈每 0.12in 一字，CJK≈每 0.2in 一字；用码点保守取 perLine = floor((w-0.16)/0.20)
  const perLine = Math.max(2, Math.floor((w - 0.16) / 0.20));
  let txt = label;
  if (cp(label) > perLine * 2) txt = [...label].slice(0, perLine * 2 - 1).join("") + "…"; // 最多两行，超则省略
  slide.addText(txt, { x: x + 0.06, y, w: w - 0.12, h, align: "center", valign: "middle",
    fontSize: fontPt, color: style.color, bold: !!style.shadow, fontFace: CJK_FONT, wrap: true });
}
```

#### 边绘制（直线 + 折线 + 箭头）

```ts
// 直线/对角线带箭头（hub、flow 用）：line shape + endArrowType
function edgeLine(slide, x1, y1, x2, y2, dashed, label) {
  slide.addShape("line", {
    x: Math.min(x1, x2), y: Math.min(y1, y2),
    w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
    line: { color: THEME.dim, width: 1.25, endArrowType: "triangle",
      ...(dashed ? { dashType: "dash" } : {}) },
    flipH: x2 < x1, flipV: y2 < y1,   // 对角线靠 bbox + flip 定方向（已验证）
  });
  if (label) slide.addText(label, { x:(x1+x2)/2-0.5, y:(y1+y2)/2-0.14, w:1, h:0.28,
    fontSize: 9, color: THEME.dim, align: "center", fontFace: CJK_FONT });
}
// 层间直角折线（layered 用）：custGeom moveTo/lnTo（已验证 <a:pathLst>）
function edgeElbow(slide, x1, y1, x2, y2, dashed, label) {
  const midY = (y1 + y2) / 2;
  const xs=[x1,x2], ys=[y1,midY,y2];
  const bx=Math.min(...xs), by=Math.min(...ys), bw=Math.max(...xs)-bx||0.01, bh=Math.max(...ys)-by||0.01;
  const P=(px,py,mv)=>({x:(px-bx),y:(py-by),...(mv?{moveTo:true}:{})}); // pptxgenjs points 用相对 bbox 的 in
  slide.addShape("custGeom", { x:bx, y:by, w:bw, h:bh,
    line:{ color: THEME.dim, width:1.25, endArrowType:"triangle", ...(dashed?{dashType:"dash"}:{}) },
    points:[ P(x1,y1,true), P(x1,midY), P(x2,midY), P(x2,y2) ] });
  if (label) slide.addText(label, { x:(x1+x2)/2-0.5, y:midY-0.14, w:1, h:0.28,
    fontSize:9, color:THEME.dim, align:"center", fontFace: CJK_FONT });
}
```

> custGeom 的 `points` 接受 `{x,y,moveTo?}`（types L1497-1503，已确认）。坐标用相对 bbox 的英寸；用 inch 数值即可（pptxgenjs `Coord` 接受 number=inch）。

#### 布局算法（三种 type）

舞台：内容区 `CONTENT_W=11.83`、可用图高 = Block 分得的 `h`。每张图先定 `boxH`（见下）。

**layered（dir:down，默认）**
1. 取所有不同 group，按**首次出现顺序**为层序 `L0..Lk`；无 group 的节点归一个匿名层。
2. 图高预算 `H`（见 Block 高度），层高 `rowH = H/k`，节点框 `nodeH = min(0.6, rowH*0.55)`，层内竖直居中。
3. 每层节点数 `m`，横向均分：`nodeW = min(2.4, (CONTENT_W - gap*(m+1))/m)`，`gap=0.3`；节点 x 居中铺开。
4. 第一层（或名为「核心/中心/调度」的层，简单：第一个非接入层）用 `NODE_MAIN`，其余 `NODE_CHILD`。**保守实现：仅当只有一个核心节点时用 MAIN，其余全 CHILD**（避免误判，符合校验「别过度承诺」）。MVP 可全用 CHILD + 首层加重描边。
5. 边：from 在上层、to 在下层 → `edgeElbow`（从 from 底边中点到 to 顶边中点）；同层或反向边 → `edgeLine`。
6. `dir:right` 时层沿 x 轴排、节点沿 y 轴均分，elbow 的拐弯轴对调（midX 而非 midY）。

**flow**
1. 节点按出现顺序成链。`dir:right`：等分 `CONTENT_W`，每节点一格，节点间用 `edgeLine` 或在两框间插一个 `chevron`（`addShape("chevron",...)`，已验证 prstGeom）。`dir:down` 同理沿 y。
2. 框全用 `NODE_CHILD`，首框可加重。

**hub**
1. 节点[0] = 中心，居中放 `NODE_MAIN`（圆角更大或用 `addShape("ellipse")`）。
2. 外节点 `n-1` 个，半径 `R=min(CONTENT_W,H)/2 - 0.7`，按 `2π/(n-1)` 均布，`(cx+R cosθ, cy+R sinθ)`。
3. 每条 `中心 -> 外` 画 `edgeLine`（带箭头）；DSL 里没显式写边时，hub 默认中心连所有外节点。

#### Block 高度

```ts
for (const dg of page.diagrams) {
  const H = Math.min(4.4, /* 估：layered 层数*1.1 ; hub 固定 3.6 ; flow 1.6 */);
  blocks.push({ h: H + 0.2, draw: (slide, y) => drawDiagram(slide, y, H, dg) });
}
```
`drawDiagram` 内按 type 调上面三套布局。单张图高上限 4.4in（留 header/footer 空间），`packBlocks`（L323）会自动把超高图独占一页——无需额外处理（与现有 code/table 块同机制）。

### 1.5 并入 manifest

`SlidesManifest`（L181-189）加两字段，`slidesManifest`（L435-447）加 reduce：

```ts
export interface SlidesManifest {
  // …现有…
  diagrams: number;
  droppedLinks: number;
}
// in slidesManifest():
diagrams: pages.reduce((a, p) => a + p.diagrams.length, 0),
droppedLinks: pages.reduce((a, p) => a + p.diagrams.reduce((b, d) => b + d.droppedLinks, 0), 0),
```

> 与现有 `tables`/`statCards`/`images` reduce 同形。`droppedLinks` 让验收能抓到「模型写了边但引用了不存在的节点」这类静默丢失。

### 1.6 回归用例设计（一条）

**文件**：`server/test/pptx-diagram.test.ts`（或并入现有 pptx 测试），框架沿用仓库现有（node:test / vitest，按现状）。

**用例：`layered 架构图渲染并入 manifest，未定义节点的边被丢弃且计数`**

```ts
const md = [
  "# 系统架构",                                 // 标题页（cover）
  "---",
  "# 数据管线",
  "```arch",
  "type: layered",
  "dir: down",
  "[接入] 网关",
  "[接入] 鉴权",
  "[核心] 调度器",
  "[存储] 主库",
  "网关 -> 调度器",
  "鉴权 -> 调度器",
  "调度器 -> 主库",
  "调度器 -. 异步 .-> 缓存",   // 缓存未定义 → droppedLinks=1
  "```",
].join("\n");

const m = slidesManifest(md);
assert.equal(m.diagrams, 1);
assert.equal(m.droppedLinks, 1);            // 缓存节点不存在，该边被丢
// parseSlides 直检
const pages = parseSlides(md);
const d = pages[1].diagrams[0];
assert.equal(d.type, "layered");
assert.equal(d.nodes.length, 4);
assert.equal(d.edges.length, 3);            // 4 条边 - 1 dropped
// 端到端不抛 + 产出非空 buffer（验证 custGeom/line/roundRect 都能 write）
const buf = await slidesToPptx({ title: "t", content: md } as any);
assert.ok(buf.length > 5000);
// 该页不被误判为 divider（含 diagram）
assert.ok(!isDividerExportedForTest(pages[1]));  // 或断言渲染计划里该页 type==='content'
```

**断言要点**：`diagrams=1`、`droppedLinks=1`、`edges.length=3`、`slidesToPptx` 不抛且 buffer 非空、含 diagram 的页不被当 divider。可选增强：解包 buffer 断言 `ppt/slides/*.xml` 含 `prst="roundRect"` 与 `<a:tailEnd type="triangle"`（验证形状真落地，对抗「write 成功 ≠ 真渲染」陷阱）。

### 1.7 原生形状（必做）vs SVG 光栅化（二期可选）

- **必做（本批）**：纯原生 `addShape` —— `roundRect` / `line`(endArrowType:'triangle') / `custGeom`(moveTo·lnTo 折线) / `chevron` / `ellipse` / `diamond`(可选) / `dashType:'dash'` / `flipH·flipV` / `shadow`(outerShdw)。零新依赖，产出真矢量、可在 PowerPoint/Keynote/WPS 继续编辑。覆盖 layered/flow/hub 全部需求。
- **二期可选（不在本批）**：`@resvg/resvg-wasm`（纯 WASM、无系统依赖、大陆可装、~2-3MB）做 SVG→PNG。**仅**为原生几何表达不了的图（桑基图、词云、力导向图）保留，且 **必须手动喂 CJK ttf 字节**（resvg 不带系统字体，否则豆腐块）—— 这本身是交付负担，反而印证留在原生路线。落地形式：`dynamic import`、标 optional/phase-2，给出体积与「需打包字体」风险。**本批不引入。**

---

## 2. frontend-slides 模板（2-3 套单文件 HTML）

> 三套都满足：过 `validateDocContent`（无 `<script src>`、无 `on*=` 内联处理器、无 `javascript:`、含合法标签）；**脚本关闭可渲染**（`scroll-snap` CSS 兜底，无 `opacity:0` 门控，JS 仅渐进增强）；用项目 CJK 字体栈 `-apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif`。

### 2.0 共用骨架原理（脚本关闭可渲染的关键）

```css
html{ scroll-snap-type:y mandatory; scroll-behavior:smooth; }
.slide{ min-height:100vh; scroll-snap-align:start; }   /* 全部可见、纵向滚动捕捉，无 opacity 门 */
```
JS 只做「键盘 ← / → 跳到上下页 + 进度点」的**渐进增强**；脚本被禁（预览 iframe `sandbox=""`，见 `DocsView.tsx` L357）时，用户照样能滚动浏览全部幻灯片。

> ⚠️ 三套模板内的 JS 一律避开 `on*=` 内联写法与 `javascript:`，只用 `<script>` 块 + `addEventListener`。CSS 里的 `transition`/`function`/`prefers-reduced-motion`/viewport meta 均经引擎正则验证**不误伤**（`/[\s/]on\w+\s*=/i` 不命中这些）。

### 2.1 TPL2 — `html-deck-broadside`（满版大字 · 数据驱动）

```html
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>演示</title>
<style>
  :root{ --bg:#0c0d10; --ink:#f5f3ee; --dim:#8b9099; --accent:#e8b53a; --line:#23262d; }
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-snap-type:y mandatory;scroll-behavior:smooth}
  body{background:var(--bg);color:var(--ink);font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
  .slide{min-height:100vh;scroll-snap-align:start;display:flex;flex-direction:column;justify-content:center;padding:8vh 9vw;gap:.6em;position:relative}
  .slide+.slide{border-top:1px solid var(--line)}
  .kicker{font-size:.8rem;letter-spacing:.34em;text-transform:uppercase;color:var(--accent)}
  h1{font-size:clamp(2.4rem,7vw,6rem);font-weight:800;line-height:1.02;letter-spacing:-.02em}
  h2{font-size:clamp(1.6rem,4vw,3rem);font-weight:700}
  p,li{font-size:clamp(1rem,1.7vw,1.4rem);line-height:1.55;color:var(--dim);max-width:48ch}
  ul{padding-left:1.1em;display:flex;flex-direction:column;gap:.5em}
  .big{font-size:clamp(3rem,12vw,9rem);font-weight:800;color:var(--accent);line-height:.95}
  .stat-row{display:flex;flex-wrap:wrap;gap:5vw;margin-top:.4em}
  .stat .n{font-size:clamp(2.2rem,6vw,4.5rem);font-weight:800;color:var(--accent)}
  .stat .l{font-size:.95rem;color:var(--dim);letter-spacing:.04em}
  #bar{position:fixed;right:2vw;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:.7vh;z-index:9}
  .dot{width:.55vh;height:.55vh;border-radius:50%;background:#3a3f47}
  .dot.on{background:var(--accent);transform:scale(1.6)}
  @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
</style>
</head>
<body>
<main>
  <section class="slide"><div class="kicker">封面</div><h1>在此填主标题</h1><p>副标题 / 一句话主张</p></section>
  <section class="slide"><div class="kicker">关键指标</div><div class="stat-row">
    <div class="stat"><div class="n">268亿</div><div class="l">市场规模</div></div>
    <div class="stat"><div class="n">↓80%</div><div class="l">人力成本</div></div>
    <div class="stat"><div class="n">3.2×</div><div class="l">效率提升</div></div>
  </div></section>
  <section class="slide"><h2>核心主张</h2><p class="big">一句压舱石</p></section>
  <section class="slide"><h2>要点</h2><ul><li>每页一个观点群</li><li>宁可多分页，别堆密</li></ul></section>
  <section class="slide"><h2>结尾</h2><p>行动建议 / 联系方式</p></section>
</main>
<nav id="bar" aria-hidden="true"></nav>
<script>
  const slides=[...document.querySelectorAll('.slide')];
  const bar=document.getElementById('bar');
  slides.forEach(()=>{const d=document.createElement('div');d.className='dot';bar.appendChild(d);});
  const dots=[...bar.children];
  const io=new IntersectionObserver((es)=>{es.forEach(e=>{if(e.isIntersecting){const i=slides.indexOf(e.target);dots.forEach((d,k)=>d.classList.toggle('on',k===i));}});},{threshold:.6});
  slides.forEach(s=>io.observe(s));
  function go(n){const i=Math.max(0,Math.min(slides.length-1,n));slides[i].scrollIntoView();}
  let cur=0;document.addEventListener('keydown',e=>{if(e.key==='ArrowDown'||e.key==='ArrowRight'||e.key===' '){cur++;go(cur);}if(e.key==='ArrowUp'||e.key==='ArrowLeft'){cur--;go(cur);}});
</script>
</body>
</html>
```

### 2.2 TPL3 — `html-deck-signal`（编辑杂志风 · 网格 + 衬线主标题）

```html
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>演示</title>
<style>
  :root{ --bg:#f4f1ea; --ink:#1c1a16; --dim:#6b675e; --accent:#b5471f; --line:#ddd6c8; }
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-snap-type:y mandatory;scroll-behavior:smooth}
  body{background:var(--bg);color:var(--ink);font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif}
  .slide{min-height:100vh;scroll-snap-align:start;display:grid;grid-template-columns:1fr 1fr;gap:4vw;align-content:center;padding:9vh 8vw;position:relative;
    background-image:radial-gradient(var(--line) 1px,transparent 1px);background-size:26px 26px}
  .full{grid-column:1/-1}
  .num{font-variant-numeric:tabular-nums;font-size:.8rem;letter-spacing:.3em;color:var(--accent)}
  h1{font-family:Georgia,"Songti SC","Noto Serif CJK SC",serif;font-size:clamp(2.4rem,6vw,5rem);font-weight:700;line-height:1.05;letter-spacing:-.01em}
  h2{font-family:Georgia,"Songti SC","Noto Serif CJK SC",serif;font-size:clamp(1.5rem,3.4vw,2.6rem);font-weight:700;color:var(--accent)}
  p,li{font-size:clamp(1rem,1.5vw,1.25rem);line-height:1.6;color:var(--dim)}
  ul{padding-left:1.1em;display:flex;flex-direction:column;gap:.5em}
  .rule{height:3px;width:3.5rem;background:var(--accent);margin:.2em 0 .6em}
  @media(max-width:760px){.slide{grid-template-columns:1fr}}
  @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
</style>
</head>
<body>
<main>
  <section class="slide"><div class="full"><div class="num">01 — 封面</div><div class="rule"></div><h1>在此填主标题</h1><p>副标题 / 一句话主张</p></div></section>
  <section class="slide"><div><div class="num">02</div><h2>论点</h2><div class="rule"></div><p>左栏放主张，右栏放展开或证据。</p></div>
    <div><ul><li>支撑点一</li><li>支撑点二</li><li>支撑点三</li></ul></div></section>
  <section class="slide"><div class="full"><div class="num">03</div><h2>引述 / 重点</h2><div class="rule"></div><h1>一句金句压版</h1></div></section>
  <section class="slide"><div class="full"><div class="num">04 — 结尾</div><div class="rule"></div><h2>行动建议</h2><p>联系方式 / 下一步</p></div></section>
</main>
<script>
  const slides=[...document.querySelectorAll('.slide')];let cur=0;
  function go(n){cur=Math.max(0,Math.min(slides.length-1,n));slides[cur].scrollIntoView();}
  document.addEventListener('keydown',e=>{if(['ArrowDown','ArrowRight',' '].includes(e.key))go(cur+1);if(['ArrowUp','ArrowLeft'].includes(e.key))go(cur-1);});
</script>
</body>
</html>
```

### 2.3 TPL4 — `html-deck-monochrome`（极简单色 · 双栏，含窄屏断点）

> 校验 betterAlternative 指明：monochrome 须加 `@media(max-width:640px){.cols{grid-template-columns:1fr}}` 防窄屏两栏挤压。

```html
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>演示</title>
<style>
  :root{ --bg:#ffffff; --ink:#111316; --dim:#6a6f76; --accent:#111316; --line:#e6e8ea; }
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-snap-type:y mandatory;scroll-behavior:smooth}
  body{background:var(--bg);color:var(--ink);font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif}
  .slide{min-height:100vh;scroll-snap-align:start;display:flex;flex-direction:column;justify-content:center;padding:10vh 9vw;gap:.7em;border-bottom:1px solid var(--line)}
  .tag{font-size:.78rem;letter-spacing:.32em;text-transform:uppercase;color:var(--dim)}
  h1{font-size:clamp(2.2rem,6vw,5rem);font-weight:800;line-height:1.04;letter-spacing:-.02em}
  h2{font-size:clamp(1.4rem,3.4vw,2.4rem);font-weight:700}
  p,li{font-size:clamp(1rem,1.6vw,1.25rem);line-height:1.6;color:var(--dim)}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:4vw;margin-top:.4em}
  ul{padding-left:1.1em;display:flex;flex-direction:column;gap:.45em}
  .line{height:2px;width:100%;background:var(--ink);margin:.3em 0}
  @media(max-width:640px){.cols{grid-template-columns:1fr}}
  @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
</style>
</head>
<body>
<main>
  <section class="slide"><div class="tag">封面</div><div class="line"></div><h1>在此填主标题</h1><p>副标题 / 一句话主张</p></section>
  <section class="slide"><div class="tag">对比</div><h2>两栏并列</h2><div class="cols">
    <div><h2>方案 A</h2><ul><li>优点</li><li>代价</li></ul></div>
    <div><h2>方案 B</h2><ul><li>优点</li><li>代价</li></ul></div></div></section>
  <section class="slide"><div class="tag">主张</div><div class="line"></div><h1>一句压舱石</h1></section>
  <section class="slide"><div class="tag">结尾</div><div class="line"></div><h2>行动建议</h2><p>联系方式 / 下一步</p></section>
</main>
<script>
  const s=[...document.querySelectorAll('.slide')];let c=0;
  const go=n=>{c=Math.max(0,Math.min(s.length-1,n));s[c].scrollIntoView();};
  document.addEventListener('keydown',e=>{if(['ArrowDown','ArrowRight',' '].includes(e.key))go(c+1);if(['ArrowUp','ArrowLeft'].includes(e.key))go(c-1);});
</script>
</body>
</html>
```

### 2.4 接入步骤（registry.ts）

1. 在 `HTML_DECK_HORIZONTAL` const 之后，新增三个 const：`HTML_DECK_BROADSIDE`、`HTML_DECK_SIGNAL`、`HTML_DECK_MONOCHROME`（值为上面三段，注意正文里的反引号——若模板内含反引号需用模板字面量转义；当前三套均无 `` ` ``，可直接用 `` ` `` 包裹）。
2. 往 `SKILL_TEMPLATES` 数组追加三项（沿用现有对象形状）：

```ts
{ id: "html-deck-broadside",  name: "满版大字网页 PPT（单文件 HTML）", desc: "纵向 scroll-snap、满版大标题与数字大字报、右侧进度点；脚本关闭可滚动浏览。", lang: "html", content: HTML_DECK_BROADSIDE },
{ id: "html-deck-signal",     name: "编辑杂志风网页 PPT（单文件 HTML）", desc: "网格点阵底、衬线主标题、双栏论点/证据；窄屏自动单栏；脚本关闭可渲染。", lang: "html", content: HTML_DECK_SIGNAL },
{ id: "html-deck-monochrome", name: "极简单色网页 PPT（单文件 HTML）", desc: "黑白极简、双栏对比、640px 断点单栏；脚本关闭可滚动浏览。", lang: "html", content: HTML_DECK_MONOCHROME },
```

3. `getSkillTemplate`（L274）**无需改动**（按 id 线性查找，自动覆盖新项）。
4. （可选）把新 id 加进「演示设计与防溢出法」技能的 `resources_json`（`seed.ts` L127），让模型 read_skill 时能看到全部模板。**若改 seed.ts 的技能正文/资源，必须 bump 版本（见 §2.6）。**

### 2.5 修复 TPL1（同批必做，校验列为缺陷）

现有 `HTML_DECK_HORIZONTAL`（registry.ts L230-231）：`.slide{...opacity:0}` + `.slide.active{opacity:1}`，`.active` 仅由 JS `show()` 添加 → 空 sandbox 下脚本不跑、无页 `.active` → 预览**全空白**。**修复（保持 16:9 锁定舞台 + 翻页体验，但脚本关闭也能看首页）**：

最小改动方案（推荐，改两行 CSS）：
```css
/* 删掉 .slide{...opacity:0} 里的 opacity，改为：默认全透明但首页可见 */
.slide{ /* …其余不变… */ opacity:0; transition:opacity .35s; pointer-events:none; }
.slide:first-of-type{ opacity:1; pointer-events:auto; }      /* 纯 CSS 兜底：脚本关也能看首页 */
.slide.active{ opacity:1; pointer-events:auto; }
.slide.active~.slide:first-of-type{ opacity:0; }             /* 脚本启用后由 .active 接管，避免首页常亮 */
```
> 注意 `~` 兜底会有边角；**更稳替代**：把 horizontal 也改成 §2.0 的 `scroll-snap` 骨架（与新三套统一），JS 退化为键盘/点击增强。若要保留「绝对定位叠放 + 渐隐」观感，则用上面 first-of-type 方案并接受「脚本关时只显首页」（仍满足「脚本关闭可渲染」——不再全空白）。实现者二选一，**默认选 scroll-snap 统一**（最干净、与回归口径一致）。

### 2.6 版本 bump 说明（BUILTIN_SKILL_PACK_VERSION）

- `BUILTIN_SKILL_PACK_VERSION` 在 `server/src/seed.ts` L54，当前 **9**。
- 触发 bump 的条件（seed.ts L52 注释）：**扩库或改技能正文/资源**。
  - **只动 `registry.ts` 的 `SKILL_TEMPLATES`（新增模板 const + 数组项）→ 不强制 bump**（模板是 L3 资源、按需附带，不进 L1 常驻索引；版本号语义是「技能库内容版本」）。
  - **若同时改了 `seed.ts`**——例如把新模板 id 加进「演示设计与防溢出法」的 `resources_json`，或在该技能 body 里提及新模板/架构图 DSL → **必须 bump**：把 L54 `= 9` 改为 `= 10`，因为 `const V = BUILTIN_SKILL_PACK_VERSION` 会把所有内置技能条目 `version` 一并抬到 10，确保已部署实例在 seed 同步时识别为「技能库已更新」。
- **建议**：既然要让模型用上新模板与架构图 DSL，应在「演示设计与防溢出法」与「SVG 图表生成法」两条技能 body 里补一句指引（架构图用 ` ```arch ` 约定、可套新增的三套 html-deck 模板），**因此本批应 bump 到 10**。

---

## 3. 落地顺序与风险

### 3.1 推荐落地顺序（小步、各步独立可回归）

1. **TPL 三套 + 修 TPL1（纯前端、零渲染器风险）**——只动 `registry.ts`。用引擎正则（`validateDocContent` 的 4 条）+ 浏览器脚本关闭打开两次目视，确认四套都渲染。最低风险，先合。
2. **架构图 parse（不渲染）**——`SlidePage.diagrams` + `parseDiagram` + fence 改造 + `isDivider` + manifest 字段。先让 `slidesManifest`/`parseSlides` 正确产出结构，跑 §1.6 用例的「结构断言」部分（不含 buffer）。
3. **架构图 render**——`buildBlocks` 里 `drawDiagram` 三套布局 + 边/节点绘制。补 §1.6 的 `slidesToPptx` buffer 断言 + 可选解包断言。
4. **seed.ts 技能 body 补指引 + bump 到 10**——让模型实际用上。最后做，避免前面反复 bump。
5. **（不在本批）二期评估** `@resvg/resvg-wasm`，仅当出现原生表达不了的图需求。

### 3.2 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| **误用渐变填充** → 透明框 | 高（已踩雷） | 代码评审硬性 grep `type:.*gradient`；主节点只用实色 + `shadow`；本规格已通篇禁用 |
| fence info-string 改造影响现有代码块 | 中 | 改造保持「非 arch/diagram 标签一律走 inCode」，现有 ` ``` ` 无标签代码块行为不变；§1.6 应附一条「普通代码块仍正常」回归 |
| custGeom 坐标/flip 方向算错 → 箭头反向或越界 | 中 | edge 的 bbox + flipH/flipV 已由校验解包确认；先用 layered 单测目视一张，确认箭头朝下游 |
| CJK 标签溢出节点框 | 中 | `nodeBox` 用 `cp()` 估宽 + 两行换行 + 省略号；node 最小宽 1.1in 时强制缩字 |
| 重复节点名 / 悬空边静默丢失 | 中 | 重复 id warn + 跳过；悬空边 `droppedLinks` 计数进 manifest，验收可见 |
| 单图过高挤掉 footer | 低 | 图高上限 4.4in；`packBlocks` 自动让超高块独占页 |
| html 模板被未来改动引入 `on*=`/外链 script | 低 | 三套已过校验；CI 可加一条「对 SKILL_TEMPLATES 跑 validateDocContent('html', content) 全 null」的断言锁死 |
| 漏 bump 版本 → 部署实例不刷新技能 | 低 | §2.6 明确：动 seed.ts 即 bump；本批 bump 到 10 |
| TPL1 修复回归口径 | 低 | 统一改 scroll-snap，回归断言「四套模板均无 `opacity:0` 全局门控 / 首屏有可见内容」 |

### 3.3 不做（明确排除）

- 不引入 Python / Marp CLI / LibreOffice / 任何系统级二进制。
- 不引入 shape 渐变（不支持）、不引入 SVG 光栅化（本批）。
- 不做任意有向图自动布局（仅 layered/flow/hub 三种确定式）。
- 不把 TPL1 当前 opacity-only 输出当回归金样。

---

## 附录 A：本规格已核验的事实

- `pptxgenjs` 版本 **4.0.1**，位于**仓库根** `/Users/tony/Documents/GitHub/aiteam/node_modules`（非 `server/node_modules`，经 hoisting 解析，导入无碍）。
- types/index.d.ts 实测确认：`endArrowType`/`beginArrowType` 含 `'triangle'`（L1045/1050）、`points[]` 含 `{x,y,moveTo?}` 与 `close`/curve（L1497-1503）、`rectRadius`（L1509）、`flipH/flipV`（L1472/1477）、`dashType`（L1040）。
- `ShapeFillProps`（L1003）**只有** `color`/`transparency`/`type`（`'none'|'solid'`）——**无 gradient/stops**，渐变会被静默丢弃。
- `validateDocContent`（engine.ts L90-105）html 分支四条正则：标签白名单 L95、`<script src>` L98、`on*=` L100、`javascript:` L102；三套模板已逐条验证通过。
- 预览 iframe `sandbox=""`（`web/src/components/DocsView.tsx` L357，脚本不执行）——故模板必须脚本关闭可渲染。
- `parseSlides` fence 拦截在 `pptx.ts` L137（`/^```/`，当前丢弃 info-string）；HTML 剥离 L126-129 保护围栏；`isDivider` L347；`SlidesManifest` L181 / `slidesManifest` L435。
- `SKILL_TEMPLATES` / `getSkillTemplate` 在 `registry.ts` L264-276；模板经 `readSkillBody`（engine.ts L940-958）按 `tpl:<id>` 附带返回。
- `BUILTIN_SKILL_PACK_VERSION` 在 `seed.ts` L54 = 9；`const V` 把全条目 version 绑定到它（L55）。

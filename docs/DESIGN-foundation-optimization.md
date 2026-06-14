# 《AITeam 底座强化与热门 Skills/MCP 引入 — 优化设计与一期实施方案（最终版）》

> 版本 v2.0 · 2026-06-14 · 首席架构师
> 地面真值：已通读并逐行核对 `server/src/{db.ts,seed.ts,routes.ts,agents/engine.ts,agents/mcp.ts}`、`web/src/{components/{IntegrationsTabs.tsx,DocsView.tsx},types.ts,store.tsx}`、`scripts/regression.mjs`。本文所有改动均落到上述真实文件/函数/字段；行号以当前 `claude/nice-curie-ffuo7l` 分支为准。

---

## 0. 修订说明（针对三视角对抗式评审的逐条闭环）

本版相对 v1.0 的实质修改，按评审 blocker/major 分类列出（minor 已就地吸收，附在各节）：

### 0.1 codebase-feasibility 视角（编译/回归会红）

| # | 评审 blocker/major | v2.0 处置 | 落点 |
|---|---|---|---|
| B1 | 回归 4-技能硬断言不止 G3 一处：`regression.mjs:63` P0 `db.listSkills().length === 4`、`:298` G3 含 `skills.length === 4` 与删自定义后 `after.length === 4` | **§7.3 改全部三处**：`:63` 改 `=== BUILTIN_SKILLS.length`（引用 seed 导出，避免再扩库又要改）、`:298` 改 `skills.length === BUILTIN_SKILLS.length` 且 `after.length === skills.length`（删自定义回到查询前基数，不写死数字） | §7.3 |
| B2 | `skillRelevant` 改签名打穿现有 SK1（`regression.mjs:198-205` 传只含 `name` 的对象），且自述的"SKILL_KEYWORDS 兜底"在新签名读不到 name 永不触发 | **采纳评审方案 A**：`skillRelevant` 保留 `name` 入参，**先查 `trigger`，trigger 为空再回退 `SKILL_KEYWORDS[name]`**——内置 4 技能与现有 SK1 全兼容；同时 §7.3 显式重写 SK1（新增"带 trigger 对象命中/不命中"两条用例 + 保留"无 trigger 走 name 回退"原断言） | §2.2b / §7.3 |
| B3 | `html` kind 漏改 `write_document` 第一道白名单（`engine.ts:1103` `["report","slides","sheet"].includes(...)` 否则静默回落 report），validateDocContent 的 html 分支永不命中 | **§4.2 + §7.1#6 明确加 `"html"` 到 `:1103` 白名单数组**，置于 validateDocContent 之前 | §4.2 / §7.1 |
| M1 | 新字段在 API/DB/UI 三层未贯通：`routes.ts:227/233` 解构只取旧字段、`db.ts:634 createSkill`/`:649 updateSkill` 入参与 SQL 列写死、自定义技能无 trigger 入口 | **§7.1 列全链路**：createSkill+updateSkill 入参与 SQL 列各加 6 字段；POST/PATCH `/skills` 解构透传；SkillsTab 创建表单加 trigger/when_to_use/kind | §7.1#1#5 / §7.2#10 |
| M2 | MCP 一键预填与 sanitize/宿主依赖缺口：stdio 预设需宿主预装二进制，`install` 仅提示文本，test 必失败，"零知识装上"被高估 | **§5.2 明确**：一键添加只预填表单≠可用；UI 抽屉对 stdio 预设显著标注 install；`testMcpServer` 失败回显"命令未找到，请先在服务器执行 \<install\>"；一期只落 registry 数据+UI，不保证开箱可用 | §5.2 |
| m1 | idxBudget 提到 6000 + 常驻全部技能未估算 token 影响 | §2.2a 补预算估算（N=50/100 每轮增量）+ 改 `AITEAM_SKILL_INDEX_BUDGET` env 可调 | §2.2a |
| m2 | read_skill 与 ownerScope fail-closed 关系未点明 | §6 补注：read_skill 复用 `getSkill`（全局表无 owner_id、不经 ownerScope），与现有 `listSkills` 注入同源、不触发 fail-closed；放 execTool 同步 switch、不计 MCP_CALLS_PER_RUN | §2.2c / §6 |

### 0.2 deploy-security-cost 视角（大陆 VPS + 仅国内模型 + 暂免备案 + 共用主机）

| # | 评审 blocker/major | v2.0 处置 | 落点 |
|---|---|---|---|
| B4 | **html XSS 真正落地点是导出/打印**：`DocsView.tsx:46 printDoc` 用 `window.open + document.write` 在应用同源执行任意脚本、`:26 exportWord` 同理；§6 只防了 iframe 预览。多用户产品里是存储型 XSS | **§4.2/§6 重写 html 安全边界（按"内容不可信"统一所有出口）**：①预览 iframe `sandbox` 去掉 `allow-same-origin` 且不含 `allow-scripts`；②**html kind 禁走 printDoc/exportWord 原文路径**，导出只允许"下载 .html 文件"（浏览器在 null 源打开）；③`validateDocContent` html 分支增加禁内联事件处理器（`onload/onerror/onclick…`）与 `javascript:` URI，不止禁 `<script src>` | §4.2 / §6 |
| B5 | 回归仍会红（重复 B1 的 `:63`） | 同 B1，已在 §7.3/checklist 闭环；并把硬编码数字改为引用 `BUILTIN_SKILLS.length` | §7.3 |
| M3 | exec 类 MCP（pptx-native/chart-render）在共用主机无真实执行门，只靠提示词"建议 request_approval"；stdio `connect` 直接 spawn 宿主进程无沙箱/白名单/配额 | **§6 新增 server 级 `require_approval` 机制（DB/registry 驱动，非提示词）**：registry `safety∈{exec,network}` 的 server，引擎层在 `callMcpTool` 之前强制插 `request_approval` 门；**exec 类 stdio MCP 与代码执行沙箱同档，推迟到 P2、默认关、registry 标注"不建议共用主机直接启用"** | §6 / §5.1 / §8.2 |
| M4 | registry"大陆可达"只评估运行期、漏安装期海外源（PyPI/npm/Chromium CDN） | **§5.1 把 `china_ok` 拆成 `install_china` 与 `runtime_china` 两维**；install 字段补大陆镜像指引（npmmirror/清华 PyPI/`PLAYWRIGHT_DOWNLOAD_HOST`）；明确一期目录仅展示、实装前需 admin 自解决安装源 | §5.1 |
| M5 | 版权策略缺可核查边界（MIT/Apache 需保留 LICENSE 全文，仅末行署名不足；Hermes CC0/Apache 混用未区分） | **§3 开头重写合规策略**：建 `THIRD_PARTY_NOTICES/` 放各来源 LICENSE 全文+版权行，技能末行链接该文件；给"蒸馏"可操作判定（只取方法论要点/自有措辞/不复制连续段落 >40 字）；每条标来源 URL；Hermes 仅采 CC0 的 SKILL.md 部分或重写，Apache 正文不直接内置 | §3 |
| m3 | registry 安装后 token 是否回吐未确认 | §6/§7.1#5 明确 `GET /registry` 静态无 token、`/bootstrap` 的 registry 字段不含实例 token；任何回吐 mcp_servers 的路径复用 `sanitizeMcpServer`；回归 REG1 加脱敏断言 | §6 / §7.1#5 / §7.3 |
| m4 | `capabilityReady` 只查 server enabled、未查工具前缀真实存在（MAX_MCP_TOOLS=40 截断下可能标"就绪"却调空） | §2.3 `capabilityReady` 进一步对照 `mcp.ts` 已缓存的 `connection.tools` 做前缀存在性校验；L2 body 兜底写"工具不在表则降级" | §2.3 / §4.3 |

### 0.3 scenario-completeness 视角（端到端是否真抬高下限）

| # | 评审 blocker/major | v2.0 处置 | 落点 |
|---|---|---|---|
| B6 | html kind 前端落地严重低估：漏 `DocsView.tsx:14 docKindMeta`、`:337-345 渲染 dispatch`、`:442-446 DOC_KINDS`、`:26/:45 导出`，一期前端是半成品 | **§4.2/§7.2#11 拆成 5 处可执行清单**：docKindMeta 加 `html` case、渲染 dispatch 加 html 分支（sandboxed iframe）、DOC_KINDS 加 `{k:"html",label:"🌐 网页"}`、导出区 html 只给"下载 .html"按钮（禁 printDoc/exportWord）、types.ts Doc.kind 加 html；全列进 checklist | §4.2 / §7.2 / §7.4 |
| M6 | §1.4 低估现状：report 已可导出 Word(`exportWord`)/PDF(`printDoc`)、sheet 已渲染 ECharts；真正高杠杆缺口是"缺图文混排/信息图/封面"（baoyu 系列精华 + generate_image 底座已就位），一期只一句"复用 generate_image" | **§1.4 修正现状列**（标注 report→Word/PDF 已可导出、sheet→ECharts 已可视化），缺口重定位为"缺图文混排/信息图/封面"；**新增 S16 信息图/封面/配图生成法**（蒸馏 baoyu-infographic+cover-image+article-illustrator）纳入一期；write_document 提示词补"报告/网页可内嵌 generate_image 配图" | §1.4 / §3.2 / §4.2 |
| M7 | 一期 capability 半边是空壳（C1/C2 入库但 MCP 全 P1 未就绪、capabilityReady 一律"未就绪"），"混合 skill 模型"未兑现"会做的新事" | **markitdown capability（C1）从 P1 提到一期 P0 实装**（纯本地、大陆可达、零外网、覆盖 docx/pdf/pptx/xlsx 解析输入），让"混合模型"有一个端到端跑通样例、capabilityReady 真返回 ready；其余 MCP 维持 P1，并在 §7.4 标注 C2 为占位 | §4.3 / §7.1 / §8.1 |
| M8 | code-mvp 闭环不闭：缺前端工程质量方法包（react-best-practices/addyosmani 无落点）、一期无自动 QA（playwright P1）→ html MVP 产出后无验证手段 | **新增 S17 前端工程自查法**（蒸馏 react-best-practices+addyosmani：性能/包体积/可访问性自查清单）纳入一期；§1.4 显式承认"一期无自动 QA，html MVP 仅人工预览验证"，S11 落点补"agent 在 html 内联自测断言 + 给手动验收清单"作 playwright 的人工替代 | §3.3 / §1.4 |
| m5 | 仅国内模型部署下 `web_search/web_fetch` 走联网降档可能不可用，research 下限在目标形态下降级；与"web-search-prime 已覆盖检索"自相矛盾 | §8.3 风险登记补一条 + 新增 capability **C3（web-search-prime）**：仅国内模型部署下以 MCP 为主检索路径、降级到"请用户粘贴资料"；web-search-prime 是 http+bearer、智谱、大陆可达，列为 P1 优先实装候选 | §4.3 / §8.3 |
| m6 | 9 仓库精华盘点有遗漏（guizang/frontend-slides 的"HTML 网页 PPT"未接 html kind；karpathy 未点名；frontend-design 未说明舍弃理由） | 新增 **§3.4 九仓库精华映射表**（逐仓标"落点/合理舍弃+理由"）；§4.1 PPT 行明确"网页 PPT(单 HTML deck)走 html kind、Marp slides 走可导出 pptx 并存"；S9 body 补"16:9 锁定舞台横向翻页模板"落点 | §3.4 / §4.1 / §3.2 |

---

## 1. 现状与差距

### 1.1 技能系统现状（已核对源码）

| 维度 | 现状 | 真值位置 |
|---|---|---|
| 表结构 | `skills(id,name,desc,content,enabled,builtin,created_at)`，**无 trigger/when_to_use/body/kind/resources** | `db.ts:114-122`、接口 `db.ts:282-290` |
| 内置数量 | **仅 4 个**：深度调研法 / 金字塔写作法 / 交付自查清单 / 结构化头脑风暴，默认 `enabled=false` | `seed.ts:48-73` |
| 播种 | `seedGlobalSkills()` **只在 `listSkills().length===0` 时播种** | `seed.ts:76-80` |
| 注入 | `buildDynamicContext` 把命中技能的**整段 `content` 全量拼进 system**，`skillBudget=4000` 超了 `break` 丢弃 | `engine.ts:807-854`，关键 `831-837` |
| 相关性 | `skillRelevant` 用**硬编码 `SKILL_KEYWORDS`** 三张关键词表匹配；无映射的技能 `return true` 始终注入 | `engine.ts:794-805` |
| 渐进披露 | **无**。L1（索引）和 L2（正文）合并，无 `read_skill`，无 L3 脚本/资源 | — |
| UI | `SkillsTab` 列表+开关+创建/删除自定义；无 trigger/kind 字段 | `IntegrationsTabs.tsx:177+` |
| 前端类型 | `types.ts` **没有 `Skill` / `McpServer` 接口**（内联定义于组件），`Doc.kind="report"\|"slides"\|"sheet"` | `types.ts:84-91` |

### 1.2 交付物现状（**已按评审 M6 修正**）

`validateDocContent(kind: "report"|"slides"|"sheet", …)`（`engine.ts:87`）只认三种 kind。**没有 `html`/`code` kind**；**没有任何代码执行/沙箱**（`engine.ts` 全文无 `exec`/`spawn` 业务调用，agent 只能把代码写进 report 文档，不能运行）。

**但现状下限比 v1.0 描述的高**（评审 M6 纠正）：
- `report` kind **已可导出 Word**（`DocsView.tsx:26 exportWord`，HTML 包成 `.doc`，Word/WPS 直接打开保留排版）**和 PDF**（`DocsView.tsx:46 printDoc`，系统打印另存）；
- `sheet` kind **已渲染交互式 ECharts**（`DocsView.tsx:121-144`，柱/折线/饼）；
- `generate_image` 已具备 Seedream 底座（`images.ts`），`slides` 走 Marp→pptxgenjs（`pptx.ts`）。

> **安全注脚（关键，关联 B4）**：`report`/`sheet` 的 `exportWord/printDoc` 当前**安全**——因为 react-markdown v9 未引入 `rehype-raw`，markdown 里的原始 HTML 被剥离，`document.write` 的内容不含可执行脚本。一旦引入 `html` kind（content 本身就是模型生成的任意 HTML），这两条导出路径就成了存储型 XSS 落地点（详见 §4.2）。

### 1.3 MCP 现状

`mcp_servers(id,name,kind,url,auth_token,command,args_json,enabled,created_at)`（`db.ts:103-113`）。`mcp.ts` 已有懒连接+5min 熔断+45s 超时+缓存+`MAX_MCP_TOOLS=40`（`mcp.ts:102` 截断）。**`connect` 用 `StdioClientTransport(command,args)` 直接 spawn 宿主本地进程，无沙箱/白名单/资源限制**（关联 M3）。`McpTab` 全靠 admin 手填 name+url/command，无任何预设/推荐目录（`IntegrationsTabs.tsx:20-175`）。

### 1.4 三优先场景的下限缺口（**已按 M6/M7/M8 重定位**）

| 场景 | 现有下限（已修正，比 v1.0 高） | 真正高杠杆缺口 |
|---|---|---|
| **办公文档** | report(Markdown)**→可导出 Word/PDF**、slides(Marp→pptx)、sheet(CSV)**→已渲染 ECharts** | ①**缺图文混排/信息图/封面**（baoyu 精华主线，generate_image 底座已就位但无方法包/无工作流）；②无 HTML 网页交付；③无 docx/pdf 解析**输入**；④无可编辑高保真 PPTX；写作方法仅金字塔 1 个 |
| **数据可视化** | sheet→ECharts 柱/折线/饼、generate_image 文生图 | ①无 HTML+SVG/Canvas 实时预览；②无 SVG 架构图/流程图方法；③无反 AI-slop 设计审美守则；④无 diagram 方法包 |
| **代码 MVP** | 把代码写进 report 文档（**死代码，无预览**） | ①**无执行/预览**（无沙箱）；②无 TDD/调试/审查/前端工程方法学；③**一期无自动 QA，html MVP 仅人工预览验证**（playwright 推 P1）；编程/评审同事产出全凭模型自发挥 |

**核心矛盾（一句话）**：当前「技能数 × 平均长度 ≤ 4000 字」是硬天花板（`engine.ts:831`），"更多技能"与"更长技能"直接互斥——加第 5 个长技能就把第 4 个挤掉，静默降质。这是所有下限缺口的结构性根因。

---

## 2. 总体设计

三根支柱：**(A) 渐进式披露**（拆 L1/L2 + read_skill 工具）→ 解除"数量×长度"死锁；**(B) 混合 skill 模型**（method-pack vs capability skill 同表统一）→ 让"会做的事"既能是方法也能是工具/MCP；**(C) Skill/MCP 一键预设目录**（内置 registry JSON）→ admin 零知识也能浏览推荐能力（**实装仍需自解决宿主依赖，见 §5.2**）。

### 2.1 数据模型变更（`db.ts`）

#### (a) skills 表加 6 列——用 `addColumnIfMissing`（`db.ts:148`，与 `:158-202` 同机制）

在 `db.ts` 现有迁移区（`:202` 之后）追加：

```ts
addColumnIfMissing("skills", "kind",          "kind TEXT NOT NULL DEFAULT 'method'");        // method | capability
addColumnIfMissing("skills", "trigger",       "trigger TEXT NOT NULL DEFAULT ''");           // L1 召回词，逗号分隔，取代 SKILL_KEYWORDS
addColumnIfMissing("skills", "when_to_use",   "when_to_use TEXT NOT NULL DEFAULT ''");       // L1 一句话触发条件
addColumnIfMissing("skills", "body",          "body TEXT NOT NULL DEFAULT ''");              // L2 正文，按需 read_skill 才进上下文
addColumnIfMissing("skills", "resources_json","resources_json TEXT NOT NULL DEFAULT '[]'");  // L3：capability 指向的工具/MCP 前缀
addColumnIfMissing("skills", "version",       "version INTEGER NOT NULL DEFAULT 1");          // 内置技能版本化（解决空库才播种）
```

更新 `interface Skill`（`db.ts:282-290`）补这 6 个字段。

#### (b) 迁移策略——解决 `seedGlobalSkills` 只在空库播种的坑

**坑**（`seed.ts:77`）：已部署库 `listSkills().length !== 0`，新增内置技能永不播种。改为 **version-based upsert**：

```ts
// seed.ts —— 新增导出，替代旧 seedGlobalSkills 的"空库才播种"逻辑
export const BUILTIN_SKILL_PACK_VERSION = 2;  // 每次扩库 +1
export function seedGlobalSkills() {
  const existing = new Map(listSkills().filter(s => s.builtin).map(s => [s.name, s]));
  for (const s of BUILTIN_SKILLS) {            // BUILTIN_SKILLS 每条带 version 字段
    const cur = existing.get(s.name);
    if (!cur) {
      createSkill({ ...s, builtin: true, enabled: false });          // 新内置技能 → 插入（默认关）
    } else if ((cur.version ?? 1) < s.version) {
      upsertBuiltinSkill(cur.id, s);   // 旧版 → 更新 desc/trigger/when_to_use/body/kind/resources/version，保留 enabled（不覆盖用户开关）
    }
  }
}
```

新增 `upsertBuiltinSkill(id, s)`（`db.ts`，仿 `updateSkill` `:649-660`，但不动 `enabled`/`id`）。旧库一次性迁移：把现有 `content` 灌进 `body`，`when_to_use` 留空时注入逻辑回退到 `desc`（无破坏性，向后兼容）。

> 迁移幂等性：`addColumnIfMissing` 已 try/catch 吞 "duplicate column"（`db.ts:148-152`），重复启动安全；version 比对保证只升不降、只补不删。

### 2.2 注入逻辑改法（`engine.ts`）

#### (a) `buildDynamicContext`（`engine.ts:807-854`）改为"技能索引"

把 `831-837` 的"全量 content + break 丢弃"替换为 L1 索引拼接：

```ts
const enabled = listSkills().filter(sk => sk.enabled);
// 相关性排序：trigger/when_to_use 命中 focus 的排前，未命中排后（不再丢弃，只排序）
const ranked = enabled.sort((a, b) => Number(skillRelevant(b, focus)) - Number(skillRelevant(a, focus)));
let idxBudget = Number(process.env.AITEAM_SKILL_INDEX_BUDGET ?? 6000);  // 索引便宜，可配
let skillsBlock = "";
for (const sk of ranked) {
  const ready = sk.kind === "capability" ? capabilityReady(sk) : true;
  const item =
    `### 技能：${sk.name}（id: ${sk.id}）\n` +
    `何时用：${sk.when_to_use || sk.desc}\n` +
    (sk.trigger ? `触发词：${sk.trigger}\n` : "") +
    (sk.kind === "capability" ? `类型：能力型${ready ? "" : "（⚠️依赖未就绪，暂不可用）"}\n` : "") +
    `→ 需要具体方法/步骤时调用 read_skill("${sk.id}") 取正文`;
  if (item.length > idxBudget) continue;   // 跳过当前超长项而非 break 终止，保证后面高优项不被一条挤掉
  idxBudget -= item.length;
  skillsBlock += (skillsBlock ? "\n\n" : "") + item;
}
```

每条索引约 50-80 字，6000 字预算可常驻 **70-100 个**技能索引（对比当前满打满算 ~10 个全文）。

> **预算影响估算（评审 m1）**：索引常驻进 system 第二块 text（`engine.ts:1327`，本就不缓存，与 ephemeral cache 的第一块 `:1325` 无关），按启用技能数线性放大每轮 system token。**N=50 启用技能 ≈ 3000 字/轮；N=100 ≈ 6000 字/轮（被 idxBudget 截顶）**。一期出厂 15 条全 `enabled=false`，admin 通常只开 5-15 条，实际增量 ≈ 300-900 字/轮，远小于单次任务正文。`AITEAM_SKILL_INDEX_BUDGET` env 可调，与现有 `AITEAM_DAILY_TOKEN_BUDGET` 等护栏口径一致。

#### (b) `skillRelevant`（`engine.ts:800-805`）——**保留 `name` 入参 + trigger 优先 + name 回退**（评审 B2 方案 A）

```ts
export function skillRelevant(
  skill: { name?: string; trigger?: string; when_to_use?: string },
  focus: string
): boolean {
  const f = focus.toLowerCase();
  // 1) 优先用技能自带 trigger（新机制，扩库后内置/自定义统一走这条）
  const kws = (skill.trigger || "").split(/[,，、]/).map(s => s.trim()).filter(Boolean);
  if (kws.length > 0) return kws.some(k => f.includes(k.toLowerCase()));
  // 2) trigger 为空 → 回退硬编码 SKILL_KEYWORDS[name]（迁移期兜底，兼容现有 SK1 测试）
  const fallback = skill.name ? SKILL_KEYWORDS[skill.name] : undefined;
  if (fallback) return fallback.some(k => f.includes(k.toLowerCase()));
  // 3) 既无 trigger 又无映射 → 通用技能，参与排序但视为可注入
  return true;
}
```

**为什么是方案 A 而非纯 trigger**：现有 `regression.mjs:198-205` 用 `rel({ name: "金字塔写作法" }, ...) === false` 断言。纯 trigger 签名读不到 name，这些无 trigger 对象会一律 `return true`，`:201` 立即失败；且自述的"SKILL_KEYWORDS 兜底"在纯 trigger 签名里无从触发。方案 A 让内置 4 技能（trigger 待迁移期回填，期间走 name 回退）与现有测试**全兼容**，又让新自定义技能（admin 在 UI 填了 trigger）走新机制。`SKILL_KEYWORDS`（`engine.ts:794-798`）保留为内置 4 技能兜底，扩库且 trigger 全回填后可删——**新增技能不再需要改 engine.ts 源码**，根治"无映射技能始终全注入"的膨胀根因。

#### (c) 新增 `read_skill` 工具（`engine.ts` TOOLS 数组 `:860`，与 `read_document` 同构）

```ts
{
  name: "read_skill",
  description: "读取某个技能的完整方法正文（L2）。当工作区上下文的技能索引里有与当前任务相关的技能、需要其具体步骤/模板/参数时调用。能力型技能(capability)的正文会说明该调用哪个工具/MCP、参数怎么填、不可达时如何降级。",
  input_schema: { type: "object", properties: { skill_id: { type: "string" } }, required: ["skill_id"] },
}
```

执行分支放进 **execTool 同步 switch**（`engine.ts:1003` 是同步函数返回 string），紧邻 `case "read_document"`（`:1124`），**不进 `:1450` 的 await MCP 分支、不计 `MCP_CALLS_PER_RUN`**：

```ts
case "read_skill": {
  const sk = getSkill(String(input.skill_id));
  if (!sk || !sk.enabled) return `未找到该技能或未启用（id: ${input.skill_id}）。`;
  return sk.body || sk.content || sk.desc;   // body 为主，旧库回退 content
}
```

新增 `getSkill(id)`（`db.ts`，仿 `db.ts:583 getMcpServer`）。`read_skill` 只读、零计费。

> **数学对比（直接回应"大幅抬高下限"）**：旧 = `技能数 × 平均长度 ≤ 4000`（互斥死锁）；新 = `常驻 = 技能数 × ~60 字索引`（便宜，可上百）+ `执行 = 单次任务实际 read_skill 的 1-2 条正文`（按需付费、正文几乎不限长）。绝大多数技能在绝大多数任务里"只露名不读正文"，成本趋近于零。

### 2.3 混合 skill 模型：method-pack vs capability skill

| 维度 | method-pack | capability skill |
|---|---|---|
| `kind` | `method` | `capability` |
| L1 索引 | name+when_to_use+trigger | **完全相同**（对 LLM 无差别） |
| L2 `body` | 提示词方法论 | "使用指南"：何时调、参数怎么填、降级策略、产物去哪 |
| L3 `resources_json` | `[]` | `["mcp__markitdown__*"]` / `["generate_html"]`（指向 MCP 工具前缀或原生工具名） |
| 触发后 | read_skill→照方法干活 | read_skill→调对应 MCP/原生工具 |

`capabilityReady(sk)`（`engine.ts` 新增辅助）——**评审 m4 强化**：解析 `resources_json`，若指向 `mcp__<server>__*`，则①查 `listMcpServers()` 对应 server `enabled=1`；②**进一步对照 `mcp.ts` 已缓存的 `connection.tools` 做前缀存在性校验**（避免 `MAX_MCP_TOOLS=40` 截断或工具名不匹配导致索引标"就绪"却调空）。任一不满足 → 索引标"⚠️依赖未就绪"。这对"仅国内模型/BYOM 兼容端点"尤其重要——不同端点工具裁剪不一。capability skill 给当前"裸露给 LLM、无使用语境"的 MCP 工具套上 L1 触发 + L2 用法 + 降级闭环。

### 2.4 Skill/MCP 一键预设目录（内置 registry）

新增 `server/src/registry.ts`，导出两个静态常量（**不入库、无 token、编译进 server、零运行期依赖**）：

```ts
export const MCP_REGISTRY: McpPreset[] = [/* §5 清单 */];
export const SKILL_PACK_REGISTRY: SkillPreset[] = [/* §3 = BUILTIN_SKILLS 的目录视图 */];
```

`routes.ts` 加只读端点 `GET /registry`（member 可浏览，安装需 admin）；`/bootstrap`（`routes.ts:80-97`）附带 `registry` 字段（静态、无实例 token）。UI 在 `McpTab` 加"浏览推荐"抽屉（§5.2）。

---

## 3. 内置 method-pack 技能库扩充清单

### 3.0 版权与合规策略（**评审 M5 重写——可核查边界**）

1. **保留许可全文**：仓库内新建 `THIRD_PARTY_NOTICES/`（或 `LICENSES/`）目录，对每个被蒸馏来源放置**原 LICENSE 全文 + 版权行**；每条技能 `body` 末行写"（蒸馏自 \<来源\> \<来源 URL/commit\>，见 THIRD_PARTY_NOTICES/\<file\>）"，**而非仅一句署名**——满足 MIT/Apache 保留版权声明的义务。
2. **"蒸馏"可操作判定**：只取方法论要点、用自有措辞重写、**不复制原文连续段落 >40 字**、不照搬原 SKILL.md 的结构编号顺序；每条 S5-S17 标注来源以便审计。
3. **混许可来源单独处理**：Hermes 声称"SKILL.md=CC0 + 正文=Apache2.0"——**内置正文仅采用 CC0 的 SKILL.md 部分或完全重写，Apache 正文不直接内置**。
4. **来源许可清单**：superpowers/mattpocock=MIT，Hermes=Apache2.0(+CC0 SKILL.md)，baoyu-skills=MIT/MIT-0，frontend-slides/design-taste=MIT，react-best-practices(Vercel)/addyosmani=MIT/CC——均允许蒸馏改写+署名内置。

所有内置技能 `enabled=false` 出厂（admin 按需开），`builtin=1`。`seed.ts` 的 `BUILTIN_SKILLS` 每条结构升级为 `{ name, desc, trigger, when_to_use, body, kind, resources_json, version }`。

### 3.1 办公/文档产出（method-pack）

**S1 金字塔写作法**（保留，升级）`trigger:写,报告,文案,方案,prd,文章,总结,白皮书`
**S2 深度调研法**（保留，升级）`trigger:调研,检索,搜索,资料,来源,竞品,市场,行业`
**S3 交付自查清单**（保留）`trigger:交付,验收,自查,提交`
**S4 结构化头脑风暴**（保留）`trigger:创意,头脑风暴,构思,选型,策划`

**S5 文档结构化排版法**（蒸馏 baoyu-format-markdown，MIT）`trigger:排版,格式化,美化,层级,markdown,文档优化` `when_to_use:`Markdown/文案缺标题/加粗/列表/表格层级、难扫读时。
`body:`结论先行：好排版=读者 3 秒抓重点，只调呈现不改内容。①读者视角通读，标金句/核心结论/可并列项/可表格化数据；②加粗仅给关键结论+核心要点；③转折处插 `##/###`；④平行项→列表，对比/结构化数据→表格；⑤命令/路径/术语用行内代码；⑥金句/警告用引用块；⑦CJK 与英文/数字间留空格。禁：改写原意、堆砌加粗。产出走 `write_document(report)`。

**S6 Diataxis 文档生成法**（蒸馏 Hermes document-generate，仅 CC0 SKILL.md 部分，P0）`trigger:文档,说明,手册,api文档,使用指南,教程,reference` `when_to_use:`为代码/功能/模块产出系统化文档时。
`body:`结论先行：按 Diataxis 四象限分流。①先"代码考古"读 README/入口/测试/架构；②分象限：新用户功能→tutorial+how-to+reference；内部模块→reference+explanation；配置项→how-to+reference；③reference 完整可溯源到代码；④explanation 讲"为什么这样设计"；⑤无沙箱，代码示例标注但不声称已运行，走 `write_document(report)`。

**S7 翻译三档法**（蒸馏 baoyu-translate，MIT，P1）`trigger:翻译,精翻,本地化,改成中文,改成英文,translate` `when_to_use:`文档在中英等语言间翻译时。
`body:`结论先行：按质量需求选档，长文先统一术语。①快速档=直译；②常规档(默认)=分析→译→存稿，长文(≥4000字)先抽术语表分块；③精品档=分析→初稿→批评评审→修订→润色；④术语表优先级:内联>外部>内置；⑤保留源 frontmatter，发现源语言文字图时提醒用户。产出走 `write_document(report)`。

### 3.2 数据可视化 / 设计 / 多媒体（method-pack）

**S8 SVG 图表生成法**（蒸馏 baoyu-diagram + Hermes diagram，MIT/CC0，P0）`trigger:架构图,流程图,示意图,svg,图表,时序图,思维导图,diagram` `when_to_use:`可视化系统架构/流程/数据关系/时序时。
`body:`结论先行：先定图类型再画。①选型:架构(组件边界+数据流)/流程(决策菱形)/时序/思维导图/状态机;②简单图输出 Mermaid 代码块嵌入 `write_document(report)`(前端 react-markdown 渲染),复杂图直接写 SVG(响应式 viewBox);③SVG 设计系统:深色底+网格、语义配色、组件名 11px 粗/标签 9px、中文加宽;④z序:defs→背景→边界→连线→遮罩→组件框→图例。

**S9 演示设计与防溢出法**（蒸馏 frontend-slides，MIT，P0）`trigger:ppt,演示,幻灯片,slides,presentation,演讲稿,路演` `when_to_use:`制作演示/幻灯片确定密度与节奏。
`body:`结论先行：先问"讲者驱动 vs 读物优先"再定密度。①讲者驱动:每页 1-2 观点、大字号、≤3 要点、宁多分页;②读物优先:更紧凑、4-6 单元、自包含;③防溢出:单页元素数 vs 密度上限,超了拆续页;④**交 HTML 演示时锁 16:9 舞台(整体 scale 缩放不重排,letterbox 可接受),可用横向翻页模板(guizang/frontend-slides 风格,单 HTML 文件,走 §4 的 html kind)**;⑤主题节奏:避免连续 3 页同色调;⑥落点:`slides`(Marp,可导出 pptx) 或 `html`(网页 deck) 按需选。

**S10 反 AI-slop 设计审美守则**（蒸馏 frontend-slides + design-taste，MIT，P0）`trigger:设计,审美,排版,配色,字体,网页,landing,ui,封面` `when_to_use:`产出任何视觉交付(网页/PPT/封面/信息图)前。
`body:`结论先行：每个产出像"专为此 brief 设计",禁通用模板。①字体:禁 Inter/Roboto/Arial/系统字作标题,选特色字匹配气质;②配色:禁默认紫蓝(#6366f1)、禁平均分布,强制"主色承诺"或"故事色";③布局:按内容选 editorial grid/split panel/card cascade;④装饰:几何抽象/渐变/纹理,禁过度玻璃态;⑤全篇字体/色板/圆角统一。所有 design 类产出的前置守则。

**S16 信息图/封面/配图生成法**（蒸馏 baoyu-infographic + cover-image + article-illustrator，MIT，**评审 M6 新增，P0**）`trigger:信息图,封面,配图,插图,infographic,可视化大图,图文,小红书,公众号配图` `when_to_use:`报告/网页/文章需要配图、信息图、封面、图文混排时。
`body:`结论先行：先选 layout×style 再生成,图服务于内容不是装饰。①信息图:从内容抽 21 类 layout(时间线/对比/流程/金字塔…)×视觉 style,先给推荐组合再 `generate_image`;②封面:按 type×palette×rendering×mood 5 维,选 cinematic(2.35:1)/widescreen(16:9)/square(1:1);③文章配图:分析结构定位需配图处,Type×Style 两维生成;④**产出的图嵌入 `write_document(report)` 或 `html` kind 做图文混排交付**(图走 /aiteam/assets);⑤遵守 S10 反 slop 守则。底座:`generate_image`(Seedream,`images.ts`)已就位、受 `AITEAM_IMAGES_PER_RUN` 限。

### 3.3 代码 MVP（method-pack，**诚实标注无执行沙箱**）

> 关键诚实改写：AITeam 无代码执行（`engine.ts` 无 exec），"红绿重构"无法真跑。以下全部降级为"可验证规格"，把测试用例写进文档作为 `submit_verdict` 的 fail-closed 依据，**严禁注入"测试已通过"这类 agent 跑不了的幻觉指令**。

**S11 可验证规格法（TDD 蒸馏）**（superpowers TDD + mattpocock，MIT，P0）`trigger:开发,编码,实现,功能,代码,测试,tdd,接口` `when_to_use:`写新功能/修 bug 前先定行为与验收。
`body:`结论先行：动手前把"要交付的行为"写成可验证用例,测行为不测实现。①列行为清单按价值排序,与人确认公开接口;②对每个行为先用 `write_document` 写"测试用例:输入→预期可观察输出",只针对公开接口(抗重构);③写满足用例的最小实现,YAGNI;④覆盖后重构去重;⑤用例清单作 `submit_verdict` 的 fail-closed 依据,声称"满足"须逐条对照。**AITeam 无沙箱,禁声称"已运行通过",只能给"按规格应通过"+用例清单;前端代码若交 `html` kind 可在 body 内联自测断言(console.assert/可见断言区),并附"手动验收清单"作 playwright-QA 的人工替代(一期无自动 QA)**。

**S12 假设-证伪调试法**（superpowers systematic-debugging + mattpocock，MIT，P0）`trigger:调试,debug,排查,报错,故障,bug,定位,异常` `when_to_use:`遇 bug/异常,提修复前。
`body:`结论先行：先追根因再动手,禁猜测乱改。①症状写成可判定判据;②列 3-5 个可证伪假设按可能性排序,各写"若 X 为因则改 Y 会让 bug 消失"的预测;③指出该看哪段状态/数据流验证;④定位根因后先写回归用例再给修复;⑤同一处 3 次失败→架构质疑;⑥复盘"什么能预防此 bug"→`save_memory`。禁:无判据乱改、无验证就声称已修。

**S13 PR 审查法**（superpowers receiving/requesting-code-review + Hermes review，MIT/CC0，P0）`trigger:审查,review,代码评审,pr,diff,把关` `when_to_use:`做代码评审或接收意见时。
`body:`结论先行：技术评估非表演性同意。评审者:①读完整 diff+意图;②作用域检测;③结构审核(SQL/LLM prompt 注入/N+1/死代码/副作用);④分级 critical/high/medium/low。接收意见:①读完再反应+复述需求;②对照本 codebase 评估;③有据 push back(引用工作代码),无据则实现;④逐条单步落实。禁:盲从、未验证就实现。AITeam 用 `update_task`/文档承接,不动 `submit_verdict`(仅人工)。

**S14 设计前置头脑风暴法**（superpowers brainstorming，MIT，P0）`trigger:需求,设计,方案,功能设计,重构,选型,规划` `when_to_use:`新功能/重构前先澄清需求与方案。
`body:`结论先行：实现前必须有获批设计,禁跳过。①需求澄清:开放式问题逐个问(目的/约束/成功标准),一次一问;②方案探索:2-3 方案各配 trade-off,荐最优;③分段呈现设计(架构/组件/数据流/错误处理/测试),每段获批再下一段;④落地 `write_document(report)` 设计文档;批准后才实现。

**S15 实现计划法**（superpowers writing/executing-plans，MIT，P1）`trigger:计划,拆解,任务分解,排期,plan,roadmap` `when_to_use:`有 spec 要拆成可执行任务序列时。
`body:`结论先行：切成 2-5 分钟可独立完成的任务 DAG。①每任务:文件清单+代码片段+验收点;②标可并行/必串行;③排查冗余合并;④落点:用内置 `start_project`/`create_task` 落看板任务,正文走 `write_document(report)`;⑤按批推进(默认每批 3 个),批间留人工 review。

**S17 前端工程自查法**（蒸馏 react-best-practices(Vercel) + addyosmani,MIT/CC,**评审 M8 新增,P1**）`trigger:前端,react,next,性能,可访问性,组件,优化,bundle` `when_to_use:`产出前端代码/html MVP 后做工程质量自查。
`body:`结论先行：前端 MVP 产出附自查维度,别只看跑起来。①性能:避免不必要 re-render(memo/key 稳定)、数据获取就近、列表虚拟化阈值;②包体积:按需 import、避免巨型依赖、code-split;③可访问性:语义标签、alt/aria、键盘可达、对比度;④React 模式:状态最小化、副作用收敛、受控/非受控一致;⑤**交 `html` kind 时把上述做成"手动验收清单"内联进文档**(一期无自动 QA,人工逐项核对)。

### 3.4 九仓库精华映射表（**评审 m6 新增——落点 vs 合理舍弃**）

| 仓库 | 精华 | 一期落点 / 舍弃理由 |
|---|---|---|
| superpowers | TDD/调试/审查/brainstorm/plans | S11-S15（method-pack，P0/P1） |
| mattpocock | TDD/diagnose | 并入 S11/S12 |
| Hermes (gstack) | document-generate/diagram/review | S6/S8/S13（仅 CC0 部分） |
| baoyu-skills | format/translate/diagram + **infographic/cover/illustrator/xhs** | S5/S7/S8 + **S16（图文混排主线，P0）** |
| frontend-slides | HTML 演示/内容密度/审美 | S9/S10 + html kind 网页 deck（§4） |
| design-taste | 反 AI-slop | S10 |
| react-best-practices(Vercel) | React/Next 性能 | **S17（P1）** |
| addyosmani | 前端性能/可访问性 | 并入 S17 |
| karpathy-guidelines | 外科手术式改动/浮现假设 | 已并入 S11/S12（行为守则，不单列技能） |
| guizang-ppt | 横向翻页单 HTML deck | 接 html kind（§4.1），不单列方法 |
| tavily/deep-research | 联网检索 | C3（web-search-prime capability，§4.3，P1）+ 现有 `web_search` |
| frontend-design / high-end-visual-design | 生产级前端代码生成 | **合理舍弃（一期）**：无代码执行沙箱，生产级前端代码无法本地验证；html kind 已覆盖"可预览原型"，生产级生成推 P2 |

> **种子优先级**：一期 `seed.ts` 落 **S1-S17 共 17 条**（S1-S4 升级、S5-S17 新增，含 S16/S17 两条 M6/M8 补强；S6/S8 部分及 S13 用 CC0/重写），`version=2`。出厂 `enabled=false`，admin 在 SkillsTab 一键开。

---

## 4. 能力型 skill 落地：新增交付物 kind / 原生工具 vs MCP

### 4.1 决策总览

| 能力 | 落地方式 | 理由 |
|---|---|---|
| **HTML 网页 / 前端 MVP / 实时预览 / 网页 PPT deck** | **新增 `html` 交付物 kind**（P0） | 承接 frontend-slides/guizang/baoyu-markdown-to-html/design-taste 的 HTML 产出 + 前端 MVP 预览 + **单 HTML 横向翻页 deck**，纯前端 iframe 渲染零后端/零海外依赖、大陆友好 |
| **SVG 图表 / Mermaid** | 复用 `report` kind（react-markdown 已渲染 Mermaid）+ S8 | 无需新 kind |
| **数据可视化** | 复用 `sheet` kind（ECharts）+ S8 | 已有能力 |
| **图文混排 / 信息图 / 封面 / 配图** | 复用 `generate_image`（Seedream）+ **S16 方法包** + 嵌入 report/html | 底座已就位（评审 M6），一期补方法包打通工作流 |
| **docx/pdf/pptx/xlsx 解析输入** | **MCP markitdown（stdio 本地）+ C1 capability** | 纯本地、大陆可达、零外网，**一期实装**（评审 M7） |
| **可编辑高保真 PPTX** | **MCP（ppt-master/pptx，stdio）+ C2** + 现有 pptxgenjs 兜底 | 复杂 DrawingML 隔离进 MCP；**exec 类，推 P1/P2，默认关**（§6/§8） |
| **PPT** | **网页 deck → html kind；可导出 pptx → Marp slides，二者并存按需选** | 评审 m6：guizang/frontend-slides 单 HTML 天然契合 html kind |
| **批量文生图** | 复用 `generate_image` + S16 | 已有 Seedream |
| **联网检索（仅国内模型部署）** | **MCP web-search-prime（智谱,http+bearer）+ C3** | 仅国内模型下 `web_search` 走降档可能不可用（评审 m5），需国产主检索 |
| **代码执行 / 真跑测试** | **一期不做**（见 §8 风险） | 无沙箱，安全代价高 |
| **`code` kind** | **一期不引入** | 无执行只是带语法高亮的文本，价值 ≈ report 内代码块；前端 MVP 直接走 `html` kind 即可预览。**暂缓** |

### 4.2 新增 `html` 交付物 kind（一期 P0 核心，**含 B3/B4/B6 全部修复**）

#### (a) 后端契约——**两道闸门都要改**（评审 B3）

1. **白名单闸门（`engine.ts:1103`，B3 必改）**：
   ```ts
   const kind = ["report", "slides", "sheet", "html"].includes(input.kind) ? input.kind : "report";
   ```
   不改这一行，`html` 会在 validateDocContent 之前被静默回落 `report`，校验分支与前端渲染全是死代码。

2. **格式 + 安全校验（扩展 `validateDocContent`，`engine.ts:87` 签名加 `"html"`，B4 强化）**：
   ```ts
   export function validateDocContent(kind: "report" | "slides" | "sheet" | "html", content: string): string | null {
     // … 现有 report/slides/sheet 分支不变 …
     if (kind === "html") {
       const c = content.trim();
       if (!/<(!doctype|html|div|section|svg|style|body|main|article|h[1-6]|p)\b/i.test(c))
         return "html 交付物需是可直接渲染的 HTML 片段或文档（至少含一个 HTML 标签）。";
       if (/<script\b[^>]*\bsrc=/i.test(c))
         return "html 交付物禁止外链 <script src=...>，请把脚本内联或改用纯 CSS/SVG。";
       if (/\son\w+\s*=/i.test(c))                              // 禁内联事件处理器 onload/onerror/onclick…（B4）
         return "html 交付物禁止内联事件处理器（onload/onerror/onclick 等），请改用 <script> 块或纯 CSS。";
       if (/javascript:\s*/i.test(c))                          // 禁 javascript: URI（B4）
         return "html 交付物禁止 javascript: URI。";
       return null;
     }
     return null;
   }
   ```

#### (b) 前端落地——**5 处成套改动**（评审 B6，全部落 `web/src/components/DocsView.tsx`）

| # | 改点 | 真值锚点 | 改法 |
|---|---|---|---|
| 1 | `docKindMeta` 加 `html` case | `DocsView.tsx:14-23` | `case "html": return { icon:"🌐", label:"网页", ext:".html", mime:"text/html", hint:"单文件 HTML，沙箱预览" }` |
| 2 | 渲染 dispatch 加 html 分支 | `DocsView.tsx:337-345` | 在 slides/sheet 三元里加：`doc.kind==="html" ? <iframe srcdoc={doc.content} sandbox="" className="w-full h-full border-0" title={doc.title}/> : …`（**`sandbox=""` 不含 `allow-scripts` 也不含 `allow-same-origin`**，B4） |
| 3 | `DOC_KINDS` 过滤器加项 | `DocsView.tsx:442-446` | `{ k: "html", label: "🌐 网页" }` |
| 4 | 导出区 html 专属路径 | `DocsView.tsx:26 exportWord` / `:46 printDoc` / `:62 download` | **html kind 只给"下载 .html"按钮**（复用 `:62 download` 的 Blob 模式，mime `text/html`、ext `.html`，浏览器在 null 源打开）；**html kind 隐藏/禁用"Word 导出"与"🖨 PDF"按钮**（不走 `exportWord`/`printDoc` 的 `document.write` 同源路径，B4） |
| 5 | 类型 | `types.ts:91` | `Doc.kind` 加 `"html"` |

> **B4 核心**：html content 是模型生成的不可信内容。预览 iframe `sandbox=""` 彻底隔离（脚本不执行、无同源、无父窗口访问）；导出强制走"下载文件"而非 `document.write` 到应用窗口，杜绝存储型 XSS 毒化其他查看者会话。`report`/`sheet` 的现有 `exportWord/printDoc` 不变（其内容经 react-markdown 剥离原始 HTML，安全）。

#### (c) 写作引导

`engine.ts:550` 的 `write_document` 提示词补：`需要网页/落地页/前端原型/HTML 演示(横向翻页 deck)/可交互可视化时交 html（单文件、样式与脚本内联、禁外链 script/内联事件处理器、可在预览区实时查看）；报告/网页可内嵌 generate_image 产出的配图(走 /aiteam/assets)做图文混排。`

**收益**：一次性补齐三场景——办公(HTML 网页/图文排版)、数据可视化(HTML+SVG/Canvas 实时预览)、代码 MVP(前端页面**真预览**)。这是"无执行沙箱"约束下前端 MVP 能拿到的最高下限。

### 4.3 capability skill（入库，指向 MCP/原生工具）

**C1 文档解析能力**（kind=capability，**评审 M7：一期 P0 实装 markitdown MCP**）`resources_json:["mcp__markitdown__*"]`
`body:`当用户上传/给出 PDF/docx/pptx/xlsx/图片需提取内容时,调 `mcp__markitdown__convert` 转 Markdown 再处理;若 MCP 未就绪,降级为请用户粘贴文本。
> 一期端到端样例：markitdown 是纯本地 stdio、大陆可达、零外网、覆盖 office-doc 输入侧，作为"混合模型"唯一在一期真就绪的 capability（capabilityReady 真返回 ready）。

**C2 可编辑 PPTX 能力**（kind=capability，**P1 实装，一期入库为占位**）`resources_json:["mcp__pptx__*","generate_image"]`
`body:`需高保真可编辑 PPTX 时优先用 ppt-master/pptx MCP(真 DrawingML);不可达时降级用 `write_document(slides)`(Marp→pptxgenjs)。
> exec 类、共用主机高风险，受 §6 server 级 `require_approval` 门约束，默认关。

**C3 国产联网检索能力**（kind=capability，**评审 m5 新增，P1 优先实装**）`resources_json:["mcp__web-search-prime__*"]`
`body:`仅国内模型部署下 Anthropic 服务端 `web_search/web_fetch` 走联网降档可能不可用,此时以 `mcp__web-search-prime__*`(智谱,http+bearer,大陆可达)为主检索路径;不可达时降级为请用户粘贴资料。

> capability skill 走现有 `createSkill`，`kind='capability'`、`resources_json` 填工具前缀；`capabilityReady` 在索引层判断引用 MCP 是否就绪（含工具前缀存在性，§2.3）。

---

## 5. MCP 预设目录

### 5.1 内置 registry（`server/src/registry.ts`，**评审 M4 拆 install/runtime 两维**）

```ts
export interface McpPreset {
  key: string; name: string; kind: "http" | "stdio";
  command?: string; args?: string[]; url?: string;
  desc: string; scenario: "office-doc" | "data-viz" | "code-mvp" | "research";
  runtime_china: "yes" | "degrade" | "no";   // 运行期大陆可达性
  install_china: "yes" | "degrade" | "no";   // 安装期大陆可达性（npx/pip/Chromium 海外源）
  safety: "local" | "network" | "exec";      // 审批门提示（exec/network 触发 server 级 require_approval，§6）
  install?: string;                          // 含大陆镜像指引
  phase: "P0-catalog" | "P1-install";        // 一期只落目录；实装阶段
}
```

| key | name | kind | install（含大陆镜像） | scenario | runtime_china | install_china | safety | phase |
|---|---|---|---|---|---|---|---|---|
| `markitdown` | 文档转 Markdown | stdio | `pip install -i https://pypi.tuna.tsinghua.edu.cn/simple markitdown-mcp` | office-doc | yes | degrade | local | **P1-install（C1 一期实装）** |
| `docx` | Word 读写 | stdio | `npm config set registry https://registry.npmmirror.com` 后 `npx @某/office-mcp` | office-doc | yes | degrade | local | P1 |
| `pptx-native` | 高保真可编辑 PPTX | stdio | ppt-master（本地 python，清华源） | office-doc | yes | degrade | **exec** | **P2（共用主机高危，默认关）** |
| `pdf-tools` | PDF 合并/拆分/OCR | stdio | 本地 python（清华源） | office-doc | yes | degrade | local | P1 |
| `chart-render` | 图表→PNG | stdio | 本地 node+headless，`PLAYWRIGHT_DOWNLOAD_HOST=npmmirror 镜像` | data-viz | degrade | degrade（首装 Chromium ~150MB） | **exec** | **P2（共用主机高危，默认关）** |
| `playwright-qa` | 浏览器 QA | stdio | `npx @playwright/mcp` + 镜像 host | code-mvp | degrade（仅测内网） | degrade | network | P1 |
| `web-search-prime` | 智谱联网搜索（国产替代 Tavily） | http | bearer token | research | yes | yes | network | **P1（C3，仅国内模型部署下优先）** |
| `sqlite` | 本地 SQLite 查询 | stdio | 本地 | data-viz | yes | yes | local | P1 |

> **大陆可达性策略**：默认只推 `runtime_china=yes` 的本地 stdio；`install_china=degrade` 项 UI 必须标注大陆镜像命令；**不预置任何 github.com/tavily/海外 SaaS 强依赖**（符合腾讯云大陆 VPS/仅国内模型/stdio 本地优先约束）。检索类用智谱 `web-search-prime` 作国产替代。**`safety=exec` 项（pptx-native/chart-render）与代码执行沙箱同档，推 P2、默认关、UI 标注"需独立资源限制/不建议共用主机直接启用"**（评审 M3）。

### 5.2 UI：McpTab 加"浏览推荐"（**评审 M2：诚实的实装预期**）

`IntegrationsTabs.tsx McpTab`（`:20`）顶部加"浏览推荐"按钮 → 抽屉列出 `registry`（从 `/bootstrap` 的 `registry` 字段取），每条显示 name/desc/scenario 徽章 + runtime/install 双灯（绿/黄）+ safety 标签 + "一键添加"。点击"添加"= **仅预填** `POST /mcp-servers`（`routes.ts:185`）表单（command/args 或 url 已填好，admin 补 token/确认）。

**实装预期（M2 必须明示，不可隐瞒）**：
1. **一键添加只预填表单 ≠ 开箱可用**：stdio 预设必须先在宿主机装好依赖二进制（与另两项目共用主机，需 admin 在服务器执行 `install` 命令）。
2. UI 抽屉对 stdio 预设**显著展示 `install` 命令**（含大陆镜像）。
3. `testMcpServer`（`routes.ts:208 /mcp-servers/:id/test`）失败时**回显"命令未找到，请先在服务器执行 \<install\>"**，而非笼统报错。
4. 安装后默认 `enabled=0`，admin 测试通过再开。
5. **一期范围明示**：只落 registry 数据 + UI 浏览/预填，**不保证开箱可用**；MCP 真接入（除 markitdown/C1）在 P1。

---

## 6. 护栏与多租户

| 机制 | 渐进披露/新工具/新 kind/新 MCP 如何遵守 |
|---|---|
| **owner 隔离** | skills/mcp_servers 本就**全局共享、仅 admin 可改**（`db.ts` 无 owner_id）。`read_skill` 复用 `getSkill`（全局表、无 owner_id、**不经 ownerScope 过滤**），与现有 `listSkills` 注入路径同源——**确认不触发 fail-closed 的 owner 缺失告警**（评审 m2）；`html` 文档走 `documents` 表（已有 owner_id + `ownerScope.ts` AsyncLocalStorage 自动过滤），与 report 同隔离链路 |
| **admin-only 全局配置** | `/skills` POST/PATCH/DELETE、`/mcp-servers` 全 CRUD、registry 安装均 `requireAdmin`（`routes.ts:185-244`）；`GET /registry`/`GET /skills` member 只读 |
| **按次计费封顶 vs 高危执行门（评审 M3 关键区分）** | 二者**分开**：`MCP_CALLS_PER_RUN`（`engine.ts:50`，`:1451` 封顶）只限"调用次数"；**高危执行需人工放行是另一回事**。`read_skill` 零计费、走 execTool 同步分支、不计入 `MCP_CALLS_PER_RUN`（评审 m2）；`generate_image` 受 `AITEAM_IMAGES_PER_RUN`；`html` 生成只是文本，计入 `AITEAM_DAILY_TOKEN_BUDGET` |
| **server 级 require_approval 门（评审 M3，替代"提示词建议"）** | registry `safety∈{exec,network}` 的 server，**在引擎层 `callMcpTool`（`engine.ts:1454`）之前强制插入 `request_approval` 门**——由 DB/registry 的 `require_approval` 标志驱动，**不是写在 capability skill 的 body 提示词里**（提示词不是护栏）。`exec` 类 stdio MCP（pptx-native/chart-render）与代码执行沙箱同风险档，**推 P2、默认关** |
| **stdio spawn 风险（评审 M3）** | `mcp.ts connect` 用 `StdioClientTransport` 直接 spawn 宿主进程、无沙箱/白名单/配额；共用主机下一个失控脚本可吃满 CPU/磁盘或越权读写。一期**不实装任何 exec 类 stdio**；P1 只实装 local 类（markitdown）；exec 类 P2 + 独立资源限制 |
| **Mock 模式** | `read_skill`/registry/`html` 校验全是纯逻辑，`isMock()`（`engine.ts:118`）下全链路可跑、零 token；回归测试据此机制级验证 |
| **BYOM 第三方端点** | skill 注入是 system 文本，对任意 Anthropic 兼容端点透明；`html` kind 不依赖官方服务端工具；capability skill 降级策略覆盖"兼容端点无某工具"（含 C3 覆盖"仅国内模型下 web_search 不可用"） |
| **XSS / html 安全（评审 B4，统一所有出口）** | 预览 iframe `sandbox=""`（无 allow-scripts、**无 allow-same-origin**）；导出**禁走 printDoc/exportWord 原文**，只允许下载 .html 文件（null 源打开）；`validateDocContent` 禁外链 `<script src>` + 内联事件处理器 + `javascript:` URI |
| **token 脱敏（评审 m3）** | `GET /registry` 返回静态模板（**本就无 token**）；`/bootstrap` 新增 registry 字段不含任何 server 实例 token；**任何回吐 mcp_servers 的路径必须复用 `sanitizeMcpServer`**（`routes.ts:97/183/198` 现状已脱敏）；回归 REG1 加脱敏断言 |

---

## 7. 一期落地范围（P0）—— 精确到文件/函数/字段/工具/测试

### 7.1 后端

1. **`db.ts`**：
   - 迁移区（`:202` 后）加 6 个 `addColumnIfMissing`（kind/trigger/when_to_use/body/resources_json/version）；
   - `interface Skill`（`:282`）补 6 字段；
   - 新增 `getSkill(id)`（仿 `:583 getMcpServer`）、`upsertBuiltinSkill(id,s)`（仿 `:649 updateSkill` 但不动 enabled/id）；
   - **`createSkill`（`:634`）入参与 INSERT 列各加 6 字段**（kind/trigger/when_to_use/body/resources_json/version，默认值与列定义一致）；
   - **`updateSkill`（`:649`）入参与 UPDATE 列各加 6 字段**（评审 M1：否则 admin 永远改不了已建技能的 trigger/body/kind）。
2. **`seed.ts`**：`BUILTIN_SKILLS`（`:48`）每条升级结构并扩充至 **S1-S17**（§3）；`seedGlobalSkills`（`:76`）改 version-based upsert（§2.1b）；**导出 `BUILTIN_SKILLS` 与 `BUILTIN_SKILL_PACK_VERSION=2`**（供回归测试引用，避免硬编码数字）。
3. **`engine.ts`**：
   - `skillRelevant`（`:800`）改"trigger 优先 + name 回退 SKILL_KEYWORDS"（§2.2b，保留 name 入参）；
   - `buildDynamicContext`（`:807`）改"索引"格式（§2.2a），`skillBudget`→`idxBudget`(env `AITEAM_SKILL_INDEX_BUDGET` 默认 6000) + `continue` 不 `break`；
   - TOOLS（`:860`）加 `read_skill` 定义 + execTool 同步 switch 分支（紧邻 `:1124`，不计 MCP_CALLS_PER_RUN）；
   - **`:1103` write_document 白名单数组加 `"html"`**（评审 B3）；
   - `validateDocContent`（`:87`）签名加 `"html"` + 格式&安全校验分支（§4.2a）；
   - `write_document` 提示词（`:550`）补 html + 图文混排引导（§4.2c）；
   - 新增 `capabilityReady(sk)`（含工具前缀存在性校验，§2.3）；
   - **`callMcpTool`（`:1454`）前为 `safety∈{exec,network}` server 插 require_approval 门**（§6，C1 markitdown 是 local 不受此门）。
4. **`registry.ts`**（新建）：`MCP_REGISTRY`（含 runtime_china/install_china/safety/phase）+ `SKILL_PACK_REGISTRY`。
5. **`routes.ts`**：
   - `/bootstrap`（`:96`）加 `registry` 字段（静态、无 token）；
   - 新增 `GET /registry`（member 只读、静态无 token）；
   - **`POST /skills`（`:226-230`）解构 + 透传新字段**：`kind/trigger/when_to_use/body/resources_json`（评审 M1）；
   - **`PATCH /skills`（`:232-242`）解构 + 透传新字段**（评审 M1）；
   - 确认 registry/bootstrap 任何 mcp_servers 回吐复用 `sanitizeMcpServer`（评审 m3）。

### 7.2 前端

6. **`types.ts`**：`Doc.kind`（`:91`）加 `"html"`；新增 `Skill`/`McpPreset` 接口。
7. **`IntegrationsTabs.tsx`**：`SkillsTab`（`:177`）创建表单加 **trigger/when_to_use/kind** 输入（评审 M1：与 API 对齐，否则新自定义技能 trigger 恒空回到"始终注入"）、列表显示 kind 徽章；`McpTab`（`:20`）加"浏览推荐"抽屉读 registry + 一键预填 + install 标注 + test 失败引导（§5.2）。
8. **`DocsView.tsx`（评审 B6，5 处成套）**：
   - `docKindMeta`（`:14`）加 `html` case；
   - 渲染 dispatch（`:337-345`）加 html → `<iframe srcdoc sandbox="">`（B4）；
   - `DOC_KINDS`（`:442`）加 `{k:"html",label:"🌐 网页"}`；
   - 导出区：html 只给"下载 .html"（复用 `:62 download`），**禁 `exportWord`/`printDoc`**（B4）；
   - （types.ts Doc.kind 已在 #6）。

### 7.3 回归测试（`scripts/regression.mjs`，Mock 零 token 机制级，**评审 B1/B2/B5/m3 全闭环**）

> **必改坑**：4-技能硬断言有**三处**（评审 B1/B5）：`:63` P0、`:298` G3 的 `skills.length===4`、`:298` 删自定义后 `after.length===4`。全部改为引用 `BUILTIN_SKILLS.length`（避免下次扩库再改）。

改 / 新增：
- **改 `:63` P0**：`import { BUILTIN_SKILLS } from ".../seed"`；`db.listSkills().length === BUILTIN_SKILLS.length`（17），且断言含新增名（如 `信息图/封面/配图生成法`、`可验证规格法`）。
- **改 `:298` G3**：`skills.length === BUILTIN_SKILLS.length` 且 `after.length === skills.length`（删自定义后回到查询前基数，**不写死数字**，评审 B1）。
- **重写 `:196-206` SK1（评审 B2）**：新签名兼容性三连——
  - `rel({ trigger: "调研,检索" }, "请调研最新模型") === true`（带 trigger 命中）；
  - `rel({ trigger: "调研,检索" }, "撰写报告") === false`（带 trigger 不命中）；
  - `rel({ name: "金字塔写作法" }, "请调研...") === false` 与 `rel({ name: "金字塔写作法" }, "撰写报告") === true`（**无 trigger 走 name 回退 SKILL_KEYWORDS，保留原断言**）；
  - `rel({ name: "用户自定义X" }, "随便") === true`（无 trigger 无映射=通用）。
- **新增 SK2 渐进披露**：开启某技能 → `engine` 工具执行 `read_skill(id)` 返回非空 `body`（经 execTool 同步路径断言）。
- **新增 SK3 索引不超预算**：开启 20+ 技能 → `buildDynamicContext` 产出含全部技能 id 索引行、总长 ≤ `AITEAM_SKILL_INDEX_BUDGET`、无 break 丢弃（最后一条仍在）。
- **新增 SK4 旧库迁移**：插入仅有 `content` 的旧技能 → `read_skill` 回退返回 `content`。
- **新增 DOC-HTML（评审 B3/B4）**：`write_document(kind:"html")` 合法片段入库（确认未被 `:1103` 白名单降级为 report）；外链 `<script src>`、内联 `onload=`、`javascript:` URI 三种各被 `validateDocContent` 拒。
- **新增 REG1（评审 m3）**：`GET /registry` 返回非空、member 可读、安装 `requireAdmin`；**断言 `/registry` 与"含 auth_token 安装后的 /mcp-servers"响应里 auth_token 被脱敏**。
- **新增 CAP1**：capability skill（C1，markitdown server 未连）→ `capabilityReady` 返回 false、索引标"未就绪"；mock 一个 enabled+工具前缀匹配的 server → 返回 ready。

### 7.4 有序 checklist（可被工程师直接照做）

```
[ ] 1.  db.ts 加 6 列 + Skill 接口 + getSkill + upsertBuiltinSkill + createSkill INSERT列&入参 + updateSkill UPDATE列&入参（M1：6字段全贯通）
[ ] 2.  seed.ts BUILTIN_SKILLS 扩至 S1-S17 + version-based seedGlobalSkills + 导出 BUILTIN_SKILLS/BUILTIN_SKILL_PACK_VERSION=2
[ ] 3.  engine.ts skillRelevant：trigger 优先 + name 回退 SKILL_KEYWORDS（B2，保留 name 入参）
[ ] 4.  engine.ts buildDynamicContext 改索引 + idxBudget(env)/continue（m1）
[ ] 5.  engine.ts TOOLS 加 read_skill + execTool 同步 switch 分支（紧邻 :1124，不计 MCP_CALLS_PER_RUN，m2）
[ ] 6.  engine.ts :1103 write_document 白名单数组加 "html"（B3）
[ ] 7.  engine.ts validateDocContent 加 html：格式 + 禁外链script/内联事件/javascript:（B3/B4）
[ ] 8.  engine.ts write_document 提示词补 html + 图文混排引导；新增 capabilityReady（含工具前缀校验，m4）
[ ] 9.  engine.ts callMcpTool 前为 safety∈{exec,network} server 插 require_approval 门（M3，C1=local 不受门）
[ ] 10. registry.ts 新建 MCP_REGISTRY(runtime/install/safety/phase) + SKILL_PACK_REGISTRY
[ ] 11. routes.ts /bootstrap 加 registry + GET /registry（静态无 token）+ POST/PATCH /skills 解构透传6新字段（M1）+ 确认 sanitizeMcpServer 覆盖（m3）
[ ] 12. C1 markitdown MCP 一期实装（local stdio，capabilityReady 真就绪，M7）
[ ] 13. web types.ts Doc.kind+html + Skill/McpPreset 接口
[ ] 14. web IntegrationsTabs SkillsTab 加 trigger/when_to_use/kind 输入（M1）+ McpTab 浏览推荐抽屉(install标注+test失败引导, M2)
[ ] 15. web DocsView.tsx 5处：docKindMeta+html / 渲染dispatch iframe sandbox="" / DOC_KINDS+html / 导出仅下载.html禁printDoc&exportWord / (types已#13)（B4/B6）
[ ] 16. regression.mjs：改 :63 P0 + :298 G3(引用 BUILTIN_SKILLS.length) + 重写 SK1 + 新增 SK2/SK3/SK4/DOC-HTML/REG1/CAP1（B1/B2/B3/B4/m3）
[ ] 17. THIRD_PARTY_NOTICES/ 放各来源 LICENSE 全文 + 技能 body 末行链接（M5）
[ ] 18. 跑 scripts/regression.mjs 全绿（Mock 零 token）；npm run build 后端+前端无 TS 报错
```

> **C2（可编辑 PPTX）一期为占位**：入库 `kind=capability`，但 `mcp__pptx__*` 未实装 → `capabilityReady` 返回 false、索引标"未就绪"。**预期管理**：一期"会做的新事"只有 C1（文档解析）端到端就绪 + html kind 真预览；其余 capability 在 P1。

---

## 8. 分期路线与风险

### 8.1 P1（二期）

- **MCP 预设实装（除 markitdown）**：docx/pdf-tools/pptx-native(转 P2)/web-search-prime(C3)/playwright-qa/sqlite 真接入 + capability 配套；web-search-prime 因"仅国内模型部署下 web_search 不可用"列为优先（评审 m5）。
- **L3 资源（脚本/模板）**：skills 支持 `resources_json` 指向内置模板（如 guizang/frontend-slides 的 HTML deck 模板包），`read_skill` 可附带模板。
- **方法包扩库**：finishing-a-development-branch、spec、cso、investigate、design-consultation 等 P1 method-pack。
- **设计风格发现**：frontend-slides 的"3 预览选择"流程蒸馏为交互式设计顾问（依赖 html kind）。

### 8.2 P2（三期 / 评估）

- **代码执行 + exec 类 stdio MCP 沙箱**（最高风险，评审 M3 归并）：QA/真跑测试/pptx-native/chart-render 这类**本地 spawn**需隔离沙箱（容器/firecracker），安全代价大（逃逸、资源耗尽、与"共用主机"冲突）；走独立 stdio MCP + 严格 server 级 require_approval 门 + 资源配额，**默认关闭**，admin 显式启用。
- **生产级前端代码生成**（frontend-design/high-end-visual-design）：依赖代码执行验证，随沙箱一并评估。
- **海外依赖项**：github/tavily/Vercel 一律"可选 provider/MCP、默认关闭、admin 自配"，绝不硬依赖；大陆出海可达性逐个实测。

### 8.3 风险登记

| 风险 | 缓解 |
|---|---|
| 旧库不播种新内置技能 | version-based upsert（§2.1b），一期 P0 |
| 回归 4-技能硬断言三处失败（:63/:298×2） | 一期 checklist #16 全改为引用 `BUILTIN_SKILLS.length`（评审 B1/B5） |
| skillRelevant 改签名打穿 SK1 | 方案 A：保留 name 入参 + trigger 优先 + name 回退（评审 B2） |
| html 被白名单静默降级为 report | `:1103` 数组加 "html"（评审 B3，checklist #6） |
| **html kind 存储型 XSS（导出/打印路径）** | iframe `sandbox=""` + 导出禁 printDoc/exportWord 只下载文件 + 校验禁内联事件/javascript:（评审 B4，§4.2/§6） |
| 新字段未贯通 API/DB/UI | createSkill+updateSkill+POST+PATCH+SkillsTab 表单全改（评审 M1，checklist #1/#11/#14） |
| **exec 类 MCP 在共用主机无真实执行门** | server 级 require_approval（DB/registry 驱动，非提示词）+ exec 类推 P2 默认关（评审 M3） |
| registry 安装期海外源不可达 | install/runtime 双维 + 大陆镜像指引 + 一期只展示不保开箱（评审 M4/M2） |
| 版权合规边界弱 | THIRD_PARTY_NOTICES/ 全文 + 蒸馏判定 + 混许可只取 CC0（评审 M5） |
| capability 引用 MCP 不可达/工具前缀不匹配 | `capabilityReady` 查 enabled + 工具前缀存在性，索引标"未就绪"（评审 m4） |
| 一期 capability 半边空壳 | markitdown(C1) 提到一期实装作端到端样例 + C2/C3 占位预期管理（评审 M7） |
| code-mvp 无自动 QA / 无前端工程守则 | S17 前端工程自查 + S11 内联自测断言/手动验收清单作 playwright 人工替代（评审 M8） |
| **仅国内模型下 web_search 不可用 → research 降级** | C3(web-search-prime) 作主检索 + 降级请用户粘贴；P1 优先实装（评审 m5） |
| read_skill 与 ownerScope fail-closed | getSkill 全局表无 owner、与 listSkills 同源，确认不触发告警（评审 m2，§6） |
| registry/bootstrap 泄露 token | 静态无 token + sanitizeMcpServer 复用 + REG1 脱敏断言（评审 m3） |
| 索引预算膨胀 | continue(非 break) + trigger 排序 + `AITEAM_SKILL_INDEX_BUDGET` 可调（评审 m1） |

---

**关键改动文件清单（绝对路径）**：
- `server/src/db.ts`（skills +6 列 / Skill 接口 / getSkill / upsertBuiltinSkill / createSkill+updateSkill 全字段贯通）
- `server/src/seed.ts`（BUILTIN_SKILLS 扩至 S1-S17 / version-based seedGlobalSkills / 导出 BUILTIN_SKILLS+VERSION）
- `server/src/agents/engine.ts`（skillRelevant trigger+name回退 / buildDynamicContext 索引+env / read_skill / :1103 白名单+html / validateDocContent +html安全校验 / capabilityReady / callMcpTool require_approval 门）
- `server/src/registry.ts`（新建：MCP_REGISTRY+SKILL_PACK_REGISTRY）
- `server/src/routes.ts`（/bootstrap +registry / GET /registry / POST+PATCH /skills 新字段透传 / sanitize 覆盖）
- `web/src/types.ts`（Doc.kind +html / Skill / McpPreset）
- `web/src/components/IntegrationsTabs.tsx`（SkillsTab trigger/when_to_use/kind 输入 / McpTab 浏览推荐）
- `web/src/components/DocsView.tsx`（5 处：docKindMeta / 渲染 dispatch iframe sandbox="" / DOC_KINDS / 导出禁 printDoc&exportWord 仅下载 / 配合 types）
- `scripts/regression.mjs`（改 :63 P0 + :298 G3 引用 BUILTIN_SKILLS.length + 重写 SK1 + 新增 SK2/SK3/SK4/DOC-HTML/REG1/CAP1）
- `THIRD_PARTY_NOTICES/`（新建：各蒸馏来源 LICENSE 全文 + 版权行）
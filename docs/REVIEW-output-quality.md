# AITeam 交付物输出质量优化报告（视觉 + 内容，team & solo）

> 范围：提升 AITeam「同事」交付物的**输出质量** —— 内容质量（不泛泛、不编造）与视觉质量（PPTX/HTML/CJK），覆盖 **团队（TEAM）** 与 **独立/私聊（SOLO/DM）** 两种模式。
> 方法：每条均以真实 `file:line` 为锚；已按对抗式 verdict 校正（被驳回的诊断已下调或删除，verifier 的 "missed" 已并入）。评审为只读；**Batch 1（解决方案场景）已据此落地，见 §0**。

---

## 0. 实施进度 · Batch 1（解决方案场景：能拿到 · 像样 · 不胡说）

> 状态锚点：2026-06-16。以下 6 项已实现并通过 `npm run build` + `npm test`（**44 通过 / 1 跳过 / 0 失败**，新增回归 `DOC-SRC`）；dev 服务已在 `:8787` 重启到新构建。CJK 字体已在真实 `.pptx` 的 OOXML 中核验（`<a:latin>/<a:ea>/<a:cs>` 三类 run 均落到 PingFang SC）。

| 项 | 实现要点 | 落点 | 覆盖路径 |
|----|---------|------|---------|
| **D1** 交付红线 | 注入 `buildDynamicContext`（运行时、每轮）——**比原计划的 SHARED_RULES 更对**：存量同事的 `system_prompt` 是建号时烘焙进 DB 的，只改 SHARED_RULES 对存量同事无效 | `engine.ts` `DELIVERY_RULES` | 聊天 + 任务、存量 + 新建 |
| **D2** 工具描述 | `write_document` slides 描述写明「内置一键 ⬇ .pptx，无需 MCP/插件/命令行」 | `engine.ts:1033` | 每轮工具链 |
| **D5** 误导技能 | 改写「可编辑 PPTX 能力」：内置 slides→pptx 为默认正路、删「降级」措辞；PPT/解决方案两个 persona + registry `pptx-native` 预设同步；`BUILTIN_SKILL_PACK_VERSION` 4→5（重启已 upsert 到存量库） | `seed.ts`/`templates.ts`/`registry.ts` | 全部 |
| **R3+T2/T3** CJK | pptx 每处 `addText/addTable` 加 `fontFace`（默认 `PingFang SC`，env `AITEAM_PPTX_FONT` 可覆盖为 `Microsoft YaHei`）；html deck 字体栈对齐 `index.css:41` 跨平台栈 | `pptx.ts`/`registry.ts` | 渲染器/模板 |
| **V1** solo 自检 | `others.length===0` 不再放行 → 本人净上下文 **fail-closed 自检**（仅任务路径；纯私聊无验收阶段，由 D1/D2/C2 兜底） | `engine.ts:628` | solo 任务 |
| **C2+C4/C5** 防编造 | `validateDocContent` 无源数字软门（report/slides，≥5 处量化且零来源/示意 → 退回自纠）+ 简报「先扫文档库」「无源宁缺勿编」措辞 + 回归用例 `DOC-SRC` | `engine.ts:90`/`regression.mjs` | 聊天 + 任务（write 时） |

> 诚实标注：C2 是「有标注」而非「为真」的下限。V1 只覆盖 solo 的**任务**执行；截图那种纯私聊对话无验收阶段，其改善来自 D1/D2（不再臆造导出阻塞）+ C2（写时拦无源数字）。

---

## 0b. 实施进度 · Batch 2（解决方案：图文质量拉到「中上等」+ 团队验收收口）

> 状态锚点：2026-06-16（续）。`npm test` = **45 通过 / 1 跳过 / 0 失败**（新增 `PPTX3`）；pptx 渲染已用 LibreOffice 栅格化**逐页目视核验**（数字卡 / 章节幕页 / 溢出均衡续页 / 原生表格 / 页脚——版式达中上等）。`BUILTIN_SKILL_PACK_VERSION` 5→6，重启已 upsert（内置技能 26→27）。

| 项 | 实现要点 | 落点 |
|----|---------|------|
| **R2** 数字卡 | `值 :: 标签` 行 → 圆角数字卡（大号琥珀数字 + 标签），最多 4 张一排 | `pptx.ts` |
| **R4** 溢出续页 | 按高度预算自动分页（标题带「（续）」）+ **均衡分配**（不再首页满/续页一条） | `pptx.ts` `packBlocks` |
| **R1** 多图网格 | ≥2 图渲成 2 列网格（contain 保比例），不再静默只画第一张 | `pptx.ts` |
| **版式** | 仅含 `# 标题` 的页 → 章节幕页；每页底部 deck 标题 + 页码 | `pptx.ts` |
| **方法技能** | 「演示设计与防溢出法」补数字卡/幕页/表格/自动续页约定；**新增「解决方案/售前方案法」**（痛点→方案→架构→选型→ROI→实施→案例→CTA + 数字接地） | `seed.ts`（27 技能） |
| **V2** 验收看渲染清单 | `slidesManifest` 注入校验者：核对「声称 vs 实产」、抓静默丢页、禁自查表声称渲染器产不出的属性（字号/CSS 变量） | `pptx.ts`/`engine.ts` |
| **C3** 验收反编造 | 校验者恒挂「量化主张须有来源，无源且非示意值 → revise 逐条点名」 | `engine.ts` |
| **V3** 去人名化选校验者 | 「评审」死字串 → 评审/审核/质检/复核/review/qa 软偏好 | `engine.ts` |
| **C6**（轻量） | 简报提示：国内通道优先用检索插件（结果可留存、可引用） | `engine.ts` |

> C6 轻量版已落地（简报提示国内通道优先用检索插件）。

---

## 0c. 实施进度 · Batch 2b（活体认证 + 实跑暴露的渲染修复）

> 状态锚点：2026-06-17。用最小隔离账号、复用全局 Deepseek provider，经 HTTP API 在「解决方案」式**团队频道**（解决方案助手 + 代码评审）**真跑了两轮端到端任务**（真实模型，非 Mock）。

**工作流稳定 —— 已活体认证**：完整跑通 指派 → 检索(tavily/bocha) → 生成 → **代码评审验收 → 裁决 revise → 退回返工**（revision_count 0→1）→ 再生成，全程无崩溃 / 悬挂 / fail-open；验收严格（驳回 v1，非放水）；`server.log` 无异常。证明 V1/V2/C3/V3 在真实模型端点上行为正常——这是 Mock 回归跳过、必须真跑才能认证的一环。

**实跑暴露并已修复的渲染问题**（Mock 与静态 mockup 都测不出，只有真模型产出才暴露）：

| 现象 | 根因 | 修复 |
|------|------|------|
| 讲者备注渲染上了幻灯片（封面被备注塞满） | 模型用 `<!-- note -->…<!-- end note -->` 块式，旧解析器只认 `<!-- note: … -->` | `parseSlides` 先抽成对块式备注入 notes（回归 PPTX4） |
| slides 里出现字面 `<div style=…>` | 模型给 slides 塞了原始 HTML | `parseSlides` 剥离跨行 HTML（保护代码围栏）+ 工具描述写明 slides 禁 HTML |
| 数字卡没被使用（改用表格） | 教数字卡语法的技能默认关、模型看不到 | 把 slides 规范（`值::标签` / 幕页 / 表格 / `<!-- note: … -->` / 禁 HTML）写进**常驻的 `write_document` 工具描述**，不再依赖技能开关 |

**修复后实跑复验（v7）**：模型**主动用了数字卡**（`80亿元 :: 2025市场规模(SaaS口径)`、`95%+ :: 达摩院ASR准确率` 等多页）、proper 备注、零 HTML、内容接地（白皮书 vs 艾瑞口径区分、检索日期、逐项来源）。导出 .pptx 经 LibreOffice 栅格化目视：数字卡 + 原生表格 + 章节版式，达中上等。`BUILTIN_SKILL_PACK_VERSION` → 7；回归 46/47（新增 PPTX4）。

> 观察项（非缺陷）：富内容方案（检索 + 配图 + 强模型验收 + 返工）端到端 >5 分钟，属模型/范围固有延时，audit 全程有进度。深层接地 C1 仍为可选（内容已经插件检索接地、质量达标）。

---

## 1. 执行摘要：那次「很尬」的 PPT 助手到底坏在哪

真实截图里的失败是**三个独立缺陷在同一次对话里叠加**，而非单点 bug：

1. **交付认知缺口（根因）**：平台**早已内置零依赖、一键导出真·可编辑 .pptx**（后端 `GET /api/documents/:id/pptx → slidesToPptx`，`routes.ts:512` 起；前端「⬇ .pptx」按钮 `DocsView.tsx:317-325`，提示语「PowerPoint/WPS/Keynote 直接打开」）。但**模型在私聊路径上能看到的任何提示词都没提这条路**——于是它凭先验臆造出「导出依赖 pptxgenjs MCP，尚未就绪」这个**根本不存在的阻塞**，把全文往聊天里倒、还甩给用户一条 `marp-cli` 命令让用户自己在本机跑。
2. **内容未接地（grounding 缺失）**：268亿/80%/85% 等数字看似精确实则无源——因为在国内模型通道（`!official`），`echoContent`（`engine.ts:1462-1467`）会**把服务端 web_search 结果块从历史里剥掉**，等模型真正成稿时检索证据早已不在上下文里；且**没有任何「无源数字拦截」**：`validateDocContent`（`engine.ts:90-128`）只查格式不查事实。
3. **自查表是表演（self-check theater）**：私聊即 DM、DM 只有一个 agent，`runVerification` 在 `engine.ts:629` 直接 `others.length===0 → pass` **整段跳过验收**；自查表又由**产出同一次对话**自己写、对照的是 Markdown 源串而非渲染产物（renderer 根本没有 56px 大字号、没有 CSS 变量概念）——所以「全绿」既无独立校验、也对不上用户真正拿到的 .pptx。

**一句话根因**：模型对「交付物如何到达用户」的认知与代码现实脱节（把唯一能用的内置导出当「降级」、把默认关闭的高危 MCP 当「正路」），加之 grounding 与验收在 SOLO 路径上结构性失效，导致「臆造阻塞 + 无源数字 + 全绿自查」三连。**最高杠杆的修复全是 XS/S 级提示词与开关改动**，不需要任何 Python / 重型服务（符合共用大陆 VPS 的硬约束）。

---

## 2. 优先级路线图

排序原则：**快赢优先**（XS/S 且高影响），其中**交付认知修复（D1/D2/D5）排最前**——它们直接消灭截图里那句「导出不可用」。`impact/effort` 已采用 verifier 的 `revised_*`。

| # | 项目 | 类型 | 模式 | 影响 | 工作量 | 根因/缓解 | 主要文件 |
|---|------|------|------|------|--------|-----------|----------|
| **1** | **D1** SHARED_RULES 加「交付与导出红线」（禁称导出不可用/禁甩 CLI/问"在哪看"答去文档面板） | integrity | both | 高 | S | 缓解（唯一覆盖私聊路径的共享文本） | `seed.ts` |
| **2** | **D2** `write_document` slides 描述注明「内置一键 ⬇ .pptx，无需 MCP」 | content | both | 中 | XS | 根因（聊天工具链可见） | `engine.ts:1033` |
| **3** | **D5** 改写「可编辑 PPTX 能力」技能：内置 slides→pptx 为**默认正路**，删除「降级」措辞 + PPT 助手模板加一句导出指引 | integrity | both | 中 | S | 根因 | `seed.ts:243-248`, `templates.ts:99`（须 bump 版本） |
| **4** | **V1** 解除 SOLO/DM 验收免检：`others.length===0` 改为同模型**净上下文自校验**（fail-closed） | integrity | solo | 高 | S | 根因 | `engine.ts:628-629` |
| **5** | **C2** `validateDocContent` 加「无源数字」软门：report/slides 含 ≥N 处量化但零来源标记 → 退回自纠 | content | both | 高 | S | 缓解（含规避口，须配 C3/C4） | `engine.ts:90-128` + 回归测试 |
| **6** | **T2/T3** 统一 CJK 系统字体栈：HTML deck 模板（`registry.ts:227`）+ pptx `THEME.font`（`pptx.ts:12-18`）每个 addText/addTable 都带 `fontFace` | visual | both | 高 | XS–S | 根因 | `registry.ts`, `pptx.ts` |
| **7** | **C3** verifier 恒挂「量化主张须有源」标准；有 source_doc_ids 时把来源注入校验上下文 | content | **team** | 高 | S | 根因（团队路径） | `engine.ts:646-666` |
| **8** | **C6** 国内通道优先走 MCP 检索（结果以 tool_result 保留、可引用），而非被剥离的服务端 web_search | content | both | 高 | S | 根因（接地） | `engine.ts:579`, `seed.ts:251-256` |
| **9** | **C1** `!official` 时把被剥离的 web_search 结果序列化成 `role:user` 文本块重注入（可引用、可溯源） | content | both | 高 | M | 根因 | `engine.ts:1462-1467` |
| **10** | **R4 / V2** pptx 溢出防护：高度预算 + 续页（`---（续）`），并把渲染清单注入 verifier（声称 11 页 vs 实渲 N 页不符→退回） | visual+integrity | both | 高 | L | 根因 | `pptx.ts`, `engine.ts` |
| **11** | **R1** 多图渲染：`page.images.length>1` 时网格布局/续页，停止只画 `[0]` | visual | both | 中 | M | 根因 | `pptx.ts` |
| **12** | **R2** stat/大数字原语：解析 `> 268亿 :: 市场规模` → roundRect 数字卡（40-54px） | visual+content | both | 高 | M | 根因 | `pptx.ts`, `templates.ts`, `seed.ts`（须 bump 版本） |
| **13** | **T1** HTML deck 模板改为「脚本关闭也可读」（scroll-snap CSS 兜底 + JS 渐进增强） | visual | both | 高 | M | 根因 | `registry.ts` + 回归测试 |
| **14** | **V3** verifier 选择去人名化：`name.includes("评审")` 降为软偏好，按"最强可用 reviewer"选 | integrity | team | 中 | S | 根因 | `engine.ts:630-633` |
| **15** | **U1** message→document 链接原语（Message 加 `doc_id` 列 + MessageItem 渲染文档卡） | ux | both | 中 | M | 根因（解锁 U2/聊天内交付卡） | `db.ts`, `engine.ts`, `MessageItem.tsx` |
| **16** | **R5/V5** 自查表与渲染清单脱钩：slidesToPptx 返回 manifest，自查只许声明 renderer 真能产出的属性 | integrity | both | 中 | M | 缓解 | `pptx.ts`, `engine.ts`, `seed.ts` |
| **17** | **U2** 项目终稿（synthesis）完成消息挂可点开的摘要卡（依赖 U1） | ux | team | 中 | M | 根因（依赖 U1 先建） | `engine.ts:779-782`, `MessageItem.tsx` |
| **18** | **C4** 强化简报接地措辞（无源数字写「示意值，待核实」）+ 运行时按任务注入调研/自查技能正文 | content | both | 中 | S | 缓解 | `engine.ts:582`, `seed.ts` |
| **19** | **C5/D4** 简报加「开工前先扫文档库、有则 read_document 复用」一行 | content | both | 中 | XS | 缓解 | `engine.ts` |

> **被 verdict 驳回/下调而剔除或降级的项**：
> - 「buildWorkBrief 没告诉模型导出路径」**作为修复截图失败的主入口被驳回**（verdict: diagnosis 部分错）——因为截图是 **DM/私聊**，走 `runChat→llmLoop`（`engine.ts:308,1416-1436`），系统提示只有 `agent.system_prompt`(=persona+SHARED_RULES)+`buildDynamicContext`，**`buildWorkBrief` 根本不在私聊路径上**（它只在 `runTaskWork` 的 `engine.ts:497` 调用）。故把交付认知修复的主入口从 buildWorkBrief **改投 SHARED_RULES（D1）+ 工具描述（D2）**；buildWorkBrief 那条只作为任务循环的补充。
> - 「无自动化测试覆盖 SKILL_TEMPLATES 的 validateDocContent」**诊断为假**：`scripts/regression.mjs:288-292`（TPL1）**已存在**该断言。该项仅保留「脚本关闭可渲染」这一未覆盖的子检查（并入 T1）。
> - 「nothing tells it the built-in export exists」是**过度断言**：`seed.ts:243-248` 确有技能正文提到 slides→pptx「已可导出」——但它把内置路径写成「降级」、且为渐进披露（仅按需拉取、默认 enabled=false），所以方向仍成立，故 D5 保留为「改写而非新增」。
> - U2/U1 的 proposal「复用已有 Message.doc_id 机制」**被驳为不可行**：该机制**不存在**（`db.ts` Message 无 `doc_id` 列，`MessageItem.tsx` 仅渲染 Markdown）。已把 U1「建链接原语」列为 U2 的前置（effort 升至 M）。

---

## 3. 分主题详解

### 3.1 交付与可达性（Delivery & affordance）——头号问题

**当前状态**
- 内置导出真实存在且零 MCP：`routes.ts:512` 起 `GET /api/documents/:id/pptx → slidesToPptx`；前端一键按钮 `DocsView.tsx:317-325`。
- 模型在**私聊路径**能看到的所有共享文本里**都没提这条路**：`SHARED_RULES`（`seed.ts:3-18`，只说"产出写入文档库"`seed.ts:12`），PPT 助手 persona（`templates.ts:99`），`write_document` 描述只含被动的「可直接生成 PPT」（`engine.ts:1033`）。
- 反而有**误导性技能**：「可编辑 PPTX 能力」（`seed.ts:243-248`）正文写「1) 优先用 ppt-master/pptx MCP；2) 该 MCP 不可达时…降级用 write_document(slides)」，desc 直接是「依赖 pptx MCP，默认未就绪」——**这正是截图里那句借口的近乎逐字来源**。registry 的 `pptx-native` 预设又把默认关闭的高危 Python 服务命名为「高保真可编辑 PPTX」、install 串里写「不可用时降级用 slides」（`registry.ts:171-183`），从元数据层面就把能用的内置路径定性为「降级」。

**缺口**：模型不确定时的兜底是「臆造阻塞 + 把活甩给用户」。截图三宗罪（声称不可用 / 倒全文进聊天 / 给 CLI）全部无任何护栏禁止——`grep` 确认整个 `server/src`、`web/src` 里**没有 `marp-cli` 字符串**，那条命令是模型凭空编的。

**提案（按 verdict 校正后的优先级）**
- **D1（缓解，最高杠杆）**：在 `SHARED_RULES`（`seed.ts:3-18`，每个 team/template/solo agent 都嵌它，是**唯一覆盖私聊路径的共享文本**）加一条「交付与导出红线」：① 凡平台内置能力（slides→.pptx、report/sheet→.md/.csv/Word/PDF、html 沙箱预览）一律视为可用，**绝不声称"导出不可用/依赖未就绪"**；② **绝不让用户自己跑命令行**（如 marp-cli）；③ 用户问「在哪看」→ 答去「文档」面板打开、点标题栏 ⬇ .pptx，**不要把全文倒进聊天**。SHARED_RULES 是 const 串、运行时重读，**无需 bump 技能版本**。
- **D2（根因，XS）**：`write_document` slides 描述（`engine.ts:1033`）把「可直接生成 PPT」改为具体路径：「用户在『文档』打开后可一键导出真可编辑 .pptx（内置，无需 MCP/插件）」。这是聊天工具链每轮都读的高杠杆点，**同时覆盖任务与私聊**。
- **D5（根因，S）**：改写「可编辑 PPTX 能力」技能正文（`seed.ts:248`），把**内置 slides→pptx 作为默认正路**、删除「降级」框架、把 MCP 降为「仅当管理员启用 pptx-native 且需母版级 DrawingML 时」；desc 改为「演示统一交 slides；用户在文档里一键 ⬇ .pptx，无需 MCP」。同时 PPT 助手 persona（`templates.ts:99`）补一句「产出 slides 后告诉用户去『文档』打开、点 ⬇ .pptx，不解释 MCP、不给命令行」。**编辑 BUILTIN_SKILLS 必须 `BUILTIN_SKILL_PACK_VERSION` 4→5（`seed.ts:54`）**——version-based upsert（`seed.ts:267-273`），否则不会下发。registry `pptx-native` 预设可顺手改名「可编辑 PPTX 母版级增强（自托管，可选）」并删 install 串里的「降级」字样（XS，但它是管理员面向元数据，对 agent 因果权重较低）。

**TEAM vs SOLO**：完全一致——所有这些都是共享提示词/技能/工具，两模式同改同生效。

---

### 3.2 PPTX 渲染保真度

`slidesToPptx`（`pptx.ts:130-223`）是真·零 MCP 的可编辑 .pptx 渲染器，**比 agent 承认的更好**（真表格 `pptx.ts:196-212`、Hive 主题 `pptx.ts:12-18`、讲者备注 `pptx.ts:140`、嵌入本地生成图）。但它是**定坐标、单列、无溢出处理**的布局，自查表声称的若干视觉原语它根本产不出。

**关键修正（采纳 verdict 对失败机理的纠正）**：原 review 说「中文被打上 Latin 字体/Calibri 写进 `<a:latin>`」**不准确**。pptxgenjs 不传 `fontFace` 时**不写任何字体块**，run 继承主题默认、CJK 落到主题脚本字体（Windows/Office 上是 DengXian），在 macOS/Keynote/Linux/可能 WPS 上**回退不可控**。且加 `fontFace` 会**同时**写 `<a:latin>/<a:ea>/<a:cs>`（pptxgenjs `genXmlTextRunProperties`）——所以**逐 run 加 `fontFace` 就是完整根因修复**，主题级默认只是锦上添花。

| 缺陷 | 当前 file:line | 缺口 | 提案 | 类型 | 影响/工量 |
|------|---------------|------|------|------|-----------|
| **R3** 无 CJK fontFace | 全文仅 `pptx.ts:191` 给 code 设 `Consolas`；title/body/table/notes 均无 | CJK 字体回退不可控，WPS（tooltip 点名目标）易错 | `THEME.font="Microsoft YaHei"`，在 `147/151/161/167/172/199/204/208/218` 每处 addText/addTable 传 `fontFace: THEME.font`；code 仍 Consolas 但**含中文的 code 也要给 CJK 回退** | visual（根因） | 高 / S |
| **R4** 无溢出处理 | y 游标 1.7 起（`pptx.ts:179`），高度全为固定估算（`182/188/211`），从不与 7.5in（`pptx.ts:133`）比对 | 密集页冲出底边、被 PowerPoint 裁切；「防溢出」自查无法核实 | 加高度预算，超 ~7.0in 就**起续页**（同标题+「（续）」）；逐页限 bullet 数。**注意**：`shrinkText/autoFit` 只是 belt-and-suspenders——pptxgenjs 发 `<a:normAutofit/>` 无 fontScale，首开（尤其 WPS）不保证预缩 | visual+integrity（根因） | 高 / L |
| **R1** 每页只画 1 图 | 收集全部图（`pptx.ts:107-111`），但封面/内容页都只画 `[0]`（`153-154/214`） | 多图页静默丢图 | `length>1` 时右栏 2-up/2×2 网格或续页，尊重 textW 分栏（`pptx.ts:176-178`） | visual（根因） | 中 / M |
| **R2** 无大数字原语 | `SlidePage` 无 stat 字段（`pptx.ts:24-35`）；正文 15-16px；`plain()` 还会剥掉 `**`（`48-54`） | 自查「56px 大数字」纯属表演（全文无 56px） | 解析约定 `> 268亿 :: 市场规模` → `page.stats`，渲染最多 3 张 roundRect 数字卡（40-54px bold accent） | visual+content（根因） | 高 / M |
| **R5** 自查与渲染脱钩 | 自查表由模型自由文本写，无 renderer 回读；「全局 CSS 色变量」是**类别错误**（CSS 只属 html kind `registry.ts:225`，pptx 无 CSS） | 绿勾盖了 .pptx 结构上装不下的特性 | slidesToPptx 返回 manifest（表格数/数字卡/置入vs丢弃图/带备注页/续页），喂进 deliver 步；自查只许声明 renderer 真产出的属性 | integrity（根因，含 R-notes） | 中 / M |
| **R6** 备注无契约 | 仅 `<!-- note -->` 才有备注（`pptx.ts:74-80,140`）；`validateDocContent` slides 分支（`engine.ts:106-112`）不查备注 | 「每页讲者备注」可绿但实际为空 | 优先**清单化**（manifest 报 pagesWithNotes/total）而非硬拒；可作软警告 | integrity（缓解） | 中 / S |

**内容 vs 视觉**：R2 跨两者（数字既是内容也是视觉呈现）；R3/R4/R1 纯视觉；R5/R6 是 integrity（声称 vs 实产）。
**TEAM vs SOLO**：渲染器两模式共用，无差异。

---

### 3.3 模板 / CJK / 视觉系统

**当前状态**
- 只有 **1 个** skill 模板 `html-deck-horizontal`（`registry.ts:264-272`），仅被「演示设计与防溢出法」技能引用（`seed.ts:127`）。
- **致命**：该模板的翻页全靠内联 `<script>`（`registry.ts:250-260`），而预览 iframe 是 `sandbox=""`（`DocsView.tsx:355-360`，注释 `353-354` 明确"内联 script 不运行"）。`.slide` 默认 `opacity:0;position:absolute;inset:0`（`registry.ts:230`），`.active` 由 JS 加（`registry.ts:256`）。**脚本关闭 → 没有任何 slide 拿到 `.active` → 预览是一块全空 16:9 舞台**（verdict 校正：不是"只显首页"，是全空）。旗舰视觉模板在**用户唯一查看处不可用**。
- **CJK 字体栈不一致**：模板用 macOS-only 的 `"PingFang SC","Helvetica Neue",Arial`（`registry.ts:227`），而 app 自身 UI 已用正确跨平台栈（`index.css:41`：`-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif`）。Windows/Linux 中文回退到泛 sans-serif → 豆腐块/错位。
- **正面**：模板确实通过 `validateDocContent`（内联 script 无 src、无 `on*=`、无 `javascript:`，`engine.ts:98-103`）；L3 `tpl:` 注入机制（`engine.ts` 的 readSkill 路径）健全；`scripts/regression.mjs:288-292`（TPL1）**已断言**所有 SKILL_TEMPLATES 通过 html 校验。
- **verdict 校正**：原 review 引用的外部 `STYLE_PRESETS.md`/`shared-standards.md`/「32 个 Google Fonts 文件」**在本仓库不存在**（`grep` 全仓零命中 `fonts.googleapis.com`）——那些是外部 skill 插件，不影响核心诊断（核心仅靠 `registry.ts:227` vs `index.css:41`，均已核实）。

**提案**
- **T2/T3（根因，XS–S）**：抽一个**共享 CJK 系统字体栈常量**，三处共用——HTML deck 模板 `registry.ts:227`、pptx `THEME.font`、（可选）seed 指引。直接复用 `index.css:41` 的栈。纯系统字体、无 @font-face、大陆安全。verdict 的「missed」点：当前 deck 主题（暗 `--bg:#0f1115`）与 pptx 主题（浅 `bg:F3F1EB`）**是两套不相干配色**，用户预览 html 再导出会看到两种观感——根本修法是**抽一份共享 theme/字体 token**（颜色 token + CJK 栈），让 R3/T2/T3/新模板从「逐处改」变「改一次」，并给 TPL1 一个一致性可断言对象。
- **T1（根因，M）**：模板改为「脚本关闭也可读」——`.slide` 默认可见（scroll-snap 垂直栈：容器 `scroll-snap-type:y mandatory;overflow:auto`，每片 `scroll-snap-align:start;height:100%`），内联 `<script>`（仅下载文件里运行）再**渐进增强**为横向 ←/→ 翻页。所有 CSS 仍内联 → 仍过 validateDocContent。**比改 `sandbox="allow-scripts"` 更稳**（后者会让模型生成的 JS 在 null 源执行，是真实 posture 变化）。需在 `scripts/regression.mjs` 补一条「脚本关闭可渲染」启发式断言（TPL1 已覆盖 validateDocContent，这是其唯一缺口）。
- **T4（根因，L）**：再补 2 个 CJK-first、约束合规的模板（浅色杂志风 / 大胆撞色风），让「设计风格探索法」（`seed.ts:191-196`）的「2-3 套风格」承诺有底座。每个须过 validateDocContent + 脚本关闭可渲染；wiring 进技能 `resources_json` 的 `tpl:` 需 **bump BUILTIN_SKILL_PACK_VERSION**（仅加模板到 registry 不需要，连进技能才需要）。

**TEAM vs SOLO**：模板/字体两模式共用，无差异。

---

### 3.4 内容质量与接地（anti-generic / anti-fabrication）

**当前状态（接地从未被结构性强制，全靠模型自觉）**
- **C1 检索证据被剥离**：`!official`（国内 DeepSeek/Zhipu 走 base_url → `official=false`，`engine.ts:191`）时 `echoContent`（`engine.ts:1462-1467`）只保留 text/tool_use/thinking，**服务端 web_search 结果块被丢弃**，跨轮（搜索→确认大纲→成稿）后成稿轮的 `messages` 里已无检索原文——这正是「搜完就编」的机理。
- **C2 无 cite-or-omit 门**：`validateDocContent`（`engine.ts:90-128`）只查格式（XSS/分页/CSV 列），report 路径非空即过（`engine.ts:92,127`）；`write_document`（`engine.ts:1206-1227`）只调 validate 就存。**无源数字与全引用文档走同一条绿色通道**。
- **C3 verifier 对来源结构性失明**：`runVerification` 提示只含 rubric+交付物文本（`engine.ts:646-666`，刻意"不带频道闲聊"），工具只有 submit_verdict + read_document（`engine.ts:668-682`），**从不拿到 source_doc_ids / 检索结果 / 反编造标准**——即便走最强模型（preferStrong `engine.ts:686`）也只能判内部一致性，**无法判 268亿 是否真**。
- **C4/C5 默认路径无接地脚手架**：grounding 全套（`sourceSection` `engine.ts:552-555`、polish 块 `engine.ts:569-571`）只在 `source_doc_ids` 非空时触发；「做个 X 的 PPT」这类从主题生成 `polishMode=false`（`engine.ts:551`），脚手架全跳过；简报第 2 步（`engine.ts:579`）把 read_document 框成"省检索"而非"接地优先"。
- **C6 国内通道被引向"结果会被丢弃"的搜索路径**：MCP 检索结果以 `role:user` tool_result 回灌（`engine.ts:1607-1609`），**不被 echoContent 过滤、全通道留存可引用**；但简报仍叫 agent 先用 web_search（`engine.ts:579`），国内通道走 webToolsStage 降档（`engine.ts:155-171`）可能啥也搜不到。「国产联网检索能力」技能（`seed.ts:251-256`）已记载 web-search-prime 为主路径，但默认 enabled=false。

**verdict 的关键「missed」**：返工循环 `buildReworkBrief`（`engine.ts:591-606`）**同样无接地、且会洗白编造**——它只注入验收标准+反馈+上一版指针，**不注入 source_doc_ids、不重跑接地脚手架**，国内通道首轮检索结果也早没了；模型可用「编一个看似真的引用串」满足"补来源"意见（C2 启发式只查"有无来源标记"，假的 `[来源:艾瑞2024]` 照过），叠加 `MAX_REVISIONS=1`（`engine.ts:50`）→ **只有一次接地机会，且返工路径比首轮更弱**。

**提案（按"内容质量"透镜，区分 team/solo）**
- **C2（缓解，S，both）**：`validateDocContent` 加无源数字软门（report/slides；html/sheet 豁免或放宽）：正则扫 `亿/万/%/倍/元/×` 等量化，≥N 处且零来源标记（无 `http(s)://`、无 `[来源`/`据…`）→ 退回自纠（复用 `engine.ts:1211-1213` 的格式退回 UX）。接受显式「示意值/待核实」标记作为豁免。**仅证明"有标注"而非"为真"**——故必须配 C3/C6。**须加回归测试**（regression.mjs 仿 DOC-HTML 模式）。
- **C3（根因，S，TEAM）**：verifier 提示恒挂一条标准——「核验所有量化主张是否有来源；无源且非显式示意值的关键数字 → revise，逐条点名」；有 source_doc_ids 时把来源注入（read_document 已在 verifier 工具集，提示叫它按 id 拉即可，是最省 token 的变体）。**仅 team 有效**——solo/DM 无 verifier（`engine.ts:628-629`），solo 靠 C2 写时门兜底。
- **C6（根因，S，both）**：`!official` 且配了 MCP 检索（web-search-prime/bocha）时，简报/动态上下文显式指示 agent **以 MCP 检索为主路径**（结果可留存可引用）；可在配了 MCP 检索的部署上**运行时注入**「国产联网检索能力」技能正文（**不要翻 seeded enabled 开关**——upsert 会保留用户开关，翻不动）。这是国内部署最可靠的接地修法，绕开 echoContent 剥离。
- **C1（根因，M，both）**：`!official` 时不静默丢弃，而是把每条结果 text+URL 序列化成 `role:user` 文本块（如 `[检索结果摘录 — 引用须注明此处来源]`，每条 ≤1500 字）重注入，使证据持久可引。注意别以服务端块格式回灌（防 400「thinking must be passed back」）。
- **C7（根因，S，both）——补 verdict missed**：硬化 `buildReworkBrief`（`engine.ts:591-606`）：返工时**重注入 source_doc_ids/sourceSection** + 一句「引用须可核验、禁止编造来源串」，否则返工沦为编造洗白步。
- **C4/C5（缓解，XS–S，both）**：简报接地措辞从软变硬（「找不到来源就写『示意值，待核实』，宁少给数字不给假数字」）；加「开工前先扫文档库、有则 read_document 复用」一行。纯提示，强模型遵从、弱端点部分遵从——配 C2 写时门兜底。

**内容 vs 视觉**：本节全是**内容质量**透镜。**TEAM vs SOLO 的分叉点**：C3 仅 team（verifier 在 team 才跑）；solo 的接地下限完全压在 C2 写时门 + C1/C6 证据留存上。

---

### 3.5 验收 / 自查 integrity

**当前状态（"全绿自查 + 不可用交付"是结构性必然）**
- **V1 SOLO/DM 整段免检（fail-open）**：DM 单 agent（`routes.ts:166` `createChannel(name,[agent.id],"dm",agent.id)`），`runVerification` 在 `engine.ts:629` `others.length===0 → pass`，工作循环 `engine.ts:507-510` 直接 break。**截图 PPT 助手几乎必走此路 → 那张全绿表零校验。**
- **V2 verifier 只看 Markdown 源、从不看渲染产物**：提示嵌 `doc.content.slice(0,16000)`（`engine.ts:657-658`），engine 只 import `parseSlides`（`engine.ts:44`）**从不调 slidesToPptx**（`grep` 确认仅 routes.ts:517 调）；`onTaskDelivered`（`engine.ts:454-463`）只解锁依赖，无可达性检查。一份打不开/错排的 deck 能过验收。
- **V3 verifier 选择脆弱**：`name.includes("评审") ?? created_by ?? others[0]`（`engine.ts:630-633`）——靠中文人名子串，无人叫"评审"就回退到任务创建者或任意 others[0]（可能是 SEO 优化师验 PPT），英文/改名直接失配。
- **V4 自查表自产自销**：简报叫**产出同一次对话**附自查表（`engine.ts:582`），「交付自查清单」技能强化（`seed.ts:77-81`），但它无净上下文/独立/fail-closed 保证，用户分不清"自称绿"与"已验绿"。
- **verdict 的「missed」（V6）**：返工耗尽仍交付——`MAX_REVISIONS` 用完后循环 `engine.ts:495-514` 落出，**最后裁决仍是 revise（从未 pass）**，但 runTaskWork 继续置 review/done 并 `onTaskDelivered`。这是**有别于 V1 的第二条 fail-open**：验收跑了、轮轮 revise、仍照发，且无"未通过 N 轮"标记。

**提案**
- **V1（根因，S，SOLO）**：把 `others.length===0 → pass` 改为**强制自校验**——同一 worker 作 verifier、`newCtx kind="verify"`（净上下文，`engine.ts:684`）、rubric-only 提示、`preferStrong=true`、保留 NO_VERDICT_FALLBACK fail-closed（`engine.ts:613-616`）。同模型自审弱于独立 verifier 但**严格优于当前无条件 pass**；仅 `isMock()` 跳过（`engine.ts:626`）。**这是 integrity 单点最高杠杆。**
- **V2（根因，M，both）**：kind=slides 时在验收内 `const pages=parseSlides(doc.content)`（已 import，零额外渲染开销可得页数/带备注页/表格/图数），并可选 `await slidesToPptx(doc)` try/catch；把**机器算出的事实块**注入 verifier（实渲页数、抛错与否），裁决纳入考量——**直接抓住截图里 13→11 的静默丢页**（声称11 vs 实渲N 不符→revise）。html/sheet 在验收内复跑 validateDocContent。
- **V6（根因，S，team）——补 verdict missed**：终交付/状态须**门控在真 pass**（或显式标注「N 轮未过仍交付」给用户），堵住"耗尽返工照发"。
- **V3（根因，S，team）**：verifier 选择去人名化——「评审」降为软偏好，按"最强可用 reviewer"选，team 永不自评（已排除），solo 用 V1 显式自审。
- **V5/R5（缓解，M，both）**：自查表与渲染脱钩——slidesToPptx 返 manifest 喂 deliver 步，自查只许声明 renderer 真产出的属性（页数/`<!-- note -->`备注/表格/嵌图），**显式禁** font px / CSS 变量（Marp→pptx 会丢）。**须 bump 技能版本**（改「交付自查清单」时）。

**内容 vs 视觉**：V1/V3/V6 是 integrity；V2/V5 跨 integrity+visual（让"能否打开/排版"成为被检前置）。
**TEAM vs SOLO 分叉**：V1 是 solo 专属补丁（team 本就有 verifier）；V3/V6 是 team；V2/V5 两模式共用。

---

### 3.6 Team-vs-solo 动态与交付 UX

**当前状态**
- **U-发现**：终稿（synthesis）完成只发纯文本审计串、无链接——`runSynthesis` 算出 `summaryDocId`（`engine.ts:779`）、存（`780-781`）、`audit()` 发一行字（`782`，`audit` 只插系统文本消息 `engine.ts:1353-1356`，无文档引用）。
- **verdict 校正**：摘要**并非聊天里完全不可见**——ChannelView 右栏 `ChannelPanel`（`ChannelView.tsx:13-70`）渲染可点的「交付物」列表（`56-68`，`onOpenDoc→DocViewerModal`），含项目摘要（同 channel_id），只是未高亮、`slice(0,10)` 截断。故 U2 从「聊天里无可点面」降为「消息流里无内联高亮」，严重度下调。
- **verdict 的真正高价值 missed（U1）**：**根本没有 message→document 链接原语**——`db.ts` 的 Message 接口无 `doc_id` 列，`MessageItem.tsx:81-82` 只把 content 当纯 ReactMarkdown 渲染、零文档卡。原 review 两处都假设"复用已有 Message.doc_id 机制"——**该机制不存在**，是净新基建（DB 列 + addColumnIfMissing 迁移 + insertMessage 签名 + broadcast payload + MessageItem 渲染分支）。

**提案**
- **U1（根因，M，both）——补 verdict missed**：建 message→document 链接原语（Message 加 `doc_id` 列 + MessageItem 渲染**可点文档卡**，须走现有 `onOpenDoc` handler 而非 raw HTML，保 XSS 安全）。这是 U2、聊天内 pptx/交付卡、之前那批"交付链接"findings 的**共享前置**——单建一次解锁全部。
- **U2（根因，M，team，依赖 U1）**：synthesis 完成消息挂 `summaryDocId` 渲染为「打开终稿」卡。U1 建好后即小改。
- D-交付认知部分已并入 §3.1（D1/D2/D5）。

**内容 vs 视觉**：U1/U2 纯 ux。**TEAM vs SOLO**：U2 是 team 专属价值（synthesis 仅 team）；U1 基建两模式共用。

---

## 4. 内容质量 vs 视觉质量：一张速查

| 透镜 | 根因级修复 | 概率性缓解 | TEAM/SOLO 差异 |
|------|-----------|-----------|----------------|
| **内容质量** | C1 证据留存、C3 verifier 反编造、C6 MCP 检索、C7 返工接地 | C2 无源数字门、C4/C5 简报接地措辞 | C3 仅 team；solo 靠 C2 写时门兜底 |
| **视觉质量** | R3 CJK 字体、R4 溢出续页、R1 多图、R2 数字卡、T1 脚本关闭可读模板、T2/T3 统一字体栈 | — | 渲染器/模板两模式共用，无差异 |
| **integrity** | V1 solo 自校验、V2 验渲染、V3 去人名化、V6 返工门控、D2/D5 交付认知 | D1 红线、V5/R5 manifest 脱钩 | V1 solo 专属；V3/V6 team；D1/D2/D5/V2 共用 |
| **ux** | U1 链接原语、U2 终稿卡 | — | U2 team 专属 |

---

## 5. 如果这周只做 3 件事

1. **D1 + D2（XS+S，both，消灭"导出不可用"）**：在 `SHARED_RULES`（`seed.ts:3-18`）加「交付与导出红线」+ 改 `write_document` slides 描述（`engine.ts:1033`）注明"内置一键 ⬇ .pptx 无需 MCP"。这两条是**唯一覆盖私聊路径**的修法，直接根除截图那句臆造阻塞 + 甩 CLI 的最尬瞬间。无需 bump 版本、无新服务。
2. **V1（S，SOLO，给独立模式装上验收下限）**：把 `engine.ts:629` 的 `others.length===0 → pass` 换成同模型净上下文自校验（fail-closed）。这是 integrity 单点最高杠杆——截图那张全绿表此前**零校验**。
3. **R3 + T2/T3（XS–S，both，让中文 PPT 真能看）**：给 pptx `THEME` 加 `font:"Microsoft YaHei"` 并在每处 addText/addTable 传 `fontFace`（`pptx.ts:147/151/161/167/172/199/204/208/218`），同时把 HTML deck 模板字体栈（`registry.ts:227`）对齐 `index.css:41` 的跨平台 CJK 栈。逐 run 加 fontFace 即完整根因修复（会同时写 `<a:ea>`），符合共用大陆 VPS 约束。

> 紧随其后（次周）：D5（改写误导技能，须 bump `BUILTIN_SKILL_PACK_VERSION` 4→5）、C2（无源数字门 + 回归测试）、C6（国内通道走 MCP 检索）、V2（验收看渲染清单、抓静默丢页）。
> **需配回归测试（`scripts/regression.mjs`）的项**：C2（无源数字门）、T1（脚本关闭可渲染——TPL1 已覆盖 validateDocContent，仅缺此子检查）。
> **需 bump `BUILTIN_SKILL_PACK_VERSION`（`seed.ts:54`）的项**：D5、R2、T4、V5（凡改 BUILTIN_SKILLS 正文/resources）。

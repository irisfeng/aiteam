import { createAgent, createChannel, createSkill, insertMessage, listAgents, listChannels, listSkills, upsertBuiltinSkill, type SkillInput } from "./db.js";

export const SHARED_RULES = `
你在一个名为 AITeam 的团队工作台中作为 AI 同事工作，与人类用户和其他 AI 同事在频道里协作。

工作守则：
- 用中文回复（除非对方使用其他语言）；输出使用 Markdown，结构清晰，像一份认真的工作产出。
- 你可以用 @名字 提及其他 AI 同事请他们接力（例如 @工程师），对方会看到并回复；只在确有必要时使用。
- 落实到行动：单个待办用 create_task 开票；需要多人分工协作的目标用 start_project 一次性拆解为带依赖关系的任务计划（依赖图自动调度、全部交付后你会被唤起做最终汇总）。任务指派给 AI 同事后对方会自动开工，所以务必写清背景与逐条可核验的验收标准——交付物将按验收标准逐条核验，不达标会被退回返工。
- 自主度：用户明确要求"先看计划/把关"或项目重大、成本高时，start_project 用 autonomy=approve_plan（计划先送用户批准）；用户要求全自主时用 auto。执行过程中用户随时可能在频道里插话，新指示会注入你的工作循环，要立即纳入考虑。
- 需要事实、数据或最新外部信息时，用 web_search / web_fetch 真实调研，不要凭空编造。
- 正式产出（报告、PRD、方案、评估）用 write_document 写入文档库，而不是只散落在聊天里；已有文档可用 read_document 查阅。
- 产出质量：正式交付物一律结论先行（开头先给核心结论 / TL;DR），要点遵循 MECE（相互独立、完全穷尽），关键事实与数据注明来源和检索日期；交付时附「自查表」——把验收标准逐条列出并标注满足 / 不满足及证据位置。
- 高风险或对外的动作（发邮件、对外发布、部署、花钱）不要直接宣称完成，必须用 request_approval 请求用户审批；关单（done）只能由人类操作。
- 值得长期记住的结论（用户偏好、项目背景、关键决策）用 save_memory 记录。
- 分工纪律：一个交付物只指派一位负责人，绝不让多人做同质任务；create_task/start_project 开票后任务系统会自动通知负责人开工，**不要再在聊天里 @ 同事重复布置**（会引发重复劳动）；看到别人已在做的事不要抢着做，需要补充就引用对方任务提建议。
- 检索节俭：联网与插件检索按次计费。检索前先想清要查什么、合并关键词；能从频道上下文或文档库（read_document）获得的信息不要重复检索。**若启用了多个搜索插件（如智谱/博查/tavily），它们能力重叠——同一问题选其中一个查即可，绝不要对同一查询换不同搜索插件重复检索（既浪费也会被去重机制拦回上次结果）；需要更多信息时请换不同的查询角度，而不是换引擎重查同一句。**
- 实事求是：不知道就说不知道，不要编造数据。`;

const BUILTIN_AGENTS = [
  {
    name: "产品经理",
    emoji: "🧭",
    role: "产品规划与需求拆解",
    system_prompt: `你是「产品经理」，团队的产品负责人。擅长：需求澄清与拆解、可行性评估、撰写 PRD、排定优先级。回复风格：先给结论，再给结构化分析；善用表格对比方案；主动把共识沉淀为任务。${SHARED_RULES}`,
  },
  {
    name: "工程师",
    emoji: "🛠️",
    role: "方案设计与技术实现",
    system_prompt: `你是「工程师」，团队的全栈工程师。擅长：技术方案设计、架构权衡、给出可执行的实现步骤与代码示例。回复风格：务实、给出明确的技术选型理由与风险点；代码示例完整可运行。${SHARED_RULES}`,
  },
  {
    name: "代码评审",
    emoji: "🔍",
    role: "代码审查与质量把关",
    system_prompt: `你是「代码评审」，团队的资深评审。擅长：发现正确性问题、边界条件、安全隐患与可维护性问题。回复风格：逐条列出发现，标注严重级别（阻断/建议/吹毛求疵），并给出修改建议。${SHARED_RULES}`,
  },
  {
    name: "SEO 优化师",
    emoji: "📈",
    role: "增长与内容优化",
    system_prompt: `你是「SEO 优化师」，团队的增长专家。擅长：关键词策略、内容结构优化、落地页转化建议、竞品分析。回复风格：数据导向，给出可执行的清单与优先级。${SHARED_RULES}`,
  },
];

/**
 * 内置技能库（混合 method/capability + 渐进式披露）。版本以 BUILTIN_SKILL_PACK_VERSION 为准。
 * 每条仅把 name/desc/when_to_use/trigger 作为 L1 索引常驻，正文 body 由 read_skill 按需拉取。
 * 全部 enabled=false 出厂，admin 在「设置 → 技能」按需开启。
 * 第三方方法学均为蒸馏改写（非原文照搬），来源与许可见 THIRD_PARTY_NOTICES/。
 * 扩库或改正文时整体把 BUILTIN_SKILL_PACK_VERSION +1，并把对应条目 version 设为该值。
 */
export const BUILTIN_SKILL_PACK_VERSION = 7;
const V = BUILTIN_SKILL_PACK_VERSION;

type BuiltinSkill = Required<Pick<SkillInput, "name" | "desc" | "trigger" | "when_to_use" | "body" | "kind" | "version">> &
  Pick<SkillInput, "resources_json">;

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  // ── 通用方法（v1 升级：补 trigger/when_to_use，正文沉入 body）──
  {
    name: "金字塔写作法", kind: "method", version: V,
    desc: "结论先行、以上统下、归类分组、逻辑递进",
    trigger: "写,撰写,报告,文案,方案,prd,文章,稿,总结,演示,slides,ppt,汇报,白皮书,长文",
    when_to_use: "写报告/PRD/方案/文案/长文等任何写作类交付时",
    body: "写作类交付遵循金字塔原理：1) 结论先行——第一段给出核心答案/主张；2) 以上统下——每层论点统领下层论据，段首句即该段主旨；3) 归类分组——并列要点遵循 MECE（相互独立、完全穷尽），3±2 个为宜；4) 逻辑递进——按时间/结构/重要性其一排序，不混用；5) 收尾给行动建议而非总结复述。",
  },
  {
    name: "深度调研法", kind: "method", version: V,
    desc: "多源交叉验证、区分事实与推断、全程标注来源",
    trigger: "调研,检索,搜索,搜一下,资料,来源,事实,核实,竞品,市场,行业,最新,对比,数据",
    when_to_use: "需要事实/数据/最新外部信息、做竞品或行业研究时",
    body: "调研类工作遵循：1) 同一问题至少换 3 组关键词检索，优先一手来源（官方文档/论文/财报）；2) 关键事实需两个独立来源交叉验证，矛盾时同时记录两种说法；3) 明确区分【事实】【推断】【传闻】并标注；4) 每个结论附来源链接或出处；5) 注明检索时间，时效敏感的数据标注采集日期。",
  },
  {
    name: "交付自查清单", kind: "method", version: V,
    desc: "交付前按验收标准逐条自查，附自查结果",
    trigger: "交付,验收,自查,提交,checklist,自查表",
    when_to_use: "任何正式交付物提交前",
    body: "任何交付物提交前完成自查：1) 逐条对照任务的验收标准，在交付摘要中附「自查表」（标准→是否满足→证据位置）；2) 数字一致性——同一指标在全文中数值一致；3) 完整性——没有「待补充」「TODO」残留；4) 可用性——读者无需追问即可直接使用；5) 自查发现的未解决项明确列出，不隐瞒。",
  },
  {
    name: "结构化头脑风暴", kind: "method", version: V,
    desc: "先发散后收敛：多视角生成、去重归类、按价值排序",
    trigger: "创意,头脑风暴,脑暴,构思,选型,策划,点子,发散,方案",
    when_to_use: "创意/方案/选型类工作需要先发散后收敛时",
    body: "创意/方案类工作先发散后收敛：1) 发散阶段从至少 4 个视角生成想法（用户视角/竞品视角/技术视角/成本视角），不做评判；2) 每个视角至少 5 个想法，鼓励极端选项（最贵的做法/最便宜的做法）；3) 收敛阶段去重归类，按「价值×可行性」二维排序；4) 输出 Top3 推荐 + 完整清单附录，说明取舍理由。",
  },

  // ── 办公/文档产出 ──
  {
    name: "文档结构化排版法", kind: "method", version: V,
    desc: "只调呈现不改内容：标题层级/加粗/列表/表格让读者 3 秒抓重点（蒸馏 baoyu-format-markdown, MIT）",
    trigger: "排版,格式化,美化,层级,markdown,文档优化,可读性",
    when_to_use: "Markdown/文案缺标题/加粗/列表/表格层级、难以扫读时",
    body: "结论先行：好排版=读者 3 秒抓重点，只调呈现不改内容。1) 读者视角通读，标出金句/核心结论/可并列项/可表格化数据；2) 加粗仅给关键结论与核心要点，不滥用；3) 转折/分段处插 ## / ###；4) 平行项→列表，对比或结构化数据→表格；5) 命令/路径/术语用行内代码；6) 金句/警告用引用块；7) CJK 与英文/数字间留空格。禁：改写原意、堆砌加粗。产出走 write_document(report)。（蒸馏自 baoyu-format-markdown，见 THIRD_PARTY_NOTICES/baoyu-skills.txt）",
  },
  {
    name: "Diataxis 文档生成法", kind: "method", version: V,
    desc: "按 tutorial/how-to/reference/explanation 四象限分流写系统化文档（蒸馏 Hermes document-generate）",
    trigger: "文档,说明,手册,api文档,使用指南,教程,reference,readme",
    when_to_use: "为代码/功能/模块产出系统化文档时",
    body: "结论先行：按 Diataxis 四象限分流。1) 先「代码考古」读 README/入口/测试/架构再动笔；2) 分象限：新用户功能→tutorial+how-to+reference，内部模块→reference+explanation，配置项→how-to+reference；3) reference 完整且可溯源到代码；4) explanation 讲「为什么这样设计」；5) 本工作台无代码执行沙箱，代码示例须标注「未实跑」而非声称已运行。产出走 write_document(report)。（蒸馏自 Hermes/gstack document-generate 的 CC0 SKILL.md 部分）",
  },
  {
    name: "翻译三档法", kind: "method", version: V,
    desc: "按质量需求选快速/常规/精品三档，长文先统一术语（蒸馏 baoyu-translate, MIT）",
    trigger: "翻译,精翻,本地化,改成中文,改成英文,translate,润色",
    when_to_use: "文档在中英等语言之间翻译时",
    body: "结论先行：按质量需求选档，长文先统一术语。1) 快速档=直译；2) 常规档(默认)=分析→翻译→存稿，长文(≥4000字)先抽术语表再分块译；3) 精品档=分析→初稿→批评式评审→修订→润色；4) 术语优先级：内联指定>外部术语表>常识；5) 保留源文 frontmatter，发现源语言文字图时提醒用户。产出走 write_document(report)。（蒸馏自 baoyu-translate）",
  },

  // ── 数据可视化 / 设计 / 多媒体 ──
  {
    name: "SVG 图表生成法", kind: "method", version: V,
    desc: "先定图类型再画：简单图出 Mermaid、复杂图写响应式 SVG（蒸馏 baoyu-diagram + Hermes diagram）",
    trigger: "架构图,流程图,示意图,svg,图表,时序图,思维导图,diagram,mermaid",
    when_to_use: "需要可视化系统架构/流程/数据关系/时序时",
    body: "结论先行：先定图类型再动手。1) 选型：架构图(组件边界+数据流)/流程图(决策菱形)/时序图/思维导图/状态机；2) 简单图输出 Mermaid 代码块嵌入 write_document(report)（前端 react-markdown 渲染），复杂图直接写 SVG（响应式 viewBox，不写死像素）；3) SVG 设计系统：深色底+网格、语义化配色、组件名 11px 加粗/标签 9px、中文字距加宽；4) z 序：defs→背景→边界→连线→遮罩→组件框→图例。（蒸馏自 baoyu-diagram 与 Hermes diagram 的 CC0 部分）",
  },
  {
    name: "演示设计与防溢出法", kind: "method", version: V,
    desc: "先定『讲者驱动 vs 读物优先』再控密度与节奏，单页防溢出（蒸馏 frontend-slides, MIT）",
    trigger: "ppt,演示,幻灯片,slides,presentation,演讲稿,路演,deck",
    when_to_use: "制作演示/幻灯片，需要确定信息密度与节奏时",
    resources_json: JSON.stringify(["tpl:html-deck-horizontal"]),
    body: "结论先行：先问『讲者驱动 vs 读物优先』再定密度，并善用 slides(Marp→内置 pptx) 的结构化原语（slides 正文用纯 Markdown，禁原始 HTML——HTML 只属 html 交付物）。1) 讲者驱动：每页 1-2 个观点、≤3 要点、宁可多分页；读物优先：4-6 个信息单元、每页自包含。2) **大数字用数字卡**：把关键指标写成单独成行的 `值 :: 标签`（如 `268亿元 :: 市场规模`、`↓80% :: 人力成本`），连续多行会自动渲成一排数字卡（最多 4 个），比埋进正文有力得多——方案/路演页标配。3) **章节幕页**：只含一个 `# 标题`（无其它内容）的页渲成章节分隔页，用于分段。4) **对比/选型用 Markdown 表格**（渲成原生可编辑 pptx 表格，不要压成要点）。5) 讲者备注写 `<!-- note: … -->`。6) 防溢出：渲染器已按高度预算自动分续页（标题带『（续）』）并均衡分配，但仍要主动控密度、别硬塞。7) 关键数字无可靠来源就写『示意值，待核实』，绝不编造。8) HTML 网页 deck 锁 16:9、可套本技能附带模板。落点：对外演示首选 slides（用户在文档面板一键 ⬇ .pptx，可编辑、无需 MCP）；纯网页交互才用 html。（蒸馏自 frontend-slides / guizang-ppt）",
  },
  {
    name: "反 AI-slop 设计审美守则", kind: "method", version: V,
    desc: "每个产出像『专为此 brief 设计』，禁通用模板与默认紫蓝（蒸馏 design-taste / frontend-slides, MIT）",
    trigger: "设计,审美,排版,配色,字体,网页,landing,ui,封面,品味",
    when_to_use: "产出任何视觉交付（网页/PPT/封面/信息图）之前",
    body: "结论先行：每个产出都要像『专为此 brief 设计』，禁默认模板感。1) 字体：禁 Inter/Roboto/Arial/系统字直接当标题，选与气质匹配的特色字；2) 配色：禁默认紫蓝(#6366f1)、禁平均分布，强制『主色承诺』或一条故事色线；3) 布局：按内容选 editorial grid / split panel / card cascade，而非千篇一律居中卡片；4) 装饰：几何抽象/渐变/纹理点到为止，禁过度玻璃态；5) 全篇字体/色板/圆角统一。这是所有 design 类产出的前置守则。（蒸馏自 Leonxlnx/taste-skill 与 frontend-slides）",
  },
  {
    name: "信息图/封面/配图生成法", kind: "method", version: V,
    desc: "先选 layout×style 再用 generate_image 生成，图服务于内容做图文混排（蒸馏 baoyu-infographic/cover/illustrator）",
    trigger: "信息图,封面,配图,插图,infographic,可视化大图,图文,小红书,公众号配图",
    when_to_use: "报告/网页/文章需要配图、信息图、封面或图文混排时",
    body: "结论先行：先选 layout×style 再生成，图服务于内容、不是装饰。1) 信息图：从内容抽 layout（时间线/对比/流程/金字塔…）×视觉 style，先给推荐组合再调 generate_image；2) 封面：按 type×palette×rendering×mood 选，尺寸 cinematic(2.35:1)/widescreen(16:9)/square(1:1)；3) 文章配图：分析结构定位需配图处，Type×Style 两维生成；4) 把返回的 Markdown 图片行原样嵌入 write_document(report) 或 html 交付物做图文混排（图存 /aiteam/assets）；5) 遵守『反 AI-slop 设计审美守则』；6) 受 AITEAM_IMAGES_PER_RUN 限，一个任务 1-2 张点睛即可。底座 generate_image(Seedream) 已就位。（蒸馏自 baoyu-infographic/cover-image/article-illustrator）",
  },

  // ── 代码 MVP（诚实标注：本工作台无代码执行沙箱）──
  {
    name: "可验证规格法", kind: "method", version: V,
    desc: "动手前把要交付的行为写成可验证用例，测行为不测实现（蒸馏 superpowers TDD + mattpocock, MIT）",
    trigger: "开发,编码,实现,功能,代码,测试,tdd,接口,需求",
    when_to_use: "写新功能或修 bug 前，先确定行为与验收口径时",
    body: "结论先行：动手前把『要交付的行为』写成可验证用例，测行为不测实现。1) 列行为清单按价值排序，与人确认公开接口；2) 对每个行为先用 write_document 写『测试用例：输入→预期可观察输出』，只针对公开接口（抗重构）；3) 写满足用例的最小实现，YAGNI；4) 覆盖后重构去重；5) 用例清单作为 submit_verdict 的 fail-closed 依据，声称『满足』须逐条对照。注意：本工作台无沙箱，禁声称『已运行通过』，只能给『按规格应通过』+用例清单；前端代码若交 html 交付物，可在其中内联自测断言(console.assert/可见断言区)并附『手动验收清单』作为人工 QA。（蒸馏自 superpowers test-driven-development 与 mattpocock/skills）",
  },
  {
    name: "假设-证伪调试法", kind: "method", version: V,
    desc: "先追根因再动手：列可证伪假设、验证、写回归用例再修（蒸馏 superpowers systematic-debugging, MIT）",
    trigger: "调试,debug,排查,报错,故障,bug,定位,异常,崩溃",
    when_to_use: "遇到 bug/异常、在提出修复方案之前",
    body: "结论先行：先追根因再动手，禁猜测乱改。1) 把症状写成可判定的判据；2) 列 3-5 个可证伪假设按可能性排序，每个写出『若 X 为因，则改 Y 会让 bug 消失』的预测；3) 指出该看哪段状态/数据流来验证；4) 定位根因后先写回归用例再给修复；5) 同一处 3 次失败→质疑架构假设；6) 复盘『什么能预防此 bug』并 save_memory。禁：无判据乱改、未验证就声称已修。（蒸馏自 superpowers systematic-debugging 与 mattpocock diagnose）",
  },
  {
    name: "PR 审查法", kind: "method", version: V,
    desc: "技术评估而非表演性同意：读完整 diff、分级缺陷、有据 push back（蒸馏 superpowers review, MIT）",
    trigger: "审查,review,代码评审,pr,diff,把关,评审",
    when_to_use: "做代码评审、或接收他人评审意见时",
    body: "结论先行：评审是技术评估，不是表演性同意。作为评审者：1) 读完整 diff 与意图；2) 作用域检测（是否越界改动）；3) 结构审核（SQL/LLM prompt 注入、N+1、死代码、隐藏副作用）；4) 缺陷分级 critical/high/medium/low。接收意见时：1) 读完再反应并复述需求；2) 对照本 codebase 评估；3) 有据可 push back（引用工作代码），无据则照做；4) 逐条单步落实。禁：盲从、未验证就实现。本工作台用 update_task/文档承接评审，不动 submit_verdict（仅人工裁决）。（蒸馏自 superpowers receiving/requesting-code-review 与 Hermes review）",
  },
  {
    name: "设计前置头脑风暴法", kind: "method", version: V,
    desc: "实现前必须有获批设计：需求澄清→方案对比→分段呈现获批（蒸馏 superpowers brainstorming, MIT）",
    trigger: "需求,设计,方案,功能设计,重构,选型,规划,架构",
    when_to_use: "开发新功能或重构前，先澄清需求与方案时",
    body: "结论先行：实现前必须有获批设计，禁跳过直接写代码。1) 需求澄清：开放式问题逐个问（目的/约束/成功标准），一次一问；2) 方案探索：给 2-3 个方案各配 trade-off，推荐最优；3) 分段呈现设计（架构/组件/数据流/错误处理/测试），每段获认可再下一段；4) 落地为 write_document(report) 设计文档；5) 批准后才进入实现。（蒸馏自 superpowers brainstorming）",
  },
  {
    name: "实现计划法", kind: "method", version: V,
    desc: "把 spec 切成 2-5 分钟可独立完成的任务 DAG，落到看板分批推进（蒸馏 superpowers plans, MIT）",
    trigger: "计划,拆解,任务分解,排期,plan,roadmap,里程碑",
    when_to_use: "有 spec/设计，需要拆成可执行任务序列时",
    body: "结论先行：把工作切成 2-5 分钟可独立完成的任务 DAG。1) 每个任务列出涉及文件清单+关键代码片段+验收点；2) 标可并行 / 必串行；3) 排查冗余并合并；4) 落点：用内置 start_project/create_task 把任务落到看板（带依赖），正文走 write_document(report)；5) 按批推进（默认每批 3 个），批间留人工 review。（蒸馏自 superpowers writing/executing-plans）",
  },
  {
    name: "前端工程自查法", kind: "method", version: V,
    desc: "前端 MVP 产出后做性能/包体积/可访问性/React 模式自查（蒸馏 Vercel react-best-practices + addyosmani）",
    trigger: "前端,react,next,性能,可访问性,组件,优化,bundle,a11y",
    when_to_use: "产出前端代码或 html MVP 后，做工程质量自查时",
    body: "结论先行：前端 MVP 产出要附自查维度，别只看『跑起来』。1) 性能：避免不必要 re-render（memo/稳定 key）、数据获取就近、长列表虚拟化；2) 包体积：按需 import、避免巨型依赖、code-split；3) 可访问性：语义标签、alt/aria、键盘可达、对比度；4) React 模式：状态最小化、副作用收敛、受控/非受控一致；5) 交 html 交付物时把以上做成『手动验收清单』内联进文档（本工作台无自动 QA，需人工逐项核对）。（蒸馏自 Vercel react-best-practices 与 addyosmani/agent-skills）",
  },

  // ── P1 扩库：工程与设计高频方法（v3 新增）──
  {
    name: "设计风格探索法", kind: "method", version: V,
    desc: "视觉交付先给 2-3 个差异化风格小样让用户选，再做全量（蒸馏 frontend-slides 三预览流程）",
    trigger: "设计风格,风格探索,多版本,风格选择,landing,首页,视觉方向,改版",
    when_to_use: "做网页/落地页/封面/PPT 等视觉交付，方向尚未敲定时",
    body: "结论先行：视觉交付先给 2-3 个差异化风格小样、让用户选定方向，再做全量，避免一把梭做错方向。1) 从 brief 提炼 3 个差异化方向（如 编辑杂志风 / 极简瑞士风 / 大胆撞色风），各一句调性描述；2) 每个方向用 write_document(html) 出一页可预览小样（可套『演示设计与防溢出法』附带的横向翻页模板）；3) 用 request_approval 或在频道里请用户选定方向后再继续；4) 据选定方向做全量交付；5) 全程遵守『反 AI-slop 设计审美守则』。（蒸馏自 frontend-slides 的多预览选择流程）",
  },
  {
    name: "设计系统咨询法", kind: "method", version: V,
    desc: "产出可落地的 design tokens + 组件规范 + DESIGN.md，而非单页美化（蒸馏 Hermes design-consultation）",
    trigger: "设计系统,design system,设计规范,组件库,品牌,视觉规范,tokens,样式规范",
    when_to_use: "需要为产品建立统一设计语言/规范，而非临时美化单页时",
    body: "结论先行：交付可落地的设计系统，不是把某一页调好看。1) 先定品牌气质 / 目标受众 / 竞品基调；2) 定 design tokens（色板、字阶、间距、圆角、阴影、动效时长）；3) 列组件清单与每个状态（默认 / hover / 聚焦 / 禁用 / 错误 / 加载）；4) 排版网格与响应式断点；5) 沉淀为 DESIGN.md（write_document report），关键组件配 html 示例页可预览。遵守『反 AI-slop 设计审美守则』。（蒸馏自 Hermes/gstack design-consultation 的 CC0 要点）",
  },
  {
    name: "安全审计法", kind: "method", version: V,
    desc: "按 STRIDE 威胁建模 + OWASP Top10 逐项查，给风险等级与修复（蒸馏 Hermes cso，OWASP/STRIDE）",
    trigger: "安全,审计,漏洞,owasp,stride,鉴权,注入,xss,csrf,越权,渗透,风险评估",
    when_to_use: "对代码/系统/功能做安全审查、上线前风险评估时",
    body: "结论先行：按 STRIDE 建模 + OWASP Top10 逐项核，每条给风险等级 + 证据 + 修复。1) 梳理资产与信任边界；2) STRIDE 逐类问（仿冒 / 篡改 / 否认 / 信息泄露 / 拒绝服务 / 提权）；3) OWASP：注入、失效鉴权、敏感数据暴露、失效访问控制、安全配置错误、XSS、不安全反序列化、已知漏洞组件、日志监控不足、SSRF；4) 每条标 严重级别 + 触发条件 + 证据位置 + 修复建议；5) 高危项用 create_task 落到看板。声明：风险提示而非替代专业渗透测试。（蒸馏自 Hermes/gstack cso）",
  },
  {
    name: "规格驱动开发法", kind: "method", version: V,
    desc: "先写可验证规格与接口契约再拆任务，契约先行（蒸馏 github/spec-kit + superpowers）",
    trigger: "规格,spec,需求规格,接口契约,api契约,验收口径,契约先行",
    when_to_use: "把模糊需求转成可落地、可验收的工程规格时",
    body: "结论先行：先写可验证规格再写代码，契约先行。1) 把需求写成『用户故事 + 可观察的验收标准』；2) 定接口契约（输入 / 输出 / 错误码 / 边界）；3) 明确非目标（这次不做什么），防范围蔓延；4) 规格送评审获认可；5) 据规格用 start_project 拆成带依赖的任务。与『设计前置头脑风暴法』衔接：先头脑风暴定方向，再本法定契约。（蒸馏自 github/spec-kit 与 superpowers writing-plans）",
  },
  {
    name: "开发分支收尾法", kind: "method", version: V,
    desc: "合并/提测前过完整检查单：验收逐条、测试构建贴证据、清残留（蒸馏 superpowers finishing-a-development-branch）",
    trigger: "收尾,合并,merge,pr,提测,交付分支,landing,封板,上线前",
    when_to_use: "一段开发完成、准备合并/提测/交付前",
    body: "结论先行：合并前过完整检查单，用证据而非口头声称。1) 全部验收标准逐条核对；2) 测试 / 构建跑通并贴出输出证据（不口头声称『应该没问题』）；3) 清理死代码 / 调试残留 / TODO；4) 文档与变更同步；5) 在 PR 描述里附自查表 + 已知风险 + 回滚方式；6) 关单（done）由人工确认。（蒸馏自 superpowers finishing-a-development-branch 与 verification-before-completion）",
  },
  {
    name: "定向润色/受限改写法", kind: "method", version: V,
    desc: "基于来源文档做有目标、限定范围的润色/改写——grounding 在原文、不发明、不越界、附改动清单（解决『从零生成→泛泛而谈』）",
    trigger: "润色,改写,修订,基于文档,定向修改,受限编辑,polish,在...基础上,按这份,改一下",
    when_to_use: "用户给了来源文档（草稿/需求/材料），要在其基础上做有目标的修改/补全，而非从零写",
    body: "结论先行：grounding 在来源文档，逐段改、不发明、不越界——产出是『修订版』不是『另写一篇』。1) 先通读来源全文（简报里已注入来源，或用 read_document 拉取），识别其结构与既有结论；2) 严格按任务限定的【目标 + 范围】改，范围外段落原样保留，不擅自扩写/删改/替换论点；3) 任何新增事实/数据必须来自来源文档、或显式调研并标来源，禁凭空补全；4) 交付物开头给『改动清单』：逐条 [改了哪段] → [怎么改] → [依据来源何处/为何]，并单列『刻意未改动』部分；5) 不确定是否越界时，用 request_approval 或在频道里问，不自作主张重写。要点：从零生成的风险是『言之无物』，定向润色把风险转成『越界』——而越界可被验收标准逐条机械检出，质量更可控。",
  },

  {
    name: "解决方案/售前方案法", kind: "method", version: V,
    desc: "把需求做成可落地、可信、能讲的解决方案：结构(痛点→方案→架构→选型→ROI→实施→案例→CTA) + 数字接地 + 配套可导出演示",
    trigger: "解决方案,方案,售前,提案,投标,标书,客户方案,技术方案,介绍ppt,产品介绍,商业计划,商业方案",
    when_to_use: "在解决方案频道、或为客户产出整套解决方案/对外介绍演示时",
    resources_json: JSON.stringify(["tpl:html-deck-horizontal"]),
    body: "结论先行：对外解决方案要『结构清、数字实、能直接讲』。1) 叙事主线（金字塔、结论先行）：客户痛点/现状 → 方案概览(一句话价值主张) → 总体架构 → 关键能力 → 选型/对比(表格+推荐理由) → 量化价值/ROI → 实施路线图(分阶段+周期) → 风险与保障 → 标杆案例 → 下一步 CTA。2) 数字接地（最关键）：市场规模/降本/提效/ROI 等关键数字必须有来源（链接/出处/『据 X 报告』）或显式标『示意值，待核实』，绝不编造看似精确的数字——对外假数据最损可信度；动笔前先 read_document 查工作区有无现成材料/调研结论，没有再检索。3) 交付组合：详版用 report；对外讲用 slides——关键指标走 `值 :: 标签` 数字卡、分段用『只含 # 标题』的章节幕页、对比用 Markdown 表格、附讲者备注 `<!-- note: … -->`（内容写注释里）、正文禁原始 HTML；用户在文档面板一键 ⬇ .pptx（可编辑、无需 MCP/命令行，别让用户跑命令行）。4) 选型必给对比表 + 推荐理由 + 取舍说明，不回避约束。5) 交付附自查表，但只声称渲染真能产出的要素。配合『金字塔写作法』『深度调研法』『演示设计与防溢出法』。",
  },

  // ── 能力型技能（capability：指向工具/MCP，read_skill 给用法+降级）──
  {
    name: "文档解析能力", kind: "capability", version: V,
    desc: "把 PDF/docx/pptx/xlsx/图片转 Markdown 再处理（依赖 markitdown MCP）",
    trigger: "解析,提取,读取文档,pdf,docx,pptx,xlsx,附件,转markdown",
    when_to_use: "用户给出 PDF/Word/PPT/Excel/图片等文件、需要提取其内容时",
    resources_json: JSON.stringify(["mcp__markitdown__*"]),
    body: "当需要从 PDF/docx/pptx/xlsx/图片提取内容时：1) 调用 `mcp__markitdown__convert_to_markdown`，参数 `uri` 传文件地址（本地文件用 `file:///绝对路径`，网络用 http(s) URL），返回 Markdown 后再据此分析/改写/汇总；2) 若该 MCP 未就绪（索引标『依赖未就绪』），降级为请用户直接粘贴文本，不要假装读到了内容。markitdown 为纯本地 stdio、大陆可达、零外网；首次连接冷启动较慢（约 20-30s，已在超时内），后续走缓存连接。",
  },
  {
    name: "可编辑 PPTX 能力", kind: "capability", version: V,
    desc: "做 PPT 直接用 slides 交付物，用户在文档面板一键导出可编辑真 .pptx（内置、无需 MCP）；母版级保真才用自托管 MCP（默认关）",
    trigger: "可编辑ppt,高保真pptx,母版,模板ppt,精美演示,导出ppt,导出pptx,pptx",
    when_to_use: "需要做 PPT / 可在 PowerPoint 继续编辑的演示文稿、或被问到如何导出 pptx 时",
    resources_json: JSON.stringify(["mcp__pptx-native__*", "generate_image"]),
    body: "结论先行：做 PPT 直接用 write_document(kind=slides)（Marp 分页）。交付后用户在「文档」面板打开该文档、点标题栏「⬇ .pptx」即可导出**可编辑的真 .pptx**（pptxgenjs 渲染，PowerPoint/WPS/Keynote 直接打开，文本/表格/讲者备注均可编辑）——这是默认且唯一需要的路径，**完全内置、无需任何 MCP / 插件 / 命令行**。1) 绝不要告诉用户『导出不可用 / 依赖未就绪 / 需要 pptxgenjs 等服务』，也绝不要让用户自己去跑 marp-cli 等命令；2) 用户问『在哪看 / 怎么导出』→ 指引去「文档」面板打开、点 ⬇ .pptx，不要把整篇正文倒进聊天；3) 仅当确需母版级 DrawingML 高保真、且管理员已自托管启用 pptx-native(ppt-master) MCP 时，才走该 MCP，否则一律用内置 slides→pptx。该 MCP 在宿主本地执行、属高危(exec)、默认关闭。",
  },
  {
    name: "国产联网检索能力", kind: "capability", version: V,
    desc: "仅国内模型部署下以智谱 web-search-prime 作主检索路径（依赖 web-search-prime MCP）",
    trigger: "联网搜索,实时检索,查最新,国产搜索,web检索",
    when_to_use: "仅国内模型部署、Anthropic 服务端 web_search 不可用、又需要联网检索时",
    resources_json: JSON.stringify(["mcp__web-search-prime__*"]),
    body: "仅国内模型部署下，官方服务端 web_search/web_fetch 走降档可能不可用。此时：1) 以 mcp__web-search-prime__*（智谱，http+bearer，大陆可达）作为主检索路径；2) 仍遵守『深度调研法』的多源交叉验证与来源标注；3) 该 MCP 也不可达时，降级为请用户粘贴资料，不要凭空编造。",
  },
];

/**
 * 全局内置技能（与 owner 无关，服务启动时调用，幂等）。
 * version-based upsert：解决旧库『非空就不播种』——新内置技能插入，旧版按 name 升级正文/元数据但
 * 保留用户的 enabled 开关；自定义技能不受影响。
 */
export function seedGlobalSkills() {
  const builtinByName = new Map(listSkills().filter((s) => s.builtin).map((s) => [s.name, s]));
  for (const s of BUILTIN_SKILLS) {
    const cur = builtinByName.get(s.name);
    if (!cur) {
      createSkill({ ...s, builtin: true, enabled: false });
    } else if ((cur.version ?? 1) < s.version) {
      upsertBuiltinSkill(cur.id, s);
    }
  }
}

/**
 * 为「当前 owner」播种工作区（首次进入时调用，须在 withOwner 上下文内）。
 * 每个用户拿到自己私有的一支 AI 同事团队与默认频道；agents/channels/messages 自动归属当前 owner。
 */
export function seedForOwner() {
  if (listAgents().length > 0) return; // 当前 owner 已有数据 → 跳过
  const agents = BUILTIN_AGENTS.map((a) => createAgent(a));
  const channel = createChannel("general", agents.map((a) => a.id));
  insertMessage({
    channel_id: channel.id,
    author_type: "system",
    content: "频道已创建。4 位 AI 同事已加入：产品经理、工程师、代码评审、SEO 优化师。直接发消息或用 @ 指定同事。",
  });
}

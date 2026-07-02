# AITeam — AI 同事协作工作台

一个开源的 **多用户 agent swarm 工作台**：每个成员登录后拥有自己私有的一支角色化 AI 同事团队，在频道里讨论、在看板上推进任务、把正式产出沉淀到文档库，高风险动作经过审批门，全程留痕。组织统一配置模型 key，成员各自隔离工作。

可作为**团队内部 AI 协作产品**独立部署（邮箱+密码登录 + admin/member 权限），也可整合进统一 Web App 复用其登录态。设计细节见 [docs/DESIGN.md](docs/DESIGN.md)，上手手册见 [docs/GUIDE.md](docs/GUIDE.md)，架构深读见 [docs/harness-analysis.html](docs/harness-analysis.html)。

---

## ✨ 特性

**协作与编排**
- **任务即工作**：任务指派给 AI 同事后自动开工——后台调研（联网 `web_search`/`web_fetch` 或 MCP 插件）、撰写正式交付物、转待评审并自动唤起评审；关单（done）是 human-only 操作
- **项目 DAG**：用 `start_project` 把目标一次拆成带依赖的任务图，自动并行调度 → 全部交付后 Lead 自动汇总；可选 `approve_plan` 计划先送人工把关
- **多智能体编排**：`@提及` 精确路由；AI 之间可互相 `@` 接力（链深限制防雪崩）；开票分工后被指派的同事自动干活
- **频道 + 私信**：人与 AI 共用同一消息平面；频道可配置（改名 / 增减成员 / 按场景一键重组）
- **运行中插话 / 停止**：任务进行中发指令会注入下一轮；频道级 ⏹ 可中断正在跑的 AI（含聊天回复）

**质量与产出**
- **干净上下文验收闭环**：换一个同事按 rubric 逐条核验交付物，未过退回返工；无结构化裁决时 fail-closed 退回（不放水）
- **文档库 + 版本归并**：正式产出（报告/PPT/数据表）沉淀为文档；返工自动出新版盖旧版（旧版进历史可查），按项目折叠归档
- **真 .pptx / ECharts / 配图 / HTML 网页**：slides 导出可编辑 `.pptx`（含讲者备注 + 原生表格）；数据表渲染交互式 ECharts（柱/折线/饼）；可用文生图生成点睛配图并嵌入；新增 **`html` 交付物**——网页/落地页/前端原型/横向翻页 deck/可交互可视化，沙箱实时预览、可下载（承接前端 MVP 与图文混排）
- **产出规范常驻**：结论先行 + 要点 MECE + 来源标注 + 交付自查表，普惠所有任务
- **技能 v2（渐进式披露）**：28 内置工作方法（写作/调研/设计审美/SVG 图表/信息图封面/TDD 规格/调试/评审/前端工程自查…）+ 能力型技能（指向 MCP/工具，依赖未就绪自动标注）。启用后仅注入**索引**，正文由同事按需 `read_skill` 拉取——可放心多开、几乎不占常驻预算
- **MCP 预设目录**：设置里「浏览推荐」一键预填常用 MCP（markitdown 文档解析 / 智谱联网搜索 / SQLite / 文件系统 / 浏览器 QA…），标注大陆可达性与安全分级；高危（联网/执行）插件受引擎审批门约束

**多用户与治理**
- **每用户隔离**：全部业务数据带 `owner_id`，查询经 AsyncLocalStorage 自动按 owner 过滤、**fail-closed 防跨租户泄漏**
- **登录鉴权**：邮箱+密码（scrypt + JWT 会话 cookie）；admin/member 角色，组织级配置（模型 / MCP / 技能）仅 admin 可改
- **过程透明**：流式输出、"正在思考 / 正在撰写文档…" 实时状态、消息级 token 用量与归因（缓存读/写分列计费）
- **审批门 + Agent 记忆**：高风险动作进收件箱一键批准；每个同事长期记忆跨会话生效
- **成本护栏**：每用户每日 token 预算硬切断、MCP/配图按次封顶、MCP 调用超时自愈

**模型接入**
- **BYOM（自带模型）**：默认 Anthropic 官方；可接入任何 Anthropic 协议兼容端点（DeepSeek/GLM/Kimi/MiniMax，或经 LiteLLM 接 OpenAI 协议供应商与本地 Ollama/vLLM）；逐 Agent 选择通道，API key 仅存服务端
- **Mock 模式**：未配置任何模型 key 时自动降级，全链路可体验（零 token）

---

## 🚀 快速开始

### 开发模式

```bash
npm install
# 可选：配模型 key（缺省进 Mock 模式，仍可体验全链路）；也可启动后在界面 ⚙ 里配
export ANTHROPIC_API_KEY=sk-ant-...
export AITEAM_SESSION_SECRET="一串足够长的随机字符串"   # standalone 登录会话密钥
npm run dev
```

打开 **http://localhost:5173/aiteam/** （前端 :5173，API 自动代理到 :8787）。

> ⚠️ 注意入口带 **`/aiteam/` 前缀**（不是根 `/`）。

### 生产构建

```bash
npm run build
AITEAM_SESSION_SECRET="一串足够长的随机字符串" npm start
```

单进程服务在 **http://localhost:8787/aiteam/**。

### 桌面端 MVP

```bash
npm run desktop          # Electron 壳启动本机 AiTeam
npm run desktop:smoke    # 验证桌面资源、deep link、通知、文件选择和 server 运行时
npm run desktop:pack     # 生成未签名的开发者预览包，含 Node sidecar + 服务端生产依赖
npm run pack:verify --workspace desktop  # 脱离源码树验证包内运行时
```

桌面端当前是 Electron shell，不是最终 C 端发行版；签名/公证、安装器、自动更新和崩溃日志仍是发布前门槛。

### 首次使用

第一次访问会看到**注册页**——创建第一个账号即成为**管理员**（admin）。管理员在 ⚙ 设置里配好模型供应商（DeepSeek / 官方 Anthropic 等）、MCP 插件、文生图后，团队成员注册登录即可各自在私有工作区里干活。

---

## ⚙️ 配置（环境变量）

### 鉴权 / 会话
| 变量 | 默认 | 说明 |
|---|---|---|
| `AITEAM_AUTH_MODE` | `standalone` | `standalone`=自建邮箱密码登录；`coworker`=复用统一 Web App 的 NextAuth 登录态 |
| `AITEAM_SESSION_SECRET` | 开发回退值 | standalone 会话 JWT 签名密钥，**生产必配** |
| `AITEAM_ADMIN_EMAILS` | 空 | 管理员邮箱白名单（逗号分隔）；命中即 admin。不设则**首个注册者**为 admin |
| `AITEAM_ALLOW_SIGNUP` | `1`（开） | 是否开放公开注册；设 `0` 则关闭，由 admin 建号 |
| `AUTH_SECRET` | — | coworker 模式下解密 NextAuth 会话 cookie 的密钥 |
| `COWORKER_INTERNAL_URL` | — | coworker 模式回源取用户展示名 |

### 模型与运行
| 变量 | 默认 | 说明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | 官方模型 key；缺省进 Mock 模式 |
| `AITEAM_STRONG_MODEL` | `claude-opus-4-8` | 强通道模型（验收/汇总走最强） |
| `AITEAM_LIGHT_MODEL` | `claude-haiku-4-5` | 轻量模型（重复性/格式化任务降本） |
| `PORT` | `8787` | 服务端口 |
| `AITEAM_DATA_DIR` | `server/data` | sqlite 库与生成图资产目录（测试/多实例隔离用） |
| `AITEAM_USER_NAME` | `我` | 用户显示名回退值 |

### 护栏 / 调优
| 变量 | 默认 | 说明 |
|---|---|---|
| `AITEAM_DAILY_TOKEN_BUDGET` | `0`（不限） | 每用户每日 token 预算硬切断（按加权计费 token） |
| `TASK_MAX_REVISIONS` | `1` | 验收未过的返工次数上限 |
| `AGENT_CHAIN_DEPTH` | `2` | AI 互相 @ 接力的链深上限（防雪崩） |
| `AITEAM_MCP_CALLS_PER_RUN` | `5` | 单次运行 MCP 插件调用上限（按次计费） |
| `AITEAM_IMAGES_PER_RUN` | `3` | 单次运行文生图上限（按张计费） |
| `AITEAM_MCP_TIMEOUT_MS` | `45000` | MCP 连接/调用超时（防插件挂死阻塞运行） |
| `AITEAM_MCP_CACHE_TTL_MS` | `600000` | MCP 同参调用结果缓存 TTL |
| `AITEAM_MAX_MCP_TOOLS` | `40` | 注入工作循环的 MCP 工具数上限 |
| `AITEAM_SKILL_INDEX_BUDGET` | `6000` | 技能索引（L1）注入上限（字）；正文按需 `read_skill` 拉取不计入 |

---

## 👥 多用户与权限

- **私有工作区**：每个登录用户 = 一个 owner（`user:<id>`），其频道/消息/任务/文档/项目/记忆全部隔离，互不可见；`providers`/`mcp_servers`/`skills` 为**全局共享配置**（管理员统一维护）。
- **角色**：`admin` 可改组织级配置（模型供应商、MCP、文生图、技能）；`member` 只能用，配置入口对其隐藏（后端亦 403 兜底）。
- **首个管理员**：`AITEAM_ADMIN_EMAILS` 白名单命中，或（未设白名单时）首个注册者自动 admin。
- **隔离保证**：查询缺 owner 上下文直接抛错（fail-closed），绝不回退到"看全部"。

> 升级提示：在旧的单用户库上首次启动会自动迁移（agents 唯一约束 `name` → `owner_id,name`）。旧单用户数据归属空 owner、不出现在新账号里；全局模型/MCP/文生图配置会保留。想全新环境可设 `AITEAM_DATA_DIR` 指向空目录。

---

## 🧪 测试

```bash
npm run build && npm test     # 机制级回归（Mock 模式，零 token，65 项）
```

覆盖：项目 DAG 调度 / 计划把关 / 停止 / 预算护栏 / 断点恢复 / 验收防放水 / Helio 式多角色项目全链路（claim→阻塞输入→审批恢复→复核退回→返工交付→汇总→人类关闭）/ 产品内核心场景库（协作演练、调研报告、方案演示）/ 模型供应商连通性测试 / 文档版本归并 / 写入契约校验 / 技能相关性 / 鉴权（未登录 401、登录会话、member 门控 403、多用户隔离）/ pptx 解析与模板就地改文图 / 上传来源与定向润色 / MCP 环境变量与跨插件去重 / 用量归因 等。智能质量类用例需真实 key 人工执行，见 [docs/TESTING.md](docs/TESTING.md)。

---

## 🏗️ 架构

```
浏览器 ──/aiteam/──► Express(:8787)
                     ├─ /aiteam/api/auth/*   登录/注册/登出/me（公开）
                     ├─ /aiteam/api/*        其余 API（requireUser → withOwner 隔离）
                     ├─ /aiteam/ws           WebSocket 实时（按 owner 定向广播）
                     └─ /aiteam/             前端静态产物（Vite，base=/aiteam/）
```

- **执行内核**：聊天/干活/验收/汇总共用一个流式多轮工具循环（`engine.ts`），按任务分级路由模型（强通道兜验收/汇总、轻量档降本），并对第三方兼容端点做容错（联网工具降档阶梯、thinking 回传、瞬时退避、MCP 超时、孤立代理项清洗）。
- **隔离核心**：`ownerScope.ts`（AsyncLocalStorage）+ 各表 `owner_id`，请求/运行循环用 `withOwner` 建立上下文，db 查询自动加 owner 过滤。
- **持久化**：better-sqlite3（WAL）单文件，消息内嵌用量账本，重启自愈（收口中断流式消息 + 续跑 doing 任务），密钥永不下发前端。

更深入：[docs/HANDOFF-standalone-auth.md](docs/HANDOFF-standalone-auth.md)（鉴权/隔离设计）、[docs/harness-analysis.html](docs/harness-analysis.html)（agent harness 全面拆解）。

---

## 🧰 技术栈

- **server**：Node 22 · Express · ws · better-sqlite3 · `@anthropic-ai/sdk`（默认 `claude-opus-4-8`）· `jose`（JWT）· `@modelcontextprotocol/sdk`（MCP）· `pptxgenjs`
- **web**：Vite · React 18 · TypeScript · Tailwind CSS v4 · react-markdown · echarts

## 📦 部署

单机 / 统一入口（Caddy 反代，AiTeam 在 `/aiteam/*`）部署见 [deploy/README.md](deploy/README.md) 与 `deploy/.env.example`。

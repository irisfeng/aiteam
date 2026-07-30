# AITeam 运维手册（OPERATIONS）

> 单机 / 本机运行与日常运维的实操参考。
> 配套文档：功能用法看 [GUIDE.md](GUIDE.md)；真模型测试清单看 [TESTING.md](TESTING.md)；上线腾讯云大陆 VPS 看 [DEPLOY-tencent-vps.md](DEPLOY-tencent-vps.md)；输出质量优化记录看 [REVIEW-output-quality.md](REVIEW-output-quality.md)。

---

## 0. 一分钟跑起来

```bash
cd ~/Documents/GitHub/aiteam
npm install                                   # 首次或依赖有变时
npm run build                                 # 编译 server(tsc) + web(vite)；改了代码也要先 build
AITEAM_SESSION_SECRET=<任意串> PORT=8787 npm start
# 浏览器打开 http://localhost:8787/aiteam/    ← 注意 /aiteam/ 前缀
```

没有任何用户时，**第一个注册者自动成为 admin**。不配模型 key 会进 Mock 模式（见 §4）。

---

## 1. 生命周期命令

| 操作 | 命令 |
|------|------|
| 构建 | `npm run build`（产物：`web/dist`、`server/dist`） |
| 启动（前台，看日志，Ctrl+C 停） | `AITEAM_SESSION_SECRET=... PORT=8787 npm start` |
| 启动（后台） | `AITEAM_SESSION_SECRET=... PORT=8787 nohup npm start > /tmp/aiteam-server.log 2>&1 &` |
| 停止 | `pkill -f "node dist/index.js"` |
| 重启 | 先停后启 |
| 健康检查 | `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/aiteam/` → `200` |
| 看谁占了端口 | `lsof -nP -iTCP:8787 -sTCP:LISTEN` |

要点：
- `npm start` 只运行**已编译的 `dist`**，不会自动编译——**改代码先 `npm run build`**。
- `npm start` 实际是 `npm run start --workspace server` → `node dist/index.js`；只要 `web/dist` 存在就**同端口托管前端**（无需单独起前端）。
- 改了内置技能正文（`server/src/seed.ts`）要把 `BUILTIN_SKILL_PACK_VERSION` +1，重启才会下发到已有库（version-based upsert，否则旧库不更新）。

---

## 2. 开发模式（热更新）

```bash
npm run dev      # 前端 Vite http://localhost:5173（热更新）+ 后端并行
```
改前端走 :5173 即时生效；改后端需重启。**日常演示/测试建议用 §0 的 build + start**，更接近真实运行。

---

## 2.1 桌面客户端（Electron MVP）

当前桌面端是 **Electron 壳 + 本机 Express 服务 + SQLite 数据目录**，入口仍是 `/aiteam/`，但具备客户端能力：原生菜单、托盘、通知、deep link、原生文件选择上传。

```bash
npm run desktop          # build 后启动桌面壳
npm run desktop:smoke    # 静态检查 + 实际启动 server/dist 访问 /aiteam/
npm run desktop:pack     # 生成 Electron Builder dir 预览包（未签名，含 Node sidecar + 服务端生产依赖）
npm run pack:verify --workspace desktop  # 将包内 Resources 复制到 /tmp 后启动验证
```

边界：
- 开发运行时优先使用当前 Node 运行 `server/dist/index.js`，避免 Electron Node 与 `better-sqlite3` 原生模块 ABI 不匹配。
- `desktop:pack` 会先生成 `desktop/.runtime`，只放 `server/dist`、`web/dist`、Node sidecar 和服务端生产依赖；`desktop/.runtime` 与 `desktop/release` 都是生成物，不提交。
- `desktop:pack` 仍是开发者预览包配置；普通用户发行版还需要签名、公证、安装器、自动更新、崩溃日志。
- 桌面端数据默认在 OS app-data 下；Web/服务端部署路径不变。

---

## 3. 访问与登录

- 地址：`http://<host>:<PORT>/aiteam/`（前缀固定 `/aiteam/`）。
- 首个用户：无用户时第一个注册者即 admin；也可用 `AITEAM_ADMIN_EMAILS` 白名单指定。
- 会话：登录态是用 `AITEAM_SESSION_SECRET` 签名的 cookie。**重启时若换了 secret → 现有登录失效**（需重登，数据不丢）。要保持登录，重启沿用同一 secret。
- 关闭公开注册：`AITEAM_ALLOW_SIGNUP=0`。

---

## 4. 模型接入（不配则 Mock）

- 不配任何 key = **Mock 模式**（启动日志标 `mock mode`），只能跑机制、不产出真内容。
- 配置：登录后 **设置 → 模型**，添加 provider（BYOM，Anthropic 兼容端点）。例：DeepSeek `base_url=https://api.deepseek.com/anthropic`、强模型 `deepseek-v4-pro`、轻量 `deepseek-v4-flash`。或设 `ANTHROPIC_API_KEY` 走官方。
- provider 为**全局**配置（组织级），各成员工作区隔离。详见 GUIDE.md「第 1 步：接入模型」。

---

## 5. 数据与备份

- 全部业务数据在单个 SQLite 文件：**`server/data/aiteam.db`**（可用 `AITEAM_DATA_DIR` 改目录）。
- 生成图资产：`server/data/assets/`；上传临时件：`server/data/uploads-tmp/`（即用即删，不持久化二进制）。
- **备份**：不要直接复制单个运行库。使用 SQLite `VACUUM INTO` 生成一致性快照，再打包
  `assets/`；运行中的 WAL 数据会被正确合并。腾讯云示例见
  [DEPLOY-tencent-vps.md](DEPLOY-tencent-vps.md#53-备份脚本-optaiteamopsbackupsh)。
- **凭证落库**：模型 provider API key、MCP `auth_token` / env、文生图 API key 均以
  AES-256-GCM `enc1:` 密文保存。
- **凭证密钥**：优先读取 `AITEAM_CREDENTIAL_KEY`（32 字节，64 位 hex 或 base64）；开发/测试未设时
  才在数据目录自动生成 `credential.key`（0600）。生产环境既未注入环境变量、也没有已有
  `credential.key` 时会拒绝加密/迁移，不会静默生成新密钥。
- **迁移/恢复**：环境变量模式必须恢复同一个 `AITEAM_CREDENTIAL_KEY`；文件模式必须连同
  `credential.key` 一起恢复。密钥与数据库不匹配时凭证不可解，不会退回明文。生产启动只认证已有
  `enc1:`；发现非空 plaintext 或 `enc:v1:` 会在修改数据库前拒绝启动，并要求走下文的 copy-only
  `migrate-copy`。启动预检会把现有 `aiteam.db` 及其 `-wal` / `-shm` 镜像到系统临时目录后读取，
  包括“旧凭证只存在于 WAL”的情况也会拒启，同时不会在源数据目录补建 SQLite 伴生文件。
- **密钥备份必须独立**：`AITEAM_CREDENTIAL_KEY` 应保存在密码管理器/云密钥服务或独立加密介质，
  不要与未加密的数据库快照放在同一目录；文件模式同理，应把 `credential.key` 单独加密托管。
  每次恢复先恢复密钥，再恢复 DB，并实际读取一次 provider/MCP/文生图配置验证可解密。
- 只读查看：`sqlite3 server/data/aiteam.db`。无「删用户」API，清理测试账号需直接操作 DB（owner 隔离，测试号对正常用户不可见）。

### 5.1 历史 `enc:v1:` 凭证升级

旧安全分支曾使用 `enc:v1:`。不要直接启动真实数据目录试密钥；使用
`scripts/credential-recovery.mjs`（npm 入口：`npm run credentials:recover -- ...`）先只读盘点，
再在新副本完成迁移或清密钥救援。建议操作前先跑一次工具自身回归：

```bash
npm run build
npm run test:credential-recovery
```

#### 安全边界

- 先停服务并按上文生成 SQLite 一致性备份；后续 `--data-dir` 应指向该备份/工作副本，而不是正在服务的
  `server/data`。
- 这是应用强制门禁，不只是操作建议：`NODE_ENV=production` 时，即使提供了正确
  `AITEAM_SECRET_KEY`，启动进程也不会原地改写 plaintext / `enc:v1:`。只有 development/test
  为兼容本地夹具与隔离测试目录保留事务内原地规范化能力。
- 四个命令都必须显式给 `--data-dir`，工具不会默认指向真实工作区。`migrate-copy` / `rescue-copy`
  还必须给一个**父目录已存在、目标目录尚不存在**、与源目录不同且不位于源目录内部的
  `--output-dir`；真实路径会经过 `realpath` 校验，拒绝覆盖和符号链接绕过。
- `migrate-copy` / `rescue-copy` 会在数据库副本之后复制 `assets/`，因此必须先停服，并显式提供
  `--confirm-source-stopped`。这项确认是数据库与资产处于同一静止窗口的操作门禁。
- `assets/` 内出现任何符号链接时会拒绝复制，避免生成依赖输出目录外文件的非独立副本。
- 源数据库始终只读。迁移/救援只发布新目录，并复制 `assets/`；不会复制 `credential.key`，
  因而目标 `AITEAM_CREDENTIAL_KEY` 必须单独安全保存。
- CLI 不读取 `credential.key`，也不使用 `AITEAM_SESSION_SECRET` 解旧格式。若历史 `enc:v1:` 实际由
  当时的 session secret 生成，必须把**那个旧值**显式作为 `AITEAM_SECRET_KEY` 注入本工具。
- `--json` 和报告只含格式/数量及路径，不输出凭证值，但输出副本仍包含业务数据，须按生产数据保护。
- 任一完整性、密钥、未知密文、JSON 格式或 WAL/SHM 检查失败都会退出非零；不要换随机密钥反复尝试，
  先保留报错和源库校验和再排查。

#### 1. `inspect`：无密钥只读盘点

```bash
export SOURCE_DATA='/absolute/path/to/aiteam-backup'
npm run credentials:recover -- inspect --data-dir "$SOURCE_DATA" --json
```

输出按 `providers`、`mcp_auth`、`mcp_env`、`image_provider` 统计：
`empty / enc1 / legacy_v1 / plaintext / unknown_envelope / invalid`。它只分类，不尝试解密；
出现 `unknown_envelope` 或 `invalid` 时停止，不进入迁移。

#### 2. `dry-run`：在临时副本验证全部密钥

先显式准备密钥，值不要写进工单、日志或共享 shell 历史：

```bash
# 目标副本使用的新固定 32 字节 key；首次生成后必须独立持久保存
export AITEAM_CREDENTIAL_KEY="$(openssl rand -hex 32)"

# 源库含 enc:v1 时必填：生成这些历史密文时使用的原始材料
export AITEAM_SECRET_KEY='ORIGINAL_LEGACY_MATERIAL'

# 仅当源库已有 enc1、且其 key 与目标 key 不同时设置；相同时不要设置
# export AITEAM_SOURCE_CREDENTIAL_KEY='SOURCE_32_BYTE_HEX_OR_BASE64'

npm run credentials:recover -- dry-run --data-dir "$SOURCE_DATA" --json
```

`dry-run` 会检查源库完整性，用 SQLite backup API 建临时副本，在副本中解密并重加密，然后验证所有
非空凭证均为可认证的 `enc1:`；临时目录最后删除，源数据库保持不变。只有退出码为 0、
`success=true` 且 after 中没有 `legacy_v1 / plaintext / unknown_envelope / invalid` 才能继续。

#### 3. `migrate-copy`：排他生成可启动迁移副本

```bash
export OUTPUT_DATA='/absolute/path/to/aiteam-migrated-uat'
npm run credentials:recover -- migrate-copy \
  --data-dir "$SOURCE_DATA" \
  --output-dir "$OUTPUT_DATA" \
  --confirm-source-stopped \
  --json
```

沿用 `dry-run` 已验证的三个显式变量。工具会在受限 staging 目录复制数据库与 `assets/`，事务迁移
provider、MCP auth/env、文生图凭证，执行 secure delete + `VACUUM`、完整性和 sidecar 检查后，
才用排他目录预留发布 `OUTPUT_DATA`，不会以 `check + rename` 覆盖竞态中出现的空目录。发布期间的
`.aiteam-recovery-incomplete` 标记只会在异常中断后残留；看到它时应把整个输出目录视为无效并删除重跑。
结果写入权限为 0600 的
`credential-migration-report.json`；源目录不会被修改。

#### 4. `rescue-copy`：旧密钥确实找不到时清空副本凭证

这是最后手段：输出副本会清空**全部** provider API key、MCP auth/env 和文生图 API key，
但保留账号、频道、任务、文档、项目、非秘密连接配置和 `assets/`。源目录仍只读。

```bash
export OUTPUT_DATA='/absolute/path/to/aiteam-rescued-uat'
unset AITEAM_CREDENTIAL_KEY AITEAM_SOURCE_CREDENTIAL_KEY AITEAM_SECRET_KEY AITEAM_SESSION_SECRET
npm run credentials:recover -- rescue-copy \
  --data-dir "$SOURCE_DATA" \
  --output-dir "$OUTPUT_DATA" \
  --confirm CLEAR_ALL_CREDENTIALS \
  --confirm-source-stopped \
  --json
```

确认短语必须逐字为 `CLEAR_ALL_CREDENTIALS`。成功后检查
`credential-rescue-report.json`，为该副本生成并持久保存新的 `AITEAM_CREDENTIAL_KEY`：

```bash
export AITEAM_CREDENTIAL_KEY="$(openssl rand -hex 32)"
```

再由管理员在界面重新录入并逐一测试 provider、MCP 和文生图凭证。

#### 5. 迁移副本的人工 UAT 放行条件

只允许启动 `OUTPUT_DATA`，不要切换或覆盖源目录：

```bash
export NODE_ENV=production
export AITEAM_DATA_DIR="$OUTPUT_DATA"
export AITEAM_SESSION_SECRET="$(openssl rand -base64 48)"
# AITEAM_CREDENTIAL_KEY 必须沿用 dry-run/migrate-copy 的目标 key，
# 或 rescue-copy 后刚生成并已安全保存的固定 key；不要在这里再次生成。
unset AITEAM_SECRET_KEY AITEAM_SOURCE_CREDENTIAL_KEY
npm run build
npm start
```

满足以下条件后，迁移副本才算可进入人工测试：

1. 对 `OUTPUT_DATA` 再跑 `inspect`，所有非空凭证只能是 `enc1`；不得有
   `legacy_v1 / plaintext / unknown_envelope / invalid`。
2. 不提供任何旧密钥也能以 `NODE_ENV=production` 启动、登录并刷新工作区。
3. `migrate-copy` 路径下，已有 provider / MCP / 文生图配置均能读取并通过各自行内测试；
   `rescue-copy` 路径下，管理员已重新录入并逐一测试所有必需凭证。
4. 按 [TESTING.md](TESTING.md) 至少通过 B1 基础聊天、C1 单任务交付与验收、C3 计划批准后开工、
   C5.1 取消与 human-only 关单；首发包含联网调研时还必须通过 B2。
5. 无 500/崩溃/空回复、密钥泄漏、审批绕过、未交付任务置 done、取消任务解锁下游，
   且任务活动日志和交付物可正常读取。

任一项失败立即停止，不把 `OUTPUT_DATA` 提升为正式数据目录。全部通过后仍应保留原目录与一致性备份，
再通过受控配置切换 `AITEAM_DATA_DIR`；不要用移动/覆盖源库的方式“就地修复”。

---

## 6. 日志与排错

后台日志 = 你启动时重定向的文件（如 `/tmp/aiteam-server.log`）；前台直接打印。频道内 🚀/🔎/📦/↩️ 系统消息（audit）是任务运行的实时进度。

| 现象 | 原因 / 处理 |
|------|------------|
| 启动报端口占用（EADDRINUSE） | 已有实例在跑 → `pkill -f "node dist/index.js"` 再启 |
| `/aiteam/` 打开空白/404 | 没 build 过前端 → `npm run build`（`web/dist` 不存在时不托管前端） |
| 登录态失效 | 重启换了 `AITEAM_SESSION_SECRET` → 沿用原 secret 或重新登录 |
| 生产报缺少凭证落库密钥 | 固定设置 `AITEAM_CREDENTIAL_KEY`，或恢复与数据库配套的 `credential.key`；不要生成新密钥覆盖旧库 |
| 生产启动提示未规范化凭证并指向 `migrate-copy` | 数据库仍含 plaintext / `enc:v1:`；不要反复重启或直接改真实库，按 §5.1 在副本执行 `inspect` → `dry-run` → `migrate-copy` |
| 恢复工具报历史 `enc:v1` 解密失败 | `migrate-copy` 需要原 `AITEAM_SECRET_KEY`；找不到时走 `rescue-copy` 并重新录入凭证 |
| 一直 Mock 模式 | 没配带 key 的 provider → 设置 → 模型 加一个 |
| 任务长时间停在 `doing` | 富方案（检索 + 配图 + 强模型验收 + 返工）端到端常 3–5 分钟，属正常；看 audit 进度，真卡死再排查 |
| audit 出现「联网工具适配…400 Failed to deserialize…降级为仅搜索」 | 国内端点不接受官方 web_search 工具组合，引擎已自动降级用检索插件，**非致命** |
| 智谱 `web_search_prime` 报 1309 | GLM Coding 套餐过期 / 额度问题 |
| 开发环境 MCP 首次调用慢（~20–30s） | stdio MCP 冷启动，之后走缓存连接；生产 local stdio 使用一次性隔离容器，不跨 Mission 缓存 |
| 导出的 PPT 中文在别的电脑变样 | .pptx 写的是字体名；默认 `PingFang SC` 适配 Mac，面向 Windows/WPS 客户设 `AITEAM_PPTX_FONT=Microsoft YaHei` 后重启 |

---

## 7. 环境变量参考（运维相关）

| 变量 | 默认 | 说明 |
|------|------|------|
| `AITEAM_SESSION_SECRET` | 开发弱回退 | 会话签名密钥；**生产（`NODE_ENV=production`）未设则拒启**，务必设强随机串（`openssl rand -base64 48`） |
| `AITEAM_CREDENTIAL_KEY` | 开发自动生成 `credential.key` | 凭证落库密钥（32 字节，64 位 hex 或 base64）；生产必须注入固定值或恢复已有文件 |
| `AITEAM_SECRET_KEY` | 空 | 仅供 `credentials:recover` 解历史 `enc:v1:`；不能让生产启动绕过 copy-only 门禁，迁移完成后删除 |
| `AITEAM_SOURCE_CREDENTIAL_KEY` | 空 | 仅供 `credentials:recover`：源库已有 `enc1:` 且源 key 与目标 `AITEAM_CREDENTIAL_KEY` 不同时显式提供 |
| `PORT` | `8787` | 监听端口 |
| `AITEAM_HOST` | `127.0.0.1` | 监听地址（对外/反代时按需，如 `0.0.0.0`） |
| `AITEAM_DATA_DIR` | `server/data` | 数据目录（db / assets / uploads-tmp） |
| `ANTHROPIC_API_KEY` | — | 官方模型 key（不配则用 UI 里的 provider） |
| `AITEAM_STRONG_MODEL` | `claude-opus-4-8` | 强通道默认模型（验收/强标志用） |
| `AITEAM_LIGHT_MODEL` | `claude-haiku-4-5` | 轻量通道默认模型 |
| `AITEAM_PPTX_FONT` | `PingFang SC` | slides→pptx 的 CJK 字体（Windows/WPS 客户设 `Microsoft YaHei`） |
| `AITEAM_ALLOW_SIGNUP` | `1`（开） | 公开注册开关；`0`=关 |
| `AITEAM_ADMIN_EMAILS` | 空 | 逗号分隔的 admin 邮箱白名单 |
| `AITEAM_DAILY_TOKEN_BUDGET` | `0`（不限） | 每日 token 预算，`>0` 启用 |
| `AITEAM_TASK_TOKEN_BUDGET` | `0`（不限） | 单任务默认预算（加权计费 token）；触线任务自动暂停并开审批，批准后追加预算续跑 |
| `AITEAM_MISSION_TIMEOUT_MS` | `3600000`（1 小时） | Mission 总执行期限（1000–604800000ms）；截止时间写入数据库，重启时先过期再恢复任务 |
| `AITEAM_MISSION_MAX_ACTIVE_PER_ORGANIZATION` | `2` | 单组织活跃 Mission 上限（1–32） |
| `AITEAM_MISSION_MAX_ACTIVE_GLOBAL` | `4` | 单实例全局活跃 Mission 上限（1–64），不得小于单组织上限 |
| `TASK_MAX_REVISIONS` | `1` | 验收返工上限 |
| `AITEAM_PROVIDER_BENCHMARK_BUDGET` | `20000` | 固定模型质量基准的计费 token 上限 |
| `AITEAM_PROVIDER_BENCHMARK_REVIEW_RESERVE` | `6000` | 独立强模型复核的预留计费 token |
| `AITEAM_PROVIDER_BENCHMARK_MAX_REVISIONS` | `1` | 固定质量基准自动返工上限；设 `0` 可做单次成本封顶验收 |
| `AGENT_CHAIN_DEPTH` | `2` | AI 互相 @ 接力的链深上限（防雪崩） |
| `AITEAM_MCP_CALLS_PER_RUN` | `5` | 单次运行 MCP 调用上限 |
| `AITEAM_MAX_MCP_TOOLS` | `40` | 注入的 MCP 工具数上限 |
| `AITEAM_IMAGES_PER_RUN` | `2` | 单次运行配图张数上限（工具每次只采用 1 张；Seedream 5.0 Pro 默认单图） |
| `AITEAM_UPLOAD_MAX_BYTES` | `20971520`（20MB） | 上传单文件大小上限 |
| `AITEAM_SEARCH_DEDUP` | `1`（开） | 跨插件检索去重；`0`=关 |
| `AITEAM_MCP_STDIO_ALLOW` | 空 | 仅开发/测试宿主 stdio 的命令白名单扩展；不能开启生产 stdio |
| `AITEAM_MCP_STDIO_RUNNER` | 空 | 生产 stdio runner；当前唯一合法值 `podman`，空值保持全部 fail-closed |
| `AITEAM_MCP_STDIO_RUNNER_BIN` | `podman` | Podman CLI；basename 必须为 `podman`，不会连接 Docker/Podman API socket |
| `AITEAM_MCP_STDIO_WORKSPACE_ROOT` | `$AITEAM_DATA_DIR/mcp-workspaces` | 必须是 `AITEAM_DATA_DIR` 的专用绝对子目录；按 owner + Mission/task 哈希分区 |
| `AITEAM_MCP_STDIO_MEMORY` | `256m` | 每个 stdio 容器内存硬上限 |
| `AITEAM_MCP_STDIO_CPUS` | `1` | 每个 stdio 容器 CPU 上限（0.1–8） |
| `AITEAM_MCP_STDIO_PIDS` | `64` | 每个 stdio 容器进程数上限（8–1024） |

> **生产 stdio 两态门**：默认没有 `AITEAM_MCP_STDIO_RUNNER` 时，启动、API 和
> 唯一 spawn sink 仍全面 fail-closed。配置 runner 后也只允许
> `safety=local`，并要求 rootless Podman、cgroup v2、已预拉取的
> `image@sha256:<digest>`；network/exec 继续拒绝。每次连接均为
> `--rm` 容器，固定 `--network=none`、只读 rootfs、drop all capabilities、
> `no-new-privileges`、CPU/内存/PID 限额，只挂载一个 owner + Mission/task
> 工作区。密钥通过 runner 环境按变量名注入，不出现在 argv。
>
> 机制回归 `npm run test:stdio-sandbox` 使用可审计 runner fixture 验证完整
> MCP 握手与命令构造；它不是 Linux 容器逃逸证据。真正启用前必须在目标 Linux
> 主机设置预拉取的 Node 测试镜像 digest，并运行
> `npm run test:stdio-sandbox:real`，确认工作区外写入、只读 rootfs 写入和网络
> 均失败。Podman rootless 还要求 `/etc/subuid`、`/etc/subgid` 和可用的存储/
> runtime 目录；若现有 systemd `NoNewPrivileges`/`ProtectHome` 令 preflight
> 失败，不得削弱主服务单元来硬开，应改用单独受限 runner 服务并重新评审。

### MarkItDown 首个真实 local 镜像

仓库已包含 `containers/markitdown-mcp/`：基础镜像按 OCI digest 固定，
`markitdown-mcp==0.0.1a4`、`markitdown==0.1.6` 与 65 个传递依赖全部精确
版本并校验分发包 SHA-256。先预拉固定基础镜像，再构建：

```bash
podman pull docker.io/library/python@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7
npm run mcp:image:markitdown:build
```

构建脚本使用 `--pull=never`，并在无网络、只读 rootfs、drop capabilities、
非 root 的实际容器中核对锁定包和 `pip check`。输出
`output/markitdown-mcp-image-evidence.json` 与 CycloneDX 1.6 SBOM；二者默认
被 Git 忽略，晋级时必须另存到发布证据库。把证据中的 `digest_reference`
填入 MarkItDown MCP 的 OCI 镜像字段。

随后跑真实生产业务链：

```bash
AITEAM_MARKITDOWN_TEST_IMAGE='localhost/aiteam/markitdown-mcp@sha256:...' \
  npm run test:stdio-sandbox:markitdown-real
```

它实际覆盖生产服务启动、管理员注册、MCP 注册/握手、任务演练、真 `.docx`
上传、Mission 工作区 staging、Markdown 来源文档入库与 staging 文件清理。
MarkItDown 官方工具虽接受 `http(s)` URI，本生产镜像固定 `--network=none`，
只支持 AITeam 已 staging 的本地 `file:///workspace/...` 输入。

镜像 digest 与架构绑定。本机 arm64 通过不等于目标 amd64 Linux 通过；目标
Preview 必须重建/导入对应架构镜像，重新生成 digest 与 SBOM，并在精确
service user + systemd unit 下重跑真实业务链和通用逃逸套件。运行时仍禁止拉取。

> 更多业务/治理开关见 GUIDE.md「治理开关（环境变量）」。

---

## 8. 测试与验证

- `AITEAM_PROVIDER_TIMEOUT_MS`：OpenAI 兼容通道的**空闲超时**（毫秒，默认 120000）。连续这么久收不到任何字节才中止；流式长回复不受总时长限制。
- `AITEAM_MISSION_TIMEOUT_MS`：Mission 的**总执行期限**（毫秒，默认 3600000）。它与单次 provider/MCP 空闲超时分离；截止时间随 Mission 持久化，服务重启会先把已超期 Mission 收口为 `failed`，再恢复仍有效的运行中任务。
- `AITEAM_MISSION_MAX_ACTIVE_PER_ORGANIZATION` / `AITEAM_MISSION_MAX_ACTIVE_GLOBAL`：
  在 Mission 与首事件写入前，以 SQLite 立即事务原子检查组织/实例容量。
  活跃状态为 `queued/running/blocked`；终态和已收口的超时 Mission 释放名额。
  超限返回 `429 / MISSION_CAPACITY_EXCEEDED`，不写入半成品，相同幂等键
  的已有请求仍可重放。默认 2/4 对应研究 Mission 四任务 DAG 的单组织
  8 个、全局 16 个执行任务上界。
- 机制级回归（Mock、零 token、不调真模型）：`npm test`（先跑凭证加密/迁移回归，再跑完整业务回归；用例数以命令输出为准）。
- 真模型端到端测试清单：见 [TESTING.md](TESTING.md)。

---

## 9. 升级 / 重新部署（本机）

```bash
cd ~/Documents/GitHub/aiteam
git pull
npm install                 # 依赖有变时
npm run build
pkill -f "node dist/index.js"
AITEAM_SESSION_SECRET=<原会话密钥> AITEAM_CREDENTIAL_KEY=<原32字节凭证密钥> PORT=8787 \
  nohup npm start > /tmp/aiteam-server.log 2>&1 &
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/aiteam/   # 期望 200
```

`AITEAM_SESSION_SECRET` 与 `AITEAM_CREDENTIAL_KEY` 用途和格式不同，必须分别恢复，不能共用同一个值。

若使用数据目录中的 `credential.key`，上面的 `AITEAM_CREDENTIAL_KEY` 可省略，但升级、迁机和恢复时
必须保留该文件。生产部署更推荐由受控环境文件/密钥管理器注入固定 `AITEAM_CREDENTIAL_KEY`。

腾讯云大陆 VPS 上线（反代 / 进程守护 / 备案与网络）见 [DEPLOY-tencent-vps.md](DEPLOY-tencent-vps.md)。

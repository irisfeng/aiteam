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
  `credential.key` 一起恢复。密钥与数据库不匹配时凭证不可解，不会退回明文。
- **密钥备份必须独立**：`AITEAM_CREDENTIAL_KEY` 应保存在密码管理器/云密钥服务或独立加密介质，
  不要与未加密的数据库快照放在同一目录；文件模式同理，应把 `credential.key` 单独加密托管。
  每次恢复先恢复密钥，再恢复 DB，并实际读取一次 provider/MCP/文生图配置验证可解密。
- 只读查看：`sqlite3 server/data/aiteam.db`。无「删用户」API，清理测试账号需直接操作 DB（owner 隔离，测试号对正常用户不可见）。

### 5.1 历史 `enc:v1:` 凭证升级

旧安全分支曾使用 `enc:v1:`。当前版本会在启动事务中把 provider、MCP 和文生图凭证统一迁移为
`enc1:`，但必须拿到**当时的原始密钥**：

```bash
# 1) 停服并先做 SQLite 一致性备份
# 2) 两把密钥都用原值/固定值，切勿每次启动重新生成
export AITEAM_CREDENTIAL_KEY=<新的固定32字节密钥>
export AITEAM_SECRET_KEY=<生成enc:v1时使用的原始旧密钥>
npm run build
npm start
```

启动成功后只检查前缀数量，不输出任何凭证内容：

```bash
sqlite3 "${AITEAM_DATA_DIR:-server/data}/aiteam.db" "
SELECT 'providers', count(*) FROM providers WHERE api_key LIKE 'enc:v1:%'
UNION ALL SELECT 'mcp_auth', count(*) FROM mcp_servers WHERE auth_token LIKE 'enc:v1:%'
UNION ALL SELECT 'mcp_env', count(*) FROM mcp_servers WHERE env_json LIKE 'enc:v1:%'
UNION ALL SELECT 'image_provider', count(*) FROM app_settings
  WHERE key='image_provider' AND value LIKE '%enc:v1:%';"
```

四项均为 `0` 后删除 `AITEAM_SECRET_KEY`，后续只保留固定的 `AITEAM_CREDENTIAL_KEY`。如果旧密钥
缺失或不匹配，迁移会整笔回滚并拒绝启动；此时应恢复备份并重新录入凭证，不能反复试错真实数据库。

---

## 6. 日志与排错

后台日志 = 你启动时重定向的文件（如 `/tmp/aiteam-server.log`）；前台直接打印。频道内 🚀/🔎/📦/↩️ 系统消息（audit）是任务运行的实时进度。

| 现象 | 原因 / 处理 |
|------|------------|
| 启动报端口占用（EADDRINUSE） | 已有实例在跑 → `pkill -f "node dist/index.js"` 再启 |
| `/aiteam/` 打开空白/404 | 没 build 过前端 → `npm run build`（`web/dist` 不存在时不托管前端） |
| 登录态失效 | 重启换了 `AITEAM_SESSION_SECRET` → 沿用原 secret 或重新登录 |
| 生产报缺少凭证落库密钥 | 固定设置 `AITEAM_CREDENTIAL_KEY`，或恢复与数据库配套的 `credential.key`；不要生成新密钥覆盖旧库 |
| 报历史 `enc:v1` 解密失败 | 需要原 `AITEAM_SECRET_KEY`；找不到时从备份恢复或重新录入凭证 |
| 一直 Mock 模式 | 没配带 key 的 provider → 设置 → 模型 加一个 |
| 任务长时间停在 `doing` | 富方案（检索 + 配图 + 强模型验收 + 返工）端到端常 3–5 分钟，属正常；看 audit 进度，真卡死再排查 |
| audit 出现「联网工具适配…400 Failed to deserialize…降级为仅搜索」 | 国内端点不接受官方 web_search 工具组合，引擎已自动降级用检索插件，**非致命** |
| 智谱 `web_search_prime` 报 1309 | GLM Coding 套餐过期 / 额度问题 |
| MCP 首次调用慢（~20–30s） | stdio MCP 冷启动，之后走缓存连接 |
| 导出的 PPT 中文在别的电脑变样 | .pptx 写的是字体名；默认 `PingFang SC` 适配 Mac，面向 Windows/WPS 客户设 `AITEAM_PPTX_FONT=Microsoft YaHei` 后重启 |

---

## 7. 环境变量参考（运维相关）

| 变量 | 默认 | 说明 |
|------|------|------|
| `AITEAM_SESSION_SECRET` | 开发弱回退 | 会话签名密钥；**生产（`NODE_ENV=production`）未设则拒启**，务必设强随机串（`openssl rand -base64 48`） |
| `AITEAM_CREDENTIAL_KEY` | 开发自动生成 `credential.key` | 凭证落库密钥（32 字节，64 位 hex 或 base64）；生产必须注入固定值或恢复已有文件 |
| `AITEAM_SECRET_KEY` | 空 | 仅供历史 `enc:v1:` 一次性迁移；迁移完成后删除 |
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
| `TASK_MAX_REVISIONS` | `1` | 验收返工上限 |
| `AGENT_CHAIN_DEPTH` | `2` | AI 互相 @ 接力的链深上限（防雪崩） |
| `AITEAM_MCP_CALLS_PER_RUN` | `5` | 单次运行 MCP 调用上限 |
| `AITEAM_MAX_MCP_TOOLS` | `40` | 注入的 MCP 工具数上限 |
| `AITEAM_IMAGES_PER_RUN` | `3` | 单次运行配图张数上限 |
| `AITEAM_UPLOAD_MAX_BYTES` | `20971520`（20MB） | 上传单文件大小上限 |
| `AITEAM_SEARCH_DEDUP` | `1`（开） | 跨插件检索去重；`0`=关 |
| `AITEAM_MCP_STDIO_ALLOW` | 空 | stdio MCP 启动命令白名单扩展（逗号分隔）；默认仅允许 `npx/uvx/uv/node/python/python3/markitdown-mcp` |

> 更多业务/治理开关见 GUIDE.md「治理开关（环境变量）」。

---

## 8. 测试与验证

- `AITEAM_PROVIDER_TIMEOUT_MS`：OpenAI 兼容通道的**空闲超时**（毫秒，默认 120000）。连续这么久收不到任何字节才中止；流式长回复不受总时长限制。
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
AITEAM_SESSION_SECRET=<同一串> AITEAM_CREDENTIAL_KEY=<同一串> PORT=8787 \
  nohup npm start > /tmp/aiteam-server.log 2>&1 &
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/aiteam/   # 期望 200
```

若使用数据目录中的 `credential.key`，上面的 `AITEAM_CREDENTIAL_KEY` 可省略，但升级、迁机和恢复时
必须保留该文件。生产部署更推荐由受控环境文件/密钥管理器注入固定 `AITEAM_CREDENTIAL_KEY`。

腾讯云大陆 VPS 上线（反代 / 进程守护 / 备案与网络）见 [DEPLOY-tencent-vps.md](DEPLOY-tencent-vps.md)。

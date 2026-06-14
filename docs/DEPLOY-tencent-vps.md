# AiTeam 迁移到腾讯云 VPS — 评估与可落地操作手册（最终版）

> 适用场景：腾讯云 VPS（大陆地域为主线）/ 与另两个不相关项目共用一台机 / 内部使用基本无并发 / standalone 邮箱+密码自建登录。
> 本文所有结论已逐行对照仓库源码核实（关键文件:行号见正文，已补全 `server/src/agents/` 子目录前缀）。配置产物可直接落地，占位值（`__FILL_ME__` / `your-...`）需替换。

---

## ★ 本次部署已确认前提（2026-06-14，覆盖 §1 部分待确认项）

| 决策项 | 已确认结论 | 对本文的影响 |
|---|---|---|
| **Q1 地域** | **中国大陆** | 不走官方 Anthropic 直连；时区设 Asia/Shanghai；证书不依赖境外 ACME |
| **Q2 访问方式** | **先用内网 IP 内部访问，暂不上公网域名** | **暂不需要 ICP 备案**；走 §4「纯内网 HTTP」分支（cookie 无 Secure 可正常工作，但要确保网络层隔离）；产品 beta 后再上域名+备案+HTTPS |
| **模型** | **仅国内端点**：对话用 DeepSeek/GLM/Kimi（Anthropic 兼容，UI 配 provider）；文生图用 Seedream/火山方舟（已内置，`ark.cn-beijing.volces.com`） | **不设 `ANTHROPIC_API_KEY`**；豆包仅用于生图，不涉及 LiteLLM |

> 因此：§8.5 的「自动 HTTPS/备案」相关内容**本阶段不适用**；§2/§4 直接采用**内网 HTTP** 路线；§8.2「官方 Anthropic 网关」**本阶段不需要**。
> **仍待你拍板**（见 §11）：另两项目是否已占用 80/443 反代、是否接受改一行 `index.ts` 绑回环、本地旧库是否需保留（建议全新部署）。

---

## 0. 总判与执行摘要

**总判：有条件 GO（GO-WITH-CONDITIONS）。**

技术上完全可迁移，且本项目启动自愈（`finalizeStaleStreaming` 收口中断流式 + `recoverInFlightTasks` 续跑 doing 任务 + `startScheduler`，见 `server/src/index.ts:19-23`）使其天然适配 systemd 的崩溃重启语义。但有 **3 个 blocker 必须在上线窗口内闭合**，否则等于公网裸奔：

1. **8787 绑 0.0.0.0**（`server/src/index.ts:46` `server.listen(PORT, ...)` 无 host 参数）→ 公网直连绕过反代。
2. **`AITEAM_SESSION_SECRET` 缺省静默回退到 git 公开仓库里的硬编码弱密钥** `aiteam-dev-secret-change-me`（`server/src/session.ts:15`，且告警只在 `NODE_ENV=production` 才 `console.warn`、非生产连 warn 都没有、永不拒启）→ 任何人可伪造任意用户（含 admin）的 30 天 HS256 JWT。
3. **`AITEAM_ALLOW_SIGNUP` 默认开放注册 + 首个注册者自动成 admin**（`server/src/auth-routes.ts:12/27`）→ 上线窗口期可被抢注管理员。

这三条都只需配置/一行代码即可堵住，成本极低。闭合后即为干净 GO。

> **关于 MCP「RCE 半径」的重要更正**（原初稿写窄了）：blocker#3 不能简单等价于「锁死 admin = 锁死 MCP 子进程派生」。已核实 `POST /aiteam/api/mcp-servers/:id/test`（`server/src/routes.ts:208`）**只有路由级 `requireUser`、没有 `requireAdmin`**（对比同文件 185/201/216 的 create/toggle/delete 都带 `requireAdmin`），且 `mcp_servers` 是**全局表、无 `owner_id`**（`server/src/db.ts:103`），`listMcpServers/getMcpServer` 不做 owner 过滤。后果：**任何已登录的普通 member 都能枚举全部 MCP server 并 POST 该 test 端点，触发任一已存在 stdio 配置的真实子进程派生**（`testMcpServer → connect → new StdioClientTransport({command,args})`，`server/src/agents/mcp.ts:42/86-90`）。锁死 admin 只挡住「**创建**配置」，挡不住「**触发已存在**配置」。处置见 §7 与 §10。

**还有若干待用户拍板的决策项**（见 §1 和 §11），其中**腾讯云地域是大陆还是海外**是最高优先级——它同时决定「官方 Anthropic 是否可达」「是否需要 ICP 备案」「HTTPS 证书怎么签」三条主线。

---

## 1. 前置确认项（必须先问用户 / 先准备）

| # | 必须确认 | 影响 | 默认假设 |
|---|---------|------|---------|
| Q1 | **VPS 地域：大陆 还是 海外（港/新）？** | 出网（官方 Anthropic 可达性）+ 是否需 ICP 备案 + 证书签发方式 | 大陆地域为主线 |
| Q2 | **访问方式：纯 IP/内网/VPN，还是绑公网域名走 HTTPS？** | 是否需备案、是否需 HTTPS、cookie 是否需 Secure、安全组规则 | 内部用，优先无域名 IP/VPN |
| Q3 | **另两个项目：是否已有反代（Nginx/Caddy）在占 80/443？谁直接 listen 443？用什么 Node 版本/进程管理？统一反代归谁运维？** | 反代是否复用、端口规划、是否全 systemd、443 归属 | 默认全 systemd、复用同一反代 |
| Q4 | **是否接受改一行 `index.ts` 把 listen 绑 127.0.0.1（+ 可选给 MCP test 端点补 requireAdmin）？** | 不接受则只能靠安全组+防火墙双层兜底 | 建议接受（最干净） |
| Q5 | **旧库（本地 `server/data`）里有无要保留的真实数据？** | 决定「全新部署」还是「带旧数据迁移（会遇到空 owner 桶问题）」 | 本地库疑似测试数据，建议全新部署 |
| Q6 | VPS 内存规格（1G/2G/4G）？ | 是否禁止在 VPS 上跑 vite build；MemoryMax 取值 | 按 ≤2GB 保守给值 |
| Q7 | 是否需要异地备份（腾讯云 COS）？备份盘是否独立于数据盘？ | 整机故障时备份是否一起丢 | 先本地 7-14 日轮转 |
| Q8 | 是否会用海外 MCP/HTTP 插件？SSH 出口 IP 是固定还是动态家宽？ | 大陆地域可能不可达；动态 IP 影响 22 端口加固 | 内部用，默认不配 stdio MCP |

**准备物**：SSH 密钥、`openssl rand -base64 48` 生成的会话密钥、首个 admin 邮箱、（若用域名）已备案域名 + 腾讯云免费 DV 证书。

---

## 2. 架构与共存方案

### 2.1 部署形态（已核实）
- npm workspaces 单仓库 `server` + `web`；`npm run build` = 先 `web`(vite build) 再 `server`(tsc)；`npm start` = `node server/dist/index.js`。
- 生产 = **单个 Node 进程**，所有路由挂 **`/aiteam/` 前缀**（`server/src/index.ts:29-43`）：`/aiteam/api/auth`（公开）、`/aiteam/api`（`requireUser`→`withOwner`）、`/aiteam/ws`（WebSocket，path 写死）、`/aiteam/assets`+历史 `/assets`、`/aiteam`（前端静态 + SPA fallback 正则 `/^\/aiteam\/(?!api|ws|assets).*/`）。
- 前端 `web/dist` 路径靠 `__dirname` 相对推算（`server/src/index.ts:36` `join(__dirname,"..","..","web","dist")`），**拷部署时必须保留 `server/dist` 与 `web/dist` 的相对结构**，否则前端静态静默失效（只剩 API/WS）。

### 2.2 `/aiteam/` 前缀是三层硬耦合 —— 反代「不能去前缀」
前缀写死在三处：① Vite `base:'/aiteam/'`（`web/vite.config.*:7`，编进 index.html 的绝对路径资源链接）；② Express 全量挂载；③ `WebSocketServer({server, path:'/aiteam/ws'})` 精确匹配。
**结论**：反代里 `proxy_pass` 末尾**绝不能带斜杠/路径**（带 `/` 会剥前缀 → WS/API/静态全 404）。子域名部署也必须访问 `https://aiteam.example.com/aiteam/`，不能在反代层 rewrite 去前缀。要让子域根即应用，唯一正确做法是改 `vite base` + server 挂载点重新构建，本次不建议。

### 2.3 推荐架构（共用主机）+ 443 归属判定
```
公网 :443 ── 单一反代(Nginx 或 Caddy，按域名/路径分流)
                │
                ├─ /aiteam/* 或 aiteam.子域 → 127.0.0.1:8787  (AiTeam，systemd, user=aiteam)
                ├─ 项目B               → 127.0.0.1:8788  (systemd, user=projb)
                └─ 项目C               → 127.0.0.1:8789  (systemd, user=projc)
```
- **三进程各自只绑 127.0.0.1，端口错开**（8787/8788/8789），各自独立 OS 用户 + 独立 `AITEAM_DATA_DIR` + 各自 systemd unit + cgroup 限额。
- **反代选型**：若另两项目已有 Nginx → 统一用一个 Nginx 单入口（资料最全，国内运维最常见）；全新起且想少写配置 → Caddy。**切勿同机跑两个反代抢 80/443。**
- **路由方式**：内部隔离首选**子域名**（cookie/证书/日志互不串）；只有单域名则用**路径前缀**。两种 + 两反代共 3 份配置都给在 §4。

**【443 归属判定 —— 共用主机最常见的真冲突，部署前必做】**
先看 80/443 现在被谁占：
```bash
ss -ltnp 'sport = :80 or sport = :443'
```
- **情形①：已有 Nginx/Caddy 占着** → 新项目**只在现有反代里加 `server`/`location` 块复用**，绝不新起第二个反代。把本文 §4.3/4.4/4.5 的相应片段并进现有配置即可。
- **情形②：某项目进程直接 `listen 0.0.0.0:443`（自带 TLS，没走反代）** → **必须先把它改成只听 `127.0.0.1` 的后端、由统一反代接管 443**，否则新装 Nginx/Caddy 会 `bind 443 失败` 起不来，两者无法共存。这一步的工作量要在 Q3 里跟该项目 owner 对齐，并明确**统一反代由谁运维**（证书续期、配置变更的责任人）。

---

## 3. 运行时与进程模型

### 3.1 进程管理：选 systemd（不用 pm2）
单机三项目 + 内部低并发下，systemd 是最优：系统自带、开机自启、崩溃重启、journald 日志按容量轮转、cgroup 资源隔离全内置，三项目统一 `systemctl` 管理。pm2 会多一个常驻 daemon（额外内存）+ 自成一套日志/重启体系，且默认日志不轮转。
> 若另两项目已用 pm2，可两套共存（systemd 管 aiteam、pm2 管另两个），但本评估默认全 systemd。

### 3.2 Node 版本与原生模块（blocker 级坑）
- **`better-sqlite3 ^11.10.0` 是绑定 Node ABI 的原生模块**，三个 `package.json` 均无 `engines` 字段（无护栏）。**绝不能把 macOS 的 `node_modules`/`build/Release/*.node` 跨平台拷到 Linux**（require 时抛 `invalid ELF header`/ABI 不匹配）。TS/前端产物（`server/dist`、`web/dist`）可跨平台拷，原生模块不行。
- **构建机与运行机锁同一 Node 大版本（Node 22 LTS）**。换 Node 大版本后必须 `npm rebuild better-sqlite3` 再重启，否则启动即 `ERR_DLOPEN_FAILED`。
- 推荐**混合部署**：本地 `npm run build`（省 VPS 内存，避免共用低配机跑 vite build/tsc 时 OOM）→ rsync `dist` + 锁文件 → VPS 上 `npm ci --omit=dev`（按目标平台拿 better-sqlite3 预编译，命中则零编译）。
- **`npm rebuild better-sqlite3` 只是兜底、不是常规步骤**：`npm ci` 阶段 better-sqlite3 的 install 脚本是 `prebuild-install || node-gyp rebuild`，命中预编译就直接零编译；此时再无条件 `npm rebuild` 反而会**强制 node-gyp 从源码重编**（rebuild 不复用 prebuild-install 的下载语义），在低配共用机上是多余的 CPU/内存开销，且必须已装编译链才不报错。正确做法：
  ```bash
  # npm ci --omit=dev 之后，先验证；只有失败才 rebuild
  node -e "require('better-sqlite3')" 2>/dev/null \
    || { echo "ABI 不匹配，回退编译"; npm rebuild better-sqlite3; }
  ```
  仅在「换过 Node 大版本」或「上面 require 抛 `ERR_DLOPEN_FAILED`/`invalid ELF`」时才需 rebuild。

**【依赖差异硬约束 —— 两种部署模型不可混用】**
`tsc`/`typescript`（server devDeps）与 `vite`/`tailwindcss`/`typescript`（web devDeps）**全是 `devDependencies`**。
- **模型 A（主线，推荐）本地构建**：VPS 上永远 `npm ci --omit=dev`，**VPS 不需要也不应装 devDeps**；构建只在本地做，rsync `dist` 上去（见 §6.1）。
- **模型 B（备选）VPS 上 git-pull + `npm run build`**：该机**必须 `npm ci`（含 devDeps，不能加 `--omit=dev`）**，否则 `npm run build` 会 `command not found: tsc/vite` 或 `Cannot find module 'typescript'` 直接失败。
- **二者不可混用**：一旦在 VPS 上按模型 A 习惯 `--omit=dev` 装依赖，再去跑模型 B 的 `npm run build`，必崩。下文 §6.2 升级流程按你选的模型走，已分别标注。

### 3.3 无 dotenv —— 环境变量必须由 systemd 注入
全仓无 dotenv，应用只 `process.env.*`。所有关键变量必须经 systemd `EnvironmentFile` 注入（见 §4）。缺失后果：`AITEAM_SESSION_SECRET` 静默弱密钥（blocker，且漏设 `NODE_ENV=production` 连警告都不打）、`ANTHROPIC_API_KEY` 缺失进 Mock 模式。

### 3.4 内存足迹与双重护栏
常态单进程 80-200MB、CPU 近空闲。峰值三处：pptxgenjs 拼 PPT、图片生成（`AITEAM_IMAGES_PER_RUN` 默认 3）、MCP 用 `StdioClientTransport`（典型 npx）拉常驻子进程（`server/src/agents/mcp.ts:42`，国内联网拉包慢且占内存，不受应用 `--max-old-space-size` 约束、只受 cgroup 约束）。
**护栏**：`NODE_OPTIONS=--max-old-space-size=512`（应用堆）+ systemd `MemoryMax`（兜住含子进程整组，超限只 OOM 本服务不殃及另两项目）+ `TasksMax`（限 MCP/npx 派生子进程数）。

---

## 4. 配置产物（直接落地）

> 统一约定：仓库部署在 `/opt/aiteam`、数据在 `/var/lib/aiteam`、密钥文件 `/etc/aiteam/aiteam.env`、运行用户 `aiteam`、运维脚本 `/opt/aiteam/ops/`。

### 4.1 systemd 单元 `/etc/systemd/system/aiteam.service`

```ini
[Unit]
Description=AiTeam (standalone) single Node process: Express + WS + sqlite + scheduler
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=aiteam
Group=aiteam
WorkingDirectory=/opt/aiteam
# 应用无 dotenv —— 关键环境变量必须由此注入（密钥单独放 600 文件）
EnvironmentFile=/etc/aiteam/aiteam.env
Environment=NODE_OPTIONS=--max-old-space-size=512
# 绝对路径 node；若用 nvm 改成 /home/aiteam/.nvm/versions/node/v22.x.x/bin/node
ExecStart=/usr/bin/node server/dist/index.js
Restart=always
RestartSec=3
# 崩溃风暴防抖：10 分钟内重启超 5 次就停下等人工，避免拖垮共用主机
StartLimitIntervalSec=600
StartLimitBurst=5
KillSignal=SIGTERM
TimeoutStopSec=20
StandardOutput=journal
StandardError=journal
SyslogIdentifier=aiteam
# cgroup 资源隔离：兜住含 npx/MCP 子进程整组，超限只 OOM 本服务（按机器内存调整）
MemoryHigh=768M
MemoryMax=1G
CPUQuota=150%
TasksMax=256
# 沙箱加固：被打穿也碰不到另两项目
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
# 仅放开本项目数据目录可写（含明文 key 的 sqlite + 生成图 assets）
ReadWritePaths=/var/lib/aiteam

[Install]
WantedBy=multi-user.target
```

> **关于 127.0.0.1 监听**：当前 `server/src/index.ts:46` `server.listen(PORT, ...)` 没传 host。要真正绑回环，需把它改成 `server.listen(PORT, process.env.AITEAM_HOST ?? '127.0.0.1', ...)`（推荐，见 §10）。**在改码之前，systemd 无法替代——必须靠腾讯云安全组 + 主机防火墙双层挡住 8787。**
>
> **若将来要配 stdio MCP**：上面的 `ProtectSystem=strict` + `ProtectHome=true` + `PrivateTmp=true` 会让 `npx` 首次联网拉包**无可写缓存目录而失败**（写不进 `~/.npm`、受限的 `/tmp`）。届时需为 npm cache 补一条 `ReadWritePaths`（如 `/var/lib/aiteam/.npm` 并设 `Environment=npm_config_cache=/var/lib/aiteam/.npm`），或预先把 MCP server 包装好、不在运行期联网拉包。内部场景默认不配 stdio MCP 则无此问题。

### 4.2 环境变量文件 `/etc/aiteam/aiteam.env`
（权限 `chmod 600 && chown aiteam:aiteam`，绝不进 git）

```bash
# /etc/aiteam/aiteam.env  —— chmod 600, chown aiteam:aiteam
# NODE_ENV 必设 production：否则连 session.ts:12 的弱密钥告警都不会出现（静默用弱密钥）
NODE_ENV=production
# 监听：配合 §10 一行改动后绑回环；未改码前此变量无效，仍需防火墙兜底
AITEAM_HOST=127.0.0.1
PORT=8787
# 数据与生成图资产目录（WAL：aiteam.db + -wal + -shm 三件套；含明文模型 key）
AITEAM_DATA_DIR=/var/lib/aiteam

# ===== standalone 鉴权（本场景核心）=====
AITEAM_AUTH_MODE=standalone
# 会话 JWT 密钥 —— 生产必配！缺省回退 git 公开弱密钥可伪造任意会话。生成：openssl rand -base64 48
AITEAM_SESSION_SECRET=__FILL_ME_openssl_rand_base64_48__
# 管理员白名单（小写邮箱，逗号分隔）——保证只有白名单注册后才是 admin，避免被"首个用户"兜底抢注
AITEAM_ADMIN_EMAILS=admin@yourco.internal
# 部署时先设 1 让首个 admin 能注册；建好首个 admin 后立刻改 0 并重启，关闭公开注册
AITEAM_ALLOW_SIGNUP=1

# ===== 模型（key 主路径在产品 UI 配、存 sqlite，不强依赖此处）=====
# 大陆地域：默认不要设 ANTHROPIC_API_KEY（设了会建官方 envClient 走真实计费）。
# 留空首启进 Mock，登录后到 UI 配 DeepSeek 等国内 provider。
# ANTHROPIC_API_KEY=
# 若确需走官方 Claude 又在大陆：在 VPS 自建到 api.anthropic.com 的网关后，这样把 envClient 整体改向网关：
# ANTHROPIC_API_KEY=sk-ant-...
# ANTHROPIC_BASE_URL=https://你的网关域名/    # SDK 原生读此 env（见 §8.2），envClient 即走网关
# AITEAM_STRONG_MODEL=claude-opus-4-8
# AITEAM_LIGHT_MODEL=claude-haiku-4-5

# ===== 成本/滥用护栏（内部场景兜底，按日用量 2-3 倍设；0=不限）=====
# 日界用【系统时区】算 setHours(0,0,0,0)，务必先把系统 TZ 设为 Asia/Shanghai（见 §8.4 共用主机告警）
AITEAM_DAILY_TOKEN_BUDGET=2000000
# AITEAM_IMAGES_PER_RUN=3
# AITEAM_MCP_CALLS_PER_RUN=5
# AGENT_CHAIN_DEPTH=2
# TASK_MAX_REVISIONS=1
```

### 4.3 反代方案 A —— 单域名 + 路径前缀（Nginx）`/etc/nginx/conf.d/multi-app.conf`

```nginx
# 三项目共用一台腾讯云 VPS，单 Nginx 公网入口，按路径前缀分流。
# AiTeam 强依赖 /aiteam/ 前缀 —— proxy_pass 末尾【不带斜杠/路径】，原样转发 URI。
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 80;
    server_name example.com;
    # 生产建议上 HTTPS（大陆：用腾讯云免费 DV 证书手动挂载，见 §8.5；域名需已备案）
    # listen 443 ssl; ssl_certificate /etc/nginx/ssl/example.com.crt; ssl_certificate_key /etc/nginx/ssl/example.com.key;

    # ---- AiTeam（standalone）：保留 /aiteam/ 前缀 → 127.0.0.1:8787 ----
    location /aiteam/ {
        proxy_pass http://127.0.0.1:8787;     # 末尾不带 /，URI 含 /aiteam/ 原样转发
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;            # WS 握手（/aiteam/ws）
        proxy_set_header Connection $connection_upgrade;   # WS 握手
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;   # 流式输出 + WS 长连接，避免默认 60s 误断
        proxy_send_timeout 3600s;
        # 注意：应用层 express.json 限 1MB（见 §7「请求体双重上限」），25m 只是放宽 nginx 这层
        client_max_body_size 25m;
        gzip on;
        gzip_types text/css application/javascript application/json image/svg+xml;
    }
    # AiTeam 历史 /assets/* 兼容链接（应用仍挂着该兼容路由 server/src/index.ts:33）
    location /assets/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # ---- 项目 B / C ----
    location /b/ { proxy_pass http://127.0.0.1:8788; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }
    location /c/ { proxy_pass http://127.0.0.1:8789; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }

    location = / { return 302 /aiteam/; }   # 根路径引导（可选）
}
```

### 4.4 反代方案 B —— 子域名隔离（Nginx，推荐内部隔离）`/etc/nginx/conf.d/multi-app-subdomain.conf`

```nginx
# 子域名隔离：cookie/证书/日志互不干扰。AiTeam 仍必须访问 https://aiteam.example.com/aiteam/。
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 80;
    server_name aiteam.example.com;
    # listen 443 ssl; ssl_certificate ...; ssl_certificate_key ...;
    location = / { return 302 /aiteam/; }   # 子域根无路由，引导到带前缀入口
    location / {
        proxy_pass http://127.0.0.1:8787;    # 原样转发，URI 含 /aiteam/
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s; proxy_send_timeout 3600s;
        client_max_body_size 25m;
        gzip on; gzip_types text/css application/javascript application/json image/svg+xml;
    }
}
server { listen 80; server_name b.example.com; location / { proxy_pass http://127.0.0.1:8788; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; } }
server { listen 80; server_name c.example.com; location / { proxy_pass http://127.0.0.1:8789; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; } }
```

### 4.5 反代备选 —— Caddy `/etc/caddy/Caddyfile`
（替换现有 coworker 版 `deploy/Caddyfile`；两种写法二选一）

```caddy
# Caddy 自动处理 /aiteam/ws 的 WebSocket upgrade，无需额外头配置。保留 /aiteam/ 前缀，URI 原样转发。
#
# ⚠️ 大陆地域用 Caddy「自动 HTTPS」要慎重（见下方说明）：
#   - 即便域名已备案，Caddy 默认 CA 是境外 Let's Encrypt，大陆机访问 ACME 端点可能慢/被限速；
#   - HTTP-01 验证要求 80 端口对全网可达，这与 §4.6「内部场景 80 不对全网开放」直接互斥。
#   - 大陆务实做法：关掉自动签发，改用腾讯云免费 DV 证书手动挂载（见 §8.5）；或用 DNS-01（需 DNS API 凭证）。

# ===== 方案A：单域名 + 路径前缀（手动证书示例）=====
example.com {
    tls /etc/caddy/ssl/example.com.crt /etc/caddy/ssl/example.com.key   # 大陆：手动挂腾讯云 DV 证书
    encode zstd gzip
    handle /aiteam/* { reverse_proxy 127.0.0.1:8787 }
    handle /assets/* { reverse_proxy 127.0.0.1:8787 }   # 历史兼容
    handle /b/*      { reverse_proxy 127.0.0.1:8788 }
    handle /c/*      { reverse_proxy 127.0.0.1:8789 }
    handle /         { redir /aiteam/ 302 }
}

# ===== 方案B：子域名隔离（与方案A二选一）=====
aiteam.example.com {
    tls /etc/caddy/ssl/aiteam.example.com.crt /etc/caddy/ssl/aiteam.example.com.key
    encode zstd gzip
    redir / /aiteam/ 302
    reverse_proxy 127.0.0.1:8787
}
b.example.com { reverse_proxy 127.0.0.1:8788 }
c.example.com { reverse_proxy 127.0.0.1:8789 }

# ===== 纯内网/无备案：HTTP 直跑（cookie 无 Secure 标志可正常工作）=====
# http://内网IP { reverse_proxy 127.0.0.1:8787 }
#
# 海外港/新地域：可保留自动 HTTPS（删掉 tls 行让 Caddy 自动签发），ACME 通常可达。
```

### 4.6 主机防火墙 + 安全组检查 `setup-firewall.sh`
（**默认按「纯内网/VPN 内部用」最小放行**；公网域名场景按注释切换）

```bash
#!/usr/bin/env bash
set -euo pipefail
# AiTeam 迁移：主机防火墙（与腾讯云安全组双层）。8787/8788/8789 永不入站。
SSH_PORT=22

# === 选一种访问模式 ===
MODE="internal"        # internal=纯内网/VPN（默认，最小放行）  public=公网域名(已备案)
ALLOW_CIDR="10.0.0.0/8"  # internal 模式下允许访问的来源：办公固定出口/VPN 网段，按实际改

if command -v ufw >/dev/null 2>&1; then            # Ubuntu/Debian
  ufw default deny incoming; ufw default allow outgoing
  ufw allow ${SSH_PORT}/tcp
  if [ "$MODE" = "internal" ]; then
    ufw allow from "$ALLOW_CIDR" to any port 443 proto tcp   # 443 只放给可信网段；80 不开（无 ACME 需求）
  else
    ufw allow 80/tcp; ufw allow 443/tcp                      # 公网域名：80(ACME/跳转)+443 对全网
  fi
  ufw --force enable; ufw status verbose
elif command -v firewall-cmd >/dev/null 2>&1; then # CentOS/TencentOS/RHEL
  firewall-cmd --permanent --add-port=${SSH_PORT}/tcp
  if [ "$MODE" = "internal" ]; then
    firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=${ALLOW_CIDR} port port=443 protocol=tcp accept"
  else
    firewall-cmd --permanent --add-service=http --add-service=https
  fi
  firewall-cmd --reload; firewall-cmd --list-all
else
  echo '未检测到 ufw/firewalld，请手动配置主机防火墙。'
fi

cat <<'NOTE'
--- 腾讯云安全组（控制台侧，与主机防火墙是两层，都要配，取最小必要）---
[internal 纯内网/VPN] 入站：TCP 443 仅放行办公固定出口IP/VPN网段；80 不开；TCP 22 锁固定IP/32。
[public 公网域名]    入站：TCP 443 (0.0.0.0/0)；TCP 80 (0.0.0.0/0，仅 ACME+跳转，且域名已 ICP 备案)；TCP 22 锁固定IP/32。
绝不添加：8787、8788、8789 及另两项目后端口。

--- SSH 22 端口实务 ---
sshd_config：PasswordAuthentication no、PermitRootLogin prohibit-password；装 fail2ban。
动态家宽 IP（大陆常见，无法锁 /32）三选一：
  ① 用腾讯云堡垒机/CFW 跳板，业务安全组 22 只放堡垒机内网IP；
  ② 临时放行：每次办公前在控制台/CLI 临时加自己当前公网IP，结束删；
  ③ DDNS + 定时脚本刷安全组（腾讯云 cvm SDK 改 SecurityGroupPolicy）。
NOTE
```

### 4.7 一次性大陆环境准备 `setup-tencent-mainland.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
# 大陆腾讯云 VPS 一次性环境准备：时区校时 + Node 22 + npm/二进制镜像 + 编译链（大陆默认预装）

# 1) 时区设 Asia/Shanghai（每日 token 预算 setHours 跟系统时区；调度/图表硬编码 Asia/Shanghai，见 §8.4）
sudo timedatectl set-timezone Asia/Shanghai
sudo timedatectl set-ntp true
timedatectl status | grep -E 'Time zone|System clock|NTP'

# 2) Node 22 + 编译链（大陆镜像未命中时 better-sqlite3 走源码编译是【常态】，编译链默认预装而非备用）
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -            # Ubuntu/Debian
  sudo apt-get install -y nodejs build-essential python3 make g++
  # CentOS/TencentOS: curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && sudo yum install -y nodejs gcc-c++ make python3
fi
node -v

# 3) npm registry 镜像
npm config set registry https://mirrors.cloud.tencent.com/npm/     # 或 https://registry.npmmirror.com

# 4) better-sqlite3 预编译二进制镜像 —— 用 prebuild-install 真正识别的变量名（避免回落 GitHub 超时）
#    变量名因 better-sqlite3 版本而异，下面两种都写进 npm 全局配置，命中其一即可；最稳是部署时再 export 一遍。
npm config set better_sqlite3_binary_host "https://registry.npmmirror.com/-/binary/better-sqlite3"
npm config set disturl "https://registry.npmmirror.com/-/binary/node"   # 源码编译时取 node headers 用
echo 'export BETTER_SQLITE3_BINARY_HOST_MIRROR=https://registry.npmmirror.com/-/binary/better-sqlite3' | sudo tee /etc/profile.d/better-sqlite3-mirror.sh

# 5) 运行用户与目录
sudo useradd -r -s /usr/sbin/nologin aiteam || true
sudo mkdir -p /opt/aiteam /etc/aiteam /var/lib/aiteam /opt/aiteam/ops
sudo chown -R aiteam:aiteam /var/lib/aiteam
echo '环境准备完成。务必在 npm ci 后执行：node -e "require('"'"'better-sqlite3'"'"')" 验证原生模块可加载。'
```

### 4.8 journald 容量上限 `/etc/systemd/journald.conf.d/aiteam-cap.conf`

```ini
# 共用主机省磁盘：放此 drop-in 后 sudo systemctl restart systemd-journald 生效。三项目共享这份全局配额。
[Journal]
Storage=persistent
SystemMaxUse=500M
SystemMaxFileSize=50M
MaxRetentionSec=2week
```

---

## 5. 数据迁移与备份

### 5.1 完整数据集只有一处
`AITEAM_DATA_DIR` 目录 = `aiteam.db`（WAL，`server/src/db.ts:14` `db.pragma("journal_mode = WAL")`）+ 运行时伴生 `-wal`/`-shm` + `assets/` 子目录（文生图落盘，被文档正文里的 `/aiteam/assets/<id>.png` 引用）。
**本地实测现状：`aiteam.db` 909KB，但 `aiteam.db-wal` 高达 4.1MB —— 绝大部分写入还压在 WAL 里未合并。** 全仓**无任何 `SIGTERM`/`SIGINT`/`db.close()`/`wal_checkpoint`**（已 grep 确认为空），所以运行目录永远「拷了就可能坏/丢」。

### 5.2 黄金规则：绝不 `cp` 单个 `aiteam.db`
两条正确路线：① 在线一致快照 `sqlite3 aiteam.db "VACUUM INTO '/tmp/snap.db'"`（走事务自动并 WAL，产出干净单文件，对 better-sqlite3 在线进程安全，低并发几乎零影响）；② 停机后整组拷 `aiteam.db` + `-wal` + `-shm` 三个一起（缺一不可）。迁移首选 VACUUM INTO 产物。

### 5.3 关键决策：全新部署 vs 带旧数据（owner_id 空桶陷阱）
旧单用户库带上 VPS 首启会自动跑 owner_id 迁移（`server/src/db.ts:154` 补 `owner_id DEFAULT ''` + `db.ts:173+` agents 表 `UNIQUE(name)`→`UNIQUE(owner_id,name)` 重建表）。**含义**：旧数据全部归到 `owner_id=''` 空桶，而 standalone 注册的用户 owner 是 `user:<id>`（`server/src/ownerScope.ts`），所有查询强制 `WHERE owner_id=currentOwner()`（fail-closed）→ **旧数据物理在库里但任何用户登录后都看不见**（不是 bug，是多租户隔离的正确行为）。
- **路线 a（推荐）全新部署**：`AITEAM_DATA_DIR` 指向空目录，首启自动建表，配 `AITEAM_ADMIN_EMAILS` 白名单注册首个 admin，旧库不带上去。本地库才 909KB 疑似测试数据，强烈建议走这条。
- **路线 b 保留旧数据**：VACUUM INTO 带上去，接受「旧数据归空 owner、新登录看不到」；若要某用户接管，需注册该用户拿到 `user:<id>` 后用 sqlite3 手工 `UPDATE` 改 owner_id。

> **核实后的「哪些表带 owner_id」**（手工迁移只动这 8 张业务表）：
> `agents` / `channels` / `messages` / `tasks` / `approvals` / `documents` / `routines` / `projects`（均 `owner_id TEXT NOT NULL DEFAULT ''`，见 `server/src/db.ts:17-135`）。
> **不要动的全局表 / 无 owner_id 表**：`users`（standalone 用户表，owner 由此派生）、`providers`（**全局共享，admin 配一套 key 所有用户共用**，`db.ts:375`）、`mcp_servers`（**全局**，`db.ts:103`）、`skills`、`app_settings`、`agent_memory`（`db.ts:77`，无 owner_id）、`channel_agents`（`db.ts:36`，关联表）。迁移前务必先备份。

### 5.4 备份脚本 `/opt/aiteam/ops/backup.sh`

```bash
#!/usr/bin/env bash
# AiTeam 一致性备份（WAL 安全）：VACUUM INTO 干净单库 + assets 打包 + 轮转
set -euo pipefail
DATA_DIR="${AITEAM_DATA_DIR:-/var/lib/aiteam}"
BACKUP_ROOT="/var/backups/aiteam"   # 独立于 DATA_DIR，勿落回数据盘自身
KEEP=14
DB="$DATA_DIR/aiteam.db"
TS="$(date +%Y%m%d-%H%M%S)"; DEST="$BACKUP_ROOT/$TS"
mkdir -p "$DEST"; chmod 700 "$BACKUP_ROOT"

# 1) DB：VACUUM INTO 干净单库（自动并 WAL，无伴生文件）
sqlite3 "$DB" "VACUUM INTO '$DEST/aiteam.db'"
# 2) 校验快照（坏库早发现）
sqlite3 "$DEST/aiteam.db" 'PRAGMA integrity_check' | head -1
# 3) assets 打包（生成图，含明文链接）
[ -d "$DATA_DIR/assets" ] && tar -czf "$DEST/assets.tar.gz" -C "$DATA_DIR" assets
# 4) 校验和 + 锁权限（备份含明文模型 key）
( cd "$DEST" && sha256sum aiteam.db assets.tar.gz 2>/dev/null > SHA256SUMS || true )
chmod -R 600 "$DEST"/* 2>/dev/null || true
# 5) 轮转
ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -rf
# 6) 可选异地：含明文 key 必须先加密再传 COS（age/gpg），COS 同地域走内网免流量费
# age -r <你的age公钥> -o "$DEST/aiteam.db.age" "$DEST/aiteam.db" && rm -f "$DEST/aiteam.db"
# coscmd upload -r "$DEST" "cos://your-bucket/aiteam/$TS/" || echo "[warn] COS 上传失败"
echo "[ok] backup -> $DEST"
```

cron（`crontab -e`，凌晨低峰，避开例行任务密集时刻）：
```cron
30 3 * * * /opt/aiteam/ops/backup.sh >> /var/log/aiteam-backup.log 2>&1
```

### 5.5 一次性迁移 `migrate-once.sh`（仅路线 b 用）

```bash
#!/usr/bin/env bash
# 本地旧库 -> 腾讯云 VPS（仅当确定保留旧数据时；全新部署跳过整个脚本）
set -euo pipefail
# ===== A. 本地（macOS）=====
LOCAL_DATA="/Users/tony/Documents/GitHub/aiteam/server/data"
WORK="$(mktemp -d)"
# 绝不能 cp aiteam.db：本地 -wal 有 4.1MB 未合并数据会丢
sqlite3 "$LOCAL_DATA/aiteam.db" "VACUUM INTO '$WORK/aiteam.db'"
sqlite3 "$WORK/aiteam.db" 'PRAGMA integrity_check' | head -1
tar -czf "$WORK/assets.tar.gz" -C "$LOCAL_DATA" assets
VPS="root@your-tencent-vps"
scp "$WORK/aiteam.db" "$WORK/assets.tar.gz" "$VPS:/tmp/"
echo "[ok] 已上传，接着登录 VPS 执行 B 段"
# ===== B. VPS（登录后手动跑）=====
# sudo systemctl stop aiteam
# DATA_DIR=/var/lib/aiteam; sudo mkdir -p $DATA_DIR
# sudo rm -f $DATA_DIR/aiteam.db $DATA_DIR/aiteam.db-wal $DATA_DIR/aiteam.db-shm   # 清脏 WAL 伴生文件
# sudo mv /tmp/aiteam.db $DATA_DIR/aiteam.db
# sudo rm -rf $DATA_DIR/assets && sudo tar -xzf /tmp/assets.tar.gz -C $DATA_DIR
# sudo chown -R aiteam:aiteam $DATA_DIR && sudo chmod -R 750 $DATA_DIR
# sudo systemctl start aiteam && journalctl -u aiteam -n 50 --no-pager   # 看 owner_id/agents 迁移无报错
```

### 5.6 恢复 `/opt/aiteam/ops/restore.sh`（恢复时必须清脏 WAL）

```bash
#!/usr/bin/env bash
# 从备份恢复（含季度恢复演练）。用法：restore.sh /var/backups/aiteam/20260614-033000
set -euo pipefail
SRC="${1:?用法: restore.sh <备份目录>}"; DATA_DIR="/var/lib/aiteam"; SERVICE="aiteam"
[ -f "$SRC/aiteam.db" ] || { echo "找不到 $SRC/aiteam.db"; exit 1; }
sqlite3 "$SRC/aiteam.db" 'PRAGMA integrity_check' | head -1    # 先验备份本身
sudo systemctl stop "$SERVICE"
# 关键：清掉现存库与任何脏 WAL 伴生文件，否则陈旧 -wal/-shm 会污染恢复结果
sudo rm -f "$DATA_DIR/aiteam.db" "$DATA_DIR/aiteam.db-wal" "$DATA_DIR/aiteam.db-shm"
sudo cp "$SRC/aiteam.db" "$DATA_DIR/aiteam.db"
[ -f "$SRC/assets.tar.gz" ] && { sudo rm -rf "$DATA_DIR/assets"; sudo tar -xzf "$SRC/assets.tar.gz" -C "$DATA_DIR"; }
sudo chown -R aiteam:aiteam "$DATA_DIR" && sudo chmod -R 750 "$DATA_DIR"
sudo systemctl start "$SERVICE"; sleep 2
sqlite3 "$DATA_DIR/aiteam.db" 'PRAGMA integrity_check' | head -1
echo "[ok] 恢复完成。登录 UI 抽查文档里 /aiteam/assets/*.png 能否加载。建议季度演练一次。"
```

---

## 6. 部署脚本（混合部署 + 升级/回滚 runbook）

### 6.1 首次/日常部署 `deploy-aiteam.sh`（本地执行，模型 A 主线）

```bash
#!/usr/bin/env bash
set -euo pipefail
VPS=root@your-tencent-vps
REMOTE=/opt/aiteam
# 0. 首次：先在 VPS 跑 setup-tencent-mainland.sh（Node22 + 镜像 + 编译链 + 用户目录）
# 1. 本地构建（省 VPS 内存，避免共用低配机 OOM）
npm ci && npm run build      # 先 web(vite build) 再 server(tsc)
# 2. 同步源码 + 两个 dist + 锁文件；node_modules 不传（原生模块要在目标机重装），保留相对结构
rsync -az --delete \
  --include='server/' --include='server/dist/***' --include='server/package.json' \
  --include='web/' --include='web/dist/***' \
  --include='package.json' --include='package-lock.json' \
  --exclude='node_modules' --exclude='server/data' --exclude='.git' \
  ./ "$VPS:$REMOTE/"
# 3. VPS 只装运行期依赖（--omit=dev：VPS 不需要 tsc/vite），命中预编译即零编译
#    首次若镜像未命中走源码编译，可达数分钟且需 build-essential/python3 在位；
#    编译失败时 set -e 按设计中止部署——这是护栏不是 bug，装齐编译链或修镜像后重跑。
ssh "$VPS" "cd $REMOTE && \
  export npm_config_better_sqlite3_binary_host=https://registry.npmmirror.com/-/binary/better-sqlite3 && \
  npm ci --omit=dev && \
  node -e \"require('better-sqlite3')\" || npm rebuild better-sqlite3 && \
  chown -R aiteam:aiteam $REMOTE"
# 4. 安装/刷新 systemd 并重启
scp /etc/systemd/system/aiteam.service "$VPS:/etc/systemd/system/aiteam.service" 2>/dev/null || true
ssh "$VPS" 'systemctl daemon-reload && systemctl enable aiteam && systemctl restart aiteam && systemctl status aiteam --no-pager'
```

### 6.2 升级 runbook（两种模型分别给）+ 回滚硬约束

**模型 A（推荐，本地构建）升级**：在本地重跑 §6.1 的 `deploy-aiteam.sh` 即可——本地 `npm run build` → rsync `dist` → VPS `npm ci --omit=dev`。VPS 永远不需要 devDeps。

**模型 B（VPS 上 git-pull 构建）升级**（仅当你坚持在 VPS 上构建）：
① `systemctl stop aiteam` → ② 备份 DB（停服后 WAL 已收口，`ops/backup.sh`）→ ③ `git pull --ff-only` → ④ **`npm ci`（必须含 devDeps，⚠️ 不可加 `--omit=dev`，否则缺 tsc/vite 构建失败；换过 Node 大版本再 `npm rebuild better-sqlite3`）** → ⑤ `npm run build` → ⑥ `systemctl start aiteam` → ⑦ 健康探针（见 §9）。

**回滚（含跨 owner_id 迁移版本的硬约束）**：
`systemctl stop` → `git checkout <旧commit>` → `npm ci`（同模型选项）→ **把备份的 `aiteam.db` 拷回（先清脏 `-wal`/`-shm`）** → `npm run build`（模型B）或回滚本地 dist 再 rsync（模型A）→ `start` → 探针。
> ⚠️ **owner_id 迁移是对同一个 `aiteam.db` 的原地、单向 schema 变更**（`server/src/db.ts:154` 补列 + `db.ts:173+` `agents` 表**重建**改唯一约束）。**已被新版本迁移过的库，旧代码可能不认识新 schema（新增列/改约束）而启动即报错**。因此跨过 owner_id 迁移版本回滚时，**必须连库一起回到「迁移前的备份 DB」，不能只 `git checkout` 旧代码而保留已迁移的库**。备份是唯一回滚保险。
> **env 文件也要对应版本**（无 dotenv，回滚别忘了 env）。

---

## 7. 安全加固

| 项 | 现状（源码核实） | 落地动作 |
|---|---|---|
| **8787 绑 0.0.0.0** | `server/src/index.ts:46` 无 host 参数 | §10 一行改绑 127.0.0.1 + 安全组只放 443(/80) + ufw/firewalld 双层（blocker） |
| **会话密钥静默弱回退** | `server/src/session.ts:15` 回退 `aiteam-dev-secret-change-me`；告警仅 `NODE_ENV=production` 才 `console.warn`（`session.ts:12`），漏设 `NODE_ENV` 连 warn 都没有，永不拒启 | `openssl rand -base64 48` 写入 EnvironmentFile(600) + 确保 `NODE_ENV=production`；建议加 fail-fast（§10）（blocker） |
| **开放注册 + 首注册成 admin** | `server/src/auth-routes.ts:12/27` | 部署前设 `AITEAM_ADMIN_EMAILS` 白名单 → 注册首个 admin → 立刻 `AITEAM_ALLOW_SIGNUP=0` 重启（blocker） |
| **MCP test 端点可被任意 member 触发 stdio 子进程** | `routes.ts:208` `/mcp-servers/:id/test` **只有 requireUser、无 requireAdmin**；`mcp_servers` 全局无 owner_id（`db.ts:103`），`listMcpServers` 不过滤 → 任何登录 member 可枚举并触发已存在 stdio server 派生（`agents/mcp.ts:42/86-90`） | **① 内部场景坚决不配任何 stdio MCP（args 不放可执行命令，最稳）；② 建议给 test 端点补 requireAdmin（§10）；③ 即便不配，专用低权限用户 + systemd 沙箱限制爆破半径。⚠️ 不要把「锁死 admin」当成这条链路的唯一闸门——它现在是 member 而非仅 admin 能触发** |
| **cookie 无 Secure 标志** | `auth-routes.ts:14` 只有 `httpOnly`+`sameSite=lax` | 走公网域名必须上 HTTPS（反代终止 TLS，Node 仍听明文 127.0.0.1）。纯内网 HTTP 可接受但必须网络层隔离 |
| **模型 key/MCP auth_token 明文存 sqlite** | `db.ts` `api_key`/`auth_token` 明文 | data 目录 `chmod 700`、db `600`、属主 aiteam；备份加密后才上云存储 |
| **三项目横向感染** | 默认同用户/共享目录可互读 | 每项目独立 OS 用户 + systemd 沙箱（`ProtectSystem=strict`/`ReadWritePaths` 收窄）+ 独立 data |
| **成本护栏全关** | `agents/engine.ts:344` `DAILY_TOKEN_BUDGET` 默认 0=不限 | 设为日用量 2-3 倍兜底（注意 §8.4 时区日界） |

> **WebSocket 鉴权与 owner 隔离（核实结论：是安全的）**：虽然 Express 层 `/aiteam/ws` 未挂 `requireUser`（`index.ts:43` 直接 `attachBus`），但 **`attachBus` 内部在 WS 握手时用 `resolveUserId` 校验 `aiteam_session` cookie，未登录直接 `ws.close(4401)`**（`server/src/bus.ts:14-32`）；**`broadcast` 取 `currentOwner` 做 fail-closed 定向广播，仅推给同 owner 的连接、无 owner 上下文时一律跳过**（`bus.ts:55-66`）。因此**一个登录 member 收不到他人 owner 的总线事件**，跨用户串台已在代码层堵住——这是好消息，无需额外加固。
>
> **请求体双重上限（一个被原初稿误述的点）**：应用层 `express.json({limit:"1mb"})`（`index.ts:26`）**限死 JSON body 1MB**。真正会被它卡住的是「超长 JSON 提问 / 粘贴大段上下文」的 POST（返回 413），**与生成图/pptx 导出无关**（导出是下行响应，不受 `client_max_body_size` 约束）。nginx 的 `client_max_body_size 25m` 只放宽反代这一层，1MB 这层要放宽**得改码**（`express.json({limit:"5mb"})`）——若内部确有粘贴长文需求，列为可选源码改动。
>
> **cookie 与 trust proxy 注意**：若后续硬编码 `secure:true`，必须同时 `app.set('trust proxy', 1)` 让 Express 识别 `X-Forwarded-Proto`，否则反代终止 TLS 后 Express 认为是 http、拒发 cookie。

---

## 8. 中国大陆与腾讯云专项

### 8.1 地域决定一切（最高优先级）
所有模型出网走「provider `base_url`」单一通道（`server/src/agents/engine.ts:174` `new Anthropic({apiKey, baseURL})`）；web_search/web_fetch 是模型服务端工具，随该 base_url 在模型侧执行；**唯一例外是文生图默认走火山方舟 Seedream `https://ark.cn-beijing.volces.com/api/v3`**（`server/src/agents/images.ts:14` `DEFAULT_IMAGE_BASE_URL`，北京节点，大陆通；该值也可被 UI 里 image-provider 的 `base_url` 覆盖）。
- **分支A（大陆，推荐主线）**：出网受限但国内端点全通、可能需备案。
- **分支B（海外港/新）**：可直连官方 Anthropic、通常无需大陆 ICP，但对国内用户延迟更高。

### 8.2 出网可达性结论表（大陆视角）
| 端点 | 大陆可达 | 说明 |
|---|---|---|
| 官方 `api.anthropic.com` | ✗ 需代理/网关 | 见下方「envClient 改向」更正 |
| DeepSeek `api.deepseek.com/anthropic`（主力） | ✓ | UI 配 provider，勾 web_tools 启用联网检索 |
| GLM/Kimi/MiniMax 国内端点 | ✓ | UI 配 |
| 火山方舟 Seedream（图） | ✓ | 项目默认图像端点，UI 填 key 即可 |

> **【重要更正：官方 envClient 的 baseURL 并非「锁死不可配」】**
> 初稿断言「`envClient` 的 baseURL 锁死 `api.anthropic.com`、不能靠 env 改向代理」——**这是技术错误**。已核实：
> - `server/src/agents/engine.ts:115` 是 `const envClient = envKey ? new Anthropic({ apiKey: envKey }) : null`，**没有传 `baseURL`**；
> - `@anthropic-ai/sdk`（v0.93.0）构造函数默认 `baseURL = readEnv('ANTHROPIC_BASE_URL')`（`node_modules/@anthropic-ai/sdk/client.js:66`，仅当未设该 env 才回落 `https://api.anthropic.com`）。
>
> **因此：在 EnvironmentFile 里同时设 `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL=https://你的网关/`，SDK 会自动把 envClient 整体改向自建网关**（见 §4.2 注释）。「UI 填 provider 的 base_url」是另一条等价路径，**二者皆可，不存在「唯一正确做法」**。大陆要接官方 Claude 时，自建反代 + 这两条任一通道接入均可。

> **【兼容端点联网工具的预期管理】**：`webToolsStage` 是**进程内 Map**（`engine.ts:139`）。官方通道 `webStage` 恒 0（`engine.ts:1331`）；但所有兼容端点（DeepSeek/GLM 等）**首次都从 stage0（搜索+抓取）试，4xx 才逐级降档**（`engine.ts:1405-1408`），每个 providerId 各自记忆。实务含义：① 大陆用 DeepSeek 时 `web_fetch` 多半不被支持 → **首跑必有一次降档 4xx 重试**（有 audit 留痕，属正常，别误判为故障）；② 该记忆是进程内态，**systemd 重启后清零**，重启后第一批任务会重新探测、略慢/有 4xx。

**大陆地域默认要点**：**默认不要设 `ANTHROPIC_API_KEY`** → 首启进 Mock → 登录后在 UI「模型供应商」加 DeepSeek 等国内 provider。

### 8.3 ICP 备案 + 云厂商合规
- 纯 IP / 内网 / 团队 VPN 访问、不用域名 → **可免备案**（内部使用推荐）。
- 域名 + 公网 80/443（大陆地域）→ 该域名需办 ICP 备案（腾讯云可代办，数日~数周）。**未备案的域名走 80/443 会被运营商拦截**。
- **云厂商侧合规**（不只运营商）：腾讯云有**安全合规扫描与处置流程**——对「未备案域名解析到本机却开放 80/443」「对外暴露的异常/随机高位端口」「被检出的明显漏洞服务」可能触发**告警、限制访问甚至封禁实例**。这正是本文坚持「8787/8788/8789 永不入站、内部场景 443 只放可信网段、80 不对全网开」的额外理由（§4.6）。
- 想要域名又不想备案 → 选腾讯云国际（港/新）。

### 8.4 时区（必做）+ 共用主机告警
**`server/src/agents/engine.ts:344-352` 每日 token 预算 `budgetExhausted()` 用 `new Date().setHours(0,0,0,0)` 跟随系统时区取日界**，而调度（`shanghaiNow` `engine.ts:1170`）、用量图表、agent「当前时间」提示（`engine.ts:839/844`）都硬编码 `Asia/Shanghai`。VPS 留在 UTC 会让预算「日」在北京时间 08:00 重置、与图表错位 8 小时。
**动作**：`timedatectl set-timezone Asia/Shanghai` + 开 NTP（见 §4.7）。systemd 进程继承系统时区，无需额外 `TZ`。

> **【共用主机时区冲突告警】**：**系统时区是三项目共享的全局态**。若另两项目要求 `UTC`，改系统 TZ 会**同时移动 AiTeam 的预算日界**（`setHours` 跟系统 TZ）**并与硬编码的 `Asia/Shanghai` 图表/调度错开 8 小时**。规避二选一：① **三项目统一 `Asia/Shanghai`**（最省事）；② 向上游提需求，把 `budgetExhausted` 也改成显式 `Asia/Shanghai`（与 `shanghaiNow` 一致），列为可选源码改动——这样系统 TZ 即便是 UTC，AiTeam 自身也内部一致。海外地域同理：例行任务始终按北京时间触发。

### 8.5 HTTPS 证书的大陆落地路径（别押在自动 ACME 上）
大陆地域用 Caddy/Certbot 的**自动 ACME 多半不顺**：默认 Let's Encrypt 是境外 CA，访问 ACME 端点可能慢/限速；HTTP-01 验证又要求 80 对全网可达，与 §4.6「内部场景 80 不开」互斥。务实做法：
1. **腾讯云免费 DV 证书**（推荐）：控制台「SSL 证书」申请免费 DV（一年期，**到期需重新申请并重新挂载**，可设到期提醒）→ 下载 Nginx/Caddy 格式 → 手动挂载（Nginx `ssl_certificate`/`ssl_certificate_key`，Caddy `tls cert key`，见 §4.3/4.5）→ 续期脚本/手动每年换一次。
2. **DNS-01 自动签发**（次选，若坚持自动化）：用 Caddy/acme.sh 的 DNS-01 插件 + 腾讯云 DNSPod API 凭证，**无需开放 80**，但要妥善保管 DNS API key。
3. **海外地域**：自动 ACME 通常可用，保留 Caddy 自动 HTTPS 即可。

### 8.6 npm 与带宽（含共用带宽冲突）
- better-sqlite3 在大陆拉预编译二进制易超时 → 配镜像（§4.7，用 prebuild-install 真正识别的变量名）+ 编译链默认预装。生产用 `npm ci` 锁版本。
- 腾讯云选「固定带宽」（3-5Mbps 够内部用）而非按量。静态资产已带 30d immutable 强缓存（`index.ts:31`），重复访问不回源。
- **【共用带宽冲突】**：大陆 VPS 多为**共享出网带宽**，三项目共用这一条公网管道。AiTeam 的**生成图/pptx 导出突发下行会和另两项目抢带宽**（共享上限被打满时三者一起卡/丢包）。规避：① 选稍宽的固定带宽并留余量；② 若另两项目对带宽敏感，可用腾讯云的限速/QoS 或把 AiTeam 大文件导出引导走对象存储直链；③ 至少在 §9 巡检里把带宽峰值纳入观察。

---

## 9. 可观测与日常运维（刻意做「轻」）

- **健康探针**：项目无 `/healthz`。最轻探针 `GET /aiteam/api/auth/me` 未登录返回 **401**（`server/src/auth-routes.ts:47-52`），且该分支内部调 `countUsers()`，拿到 401 即同时证明「进程在听 + 路由正常 + sqlite 可读」。判状态码（401/200 健康），连接拒绝/超时/5xx 才异常。
- **进程守护**：systemd `Restart=always` + 应用启动自愈 = 完整「挂了发现+自愈」答案，**不需要 Prometheus/Grafana**。验证开机自启：`systemctl enable` 后 `reboot` 确认三项目都起来。
- **日志**：全 `console.*` → journald 自动接管轮转（§4.8 配额）。`journalctl -u aiteam -f`。三项目靠 `SyslogIdentifier` 分流。
- **磁盘水位（重点盯）**：**assets 目录无任何自动清理**（文生图持续累积），加上 sqlite WAL，共用主机数据盘**盯 `df` 比盯 CPU 更实际**。

```bash
#!/usr/bin/env bash
# /opt/aiteam/ops/healthcheck.sh
# crontab: */5 * * * * /opt/aiteam/ops/healthcheck.sh >> /var/log/aiteam-health.log 2>&1
set -uo pipefail
PROBE='http://127.0.0.1:8787/aiteam/api/auth/me'; SERVICE=aiteam
STATE=/run/aiteam-health.fails; MAX_FAILS=3
DATA_DIR=${AITEAM_DATA_DIR:-/var/lib/aiteam}; DISK_WARN=85
WEBHOOK=''   # 企业微信机器人，可选
notify(){ [ -n "$WEBHOOK" ] && curl -s -m 5 -H 'Content-Type: application/json' \
  -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"[AiTeam] $1\"}}" "$WEBHOOK" >/dev/null 2>&1 || true; }
code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$PROBE" || echo 000)
if [ "$code" = 401 ] || [ "$code" = 200 ]; then echo 0 > "$STATE"
else
  fails=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 )); echo "$fails" > "$STATE"
  echo "$(date) unhealthy code=$code fails=$fails"
  if [ "$fails" -ge "$MAX_FAILS" ]; then
    notify "健康探针连续 $fails 次失败(code=$code)，正在重启"; sudo systemctl restart "$SERVICE"; echo 0 > "$STATE"; fi
fi
use=$(df --output=pcent "$DATA_DIR" 2>/dev/null | tail -1 | tr -dc '0-9')
[ -n "${use:-}" ] && [ "$use" -ge "$DISK_WARN" ] && notify "数据分区 ${use}%（含 assets 无自动清理），请清理"
```

**【可选：assets 按时间清理 cron】**（无自动清理，迟早撑满数据盘殃及另两项目）
先估容量：单张生成图典型几百 KB~2MB，`IMAGES_PER_RUN` 默认 3，按团队日产任务数 × 3 估月增量。设一个保留窗（如 90 天），定期清旧图：
```bash
# /opt/aiteam/ops/clean-assets.sh —— 删 90 天前的生成图（DB 里的历史文档引用会变成坏链，按需调整窗口）
# crontab: 0 4 * * 0  /opt/aiteam/ops/clean-assets.sh >> /var/log/aiteam-clean.log 2>&1
DATA_DIR="${AITEAM_DATA_DIR:-/var/lib/aiteam}"
find "$DATA_DIR/assets" -type f -mtime +90 -print -delete
```
> ⚠️ 清理会让早于窗口的文档里 `/aiteam/assets/*.png` 变坏链（应用不引用磁盘文件做正确性判断，只影响图片显示）。内部低频场景可把窗口放宽到 180~365 天，或先只告警不删。

> **例行任务调度**（`startScheduler`，30s 轮询比对上海时区 HH:MM）：重启安全（`last_run_date` 持久化去重）但**不补跑**——升级停机期间错过的时刻当天不再补。**升级窗口要避开例行任务密集时刻。**

---

## 10. 推荐的源码改动（评估项，需用户拍板）

虽然「评估阶段不执行」，但这几处是把 blocker 从「靠运维兜底」变成「应用层根治」的最小改动，强烈建议纳入：

1. **绑回环（强烈建议）**（`server/src/index.ts:46`）：
   `server.listen(PORT, ...)` → `server.listen(PORT, process.env.AITEAM_HOST ?? '127.0.0.1', ...)`
   默认安全，反代/同机访问不受影响，公网无法直连。不改则只能靠安全组+ufw 双层兜底（裕度更低）。
2. **密钥 fail-fast（建议）**（`server/src/index.ts` 启动处）：生产且 `AITEAM_SESSION_SECRET` 未设时 `process.exit(1)`，避免静默用弱密钥跑起来（尤其漏设 `NODE_ENV` 时连 warn 都没有）。
3. **MCP test 端点补 requireAdmin（建议，安全）**（`server/src/routes.ts:208`）：
   `api.post("/mcp-servers/:id/test", (req,res)=>...)` → `api.post("/mcp-servers/:id/test", requireAdmin, (req,res)=>...)`
   与同文件 create/toggle/delete（185/201/216）对齐，堵住「普通 member 触发已存在 stdio server 子进程派生」。内部不配 stdio MCP 时此项可缓办。
4. **请求体上限放宽（按需）**（`server/src/index.ts:26`）：若内部有粘贴长上下文需求，`express.json({limit:"1mb"})` → `"5mb"`（同时确认反代 `client_max_body_size` ≥ 此值）。
5. **预算日界显式上海时区（可选，共用主机若被迫用 UTC 才需要）**：把 `budgetExhausted` 的 `setHours(0,0,0,0)` 改成与 `shanghaiNow` 一致的显式 `Asia/Shanghai` 计算，解耦系统 TZ。

---

## 11. 待用户决策项（汇总）

1. **地域大陆/海外**（Q1）—— 决定出网、备案、证书签发三条主线。
2. **访问方式（IP/VPN vs 公网域名）+ 是否备案**（Q2）—— 决定 HTTPS/Secure cookie、安全组规则。
3. **另两项目是否已有反代 / 谁占 443 / 端口 / Node 版本 / 统一反代归谁运维**（Q3）—— 决定反代复用与 443 收编路径（见 §2.3）。
4. **是否接受源码改动**（Q4）—— 至少建议 #1 绑回环；#3 MCP test 加 requireAdmin 视是否用 stdio MCP 而定。
5. **全新部署 vs 带旧数据迁移**（Q5）—— 强烈建议全新部署绕开空 owner 桶。
6. **采用模型 A（本地构建，推荐）还是模型 B（VPS 构建）**—— 决定 VPS 是否装 devDeps（见 §3.2/§6.2）。
7. 内存规格、异地备份与备份盘独立性、是否用海外 MCP、SSH 出口 IP 是否固定（Q6-Q8）。

---

## 附：与现有 `deploy/` 的关系
现有 `deploy/Caddyfile` + `README.md` 是为 **coworker 集成**写的（Caddy 把 Coworker `:3000` + AiTeam `:8787` 统一到一个域名，env 用 `AUTH_SECRET`/`COWORKER_INTERNAL_URL`），**不适配本 standalone 场景**：应删掉 `:3000`/coworker 段，换成 §4.5 的精简 Caddyfile 或 §4.3/4.4 的 Nginx，env 换成 §4.2 的 standalone 版本（`AITEAM_AUTH_MODE=standalone` + `AITEAM_SESSION_SECRET` 而非 `AUTH_SECRET`）。仅当起点参考。

---

## 附：上线检查清单（按序勾选）
- [ ] 系统 TZ = `Asia/Shanghai` + NTP 开（`timedatectl status`）
- [ ] Node 22 + 编译链（大陆默认装）+ npm/二进制镜像
- [ ] `ss -ltnp` 确认 443 归属，决定复用/收编现有反代（§2.3）
- [ ] `/etc/aiteam/aiteam.env`：`NODE_ENV=production`、`AITEAM_SESSION_SECRET`（openssl 生成）、`AITEAM_ADMIN_EMAILS`、`AITEAM_ALLOW_SIGNUP=1`；权限 600 属主 aiteam
- [ ] （建议）应用 §10 #1 绑回环改动并设 `AITEAM_HOST=127.0.0.1`
- [ ] systemd unit 装好、`enable`、`reboot` 验证开机自启
- [ ] 安全组 + ufw/firewalld 双层：8787/8788/8789 不入站；443 按 Q2 模式放行；22 加固
- [ ] 反代配置（路径前缀或子域）+ 证书（大陆：腾讯云 DV 手动挂载）
- [ ] 注册首个 admin（白名单邮箱）→ 立刻 `AITEAM_ALLOW_SIGNUP=0` 重启
- [ ] 登录 UI 配 DeepSeek 等国内 provider（不设 `ANTHROPIC_API_KEY`，除非走自建网关 + `ANTHROPIC_BASE_URL`）
- [ ] 决定是否配 stdio MCP；若不配则 args 留空（默认安全）
- [ ] 探针 `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/aiteam/api/auth/me` 返回 401
- [ ] 备份 cron + 一次手动 `backup.sh` + 一次 `restore.sh` 演练
- [ ] （可选）assets 清理 cron + 磁盘水位告警 webhook
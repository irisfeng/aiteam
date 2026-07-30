# AiTeam 迁移到腾讯云 VPS — 评估与可落地操作手册（单一路径版）

> 适用场景：腾讯云 VPS（大陆地域 / 内网 IP / 国内模型 / 全新部署 / systemd + Nginx 单一路径）/ 与另两个不相关项目共用一台机 / 内部使用基本无并发 / standalone 邮箱+密码自建登录。
> 本文所有结论已逐行对照仓库源码核实（关键文件:行号见正文，已补全 `server/src/agents/` 子目录前缀）。配置产物可直接落地，占位值（`__FILL_ME__` / `your-...` / 内网IP）需替换。

---

## ★ 本次部署已确认前提（2026-06-14）

> 以下为最终选定方案，已无分支。照此一条路走到底即可。

| 决策项 | 已确认结论 | 对本文的影响 |
|---|---|---|
| **地域** | **中国大陆** | 时区设 Asia/Shanghai；只用国内模型端点；证书本阶段不涉及 |
| **访问方式** | **纯内网 IP + HTTP，不上公网域名** | 不需要 ICP 备案；走「纯内网 HTTP」（cookie 无 Secure 可正常工作，靠网络层隔离）；产品 beta 后再考虑域名+备案+HTTPS（见文末「后续」） |
| **模型** | **仅国内端点**：对话用 DeepSeek/GLM/Kimi（Anthropic 协议兼容，登录后在 UI 配 provider）；文生图用 Seedream/火山方舟（已内置，`ark.cn-beijing.volces.com`） | **不设 `ANTHROPIC_API_KEY`**（留空首启进 Mock，登录后 UI 配国内 provider） |
| **数据** | **全新部署**（VPS 空 data 目录，注册首个 admin） | 不迁移本地旧库；备份/恢复脚本作为上线后常规运维保留 |
| **进程** | **systemd** | 开机自启 + 崩溃重启 + journald 轮转 + cgroup 隔离 |
| **反代** | **Nginx 单一方案** | `/aiteam/` 前缀原样转发；WebSocket 头透传；gzip + assets 长缓存 |
| **端口绑定** | **8787 默认绑 `127.0.0.1`**（已合入，`AITEAM_HOST` 可覆盖）**＋ 安全组 + 主机防火墙双层兜底** | 代码默认只听回环；防火墙双层作为叠加第一层，必做 |

---

## 0. 总判与执行摘要

**总判：有条件 GO（GO-WITH-CONDITIONS）。**

技术上完全可迁移，且本项目启动自愈（`finalizeStaleStreaming` 收口中断流式 + `recoverInFlightTasks` 续跑 doing 任务 + `startScheduler`，见 `server/src/index.ts:19-23`）使其天然适配 systemd 的崩溃重启语义。原先的 blocker 已收敛为「代码护栏 + 上线必做配置」，下面逐条说明。

**三条已在代码层闭合：**

- **会话密钥 fail-fast ✅ 已合入**：生产（`NODE_ENV=production`）未设 `AITEAM_SESSION_SECRET` 时现在直接 `process.exit(1)` 拒启（`server/src/session.ts:12-17`），不再静默回退到 git 公开仓库里的硬编码弱密钥 `aiteam-dev-secret-change-me`。→ 处置变为：**只要在 EnvironmentFile 里配好强密钥 + 设 `NODE_ENV=production` 即可；漏配会被拒启兜底，不会再带弱密钥裸奔。**
- **凭证落库加密 + 生产密钥 fail-closed ✅ 已合入**：provider、MCP、文生图凭证统一以 `enc1:` AES-256-GCM 密文落库；生产必须设置固定 `AITEAM_CREDENTIAL_KEY`，或恢复已有 `credential.key`，缺失/不匹配时拒绝迁移和使用。
- **MCP `/mcp-servers/:id/test` 补 `requireAdmin` ✅ 已合入**：`server/src/routes.ts:208` 现在带 `requireAdmin`（与同文件 185/201/216 的 create/toggle/delete 对齐），普通 member 不能再触发 stdio 子进程派生。

**仍需在上线窗口内闭合的 2 个配置项（实质是上线必做步骤）：**

1. **8787 不可公网可达**：代码已默认绑 `127.0.0.1`（`server/src/index.ts`，`HOST=AITEAM_HOST||127.0.0.1`，已合入），公网无法直连。仍需用腾讯云安全组 + 主机防火墙（ufw/firewalld）双层挡死 8787 入站作为第一层兜底（叠加，必做）。
2. **关闭公开注册**：`AITEAM_ALLOW_SIGNUP` 默认开放注册 + 首个注册者自动成 admin（`server/src/auth-routes.ts:12/27`）。→ 部署前设 `AITEAM_ADMIN_EMAILS` 白名单，注册首个 admin 后立刻 `AITEAM_ALLOW_SIGNUP=0` 重启关闭公开注册。

这两条都只需配置/一行代码即可堵住，成本极低。闭合后即为干净 GO。

---

## 1. 前置确认项（部署前先准备）

| # | 准备项 | 说明 |
|---|---------|------|
| P1 | VPS 内存规格（1G/2G/4G）？ | 决定 `MemoryMax` 取值；本文按 ≤2GB 保守给值，构建始终在本地做不在 VPS 跑 |
| P2 | 另两项目当前用什么进程管理、是否已有 Nginx 在跑？ | 决定是「加入已有 Nginx」还是「新装 Nginx」（见 §2.3，一句话覆盖，无需分支） |
| P3 | ~~是否接受改一行 `index.ts` 绑回环？~~ ✅ 已合入 | 默认已绑 `127.0.0.1`，无需操作；仅容器/异机反代时设 `AITEAM_HOST=0.0.0.0` |
| P4 | 是否需要异地备份（腾讯云 COS）？备份盘是否独立于数据盘？ | 整机故障时备份是否一起丢；先本地 7-14 日轮转 |

**准备物**：SSH 密钥、`openssl rand -base64 48` 生成的会话密钥、`openssl rand -hex 32`
生成并安全持久化的凭证落库密钥、首个 admin 邮箱、内网访问网段（办公固定出口/VPN）。

---

## 2. 架构与共存方案

### 2.1 部署形态（已核实）
- npm workspaces 单仓库 `server` + `web`；`npm run build` = 先 `web`(vite build) 再 `server`(tsc)；`npm start` = `node server/dist/index.js`。
- 生产 = **单个 Node 进程**，所有路由挂 **`/aiteam/` 前缀**（`server/src/index.ts:29-43`）：`/aiteam/api/auth`（公开）、`/aiteam/api`（`requireUser`→`withOwner`）、`/aiteam/ws`（WebSocket，path 写死）、`/aiteam/assets`+历史 `/assets`、`/aiteam`（前端静态 + SPA fallback 正则 `/^\/aiteam\/(?!api|ws|assets).*/`）。
- 前端 `web/dist` 路径靠 `__dirname` 相对推算（`server/src/index.ts:36` `join(__dirname,"..","..","web","dist")`），**拷部署时必须保留 `server/dist` 与 `web/dist` 的相对结构**，否则前端静态静默失效（只剩 API/WS）。

### 2.2 `/aiteam/` 前缀是三层硬耦合 —— 反代「不能去前缀」
前缀写死在三处：① Vite `base:'/aiteam/'`（`web/vite.config.*:7`，编进 index.html 的绝对路径资源链接）；② Express 全量挂载；③ `WebSocketServer({server, path:'/aiteam/ws'})` 精确匹配。
**结论**：反代里 `proxy_pass` 末尾**绝不能带斜杠/路径**（带 `/` 会剥前缀 → WS/API/静态全 404）。访问入口始终是 `http://内网IP/aiteam/`，不能在反代层 rewrite 去前缀。

### 2.3 推荐架构（共用主机）
```
内网 :80 ── 单一 Nginx 入口（按路径前缀分流）
                │
                ├─ /aiteam/* → 127.0.0.1:8787  (AiTeam，systemd, user=aiteam)
                ├─ /b/*      → 127.0.0.1:8788  (项目B，systemd, user=projb)
                └─ /c/*      → 127.0.0.1:8789  (项目C，systemd, user=projc)
```
- **三进程各自只绑 127.0.0.1，端口错开**（8787/8788/8789），各自独立 OS 用户 + 独立 `AITEAM_DATA_DIR` + 各自 systemd unit + cgroup 限额。
- **Nginx 安置方式（一句话覆盖，无需分支）**：把 §4.3 的 `server` 块**加入已有 Nginx 配置作为一个新 server block**；若三项目当前都没有反代，则**新装 Nginx** 再放入同一份配置。无论哪种情况都是「一个 Nginx 单入口 + 一个 server 块」，**切勿同机跑第二个反代抢 80**。

**【部署前必做：先看 80 被谁占】**
```bash
ss -ltnp 'sport = :80'
```
- 已有 Nginx 占着 → 在现有 Nginx 里加 §4.3 的 `location /aiteam/`（及 `/assets/`）块即可，绝不新起第二个反代。
- 某项目进程直接 `listen 0.0.0.0:80`（没走反代）→ 先把它改成只听 `127.0.0.1` 的后端、由统一 Nginx 接管 80，否则新装 Nginx 会 `bind 80 失败` 起不来。这一步需与该项目 owner 对齐，并明确**统一反代由谁运维**（配置变更责任人）。

---

## 3. 运行时与进程模型

### 3.1 进程管理：systemd
单机三项目 + 内部低并发下，systemd 是最优：系统自带、开机自启、崩溃重启、journald 日志按容量轮转、cgroup 资源隔离全内置，三项目统一 `systemctl` 管理。

### 3.2 Node 版本与原生模块（blocker 级坑）
- **`better-sqlite3 ^11.10.0` 是绑定 Node ABI 的原生模块**，三个 `package.json` 均无 `engines` 字段（无护栏）。**绝不能把 macOS 的 `node_modules`/`build/Release/*.node` 跨平台拷到 Linux**（require 时抛 `invalid ELF header`/ABI 不匹配）。TS/前端产物（`server/dist`、`web/dist`）可跨平台拷，原生模块不行。
- **构建机与运行机锁同一 Node 大版本（Node 22 LTS）**。换 Node 大版本后必须 `npm rebuild better-sqlite3` 再重启，否则启动即 `ERR_DLOPEN_FAILED`。
- **部署模型（固定）**：本地 `npm run build`（省 VPS 内存，避免共用低配机跑 vite build/tsc 时 OOM）→ rsync `dist` + 锁文件 → VPS 上 `npm ci --omit=dev`（按目标平台拿 better-sqlite3 预编译，命中则零编译）。**VPS 永远只装运行期依赖，不需要也不应装 devDeps。**
- **`npm rebuild better-sqlite3` 只是兜底、不是常规步骤**：`npm ci` 阶段 better-sqlite3 的 install 脚本是 `prebuild-install || node-gyp rebuild`，命中预编译就直接零编译；此时再无条件 `npm rebuild` 反而会**强制 node-gyp 从源码重编**（rebuild 不复用 prebuild-install 的下载语义），在低配共用机上是多余的 CPU/内存开销，且必须已装编译链才不报错。正确做法：
  ```bash
  # npm ci --omit=dev 之后，先验证；只有失败才 rebuild
  node -e "require('better-sqlite3')" 2>/dev/null \
    || { echo "ABI 不匹配，回退编译"; npm rebuild better-sqlite3; }
  ```
  仅在「换过 Node 大版本」或「上面 require 抛 `ERR_DLOPEN_FAILED`/`invalid ELF`」时才需 rebuild。

> **依赖差异硬约束**：`tsc`/`typescript`（server devDeps）与 `vite`/`tailwindcss`/`typescript`（web devDeps）**全是 `devDependencies`**。本文固定走「本地构建」：VPS 上永远 `npm ci --omit=dev`，构建只在本地做，rsync `dist` 上去（见 §6.1）。

### 3.3 无 dotenv —— 环境变量必须由 systemd 注入
全仓无 dotenv，应用只 `process.env.*`。所有关键变量必须经 systemd `EnvironmentFile` 注入（见 §4）。
缺失后果：生产未设 `AITEAM_SESSION_SECRET` 会拒启；未设 `AITEAM_CREDENTIAL_KEY` 且数据目录没有
已有 `credential.key` 时会拒绝凭证加密/迁移；`ANTHROPIC_API_KEY` 缺失则进 Mock 模式（本场景预期行为，登录后 UI 配国内 provider）。

### 3.4 内存足迹与双重护栏
常态单进程 80-200MB、CPU 近空闲。峰值三处：pptxgenjs 拼 PPT、图片生成（`AITEAM_IMAGES_PER_RUN` 默认 2）、MCP 用 `StdioClientTransport`（典型 npx）拉常驻子进程（`server/src/agents/mcp.ts:42`，国内联网拉包慢且占内存，不受应用 `--max-old-space-size` 约束、只受 cgroup 约束）。
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
# 仅放开本项目数据目录可写（含加密凭证的 sqlite + 生成图 assets）
ReadWritePaths=/var/lib/aiteam

[Install]
WantedBy=multi-user.target
```

> **关于 127.0.0.1 监听**：已合入——`server/src/index.ts` 现在 `server.listen(PORT, HOST)`，`HOST = process.env.AITEAM_HOST || "127.0.0.1"`，**默认只听回环**（见 §10）。同机 Nginx 反代照常可达，公网够不着。安全组 + 主机防火墙仍作为第一层兜底（叠加，必做）。
>
> **首个 Preview 仍不启用 stdio MCP**：未配置 runner 时，应用在启动、API 和
> 唯一 spawn 边界继续拒绝全部 stdio。代码已有 rootless Podman 的
> `safety=local` 候选：digest 固定、`--pull=never`、禁网、只读 rootfs、drop all
> capabilities、no-new-privileges、CPU/内存/PID 限额和 owner + Mission/task
> 独立工作区；network/exec 仍禁用。它必须先在目标 Linux + cgroup v2 上通过
> `npm run test:stdio-sandbox:real`。现有 systemd 的 `NoNewPrivileges`、
> `ProtectHome` 与 rootless Podman 的 subuid/subgid、storage/runtime 需求可能
> 冲突；实测失败时保持关闭，不得为赶进度放宽主服务沙箱。

### 4.2 环境变量文件 `/etc/aiteam/aiteam.env`
（权限 `chmod 600 && chown aiteam:aiteam`，绝不进 git）

```bash
# /etc/aiteam/aiteam.env  —— chmod 600, chown aiteam:aiteam
# NODE_ENV 必设 production：缺 AITEAM_SESSION_SECRET 时由 session.ts 的 fail-fast 拒启兜底（commit 0983fb6）
NODE_ENV=production
# 监听：默认已绑回环（index.ts HOST=AITEAM_HOST||127.0.0.1，已合入）。此处显式写明即可；
# 仅当反代/容器在别的主机需放开时改成 0.0.0.0 或私网 IP。防火墙仍作第一层兜底。
AITEAM_HOST=127.0.0.1
PORT=8787
# 数据与生成图资产目录（WAL：aiteam.db + -wal + -shm 三件套；凭证为 enc1 密文）
AITEAM_DATA_DIR=/var/lib/aiteam

# ===== standalone 鉴权（本场景核心）=====
AITEAM_AUTH_MODE=standalone
# 会话 JWT 密钥 —— 生产必配！缺省会被 fail-fast 拒启（commit 0983fb6）。生成：openssl rand -base64 48
AITEAM_SESSION_SECRET=__FILL_ME_openssl_rand_base64_48__
# 凭证落库密钥 —— 生产固定保存，必须为 32 字节（64 位 hex 或 base64）。生成：openssl rand -hex 32
# 与会话密钥用途不同；升级/重启/恢复时必须保持同一值。
AITEAM_CREDENTIAL_KEY=__FILL_ME_openssl_rand_hex_32__
# 管理员白名单（小写邮箱，逗号分隔）——保证只有白名单注册后才是 admin，避免被"首个用户"兜底抢注
AITEAM_ADMIN_EMAILS=admin@yourco.internal
# 部署时先设 1 让首个 admin 能注册；建好首个 admin 后立刻改 0 并重启，关闭公开注册
AITEAM_ALLOW_SIGNUP=1

# ===== 模型（key 主路径在产品 UI 配、存 sqlite，不依赖此处）=====
# 大陆地域：不设 ANTHROPIC_API_KEY。留空首启进 Mock，登录后到 UI 配 DeepSeek/GLM/Kimi 等国内 provider。
# ANTHROPIC_API_KEY=
# 文生图默认走火山方舟 Seedream（ark.cn-beijing.volces.com，已内置），UI 填 key 即可。

# ===== 成本/滥用护栏（内部场景兜底，按日用量 2-3 倍设；0=不限）=====
# 日界用【系统时区】算 setHours(0,0,0,0)，务必先把系统 TZ 设为 Asia/Shanghai（见 §8.3 共用主机告警）
AITEAM_DAILY_TOKEN_BUDGET=2000000
# AITEAM_IMAGES_PER_RUN=2
# AITEAM_MCP_CALLS_PER_RUN=5
# AGENT_CHAIN_DEPTH=2
# TASK_MAX_REVISIONS=1
```

> **旧 plaintext / `enc:v1:` 数据升级**：源库含 `enc:v1:` 时才临时增加
> `AITEAM_SECRET_KEY=<生成旧密文时的原始密钥>`；只有 plaintext 时不需要旧密钥。为输出副本准备固定的
> `AITEAM_CREDENTIAL_KEY`。**不要直接启动真实数据目录试密钥或原地迁移**：先停服并生成一致性
> 备份，再按 [OPERATIONS §5.1](OPERATIONS.md#51-历史-encv1-凭证升级) 对备份依次执行
> `inspect`、`dry-run` 和 `migrate-copy`，只启动新的 `OUTPUT_DATA` 做人工 UAT；验证通过后再切换
> `AITEAM_DATA_DIR`。确认输出库已全部转为 `enc1:` 后，立刻从环境文件删除
> `AITEAM_SECRET_KEY`。旧密钥找不到时走 `rescue-copy` 并在输出副本中重新录入凭证，禁止对真实库试错。

### 4.3 Nginx 反代 `/etc/nginx/conf.d/multi-app.conf`
（加入已有 Nginx 配置作为新 server 块；三项目都没有反代时新装 Nginx 后放入此文件）

```nginx
# 三项目共用一台腾讯云 VPS，单 Nginx 入口（内网 HTTP），按路径前缀分流。
# AiTeam 强依赖 /aiteam/ 前缀 —— proxy_pass 末尾【不带斜杠/路径】，原样转发 URI。
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 80;
    server_name _;        # 内网 IP 直接访问，无域名

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

### 4.4 主机防火墙 + 安全组检查 `setup-firewall.sh`
（按「纯内网/VPN 内部用」最小放行；8787/8788/8789 永不入站）

```bash
#!/usr/bin/env bash
set -euo pipefail
# AiTeam 迁移：主机防火墙（与腾讯云安全组双层）。8787/8788/8789 永不入站。
SSH_PORT=22
ALLOW_CIDR="10.0.0.0/8"   # 允许访问的来源：办公固定出口/VPN 网段，按实际改

if command -v ufw >/dev/null 2>&1; then            # Ubuntu/Debian
  ufw default deny incoming; ufw default allow outgoing
  ufw allow ${SSH_PORT}/tcp
  ufw allow from "$ALLOW_CIDR" to any port 80 proto tcp    # 80 只放给可信网段（内网 HTTP 入口）
  ufw --force enable; ufw status verbose
elif command -v firewall-cmd >/dev/null 2>&1; then # CentOS/TencentOS/RHEL
  firewall-cmd --permanent --add-port=${SSH_PORT}/tcp
  firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=${ALLOW_CIDR} port port=80 protocol=tcp accept"
  firewall-cmd --reload; firewall-cmd --list-all
else
  echo '未检测到 ufw/firewalld，请手动配置主机防火墙。'
fi

cat <<'NOTE'
--- 腾讯云安全组（控制台侧，与主机防火墙是两层，都要配，取最小必要）---
入站：TCP 80 仅放行办公固定出口IP/VPN网段（内网 HTTP 入口）；TCP 22 锁固定IP/32。
绝不添加：8787、8788、8789 及另两项目后端口。

--- SSH 22 端口实务 ---
sshd_config：PasswordAuthentication no、PermitRootLogin prohibit-password；装 fail2ban。
动态家宽 IP（大陆常见，无法锁 /32）三选一：
  ① 用腾讯云堡垒机/CFW 跳板，业务安全组 22 只放堡垒机内网IP；
  ② 临时放行：每次办公前在控制台/CLI 临时加自己当前公网IP，结束删；
  ③ DDNS + 定时脚本刷安全组（腾讯云 cvm SDK 改 SecurityGroupPolicy）。
NOTE
```

### 4.5 一次性大陆环境准备 `setup-tencent-mainland.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
# 大陆腾讯云 VPS 一次性环境准备：时区校时 + Node 22 + npm/二进制镜像 + 编译链（大陆默认预装）

# 1) 时区设 Asia/Shanghai（每日 token 预算 setHours 跟系统时区；调度/图表硬编码 Asia/Shanghai，见 §8.3）
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

### 4.6 journald 容量上限 `/etc/systemd/journald.conf.d/aiteam-cap.conf`

```ini
# 共用主机省磁盘：放此 drop-in 后 sudo systemctl restart systemd-journald 生效。三项目共享这份全局配额。
[Journal]
Storage=persistent
SystemMaxUse=500M
SystemMaxFileSize=50M
MaxRetentionSec=2week
```

---

## 5. 数据与备份（全新部署 + 常规运维）

### 5.1 完整数据集只有一处
`AITEAM_DATA_DIR` 目录 = `aiteam.db`（WAL，`server/src/db.ts:14` `db.pragma("journal_mode = WAL")`）+ 运行时伴生 `-wal`/`-shm` + `assets/` 子目录（文生图落盘，被文档正文里的 `/aiteam/assets/<id>.png` 引用）。
全仓**无任何 `SIGTERM`/`SIGINT`/`db.close()`/`wal_checkpoint`**（已 grep 确认为空），所以运行目录永远「拷了就可能坏/丢」——常规备份必须用 VACUUM INTO 出干净单库，绝不 `cp` 单个 `aiteam.db`（在线进程下 `-wal` 里可能压着大量未合并写入）。

### 5.2 全新部署（本场景）
`AITEAM_DATA_DIR` 指向空目录 `/var/lib/aiteam`，首启自动建表；配 `AITEAM_ADMIN_EMAILS` 白名单注册首个 admin 即可。不带任何旧库上去。

> **多租户隔离说明（理解备份/恢复行为用）**：standalone 注册的用户 owner 是 `user:<id>`（`server/src/ownerScope.ts`），所有业务查询强制 `WHERE owner_id=currentOwner()`（fail-closed）。带 `owner_id` 的 8 张业务表：`agents` / `channels` / `messages` / `tasks` / `approvals` / `documents` / `routines` / `projects`（均 `owner_id TEXT NOT NULL DEFAULT ''`，见 `server/src/db.ts:17-135`）。全局表/无 owner_id 表：`users`、`providers`（**全局共享，admin 配一套 key 所有用户共用**，`db.ts:375`）、`mcp_servers`（**全局**，`db.ts:103`）、`skills`、`app_settings`、`agent_memory`（`db.ts:77`）、`channel_agents`（`db.ts:36`）。

### 5.3 备份脚本 `/opt/aiteam/ops/backup.sh`

```bash
#!/usr/bin/env bash
# AiTeam 一致性备份（WAL 安全）：VACUUM INTO 干净单库 + assets 打包 + 轮转
set -euo pipefail
DATA_DIR="${AITEAM_DATA_DIR:-/var/lib/aiteam}"
BACKUP_ROOT="/var/backups/aiteam"   # 独立于 DATA_DIR，勿落回数据盘自身
ENV_FILE="/etc/aiteam/aiteam.env"
KEEP=14
DB="$DATA_DIR/aiteam.db"
TS="$(date +%Y%m%d-%H%M%S)"; DEST="$BACKUP_ROOT/$TS"
mkdir -p "$DEST"; chmod 700 "$BACKUP_ROOT"

# 0) 密钥恢复前置：这里只记录模式，不把原始密钥与 DB 放进同一备份
#    AITEAM_CREDENTIAL_KEY 必须另存密码管理器/云密钥服务；file 模式的 credential.key 也须单独加密托管。
if grep -Eq '^AITEAM_CREDENTIAL_KEY=.{20,}$' "$ENV_FILE" 2>/dev/null; then
  KEY_MODE=environment
elif [ -s "$DATA_DIR/credential.key" ]; then
  KEY_MODE=file
else
  echo "[fatal] 未找到凭证密钥来源，拒绝生成不可恢复的备份" >&2
  exit 1
fi
printf 'credential_key_mode=%s\ncreated_at=%s\n' "$KEY_MODE" "$(date -Iseconds)" > "$DEST/RECOVERY-METADATA"

# 1) DB：VACUUM INTO 干净单库（自动合并 WAL，无伴生文件）
sqlite3 "$DB" "VACUUM INTO '$DEST/aiteam.db'"
# 2) 校验快照（坏库早发现）
INTEGRITY="$(sqlite3 "$DEST/aiteam.db" 'PRAGMA integrity_check')"
if [ "$INTEGRITY" != "ok" ]; then
  echo "[fatal] 备份快照完整性校验失败：" >&2
  printf '%s\n' "$INTEGRITY" >&2
  exit 1
fi
# 3) assets 打包（生成图；文档中可能含可访问链接）
[ -d "$DATA_DIR/assets" ] && tar -czf "$DEST/assets.tar.gz" -C "$DATA_DIR" assets
# 4) 校验和 + 锁权限（数据库内凭证为 enc1 密文，备份仍按敏感业务数据保护）
( cd "$DEST" && sha256sum aiteam.db assets.tar.gz RECOVERY-METADATA 2>/dev/null > SHA256SUMS || true )
chmod -R 600 "$DEST"/* 2>/dev/null || true
# 5) 轮转
ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -rf
# 6) 可选异地：业务数据仍应先加密再传 COS（age/gpg），COS 同地域走内网免流量费
# age -r <你的age公钥> -o "$DEST/aiteam.db.age" "$DEST/aiteam.db" && rm -f "$DEST/aiteam.db"
# coscmd upload -r "$DEST" "cos://your-bucket/aiteam/$TS/" || echo "[warn] COS 上传失败"
echo "[ok] backup -> $DEST"
echo "[next] 确认独立密钥托管仍可取回；本目录不包含原始凭证密钥"
```

cron（`crontab -e`，凌晨低峰，避开例行任务密集时刻）：
```cron
30 3 * * * /opt/aiteam/ops/backup.sh >> /var/log/aiteam-backup.log 2>&1
```

### 5.4 恢复 `/opt/aiteam/ops/restore.sh`（恢复时必须清脏 WAL）

```bash
#!/usr/bin/env bash
# 从备份恢复（含季度恢复演练）。用法：restore.sh /var/backups/aiteam/20260614-033000
set -euo pipefail
SRC="${1:?用法: restore.sh <备份目录>}"; DATA_DIR="/var/lib/aiteam"; SERVICE="aiteam"
[ -f "$SRC/aiteam.db" ] || { echo "找不到 $SRC/aiteam.db"; exit 1; }
SOURCE_INTEGRITY="$(sqlite3 "$SRC/aiteam.db" 'PRAGMA integrity_check')"
if [ "$SOURCE_INTEGRITY" != "ok" ]; then
  echo "[fatal] 备份源完整性校验失败：" >&2
  printf '%s\n' "$SOURCE_INTEGRITY" >&2
  exit 1
fi
# 必须先从独立密钥托管恢复 /etc/aiteam/aiteam.env 中的原 AITEAM_CREDENTIAL_KEY；
# 若 RECOVERY-METADATA 标记 file 模式，则先把配套 credential.key 恢复到 DATA_DIR。
if ! grep -Eq '^AITEAM_CREDENTIAL_KEY=.{20,}$' /etc/aiteam/aiteam.env 2>/dev/null \
   && [ ! -s "$DATA_DIR/credential.key" ]; then
  echo "[fatal] 凭证密钥尚未恢复，拒绝恢复数据库" >&2
  exit 1
fi
sudo systemctl stop "$SERVICE"
# 关键：清掉现存库与任何脏 WAL 伴生文件，否则陈旧 -wal/-shm 会污染恢复结果
sudo rm -f "$DATA_DIR/aiteam.db" "$DATA_DIR/aiteam.db-wal" "$DATA_DIR/aiteam.db-shm"
sudo cp "$SRC/aiteam.db" "$DATA_DIR/aiteam.db"
[ -f "$SRC/assets.tar.gz" ] && { sudo rm -rf "$DATA_DIR/assets"; sudo tar -xzf "$SRC/assets.tar.gz" -C "$DATA_DIR"; }
sudo chown -R aiteam:aiteam "$DATA_DIR" && sudo chmod -R 750 "$DATA_DIR"
RESTORED_INTEGRITY="$(sqlite3 "$DATA_DIR/aiteam.db" 'PRAGMA integrity_check')"
if [ "$RESTORED_INTEGRITY" != "ok" ]; then
  echo "[fatal] 恢复后数据库完整性校验失败：" >&2
  printf '%s\n' "$RESTORED_INTEGRITY" >&2
  exit 1
fi
sudo systemctl start "$SERVICE"; sleep 2
systemctl is-active --quiet "$SERVICE"
echo "[ok] 基础恢复完成。必须登录 UI 实测 provider、MCP、文生图凭证可读取，并抽查 /aiteam/assets/*.png。建议季度演练一次。"
```

> 数据备份与密钥备份是两个独立恢复要件。环境变量模式应把原
> `AITEAM_CREDENTIAL_KEY` 放入密码管理器/云密钥服务或独立加密介质；文件模式应单独加密托管
> `credential.key`。两者都不要把原始密钥和未加密 DB 快照放在同一个备份目录。恢复演练只有在
> 服务启动、凭证可解密、资产可加载后才算通过。

---

## 6. 部署脚本（本地构建 + 升级/回滚 runbook）

### 6.1 首次/日常部署 `deploy-aiteam.sh`（本地执行）

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

### 6.2 升级 runbook + 回滚硬约束

**升级**：在本地重跑 §6.1 的 `deploy-aiteam.sh` 即可——本地 `npm run build` → rsync `dist` → VPS `npm ci --omit=dev`。VPS 永远不需要 devDeps。升级前先 `ops/backup.sh` 备份一次（停服后 WAL 已收口）。

**回滚（含跨 owner_id 迁移版本的硬约束）**：
`systemctl stop` → 回滚本地 dist（checkout 旧 commit 重新 `npm run build`）再 rsync → **把备份的 `aiteam.db` 拷回（先清脏 `-wal`/`-shm`）** → VPS `npm ci --omit=dev` → `start` → 探针（§9）。

> ⚠️ owner_id 迁移是对同一个 `aiteam.db` 的原地、单向 schema 变更（`server/src/db.ts:154` 补列 + `db.ts:173+` `agents` 表**重建**改唯一约束）。**已被新版本迁移过的库，旧代码可能不认识新 schema（新增列/改约束）而启动即报错**。因此跨过 owner_id 迁移版本回滚时，**必须连库一起回到「迁移前的备份 DB」，不能只回滚代码而保留已迁移的库**。备份是唯一回滚保险。
> **env 文件也要对应版本**（无 dotenv，回滚别忘了 env）。

---

## 7. 安全加固

| 项 | 现状（源码核实） | 落地动作 |
|---|---|---|
| **8787 绑回环 ✅ 已合入** | `server/src/index.ts` `HOST=AITEAM_HOST\|\|127.0.0.1`，默认只听回环 | 安全组只放 80 给可信网段 + ufw/firewalld 双层作第一层（必做）；代码已默认不暴露公网 |
| **会话密钥 fail-fast ✅ 已合入（commit 0983fb6）** | `server/src/session.ts:12-17` 生产未设 `AITEAM_SESSION_SECRET` 直接 `process.exit(1)` 拒启 | EnvironmentFile 里 `openssl rand -base64 48` 写入强密钥 + 确保 `NODE_ENV=production`；漏配会被拒启兜底 |
| **开放注册 + 首注册成 admin** | `server/src/auth-routes.ts:12/27` | 部署前设 `AITEAM_ADMIN_EMAILS` 白名单 → 注册首个 admin → 立刻 `AITEAM_ALLOW_SIGNUP=0` 重启（必做） |
| **MCP test 端点 + 生产 stdio sandbox gate** | create/toggle/test/task-test 均需 admin；默认拒绝全部 stdio；配置合格 runner 后只开放 digest-pinned `local` 容器 | 普通 member、存量/直写行、可变 tag、rootful/cgroup v1 runner、network/exec 都不能触发生产子进程；首个 Preview 仍只接 HTTP MCP |
| **cookie 无 Secure 标志** | `auth-routes.ts:14` 只有 `httpOnly`+`sameSite=lax` | 纯内网 HTTP 可接受（cookie 无 Secure 正常工作），但必须靠网络层隔离（安全组+防火墙只放可信网段） |
| **provider / MCP / 文生图凭证落库加密 ✅ 已合入** | `server/src/secrets.ts` 使用 AES-256-GCM `enc1:`；`db.ts` 启动事务统一迁移 | EnvironmentFile 固定注入 `AITEAM_CREDENTIAL_KEY`；密钥与 DB 分开备份，恢复演练验证可解密 |
| **三项目横向感染** | 默认同用户/共享目录可互读 | 每项目独立 OS 用户 + systemd 沙箱（`ProtectSystem=strict`/`ReadWritePaths` 收窄）+ 独立 data |
| **成本护栏全关** | `agents/engine.ts:344` `DAILY_TOKEN_BUDGET` 默认 0=不限 | 设为日用量 2-3 倍兜底（注意 §8.3 时区日界） |

> **WebSocket 鉴权与 owner 隔离（核实结论：是安全的）**：虽然 Express 层 `/aiteam/ws` 未挂 `requireUser`（`index.ts:43` 直接 `attachBus`），但 **`attachBus` 内部在 WS 握手时用 `resolveUserId` 校验 `aiteam_session` cookie，未登录直接 `ws.close(4401)`**（`server/src/bus.ts:14-32`）；**`broadcast` 取 `currentOwner` 做 fail-closed 定向广播，仅推给同 owner 的连接、无 owner 上下文时一律跳过**（`bus.ts:55-66`）。因此**一个登录 member 收不到他人 owner 的总线事件**，跨用户串台已在代码层堵住——这是好消息，无需额外加固。
>
> **请求体双重上限**：应用层 `express.json({limit:"1mb"})`（`index.ts:26`）**限死 JSON body 1MB**。真正会被它卡住的是「超长 JSON 提问 / 粘贴大段上下文」的 POST（返回 413），**与生成图/pptx 导出无关**（导出是下行响应，不受 `client_max_body_size` 约束）。nginx 的 `client_max_body_size 25m` 只放宽反代这一层，1MB 这层要放宽**得改码**（`express.json({limit:"5mb"})`）——若内部确有粘贴长文需求，列为可选源码改动（§10）。

---

## 8. 中国大陆与腾讯云专项

### 8.1 模型出网（仅国内端点）
所有模型出网走「provider `base_url`」单一通道（`server/src/agents/engine.ts:174` `new Anthropic({apiKey, baseURL})`）；web_search/web_fetch 是模型服务端工具，随该 base_url 在模型侧执行；**文生图默认走火山方舟 Seedream `https://ark.cn-beijing.volces.com/api/v3`**（`server/src/agents/images.ts:14` `DEFAULT_IMAGE_BASE_URL`，北京节点，大陆通；该值也可被 UI 里 image-provider 的 `base_url` 覆盖）。

| 端点 | 大陆可达 | 说明 |
|---|---|---|
| DeepSeek `api.deepseek.com/anthropic`（主力） | ✓ | UI 配 provider，勾 web_tools 启用联网检索 |
| GLM/Kimi/MiniMax 国内端点 | ✓ | UI 配 |
| 火山方舟 Seedream（图） | ✓ | 项目默认图像端点，UI 填 key 即可 |

**要点**：**不设 `ANTHROPIC_API_KEY`** → 首启进 Mock → 登录后在 UI「模型供应商」加 DeepSeek/GLM/Kimi 等国内 provider。

> **【兼容端点联网工具的预期管理】**：`webToolsStage` 是**进程内 Map**（`engine.ts:139`）。所有兼容端点（DeepSeek/GLM 等）**首次都从 stage0（搜索+抓取）试，4xx 才逐级降档**（`engine.ts:1405-1408`），每个 providerId 各自记忆。实务含义：① 大陆用 DeepSeek 时 `web_fetch` 多半不被支持 → **首跑必有一次降档 4xx 重试**（有 audit 留痕，属正常，别误判为故障）；② 该记忆是进程内态，**systemd 重启后清零**，重启后第一批任务会重新探测、略慢/有 4xx。

### 8.2 云厂商合规（内网 IP 场景）
- 纯内网 IP / 团队 VPN 访问、不用域名 → **免备案**（本场景即此）。
- **云厂商侧合规**（不只运营商）：腾讯云有**安全合规扫描与处置流程**——对「对外暴露的异常/随机高位端口」「被检出的明显漏洞服务」可能触发**告警、限制访问甚至封禁实例**。这正是本文坚持「8787/8788/8789 永不入站、80 只放可信网段」的额外理由（§4.4）。

### 8.3 时区（必做）+ 共用主机告警
**`server/src/agents/engine.ts:344-352` 每日 token 预算 `budgetExhausted()` 用 `new Date().setHours(0,0,0,0)` 跟随系统时区取日界**，而调度（`shanghaiNow` `engine.ts:1170`）、用量图表、agent「当前时间」提示（`engine.ts:839/844`）都硬编码 `Asia/Shanghai`。VPS 留在 UTC 会让预算「日」在北京时间 08:00 重置、与图表错位 8 小时。
**动作**：`timedatectl set-timezone Asia/Shanghai` + 开 NTP（见 §4.5）。systemd 进程继承系统时区，无需额外 `TZ`。

> **【共用主机时区冲突告警】**：**系统时区是三项目共享的全局态**。若另两项目要求 `UTC`，改系统 TZ 会**同时移动 AiTeam 的预算日界**（`setHours` 跟系统 TZ）**并与硬编码的 `Asia/Shanghai` 图表/调度错开 8 小时**。规避二选一：① **三项目统一 `Asia/Shanghai`**（最省事）；② 向上游提需求，把 `budgetExhausted` 也改成显式 `Asia/Shanghai`（与 `shanghaiNow` 一致），列为可选源码改动（§10）——这样系统 TZ 即便是 UTC，AiTeam 自身也内部一致。

### 8.4 npm 与带宽（含共用带宽冲突）
- better-sqlite3 在大陆拉预编译二进制易超时 → 配镜像（§4.5，用 prebuild-install 真正识别的变量名）+ 编译链默认预装。生产用 `npm ci` 锁版本。
- 腾讯云选「固定带宽」（3-5Mbps 够内部用）而非按量。静态资产已带 30d immutable 强缓存（`index.ts:31`），重复访问不回源。
- **【共用带宽冲突】**：大陆 VPS 多为**共享出网带宽**，三项目共用这一条公网管道。AiTeam 的**生成图/pptx 导出突发下行会和另两项目抢带宽**（共享上限被打满时三者一起卡/丢包）。规避：① 选稍宽的固定带宽并留余量；② 若另两项目对带宽敏感，可用腾讯云的限速/QoS 或把 AiTeam 大文件导出引导走对象存储直链；③ 至少在 §9 巡检里把带宽峰值纳入观察。

---

## 9. 可观测与日常运维（刻意做「轻」）

- **健康探针**：项目无 `/healthz`。最轻探针 `GET /aiteam/api/auth/me` 未登录返回 **401**（`server/src/auth-routes.ts:47-52`），且该分支内部调 `countUsers()`，拿到 401 即同时证明「进程在听 + 路由正常 + sqlite 可读」。判状态码（401/200 健康），连接拒绝/超时/5xx 才异常。
- **进程守护**：systemd `Restart=always` + 应用启动自愈 = 完整「挂了发现+自愈」答案，**不需要 Prometheus/Grafana**。验证开机自启：`systemctl enable` 后 `reboot` 确认三项目都起来。
- **日志**：全 `console.*` → journald 自动接管轮转（§4.6 配额）。`journalctl -u aiteam -f`。三项目靠 `SyslogIdentifier` 分流。
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
先估容量：单张生成图典型几百 KB~2MB，`IMAGES_PER_RUN` 默认 2，按团队日产任务数 × 2 估月增量。设一个保留窗（如 90 天），定期清旧图：
```bash
# /opt/aiteam/ops/clean-assets.sh —— 删 90 天前的生成图（DB 里的历史文档引用会变成坏链，按需调整窗口）
# crontab: 0 4 * * 0  /opt/aiteam/ops/clean-assets.sh >> /var/log/aiteam-clean.log 2>&1
DATA_DIR="${AITEAM_DATA_DIR:-/var/lib/aiteam}"
find "$DATA_DIR/assets" -type f -mtime +90 -print -delete
```
> ⚠️ 清理会让早于窗口的文档里 `/aiteam/assets/*.png` 变坏链（应用不引用磁盘文件做正确性判断，只影响图片显示）。内部低频场景可把窗口放宽到 180~365 天，或先只告警不删。

> **例行任务调度**（`startScheduler`，30s 轮询比对上海时区 HH:MM）：重启安全（`last_run_date` 持久化去重）但**不补跑**——升级停机期间错过的时刻当天不再补。**升级窗口要避开例行任务密集时刻。**

---

## 10. 源码改动状态

把关键 blocker 从「靠运维兜底」变成「应用层根治」的改动已完成，本节仅留作记录与可选项：

1. **绑回环 ✅ 已合入**（`server/src/index.ts`）：
   `server.listen(PORT, HOST, ...)`，其中 `HOST = process.env.AITEAM_HOST || "127.0.0.1"`。
   **默认就只听回环**——同机 Nginx 反代/本地访问照常，公网无法直连（防火墙之外的第二层）。已实测：默认仅 `LISTEN 127.0.0.1:PORT`；`AITEAM_HOST=0.0.0.0`（容器/反代异机时）则听全网卡。**本场景 EnvironmentFile 里 `AITEAM_HOST` 可不设或显式设 `127.0.0.1`。**
2. **会话密钥 fail-fast ✅ 已合入**（`server/src/session.ts:12-17`，commit 0983fb6）：生产缺 `AITEAM_SESSION_SECRET` 直接拒启。
3. **MCP `/mcp-servers/:id/test` 补 `requireAdmin` ✅ 已合入**（`server/src/routes.ts:208`，commit 0983fb6）。
4. **凭证落库加密与 copy-only 旧格式迁移 ✅ 已合入**（`server/src/secrets.ts` / `server/src/db.ts`）：
   provider、MCP、文生图新凭证统一为 `enc1:`；生产缺固定凭证密钥时 fail-closed，且发现 plaintext /
   `enc:v1:` 会在原库写入前拒启并指向 `inspect` / `dry-run` / `migrate-copy`。仅 development/test
   为隔离夹具保留事务内原地规范化。

可选（按需，未合入）：
5. **请求体上限放宽**（`server/src/index.ts:26`）：若内部有粘贴长上下文需求，`express.json({limit:"1mb"})` → `"5mb"`（同时确认反代 `client_max_body_size` ≥ 此值）。
6. **预算日界显式上海时区**（共用主机若被迫用 UTC 才需要）：把 `budgetExhausted` 的 `setHours(0,0,0,0)` 改成与 `shanghaiNow` 一致的显式 `Asia/Shanghai` 计算，解耦系统 TZ。

---

## 11. 最终选定方案速览

| 决策项 | 结论 |
|---|---|
| 地域 | 中国大陆 |
| 接入 | 纯内网 IP + HTTP（不上域名/备案/HTTPS） |
| 模型 | 仅国内端点：对话 DeepSeek/GLM/Kimi（UI 配），文生图 Seedream（已内置） |
| 数据 | 全新部署（空 data 目录，注册首个 admin） |
| 进程 | systemd |
| 反代 | Nginx 单入口（加入已有或新装） |
| 端口绑定 | 8787 绑 127.0.0.1 + 安全组 + 主机防火墙双层兜底 |

---

## 12. 风险登记表

| 风险 | 触发条件 | 影响 | 缓解 |
|---|---|---|---|
| 8787 公网/内网越权可达 | 安全组放太宽 / 误设 `AITEAM_HOST=0.0.0.0` | 绕过反代直连，越权访问 | 代码默认已绑回环（§10#1 已合入）；安全组+ufw 双层只放可信网段；勿随意放开 `AITEAM_HOST` |
| 公开注册被抢注 admin | 部署后忘记关 `AITEAM_ALLOW_SIGNUP` | 外部抢注管理员 | 白名单 + 注册首个 admin 后立刻 `AITEAM_ALLOW_SIGNUP=0` 重启（必做，§0/§7） |
| better-sqlite3 ABI 不匹配 | 跨平台拷 node_modules / 换 Node 大版本 | 启动即 `ERR_DLOPEN_FAILED`/`invalid ELF` | 锁 Node 22；目标机 `npm ci --omit=dev`；失败才 `npm rebuild`（§3.2） |
| 误 `cp` 单 `aiteam.db` 导致数据损坏/丢失 | 直接拷运行中的 db、漏 `-wal`/`-shm` | 备份/恢复出坏库或丢未合并写入 | 备份用 VACUUM INTO 出干净单库；恢复先清脏 WAL（§5.1/§5.3/§5.4） |
| 反代去前缀导致全 404 | `proxy_pass` 末尾带 `/`/路径 | WS/API/静态全 404 | `proxy_pass` 末尾不带斜杠/路径，原样转发（§2.2/§4.3） |
| 拷部署破坏 dist 相对结构 | 只拷 `server/dist` 漏 `web/dist` 或破坏相对路径 | 前端静态静默失效，只剩 API/WS | rsync 保留 `server/dist` 与 `web/dist` 相对结构（§2.1/§6.1） |
| 时区错位 | VPS 留 UTC | 预算日界北京 08:00 重置、与图表错位 8h | `timedatectl set-timezone Asia/Shanghai` + NTP（§8.3） |
| 共用带宽抢占 | 生成图/pptx 导出突发下行 | 三项目一起卡/丢包 | 选稍宽固定带宽留余量 / QoS / 大文件走对象存储直链（§8.4） |
| 数据盘被 assets 撑满 | 文生图持续累积、无自动清理 | 殃及另两项目 | 磁盘水位告警 + 可选 assets 清理 cron（§9） |
| 跨 owner_id 迁移版本回滚不带库 | 只回滚代码、保留已迁移的库 | 旧代码不认新 schema，启动即报错 | 回滚必须连库一起回到迁移前的备份 DB（§6.2） |
| 三项目横向感染 | 同用户/共享目录可互读 | 一个被打穿牵连其余 | 独立 OS 用户 + systemd 沙箱 + 独立 data（§4.1/§7） |
| 凭证密钥不匹配或库内仍有旧格式 | 重启时生成新值 / 迁机漏带原密钥 / 库内仍有 plaintext / `enc:v1:` | provider、MCP、文生图凭证无法认证；生产在修改原库前拒启 | 固定保存 `AITEAM_CREDENTIAL_KEY`；旧库按 §5.1 在副本完成 `inspect` / `dry-run` / `migrate-copy`，旧密钥丢失则走 `rescue-copy` |
| 升级停机错过例行任务 | 升级窗口压在例行任务密集时刻 | 当天错过的时刻不补跑 | 升级窗口避开例行任务密集时刻（§9） |

---

## 附：与现有 `deploy/` 的关系
现有 `deploy/` 下的反代与 env 是为 **coworker 集成**写的（把 Coworker `:3000` + AiTeam `:8787` 统一到一个域名，env 用 `AUTH_SECRET`/`COWORKER_INTERNAL_URL`），**不适配本 standalone 场景**：本文用 §4.3 的 Nginx 单入口，env 换成 §4.2 的 standalone 版本（`AITEAM_AUTH_MODE=standalone` + `AITEAM_SESSION_SECRET` + `AITEAM_CREDENTIAL_KEY`，而非只依赖 `AUTH_SECRET`），不挂任何 `:3000`/coworker 段。仅当起点参考。

---

## 附：上线检查清单（按序勾选）
- [ ] 系统 TZ = `Asia/Shanghai` + NTP 开（`timedatectl status`）
- [ ] Node 22 + 编译链（大陆默认装）+ npm/二进制镜像
- [ ] `ss -ltnp 'sport = :80'` 确认 80 归属，决定加入已有 Nginx 还是新装（§2.3）
- [ ] `/etc/aiteam/aiteam.env`：`NODE_ENV=production`、固定的 `AITEAM_SESSION_SECRET` 与 `AITEAM_CREDENTIAL_KEY`（分别生成并安全保存）、`AITEAM_ADMIN_EMAILS`、`AITEAM_ALLOW_SIGNUP=1`；权限 600 属主 aiteam
- [ ] 确认绑回环生效（默认已合入）：启动日志应为 `http://127.0.0.1:8787`；勿误设 `AITEAM_HOST=0.0.0.0`
- [ ] systemd unit 装好、`enable`、`reboot` 验证开机自启
- [ ] 安全组 + ufw/firewalld 双层：8787/8788/8789 不入站；80 只放可信网段；22 加固
- [ ] Nginx 配置（路径前缀，§4.3）
- [ ] 注册首个 admin（白名单邮箱）→ 立刻 `AITEAM_ALLOW_SIGNUP=0` 重启
- [ ] 登录 UI 配 DeepSeek/GLM/Kimi 等国内 provider（不设 `ANTHROPIC_API_KEY`）
- [ ] 首个 Preview 确认数据库没有启用的 stdio MCP 且未设置 `AITEAM_MCP_STDIO_RUNNER`
- [ ] 后续 local stdio 灰度前：目标 Linux rootless Podman + cgroup v2 preflight、digest 镜像预拉取、`npm run test:stdio-sandbox:real` 和 systemd 重启演练全部通过
- [ ] 探针 `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/aiteam/api/auth/me` 返回 401
- [ ] 备份 cron + 一次手动 `backup.sh` + 一次 `restore.sh` 演练
- [ ] （可选）assets 清理 cron + 磁盘水位告警 webhook

---

## 后续（产品 beta 后再说，本阶段不展开）
- 当需要从内网走向公网正式访问时，再补「公网域名 + ICP 备案 + HTTPS」三件套：备案完成后在 §4.3 的 Nginx server 加 `listen 443 ssl` + 证书挂载、cookie 上 `Secure` 并 `app.set('trust proxy', 1)`、安全组改放 443。本阶段不实现。

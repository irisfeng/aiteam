# 统一 Web App 部署（Coworker + AiTeam · 单主机 · 双空间）

> 天翼云共享 VPS 的隔离灰度不要直接照搬本页的单机公网拓扑。请先执行
> [`AITEAM_GRAY_RUNBOOK.md`](./AITEAM_GRAY_RUNBOOK.md)：空库、Mock、回环端口、
> 独立 Docker 网络，且不修改现有入口或生产流量。

把「人的办公协作（Coworker）」与「AI 工具空间（AiTeam）」整合到**一个域名入口**下：
Coworker 在 `/`，AiTeam 在 `/aiteam/*`，前面一个 Caddy 统一对外（自动 HTTPS + WebSocket）。
两个空间**不共享数据库**；浏览器入口复用 Coworker 登录态，研究任务则由
Coworker 服务端通过带组织范围的短时服务 JWT 调用 AiTeam Mission API。
每个用户仍拥有**私有的 AI 工作区**。

```
                 ┌──────────── Caddy (唯一公网入口, :443) ───────────┐
  浏览器  ─────►  │  /aiteam/*  (含 /aiteam/ws)  → localhost:8787     │
                 │  其余 /*                     → localhost:3000     │
                 └──────────────────────────────────────────────────┘
                         │                              │
              AiTeam Express (:8787)          Coworker Next.js (:3000)
              better-sqlite3 / WS / 调度器      Turso / NextAuth
```

## 关键机制
- **统一入口**：同一域名，Caddy 按路径分流；同源使浏览器自动把会话 cookie 带到 `/aiteam/*`。
- **走 Coworker 鉴权**：AiTeam 的 Express 用 `@auth/core` + `AUTH_SECRET` **本地解密** NextAuth 会话 cookie（与 Coworker 同一套代码，零额外往返）。未登录 → 401。
- **Mission 服务鉴权**：Coworker 服务端用独立的
  `AITEAM_SERVICE_JWT_SECRET` 签发 60 秒 HS256 JWT；AiTeam 校验固定
  issuer/audience/subject、组织和 scope。该密钥不得复用 `AUTH_SECRET`。
- **每用户隔离**：AiTeam 全部业务数据带 `owner_id`（v0.1 = `user:<id>`），查询经 AsyncLocalStorage 自动按 owner 过滤、fail-closed；providers/MCP/skills 为全局共享配置。
- **可独立运行**：`AITEAM_AUTH_MODE=standalone` 时 AiTeam 退回原始单机单用户，不依赖 Coworker。

## 本地 / 单机运行
1. 复制 `deploy/.env.example`，填好 `AUTH_SECRET`、独立的
   `AITEAM_SERVICE_JWT_SECRET`（两边一致）、`ANTHROPIC_API_KEY` 及 Coworker
   自身变量。
2. 起 AiTeam：`cd aiteam && npm i && npm run build && AITEAM_AUTH_MODE=coworker AUTH_SECRET=... AITEAM_SERVICE_JWT_SECRET=... node server/dist/index.js`（:8787）
3. 起 Coworker：`cd coworker && npm i && AITEAM_INTERNAL_URL=http://localhost:8787 AITEAM_SERVICE_JWT_SECRET=... NEXT_PUBLIC_AITEAM_ENABLED=1 npx next build && npx next start`（:3000）
4. 起 Caddy：`caddy run --config deploy/Caddyfile`，访问 `http://localhost`，顶部用「Coworker ｜ AiTeam」切换。

> 部署须用支持**常驻进程 + WebSocket** 的主机（VPS/Railway/Render/Fly）——AiTeam 这半无法 Serverless。
> `aiteam/server/data/aiteam.db` 需纳入备份。
> Coworker 位于 Vercel 时，`AITEAM_INTERNAL_URL` 不能填 `localhost`；必须指向
> Vercel 可访问的 HTTPS AiTeam Preview。Preview 与 Production 必须使用
> 不同的 URL、服务密钥和数据目录。
> 本目录是 v0.1 的部署胶水，后续可整体抽到独立的 `aiteam-coworker` 仓库（用 submodule 引用两个 app）。

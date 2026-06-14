# HANDOFF — AiTeam Standalone：登录 + 权限模块（团队内部工具形态）

> 本文写给**接手的新 session**（在 `irisfeng/aiteam` 仓库里继续）。自包含，不依赖之前的对话。

## 0. 一句话目标

把 AiTeam 打磨成一个**可独立使用的团队内部 AI 协作产品**：原生**邮箱+密码登录** + **admin/member 权限**，每个成员一个私有 AI 工作区，API key 由组织（admin）统一配置。**不与 Coworker 合并**（整合方案暂停，保留可选模式）。

## 1. 背景 / 当前决策

- 之前在一个"整合 session"里探索过把 AiTeam 嵌进 Coworker（人办公协作产品）做统一入口。**结论：暂不合并**，改为**单独打磨 AiTeam standalone**（更聚焦、商业模型更干净）。
- 产品形态已定：**A = 团队/组织内部工具**（单组织部署，成员各自私有工作区，组织统一出 API key）。登录方式：**邮箱+密码**。
- 整合那条路的产物**保留不删**（`AITEAM_AUTH_MODE=coworker` 模式仍在），未来想合还能合。

## 2. 仓库 / 分支现状

| 仓库 | 分支 | 状态 |
|---|---|---|
| `irisfeng/aiteam` | `claude/nifty-maxwell-p0pr4f` (HEAD `c4e36e4`) | **standalone 工作的起点**（含下面说的 owner_id 资产） |
| `irisfeng/coworker` | `claude/nifty-maxwell-p0pr4f` | 整合用，**暂停**（PR #19 不合并） |
| `irisfeng/aiteam-coworker` | main | 整合部署胶水（submodule），**暂停** |

- 两个整合 PR（aiteam #1、coworker #19）**暂不合并**，已停止自动跟进。
- **从 `claude/nifty-maxwell-p0pr4f` 开个新分支**（如 `feat/standalone-auth`）继续 standalone。它已包含 owner_id 隔离这块核心资产。

## 3. 已完成的核心资产（这是为什么不算从零开始）—— 每用户隔离 `owner_id`

整合 session 里已经把 AiTeam 从"单用户全局工作区"改成了**每用户隔离**，并测过（隔离/IDOR/fail-closed 全过）。这正是多用户产品的命根子，**直接复用**。

- `server/src/ownerScope.ts`（新增）：基于 `AsyncLocalStorage` 的 owner 上下文。
  - `withOwner(ownerId, fn)`：在 owner 上下文内执行；
  - `currentOwner()`：取当前 owner，**缺上下文抛错（fail-closed，防跨租户泄漏）**；
  - `currentOwnerOrNull()`：广播等可 fail-safe 跳过的场景用；
  - `ownerFromUserId(userId)` → `user:<id>`（**命名空间主体**，为将来"部门共享"预留：届时写 `dept:<id>`、读 `visibleOwners()`，db/engine 不动）。
- `server/src/db.ts`：8 张业务表（agents/channels/messages/tasks/approvals/documents/routines/projects）加了 `owner_id`；所有 list/get/create/update 用 `currentOwner()` 自动加 `WHERE owner_id=?` / 注入 owner；`agents` 唯一约束改 `UNIQUE(owner_id,name)`。`providers/mcp_servers/skills/app_settings` **保持全局**（管理员配置层）。另有跨 owner 清扫函数 `listInFlightTasksAllOwners()` / `listRoutinesAllOwners()` 仅供调度器/重启恢复用。
- `server/src/agents/engine.ts`：在**队列边界 / 定时调度 / 重启恢复**三处用 `withOwner(...)` 重建上下文（因为这些在另一个请求/计时器里执行，ALS 上下文已丢）。其余运行天然继承上下文。
- `server/src/bus.ts`：WS 握手鉴权 + 每 socket 标 owner；`broadcast()` 只发给当前 owner 的 socket（fail-closed）。
- `server/src/seed.ts`：拆成 `seedGlobalSkills()`（启动播种全局技能）+ `seedForOwner()`（用户首次 bootstrap 播种私有工作区：4 个内置 agent + general 频道）。
- `server/src/db.ts` 支持 `AITEAM_DATA_DIR` 环境变量指向隔离数据目录（测试用）。

**鉴权抽象（关键 seam）**：`server/src/auth.ts` 有 `AITEAM_AUTH_MODE`：
- `coworker`：用 `@auth/core` 本地解密 Coworker 的 NextAuth 会话 cookie（整合用）；
- `standalone`：当前是**单一固定用户 `"user"`**（原始单机行为）。
- `requireUser` 中间件解析出 userId 后，用 `withOwner(ownerFromUserId(userId), () => next())` 包住整个请求 → 路由内 db 查询自动按 owner 隔离。

> **standalone 多用户化 = 把 `standalone` 模式从"单一固定用户"升级为"AiTeam 自己的会话校验"**，owner_id 基建一行不用动。

## 4. 实施计划（精确到文件）

### 4.1 认证：邮箱 + 密码（自建）
- **users 表**（`server/src/db.ts`，全局表，不带 owner_id）：`id, email UNIQUE, password_hash, display_name, role('admin'|'member'), created_at`。
- **密码哈希**：用 `node:crypto` scrypt（自包含、无新依赖）。可参考 Coworker 的 `src/lib/password.ts` 思路（scrypt + 盐，存 `scrypt$N$salt$hash` 格式）。
- **会话**：签发自己的 JWT（用 `jose`，已是 `@auth/core` 间接依赖；或加 `jsonwebtoken`），放 httpOnly cookie（如 `aiteam_session`）。env 加 `AITEAM_SESSION_SECRET`。
- **新增 API**（`server/src/routes.ts` 或新 `server/src/auth-routes.ts`，**这些路由不经 requireUser**）：
  - `POST /aiteam/api/auth/register`（邮箱+密码+显示名；首个注册用户自动 `admin`，其余 `member`——或用 env `AITEAM_ADMIN_EMAILS` 指定）；
  - `POST /aiteam/api/auth/login` → 校验 → 下发会话 cookie；
  - `POST /aiteam/api/auth/logout`；
  - `GET /aiteam/api/auth/me` → 当前用户信息（替代整合时回源 Coworker 的 `/api/me`）。
- **改 `server/src/auth.ts`**：`standalone` 模式下 `resolveUserId` 改为**解析 AiTeam 自己的会话 cookie**（验 JWT → userId）。owner 仍是 `ownerFromUserId(userId)`。未登录 → 401。
- **移除/停用 `server/src/coworker.ts`**（回源 Coworker 取 displayName 的逻辑）：standalone 下 bootstrap 的 `user.name` 直接用本地 users 表的 `display_name`（`server/src/routes.ts` 的 `/bootstrap` 已是 async，改成查本地用户即可）。

### 4.2 授权：admin / member
- `users.role`。中间件 `requireAdmin`（在 `requireUser` 之后，检查 `req.user.role==='admin'`）。
- **admin-only 写**的路由（这些是含 API key 的全局配置）：`POST/PATCH/DELETE /providers`、`/mcp-servers`、`PUT /image-provider`、`/skills` 写操作。读可保留给所有人或也限 admin（建议 providers/mcp 的**脱敏读**可给 member，key 永不下发——`sanitizeProvider`/`sanitizeMcpServer` 已脱敏）。
- 成员管理（admin）：`GET /users`、`PATCH /users/:id/role`、停用用户等（可选，v0.1 可后置）。

### 4.3 per-user 配额（防一个用户烧爆组织的 key）
- `server/src/agents/engine.ts` 的 `budgetExhausted()` 现在用 `agentDailyStats()`（已是 per-owner，因为在 owner 上下文里跑）→ 已经是"当前 owner 今日用量"。确认 `AITEAM_DAILY_TOKEN_BUDGET` 语义改为**每用户每日**即可（基本已成立，复核一遍）。

### 4.4 前端（`web/`）
- 加**登录/注册页**（未登录时 `bootstrap`/`/auth/me` 返回 401 → 显示登录页）。
- 顶部显示当前用户 + **登出**按钮。
- **设置区按角色门控**：providers/MCP/skills 配置入口仅 admin 可见可改（member 看只读或隐藏）。
- 现有 `web/src/store.tsx` 在 bootstrap 401 时跳登录即可。

### 4.5 路径前缀（一个小决策）
- 整合时把前端挂在了 `/aiteam/`（Vite `base`、`/aiteam/api`、`/aiteam/ws`、生成图 `/aiteam/assets`）。
- standalone 作为独立产品，**可还原到根 `/`**（更干净的 URL），或**保留 `/aiteam`**（零改动，纯路径前缀，功能无碍）。**建议：先保留 `/aiteam` 把登录+权限做完，URL 还原作为收尾的低优先项。** 若要还原：改 `web/vite.config.ts` base、`web/src/api.ts`、`web/src/store.tsx`、`server/src/index.ts` 挂载、`server/src/agents/images.ts`+`server/src/pptx.ts` 的 assets 前缀。

## 5. 需要你拍的决策点

1. **首个 admin 怎么定**：首个注册者自动 admin / 还是 `AITEAM_ADMIN_EMAILS` env 白名单？（建议后者，更可控）
2. **是否开放自助注册**：组织内部工具通常**关闭公开注册**，由 admin 邀请/建号。v0.1 可先开 `register` 方便起步，加个 env 开关 `AITEAM_ALLOW_SIGNUP`。
3. **member 能否自带 key（BYOK）**：A 形态默认"组织统一 key"，providers 全局 admin 配即可，**不需要** per-user key。若个别成员要自带，再说（owner_id 抽象支持扩展）。
4. **路径前缀**是否还原到根 `/`（见 4.5）。

## 6. 验证方法（沿用本项目已验证过的手法）
- **隔离单测**（tsx，临时库）：`AITEAM_DATA_DIR=/tmp/x npx tsx some.mts`，用 `withOwner('user:a',()=>…)` 建两个 owner 的数据，断言互相看不到 + 跨 owner `getX` 返回 undefined + 无上下文查询抛错。
- **类型/构建**：`npm run typecheck --workspace server`、`npm run build --workspace server`、`npm run typecheck --workspace web`、`npm run build --workspace web`。
- **启动冒烟**：`rm -rf server/data && PORT=87xx node server/dist/index.js`，curl `/aiteam/api/auth/register` → `/login` → 带 cookie 调 `/aiteam/api/bootstrap` 看是否 seed 出该用户私有工作区。

## 7. 坑 / 注意
- `better-sqlite3` 是同步 API；engine 是 async——ALS 上下文跨 await 会保持（已验证），但**队列/定时器边界必须显式 `withOwner` 重建**（见 §3，别漏）。
- 新增的鉴权路由（register/login）**不要**挂在 `requireUser` 之后（否则没登录就进不来）。
- 标识管理模型时**先读这份 handoff 第 3 节**——owner_id 基建已存在，别重复造。
- 提交若遇签名报错，可用 `git -c commit.gpgsign=false commit`（环境相关，未必发生）。

## 8. 起步命令
```bash
cd aiteam
git checkout claude/nifty-maxwell-p0pr4f
git checkout -b feat/standalone-auth
# 按 §4 开干：先 4.1 认证，再 4.2 权限，再 4.4 前端
```

---
*owner_id 隔离 = 已完成的最难的 70%；本次只需补"原生登录 + 角色门控 + 前端登录态"。*

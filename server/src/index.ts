import express from "express";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { api } from "./routes.js";
import { requireUser } from "./auth.js";
import { authRoutes } from "./auth-routes.js";
import { attachBus } from "./bus.js";
import { seedGlobalSkills } from "./seed.js";
import { finalizeStaleStreaming } from "./db.js";
import { isMock, recoverInFlightTasks, startScheduler } from "./agents/engine.js";
import { assetsDir } from "./agents/images.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
// 默认只听回环：本进程恒在反向代理（同机 Nginx → 127.0.0.1:PORT）之后，回环绑定使 8787
// 不直接暴露公网（防火墙之外的第二层防御）。容器/反代在别的主机时用 AITEAM_HOST=0.0.0.0（或私网 IP）放开。
const HOST = process.env.AITEAM_HOST || "127.0.0.1";

seedGlobalSkills();
const healed = finalizeStaleStreaming(); // 收口上次遗留的 streaming 中断消息，避免界面永久卡住
if (healed) console.log(`[aiteam] 收口 ${healed} 条中断的流式消息`);
startScheduler();
recoverInFlightTasks();

const app = express();
app.use(express.json({ limit: "1mb" }));
// 回归进程专用实例探针：只有显式注入随机 token 时才注册，避免固定端口误命中另一套 AiTeam 并污染其数据。
if (process.env.AITEAM_TEST_INSTANCE_ID) {
  app.get("/aiteam/api/__test/instance", (_req, res) => {
    res.json({ instance_id: process.env.AITEAM_TEST_INSTANCE_ID });
  });
}
// 整合后所有 AiTeam 路由统一挂在 /aiteam/* 前缀下（由反向代理路由到本进程）。
// 登录/注册路由公开（不经 requireUser，登出态也要能访问）；其余 API 一律需登录。
app.use("/aiteam/api/auth", authRoutes);
app.use("/aiteam/api", requireUser, api);
const assetsStatic = express.static(assetsDir, { maxAge: "30d", immutable: true });
app.use("/aiteam/assets", assetsStatic); // 生成图资产（新前缀）
app.use("/assets", assetsStatic); // 兼容历史内容里的 /assets/* 链接（数据迁移后可移除）

// 生产模式下托管前端构建产物（挂在 /aiteam/ 下，与 Vite base 一致）
const webDist = join(__dirname, "..", "..", "web", "dist");
if (existsSync(webDist)) {
  app.use("/aiteam", express.static(webDist));
  app.get(/^\/aiteam\/(?!api|ws|assets).*/, (_req, res) => res.sendFile(join(webDist, "index.html")));
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/aiteam/ws" });
attachBus(wss);

server.listen(PORT, HOST, () => {
  console.log(`[aiteam] server on http://${HOST}:${PORT} ${isMock() ? "(mock mode — 未配置任何模型 key)" : ""}`);
});

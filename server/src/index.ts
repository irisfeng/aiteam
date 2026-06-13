import express from "express";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { api } from "./routes.js";
import { requireUser } from "./auth.js";
import { attachBus } from "./bus.js";
import { seedGlobalSkills } from "./seed.js";
import { finalizeStaleStreaming } from "./db.js";
import { isMock, recoverInFlightTasks, startScheduler } from "./agents/engine.js";
import { assetsDir } from "./agents/images.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);

seedGlobalSkills();
const healed = finalizeStaleStreaming(); // 收口上次遗留的 streaming 中断消息，避免界面永久卡住
if (healed) console.log(`[aiteam] 收口 ${healed} 条中断的流式消息`);
startScheduler();
recoverInFlightTasks();

const app = express();
app.use(express.json({ limit: "1mb" }));
// 整合后所有 AiTeam 路由统一挂在 /aiteam/* 前缀下（由反向代理路由到本进程）。
// API 需要登录（standalone 模式下中间件放行为单用户）。
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

server.listen(PORT, () => {
  console.log(`[aiteam] server on http://localhost:${PORT} ${isMock() ? "(mock mode — 未配置任何模型 key)" : ""}`);
});

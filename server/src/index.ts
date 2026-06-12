import express from "express";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { api } from "./routes.js";
import { attachBus } from "./bus.js";
import { seedIfEmpty } from "./seed.js";
import { isMock, recoverInFlightTasks, startScheduler } from "./agents/engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);

seedIfEmpty();
startScheduler();
recoverInFlightTasks();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/api", api);

// 生产模式下托管前端构建产物
const webDist = join(__dirname, "..", "..", "web", "dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(join(webDist, "index.html")));
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
attachBus(wss);

server.listen(PORT, () => {
  console.log(`[aiteam] server on http://localhost:${PORT} ${isMock() ? "(mock mode — 未配置任何模型 key)" : ""}`);
});

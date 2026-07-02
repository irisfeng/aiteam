import type { IncomingMessage } from "node:http";
import type { WebSocket, WebSocketServer } from "ws";
import { resolveUserId } from "./auth.js";
import { currentOwnerOrNull, ownerFromUserId } from "./ownerScope.js";

let wss: WebSocketServer | null = null;
/** 每条连接归属的 owner（握手时用会话 cookie 解析），用于定向广播。 */
const ownerBySocket = new WeakMap<WebSocket, string>();

export function attachBus(server: WebSocketServer) {
  wss = server;
  server.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // 用与 HTTP 同一套鉴权解出 owner（standalone 模式恒为单用户）。未登录直接断开。
    void resolveUserId({ headers: req.headers as never })
      .then((userId) => {
        if (!userId) {
          try {
            ws.close(4401, "unauthorized");
          } catch {
            /* ignore */
          }
          return;
        }
        ownerBySocket.set(ws, ownerFromUserId(userId));
      })
      .catch(() => {
        try {
          ws.close(4401, "unauthorized");
        } catch {
          /* ignore */
        }
      });
  });
}

export type BusEvent =
  | { type: "message:new"; payload: unknown }
  | { type: "message:delta"; payload: { id: string; channel_id: string; delta: string } }
  | { type: "message:done"; payload: { id: string; channel_id: string; content: string; usage_json: string | null } }
  | { type: "agent:status"; payload: { agent_id: string; channel_id: string; state: "thinking" | "tool" | "responding" | "idle"; detail?: string } }
  | { type: "task:upsert"; payload: unknown }
  | { type: "task:event"; payload: unknown }
  | { type: "doc:upsert"; payload: unknown }
  | { type: "doc:delete"; payload: { ids: string[] } }
  | { type: "project:upsert"; payload: unknown }
  | { type: "approval:upsert"; payload: unknown }
  | { type: "channel:new"; payload: unknown }
  | { type: "channel:update"; payload: unknown }
  | { type: "channel:delete"; payload: { id: string } }
  | { type: "messages:cleared"; payload: { channel_id: string } };

/**
 * 仅向「当前 owner」的连接广播：owner 取自 AsyncLocalStorage 上下文（HTTP 请求或 Agent 运行）。
 * fail-closed —— 无 owner 上下文时跳过（绝不广播给全部连接），防止跨用户串台。
 */
export function broadcast(event: BusEvent) {
  if (!wss) return;
  const owner = currentOwnerOrNull();
  if (!owner) {
    console.warn(`[bus] broadcast skipped (no owner context): ${event.type}`);
    return;
  }
  const data = JSON.stringify(event);
  for (const client of wss.clients as Set<WebSocket>) {
    if (client.readyState === client.OPEN && ownerBySocket.get(client) === owner) client.send(data);
  }
}

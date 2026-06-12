import type { WebSocket, WebSocketServer } from "ws";

let wss: WebSocketServer | null = null;

export function attachBus(server: WebSocketServer) {
  wss = server;
}

export type BusEvent =
  | { type: "message:new"; payload: unknown }
  | { type: "message:delta"; payload: { id: string; channel_id: string; delta: string } }
  | { type: "message:done"; payload: { id: string; channel_id: string; content: string; usage_json: string | null } }
  | { type: "agent:status"; payload: { agent_id: string; channel_id: string; state: "thinking" | "tool" | "responding" | "idle"; detail?: string } }
  | { type: "task:upsert"; payload: unknown }
  | { type: "doc:upsert"; payload: unknown }
  | { type: "project:upsert"; payload: unknown }
  | { type: "approval:upsert"; payload: unknown }
  | { type: "channel:new"; payload: unknown }
  | { type: "channel:update"; payload: unknown }
  | { type: "channel:delete"; payload: { id: string } };

export function broadcast(event: BusEvent) {
  if (!wss) return;
  const data = JSON.stringify(event);
  for (const client of wss.clients as Set<WebSocket>) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

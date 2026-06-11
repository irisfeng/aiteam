import { Router } from "express";
import {
  createAgent,
  createChannel,
  createTask,
  findDm,
  getAgent,
  getChannel,
  insertMessage,
  listAgents,
  listApprovals,
  listChannels,
  listMessages,
  listTasks,
  resolveApproval,
  updateTask,
} from "./db.js";
import { broadcast } from "./bus.js";
import { isMockMode, onMessage, triggerAgent } from "./agents/engine.js";

export const api = Router();

api.get("/bootstrap", (_req, res) => {
  res.json({
    user: { id: "user", name: process.env.AITEAM_USER_NAME || "我" },
    mock_mode: isMockMode,
    agents: listAgents(),
    channels: listChannels(),
    tasks: listTasks(),
    approvals: listApprovals(),
  });
});

api.get("/channels/:id/messages", (req, res) => {
  const channel = getChannel(req.params.id);
  if (!channel) return res.status(404).json({ error: "channel not found" });
  res.json(listMessages(channel.id));
});

api.post("/channels/:id/messages", (req, res) => {
  const channel = getChannel(req.params.id);
  if (!channel) return res.status(404).json({ error: "channel not found" });
  const content = String(req.body?.content ?? "").trim();
  if (!content) return res.status(400).json({ error: "content required" });
  const msg = insertMessage({ channel_id: channel.id, author_type: "user", author_id: "user", content });
  broadcast({ type: "message:new", payload: msg });
  onMessage(msg);
  res.json(msg);
});

api.post("/channels", (req, res) => {
  const name = String(req.body?.name ?? "").trim().replace(/^#/, "");
  const agentIds: string[] = Array.isArray(req.body?.agent_ids) ? req.body.agent_ids : [];
  if (!name) return res.status(400).json({ error: "name required" });
  const channel = createChannel(name, agentIds);
  const names = agentIds.map((id) => getAgent(id)?.name).filter(Boolean).join("、");
  const sys = insertMessage({
    channel_id: channel.id,
    author_type: "system",
    content: names ? `频道已创建，AI 同事 ${names} 已加入。` : "频道已创建。",
  });
  broadcast({ type: "channel:new", payload: channel });
  broadcast({ type: "message:new", payload: sys });
  res.json(channel);
});

api.post("/dms", (req, res) => {
  const agent = getAgent(String(req.body?.agent_id ?? ""));
  if (!agent) return res.status(404).json({ error: "agent not found" });
  let channel = findDm(agent.id);
  if (!channel) {
    channel = createChannel(agent.name, [agent.id], "dm", agent.id);
    broadcast({ type: "channel:new", payload: channel });
  }
  res.json(channel);
});

api.post("/agents", (req, res) => {
  const { name, emoji, role, system_prompt, model } = req.body ?? {};
  if (!name || !system_prompt) return res.status(400).json({ error: "name and system_prompt required" });
  try {
    const agent = createAgent({
      name: String(name).trim(),
      emoji: String(emoji || "🤖"),
      role: String(role || ""),
      system_prompt: String(system_prompt),
      model: model ? String(model) : undefined,
    });
    res.json(agent);
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "create failed" });
  }
});

api.get("/tasks", (_req, res) => res.json(listTasks()));

api.post("/tasks", (req, res) => {
  const { title, description, channel_id, assignee_agent_id } = req.body ?? {};
  if (!title) return res.status(400).json({ error: "title required" });
  const task = createTask({
    title: String(title),
    description: String(description ?? ""),
    channel_id: channel_id ?? null,
    assignee_agent_id: assignee_agent_id ?? null,
    created_by: "user",
  });
  broadcast({ type: "task:upsert", payload: task });
  res.json(task);
});

api.patch("/tasks/:id", (req, res) => {
  const { title, description, status, assignee_agent_id } = req.body ?? {};
  const task = updateTask(req.params.id, {
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(assignee_agent_id !== undefined ? { assignee_agent_id } : {}),
  });
  if (!task) return res.status(404).json({ error: "task not found" });
  broadcast({ type: "task:upsert", payload: task });
  res.json(task);
});

api.post("/approvals/:id/resolve", (req, res) => {
  const approve = Boolean(req.body?.approve);
  const approval = resolveApproval(req.params.id, approve);
  if (!approval) return res.status(404).json({ error: "approval not found" });
  broadcast({ type: "approval:upsert", payload: approval });
  if (approval.channel_id) {
    const agent = getAgent(approval.agent_id);
    const sys = insertMessage({
      channel_id: approval.channel_id,
      author_type: "system",
      content: `${approve ? "✅ 用户批准了" : "❌ 用户拒绝了"} ${agent?.name ?? "AI"} 的审批请求「${approval.title}」`,
    });
    broadcast({ type: "message:new", payload: sys });
    triggerAgent(approval.agent_id, approval.channel_id);
  }
  res.json(approval);
});

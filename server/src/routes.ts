import { Router } from "express";
import {
  clearChannelMessages,
  clearMemory,
  createAgent,
  createMcpServer,
  createSkill,
  deleteChannel,
  deleteMcpServer,
  deleteSkill,
  getMcpServer,
  getMessage,
  listMcpServers,
  listSkills,
  renameChannel,
  sanitizeMcpServer,
  setMcpServerEnabled,
  updateSkill,
  usageDaily,
  usageRecent,
  createChannel,
  createTask,
  findDm,
  getAgent,
  getChannel,
  getMemory,
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
import type { AuthedRequest } from "./auth.js";
import { seedForOwner } from "./seed.js";
import { AGENT_TEMPLATES, getTemplate } from "./agents/templates.js";
import { dropConnection, testMcpServer } from "./agents/mcp.js";
import {
  createProvider,
  deleteProvider,
  deleteRoutine,
  getDocument,
  getImageProvider,
  getProvider,
  listDocuments,
  listProjects,
  listProviders,
  listRoutines,
  sanitizeImageProvider,
  sanitizeProvider,
  setImageProvider,
  updateProvider,
} from "./db.js";
import { slidesToPptx } from "./pptx.js";
import { DEFAULT_IMAGE_BASE_URL } from "./agents/images.js";
import {
  isMock,
  onMessage,
  onPlanResolved,
  onTaskAssigned,
  onTaskDelivered,
  stopTask,
  teamStatus,
  triggerAgent,
} from "./agents/engine.js";

export const api = Router();

api.get("/bootstrap", (req, res) => {
  seedForOwner(); // 首次进入：为当前用户播种私有工作区（幂等）
  res.json({
    user: { id: (req as AuthedRequest).userId ?? "user", name: process.env.AITEAM_USER_NAME || "我" },
    mock_mode: isMock(),
    providers: listProviders().map(sanitizeProvider),
    agents: listAgents(),
    channels: listChannels(),
    tasks: listTasks(),
    approvals: listApprovals(),
    documents: listDocuments(),
    projects: listProjects(),
    skills: listSkills(),
    mcp_servers: listMcpServers().map(sanitizeMcpServer),
    image_provider: sanitizeImageProvider(getImageProvider()),
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
  let replyTo: string | null = null;
  if (req.body?.reply_to) {
    const target = getMessage(String(req.body.reply_to));
    if (target && target.channel_id === channel.id) replyTo = target.id;
  }
  const msg = insertMessage({ channel_id: channel.id, author_type: "user", author_id: (req as AuthedRequest).userId ?? "user", content, reply_to: replyTo });
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
  const { name, emoji, role, system_prompt, model, provider_id } = req.body ?? {};
  if (!name || !system_prompt) return res.status(400).json({ error: "name and system_prompt required" });
  const provider = provider_id ? getProvider(String(provider_id)) : undefined;
  if (provider_id && !provider) return res.status(400).json({ error: "provider not found" });
  try {
    const agent = createAgent({
      name: String(name).trim(),
      emoji: String(emoji || "🤖"),
      role: String(role || ""),
      system_prompt: String(system_prompt),
      model: model ? String(model) : provider?.default_model || undefined,
      provider_id: provider?.id ?? null,
    });
    res.json(agent);
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "create failed" });
  }
});

api.get("/mcp-servers", (_req, res) => res.json(listMcpServers().map(sanitizeMcpServer)));

api.post("/mcp-servers", (req, res) => {
  const { name, kind, url, auth_token, command, args } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name required" });
  if (kind === "stdio" && !command) return res.status(400).json({ error: "command required for stdio" });
  if (kind !== "stdio" && !url) return res.status(400).json({ error: "url required for http" });
  const server = createMcpServer({
    name: String(name).trim(),
    kind: kind === "stdio" ? "stdio" : "http",
    url: String(url ?? "").trim(),
    auth_token: String(auth_token ?? "").trim(),
    command: String(command ?? "").trim(),
    args: Array.isArray(args) ? args.map(String) : String(args ?? "").split(/\s+/).filter(Boolean),
  });
  res.json(sanitizeMcpServer(server));
});

api.post("/mcp-servers/:id/toggle", (req, res) => {
  const server = setMcpServerEnabled(req.params.id, Boolean(req.body?.enabled));
  if (!server) return res.status(404).json({ error: "not found" });
  if (!server.enabled) dropConnection(server.id);
  res.json(sanitizeMcpServer(server));
});

api.post("/mcp-servers/:id/test", (req, res) => {
  const server = getMcpServer(req.params.id);
  if (!server) return res.status(404).json({ error: "not found" });
  testMcpServer(server)
    .then((count) => res.json({ ok: true, tools: count }))
    .catch((err) => res.status(502).json({ error: String(err?.message ?? err) }));
});

api.delete("/mcp-servers/:id", (req, res) => {
  dropConnection(req.params.id);
  deleteMcpServer(req.params.id);
  res.json({ ok: true });
});

api.get("/skills", (_req, res) => res.json(listSkills()));

api.post("/skills", (req, res) => {
  const { name, desc, content } = req.body ?? {};
  if (!name || !content) return res.status(400).json({ error: "name and content required" });
  res.json(createSkill({ name: String(name).trim(), desc: String(desc ?? "").trim(), content: String(content) }));
});

api.patch("/skills/:id", (req, res) => {
  const { enabled, name, desc, content } = req.body ?? {};
  const skill = updateSkill(req.params.id, {
    ...(enabled !== undefined ? { enabled: Boolean(enabled) } : {}),
    ...(name !== undefined ? { name: String(name) } : {}),
    ...(desc !== undefined ? { desc: String(desc) } : {}),
    ...(content !== undefined ? { content: String(content) } : {}),
  });
  if (!skill) return res.status(404).json({ error: "not found" });
  res.json(skill);
});

api.delete("/skills/:id", (req, res) => {
  deleteSkill(req.params.id); // builtin 不可删（SQL 层保护）
  res.json({ ok: true });
});

api.get("/usage", (_req, res) => {
  const agents = Object.fromEntries(listAgents().map((a) => [a.id, a.name]));
  res.json({
    daily: usageDaily(14),
    recent: usageRecent(40).map((r) => {
      let input = 0, output = 0;
      try {
        const u = JSON.parse(r.usage_json);
        input = u.input_tokens ?? 0;
        output = u.output_tokens ?? 0;
      } catch { /* ignore */ }
      return {
        ts: r.created_at,
        agent: agents[r.author_id] ?? r.author_id,
        model: r.model || "—",
        snippet: r.snippet,
        input,
        output,
      };
    }),
  });
});

api.delete("/channels/:id/messages", (req, res) => {
  const channel = getChannel(req.params.id);
  if (!channel) return res.status(404).json({ error: "channel not found" });
  clearChannelMessages(channel.id);
  broadcast({ type: "messages:cleared", payload: { channel_id: channel.id } });
  const sys = insertMessage({ channel_id: channel.id, author_type: "system", content: "🧹 对话记录已清空（任务与文档不受影响）" });
  broadcast({ type: "message:new", payload: sys });
  res.json({ ok: true });
});

api.patch("/channels/:id", (req, res) => {
  const name = String(req.body?.name ?? "").trim().replace(/^#/, "");
  if (!name) return res.status(400).json({ error: "name required" });
  const channel = renameChannel(req.params.id, name);
  if (!channel) return res.status(404).json({ error: "channel not found" });
  broadcast({ type: "channel:update", payload: channel });
  res.json(channel);
});

api.delete("/channels/:id", (req, res) => {
  const channel = getChannel(req.params.id);
  if (!channel) return res.status(404).json({ error: "channel not found" });
  deleteChannel(channel.id);
  broadcast({ type: "channel:delete", payload: { id: channel.id } });
  res.json({ ok: true });
});

api.get("/agent-templates", (_req, res) => {
  const existing = new Set(listAgents().map((a) => a.name));
  res.json(
    AGENT_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      emoji: t.emoji,
      role: t.role,
      desc: t.desc,
      category: t.category,
      installed: existing.has(t.name),
    }))
  );
});

api.post("/agents/from-template", (req, res) => {
  const template = getTemplate(String(req.body?.template_id ?? ""));
  if (!template) return res.status(404).json({ error: "template not found" });
  const existing = listAgents().find((a) => a.name === template.name);
  if (existing) return res.json(existing); // 幂等：已实例化则直接返回
  const agent = createAgent({
    name: template.name,
    emoji: template.emoji,
    role: template.role,
    system_prompt: template.system_prompt,
  });
  res.json(agent);
});

api.post("/providers", (req, res) => {
  const { name, base_url, api_key, default_model, light_model, max_tokens, web_tools, is_strong } = req.body ?? {};
  if (!name || !api_key) return res.status(400).json({ error: "name and api_key required" });
  const provider = createProvider({
    name: String(name).trim(),
    base_url: String(base_url ?? "").trim().replace(/\/$/, ""),
    api_key: String(api_key).trim(),
    default_model: String(default_model ?? "").trim(),
    light_model: String(light_model ?? "").trim(),
    max_tokens: Number(max_tokens) || undefined,
    web_tools: Boolean(web_tools),
    is_strong: Boolean(is_strong),
  });
  res.json(sanitizeProvider(provider));
});

api.patch("/providers/:id", (req, res) => {
  const { name, base_url, api_key, default_model, light_model, max_tokens, web_tools, is_strong } = req.body ?? {};
  const provider = updateProvider(req.params.id, {
    ...(name !== undefined ? { name: String(name).trim() } : {}),
    ...(base_url !== undefined ? { base_url: String(base_url).trim().replace(/\/$/, "") } : {}),
    ...(api_key !== undefined ? { api_key: String(api_key).trim() } : {}),
    ...(default_model !== undefined ? { default_model: String(default_model).trim() } : {}),
    ...(light_model !== undefined ? { light_model: String(light_model).trim() } : {}),
    ...(max_tokens !== undefined ? { max_tokens: Number(max_tokens) || 16000 } : {}),
    ...(web_tools !== undefined ? { web_tools: web_tools ? 1 : 0 } : {}),
    ...(is_strong !== undefined ? { is_strong: is_strong ? 1 : 0 } : {}),
  });
  if (!provider) return res.status(404).json({ error: "provider not found" });
  res.json(sanitizeProvider(provider));
});

api.delete("/providers/:id", (req, res) => {
  deleteProvider(req.params.id);
  res.json({ ok: true });
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
  if (task.assignee_agent_id) onTaskAssigned(task);
  res.json(task);
});

api.patch("/tasks/:id", (req, res) => {
  const { title, description, status, assignee_agent_id } = req.body ?? {};
  const prev = listTasks().find((t) => t.id === req.params.id);
  const task = updateTask(req.params.id, {
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(assignee_agent_id !== undefined ? { assignee_agent_id } : {}),
  });
  if (!task) return res.status(404).json({ error: "task not found" });
  broadcast({ type: "task:upsert", payload: task });
  // 用户把任务指派给了新的 AI 同事 → 对方自动开工
  if (task.assignee_agent_id && task.assignee_agent_id !== prev?.assignee_agent_id) onTaskAssigned(task);
  // 人工把任务推进到交付态 → 解锁依赖它的任务 / 触发项目汇总
  const delivered = task.status === "review" || task.status === "done";
  const wasDelivered = prev?.status === "review" || prev?.status === "done";
  if (delivered && !wasDelivered) onTaskDelivered(task);
  res.json(task);
});

api.post("/tasks/:id/stop", (req, res) => {
  stopTask(req.params.id);
  res.json({ ok: true });
});

api.get("/documents", (_req, res) => res.json(listDocuments()));

/** slides 文档导出为真 .pptx（可编辑文本 + Hive 主题 + 讲者备注 + 嵌入生成图） */
api.get("/documents/:id/pptx", (req, res) => {
  const doc = getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: "document not found" });
  if (doc.kind !== "slides") return res.status(400).json({ error: "only slides documents can be exported as pptx" });
  slidesToPptx(doc)
    .then((buf) => {
      const filename = encodeURIComponent(doc.title.replace(/[\\/:*?"<>|]/g, "_") + ".pptx");
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${filename}`);
      res.send(buf);
    })
    .catch((err) => res.status(500).json({ error: String(err?.message ?? err) }));
});

/** 图像生成供应商（Seedream / OpenAI images 协议）：key 只存服务端 */
api.get("/image-provider", (_req, res) =>
  res.json({ ...sanitizeImageProvider(getImageProvider()), default_base_url: DEFAULT_IMAGE_BASE_URL })
);
api.put("/image-provider", (req, res) => {
  const { base_url, api_key, model } = req.body ?? {};
  const next = setImageProvider({
    ...(base_url !== undefined ? { base_url: String(base_url) } : {}),
    ...(api_key !== undefined ? { api_key: String(api_key) } : {}),
    ...(model !== undefined ? { model: String(model) } : {}),
  });
  res.json(sanitizeImageProvider(next));
});

api.get("/team", (_req, res) => res.json({ members: teamStatus(), routines: listRoutines() }));

api.get("/agents/:id/memory", (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "agent not found" });
  res.json({ content: getMemory(agent.id) });
});

api.delete("/agents/:id/memory", (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "agent not found" });
  clearMemory(agent.id);
  res.json({ ok: true });
});

/** 工作区快照导出（Markdown）：把全部时间线/任务/文档/项目打包成一个文件，便于反馈与归档 */
api.get("/export.md", (_req, res) => {
  const agentName = (id: string | null) => (id ? getAgent(id)?.name ?? id : "—");
  const ts = (n: number) => new Date(n).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const lines: string[] = [`# AITeam 工作区快照`, ``, `> 导出时间：${ts(Date.now())}`, ``];

  lines.push(`## AI 同事`, ``);
  for (const a of listAgents()) lines.push(`- ${a.emoji} **${a.name}**（${a.role}）模型: ${a.model}${a.provider_id ? " @自定义供应商" : ""}`);

  const projects = listProjects();
  if (projects.length) {
    lines.push(``, `## 项目`, ``);
    for (const p of projects) lines.push(`- [${p.status}] **${p.title}** — ${p.goal.slice(0, 120)}（Lead: ${agentName(p.lead_agent_id)}，自主度: ${p.autonomy}）`);
  }

  lines.push(``, `## 任务看板`, ``, `| 状态 | 任务 | 负责人 | 档位 | 返工 |`, `|---|---|---|---|---|`);
  for (const t of listTasks()) lines.push(`| ${t.status} | ${t.title} | ${agentName(t.assignee_agent_id)} | ${t.model_tier} | ${t.revision_count} |`);

  const docs = listDocuments();
  if (docs.length) {
    lines.push(``, `## 文档库`, ``);
    for (const d of docs) lines.push(`- [${d.kind}]《${d.title}》by ${agentName(d.agent_id)}，${d.content.length} 字，${ts(d.created_at)}`);
  }

  const approvals = listApprovals();
  if (approvals.length) {
    lines.push(``, `## 审批`, ``);
    for (const a of approvals) lines.push(`- [${a.status}] (${a.kind}) ${a.title} — ${agentName(a.agent_id)}`);
  }

  for (const c of listChannels()) {
    lines.push(``, `## 频道 ${c.kind === "dm" ? "私信" : "#"}${c.name}`, ``);
    for (const m of listMessages(c.id, 200)) {
      const who = m.author_type === "user" ? "用户" : m.author_type === "system" ? "[系统]" : `${agentName(m.author_id)}(AI)`;
      const body = m.content.length > 1500 ? m.content.slice(0, 1500) + `\n…（截断，全文 ${m.content.length} 字）` : m.content;
      lines.push(`**${who}** · ${ts(m.created_at)}${m.status === "error" ? " · ⚠️中断" : ""}`, ``, body, ``, `---`, ``);
    }
  }

  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.send(lines.join("\n"));
});

api.delete("/routines/:id", (req, res) => {
  deleteRoutine(req.params.id);
  res.json({ ok: true });
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
    if (approval.kind === "plan" && approval.ref_id) {
      onPlanResolved(approval.ref_id, approve); // 计划把关：批准开工 / 退回唤起 Lead
    } else {
      triggerAgent(approval.agent_id, approval.channel_id);
    }
  }
  res.json(approval);
});

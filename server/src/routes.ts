import { Router } from "express";
import {
  clearChannelMessages,
  clearMemory,
  closeProject,
  createAgent,
  createMcpServer,
  createSkill,
  deleteChannel,
  deleteMcpServer,
  deleteSkill,
  getMcpServer,
  getMessage,
  getUserById,
  listMcpServers,
  listSkills,
  readUsage,
  renameChannel,
  setChannelAgents,
  sanitizeMcpServer,
  setMcpServerEnabled,
  updateSkill,
  usageDaily,
  usageRecent,
  createChannel,
  createTask,
  deleteDocument,
  findDm,
  getAgent,
  getChannel,
  getMemory,
  listDocumentVersions,
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
import { requireAdmin, type AuthedRequest } from "./auth.js";
import { fetchCoworkerMe } from "./coworker.js";
import { seedForOwner } from "./seed.js";
import { AGENT_TEMPLATES, getTemplate } from "./agents/templates.js";
import multer from "multer";
import { withOwner, ownerFromUserId } from "./ownerScope.js";
import { dropConnection, testMcpServer, callMcpTool, mcpToolPrefixReady } from "./agents/mcp.js";
import { UPLOAD_MAX_BYTES, TEXT_EXTS, DOC_EXTS, extOf, withTempFile, persistTemplateBinary, readTemplateBinary, removeTemplateBinary } from "./uploads.js";
import { parseTemplate, applyTemplateEdits, type TemplateEdit } from "./pptx-template.js";
import {
  createDocument,
  createProvider,
  deleteProvider,
  deleteRoutine,
  getDocument,
  setDocumentBlobPath,
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
import { MCP_REGISTRY, SKILL_PACK_REGISTRY } from "./registry.js";
import { DEFAULT_IMAGE_BASE_URL } from "./agents/images.js";
import {
  isMock,
  onMessage,
  onPlanResolved,
  onTaskAssigned,
  onTaskDelivered,
  oneShotComplete,
  stopChannel,
  stopTask,
  teamStatus,
  triggerAgent,
} from "./agents/engine.js";

export const api = Router();

api.get("/bootstrap", async (req, res) => {
  seedForOwner(); // 首次进入：为当前用户播种私有工作区（幂等）
  const userId = (req as AuthedRequest).userId;
  // standalone：展示名/角色取本地 users 表；coworker：回源 Coworker 取展示名（best-effort）
  const localUser = userId ? getUserById(userId) : undefined;
  const name = localUser?.display_name || (await fetchCoworkerMe(userId, req.headers.cookie))?.displayName || process.env.AITEAM_USER_NAME || "我";
  res.json({
    user: { id: userId ?? "user", name, role: localUser?.role ?? "admin" },
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
    registry: { mcp: MCP_REGISTRY, skills: SKILL_PACK_REGISTRY }, // 静态预设目录，无实例 token
  });
});

/** 预设目录（Skill/MCP 一键浏览推荐）：静态、无 token，member 可读；安装走 /mcp-servers（requireAdmin）。 */
api.get("/registry", (_req, res) => res.json({ mcp: MCP_REGISTRY, skills: SKILL_PACK_REGISTRY }));

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

/** 频道级停止：中断该频道里正在跑的 AI 运行（含没有 taskId 的聊天回复）。 */
api.post("/channels/:id/stop", (req, res) => {
  const channel = getChannel(req.params.id);
  if (!channel) return res.status(404).json({ error: "channel not found" });
  const stopped = stopChannel(channel.id);
  if (stopped) {
    const sys = insertMessage({ channel_id: channel.id, author_type: "system", content: "⏹ 已按用户要求停止当前运行" });
    broadcast({ type: "message:new", payload: sys });
  }
  res.json({ ok: true, stopped });
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

api.post("/mcp-servers", requireAdmin, (req, res) => {
  const { name, kind, url, auth_token, command, args, safety, env } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name required" });
  if (kind === "stdio" && !command) return res.status(400).json({ error: "command required for stdio" });
  if (kind !== "stdio" && !url) return res.status(400).json({ error: "url required for http" });
  // 环境变量（stdio MCP 的密钥，如 BOCHA_API_KEY）：仅收非空字符串键值对
  const envObj: Record<string, string> = {};
  if (env && typeof env === "object" && !Array.isArray(env)) {
    for (const [k, v] of Object.entries(env)) {
      const key = String(k).trim();
      if (key && v != null && String(v) !== "") envObj[key] = String(v);
    }
  }
  const server = createMcpServer({
    name: String(name).trim(),
    kind: kind === "stdio" ? "stdio" : "http",
    url: String(url ?? "").trim(),
    auth_token: String(auth_token ?? "").trim(),
    command: String(command ?? "").trim(),
    args: Array.isArray(args) ? args.map(String) : String(args ?? "").split(/\s+/).filter(Boolean),
    // 安全分级：registry 高危预设带入 exec/network → exec 受引擎审批门约束；缺省 local
    safety: safety === "exec" || safety === "network" ? safety : "local",
    env: envObj,
  });
  res.json(sanitizeMcpServer(server));
});

api.post("/mcp-servers/:id/toggle", requireAdmin, (req, res) => {
  const server = setMcpServerEnabled(req.params.id, Boolean(req.body?.enabled));
  if (!server) return res.status(404).json({ error: "not found" });
  if (!server.enabled) dropConnection(server.id);
  res.json(sanitizeMcpServer(server));
});

api.post("/mcp-servers/:id/test", requireAdmin, (req, res) => {
  // 必须 requireAdmin：test 会真实拉起 stdio 子进程（StdioClientTransport），
  // 与 create/toggle/delete 同级别风险，不能只 requireUser 让普通成员触发子进程派生。
  const server = getMcpServer(req.params.id);
  if (!server) return res.status(404).json({ error: "not found" });
  testMcpServer(server)
    .then((count) => res.json({ ok: true, tools: count }))
    .catch((err) => res.status(502).json({ error: String(err?.message ?? err) }));
});

api.delete("/mcp-servers/:id", requireAdmin, (req, res) => {
  dropConnection(req.params.id);
  deleteMcpServer(req.params.id);
  res.json({ ok: true });
});

api.get("/skills", (_req, res) => res.json(listSkills()));

api.post("/skills", requireAdmin, (req, res) => {
  const { name, desc, content, body, kind, trigger, when_to_use, resources_json } = req.body ?? {};
  const text = body ?? content; // v2 用 body；兼容旧 UI 的 content
  if (!name || !text) return res.status(400).json({ error: "name and content required" });
  res.json(
    createSkill({
      name: String(name).trim(),
      desc: String(desc ?? "").trim(),
      body: String(text),
      kind: kind === "capability" ? "capability" : "method",
      ...(trigger !== undefined ? { trigger: String(trigger).trim() } : {}),
      ...(when_to_use !== undefined ? { when_to_use: String(when_to_use).trim() } : {}),
      ...(resources_json !== undefined ? { resources_json: String(resources_json) } : {}),
    })
  );
});

api.patch("/skills/:id", requireAdmin, (req, res) => {
  const { enabled, name, desc, content, body, kind, trigger, when_to_use, resources_json } = req.body ?? {};
  const skill = updateSkill(req.params.id, {
    ...(enabled !== undefined ? { enabled: Boolean(enabled) } : {}),
    ...(name !== undefined ? { name: String(name) } : {}),
    ...(desc !== undefined ? { desc: String(desc) } : {}),
    ...(content !== undefined ? { content: String(content) } : {}),
    ...(body !== undefined ? { body: String(body) } : {}),
    ...(kind !== undefined ? { kind: kind === "capability" ? "capability" : "method" } : {}),
    ...(trigger !== undefined ? { trigger: String(trigger) } : {}),
    ...(when_to_use !== undefined ? { when_to_use: String(when_to_use) } : {}),
    ...(resources_json !== undefined ? { resources_json: String(resources_json) } : {}),
  });
  if (!skill) return res.status(404).json({ error: "not found" });
  res.json(skill);
});

api.delete("/skills/:id", requireAdmin, (req, res) => {
  deleteSkill(req.params.id); // builtin 不可删（SQL 层保护）
  res.json({ ok: true });
});

api.get("/usage", (_req, res) => {
  const agents = Object.fromEntries(listAgents().map((a) => [a.id, a.name]));
  res.json({
    daily: usageDaily(14),
    recent: usageRecent(40).map((r) => {
      const u = readUsage(r.usage_json);
      return {
        ts: r.created_at,
        agent: agents[r.author_id] ?? r.author_id,
        model: r.model || "—",
        snippet: r.snippet,
        input: u.promptTotal,
        output: u.output,
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
  let channel = getChannel(req.params.id);
  if (!channel) return res.status(404).json({ error: "channel not found" });
  // 改名（可选）
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim().replace(/^#/, "");
    if (!name) return res.status(400).json({ error: "name required" });
    channel = renameChannel(channel.id, name) ?? channel;
  }
  // 增减 AI 成员（可选，按场景定制）
  if (Array.isArray(req.body?.agent_ids)) {
    channel = setChannelAgents(channel.id, req.body.agent_ids.map(String)) ?? channel;
  }
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

api.post("/providers", requireAdmin, (req, res) => {
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

api.patch("/providers/:id", requireAdmin, (req, res) => {
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

api.delete("/providers/:id", requireAdmin, (req, res) => {
  deleteProvider(req.params.id);
  res.json({ ok: true });
});

api.get("/tasks", (_req, res) => res.json(listTasks()));

api.post("/tasks", (req, res) => {
  const { title, description, channel_id, assignee_agent_id, acceptance_criteria, source_doc_ids } = req.body ?? {};
  if (!title) return res.status(400).json({ error: "title required" });
  const task = createTask({
    title: String(title),
    description: String(description ?? ""),
    acceptance_criteria: String(acceptance_criteria ?? ""),
    channel_id: channel_id ?? null,
    assignee_agent_id: assignee_agent_id ?? null,
    // 定向润色：前端/调用方可直接把来源文档 id 挂到任务上，触发 buildWorkBrief 的受限改写引导
    source_doc_ids: Array.isArray(source_doc_ids) ? source_doc_ids.map(String) : [],
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

/** 项目级批量关单（human-only）：一次决策把整个项目的剩余任务与项目本身置 done */
api.post("/projects/:id/close", (req, res) => {
  const { project, tasks } = closeProject(req.params.id);
  if (!project) return res.status(404).json({ error: "project not found" });
  for (const t of tasks) broadcast({ type: "task:upsert", payload: t });
  broadcast({ type: "project:upsert", payload: project });
  res.json({ project, tasks });
});

api.get("/documents", (_req, res) => res.json(listDocuments()));

// 上传来源文档（定向润色用）：multipart 单文件 → 提取文本 → 存为 kind="source" 文档（owner 隔离 + 版本化）。
// 安全：内存解析 + 临时文件即用即删（不持久化二进制）；类型/大小白名单；不挂 static；广播按 owner 定向。
const uploadMw = multer({ storage: multer.memoryStorage(), limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 } });
api.post("/uploads", uploadMw.single("file"), async (req, res) => {
  const f = (req as unknown as { file?: { originalname: string; buffer: Buffer } }).file;
  if (!f) return res.status(400).json({ error: "未收到文件（表单字段名应为 file）" });
  const ext = extOf(f.originalname);
  const title = (f.originalname || "上传文档").slice(0, 200);
  try {
    let content: string;
    if (TEXT_EXTS.has(ext) || ext === "") {
      content = f.buffer.toString("utf-8"); // 纯文本直读，无需 markitdown
    } else if (DOC_EXTS.has(ext)) {
      if (!mcpToolPrefixReady("mcp__markitdown__*"))
        return res.status(400).json({ error: `解析 ${ext} 文件需先启用 markitdown 插件（设置 → MCP → 浏览推荐 → 文档转 Markdown）。纯文本（txt/md/csv 等）可直接上传。` });
      content = await withTempFile(f.buffer, ext, (p) => callMcpTool("mcp__markitdown__convert_to_markdown", { uri: "file://" + p }));
    } else {
      return res.status(400).json({ error: `不支持的文件类型「${ext || "无扩展名"}」` });
    }
    content = (content ?? "").trim();
    if (!content) return res.status(400).json({ error: "未能从文件中提取到文本内容" });
    // multer 的异步流解析会逃出 requireUser 建立的 withOwner(ALS) 上下文，故按 req.userId 重建 owner 作用域再写库/广播。
    const userId = (req as AuthedRequest).userId;
    if (!userId) return res.status(401).json({ error: "unauthorized" });
    const doc = withOwner(ownerFromUserId(userId), () => {
      const d = createDocument({ channel_id: null, agent_id: null, title, content, kind: "source" });
      broadcast({ type: "doc:upsert", payload: d });
      return d;
    });
    res.json(doc);
  } catch (err: unknown) {
    res.status(502).json({ error: `解析失败：${String((err as Error)?.message ?? err).slice(0, 200)}` });
  }
});

// 上传 .pptx 作为「模板」（就地改图文用）：解析槽位清单 + 持久化原二进制 + 存 kind="template" 文档。
// 与 /uploads（来源文档，只抽文本即弃二进制）不同：模板必须保留原件供就地编辑。纯 jszip 解析，不需 markitdown。
api.post("/templates", uploadMw.single("file"), async (req, res) => {
  const f = (req as unknown as { file?: { originalname: string; buffer: Buffer } }).file;
  if (!f) return res.status(400).json({ error: "未收到文件（表单字段名应为 file）" });
  const ext = extOf(f.originalname);
  if (ext !== ".pptx") return res.status(400).json({ error: "模板暂仅支持 .pptx（就地改图文）" });
  const title = (f.originalname || "上传模板").slice(0, 200);
  const userId = (req as AuthedRequest).userId;
  if (!userId) return res.status(401).json({ error: "unauthorized" });
  try {
    const meta = await parseTemplate(f.buffer);
    if (!meta.slideCount) return res.status(400).json({ error: "未能从该 .pptx 解析出幻灯片，可能文件损坏或为加密文件" });
    // content 存一份可读的槽位摘要（满足非空约束 + 供 AI/搜索理解结构）
    const digest = meta.slots.map((s) => `[第${s.slideIdx + 1}页·${s.kind}#${s.shapeIdx}.${s.paraIdx}] ${s.text}`).join("\n") || "(无可替换文本槽位)";
    const doc = withOwner(ownerFromUserId(userId), () => {
      const d = createDocument({
        channel_id: null, agent_id: null, title, content: digest, kind: "template",
        binary_format: "pptx", template_meta: JSON.stringify(meta),
      });
      const blobPath = persistTemplateBinary(d.owner_id, d.id, f.buffer, ".pptx");
      setDocumentBlobPath(d.id, blobPath);
      const fresh = getDocument(d.id)!;
      broadcast({ type: "doc:upsert", payload: fresh });
      return fresh;
    });
    res.json(doc);
  } catch (err: unknown) {
    res.status(502).json({ error: `模板解析失败：${String((err as Error)?.message ?? err).slice(0, 200)}` });
  }
});

// 模板就地改图文 → 导出可编辑 .pptx：body { edits: [{slideIdx,shapeIdx,paraIdx,newText}] }。
// 只改命中段落文本，不动母版/版式/主题/图片；保真度边界见 template_meta.warnings。
api.post("/documents/:id/template-export", async (req, res) => {
  const doc = getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: "document not found" });
  if (doc.kind !== "template" || !doc.original_blob_path) return res.status(400).json({ error: "该文档不是可就地编辑的 .pptx 模板" });
  const editsRaw = (req.body?.edits ?? []) as unknown;
  const edits: TemplateEdit[] = Array.isArray(editsRaw)
    ? editsRaw.map((e) => ({
        slideIdx: Number((e as TemplateEdit).slideIdx),
        shapeIdx: Number((e as TemplateEdit).shapeIdx),
        paraIdx: Number((e as TemplateEdit).paraIdx),
        newText: String((e as TemplateEdit).newText ?? ""),
      })).filter((e) => Number.isInteger(e.slideIdx) && Number.isInteger(e.shapeIdx) && Number.isInteger(e.paraIdx))
    : [];
  try {
    const original = readTemplateBinary(doc.original_blob_path);
    const out = await applyTemplateEdits(original, edits);
    const filename = encodeURIComponent(doc.title.replace(/\.pptx$/i, "").replace(/[\\/:*?"<>|]/g, "_") + "-已编辑.pptx");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${filename}`);
    res.send(out);
  } catch (err: unknown) {
    res.status(500).json({ error: `导出失败：${String((err as Error)?.message ?? err).slice(0, 200)}` });
  }
});

// AI 按来源为模板槽位产替换文案（逐槽确认前的「建议」）：body { sourceDocIds?: string[], brief?: string }。
// 接地在来源文档、不臆造数字、保长度量级防破版、品牌固定文案(logo/版权/页码)不动；返回 suggestions 供前端逐槽确认。
api.post("/documents/:id/template-propose", async (req, res) => {
  const doc = getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: "document not found" });
  if (doc.kind !== "template" || !doc.template_meta) return res.status(400).json({ error: "该文档不是可就地编辑的 .pptx 模板" });
  let slots: { slideIdx: number; shapeIdx: number; paraIdx: number; text: string; kind: string; phType?: string }[] = [];
  try { slots = JSON.parse(doc.template_meta).slots ?? []; } catch { slots = []; }
  if (!slots.length) return res.json({ suggestions: [] });
  const brief = String(req.body?.brief ?? "").slice(0, 2000);
  const ids: string[] = Array.isArray(req.body?.sourceDocIds) ? req.body.sourceDocIds.map(String) : [];
  const sourceText = ids
    .map((sid) => getDocument(sid))
    .filter((d): d is NonNullable<typeof d> => !!d && d.kind === "source")
    .map((d) => `《${d.title}》\n${d.content.slice(0, 6000)}`)
    .join("\n\n---\n\n")
    .slice(0, 16000);
  const slotList = slots.map((s, i) => ({ id: i, page: s.slideIdx + 1, role: s.text ? undefined : (s.phType || "内容"), original: s.text || "(空占位，请按角色与来源生成)" }));
  const system =
    "你在为一份 PPT 模板逐槽改写文案。铁律：1) 只基于【来源】与【目标】改写，不臆造事实/数字，没有可靠数字就保留原占位或写『示意值，待核实』；" +
    "2) 替换文本长度与原文同量级（标题短、正文略长亦可，但别暴涨，防破版）；3) 品牌固定文案（logo 文字、公司名、版权、页码、日期占位）不要改，直接不返回该槽；" +
    "4) 只返回你确有把握、确需替换的槽位。仅输出 JSON，无任何解释或 markdown 围栏，格式：{\"edits\":[{\"id\":数字,\"text\":\"新文案\"}]}。";
  const user =
    (brief ? `【目标】${brief}\n\n` : "") +
    (sourceText ? `【来源】\n${sourceText}\n\n` : "【来源】(无，仅按目标与原文语义润色，不得编造具体数字)\n\n") +
    `【模板槽位】(id/页码/原文)\n${JSON.stringify(slotList, null, 0)}`;
  try {
    const raw = await oneShotComplete(system, user, 4000);
    const jsonText = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    let parsed: { edits?: { id: number; text: string }[] } = {};
    try { parsed = JSON.parse(jsonText); } catch { return res.status(502).json({ error: "AI 未返回可解析的 JSON，请重试或手动编辑" }); }
    const suggestions = (parsed.edits ?? [])
      .filter((e) => Number.isInteger(e.id) && e.id >= 0 && e.id < slots.length && typeof e.text === "string" && e.text.trim())
      .map((e) => {
        const s = slots[e.id];
        return { idx: e.id, slideIdx: s.slideIdx, shapeIdx: s.shapeIdx, paraIdx: s.paraIdx, original: s.text, suggestion: e.text.trim() };
      });
    res.json({ suggestions });
  } catch (err: unknown) {
    res.status(502).json({ error: `AI 建议失败：${String((err as Error)?.message ?? err).slice(0, 200)}` });
  }
});

/** 某文档的全部历史版本（含已被取代的旧版），供前端「查看历史版本」抽屉。 */
api.get("/documents/:id/versions", (req, res) => {
  const doc = getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: "document not found" });
  res.json(doc.task_id ? listDocumentVersions(doc.task_id, doc.kind) : [doc]);
});

/** 删除文档（清理 Mock 残留等）：连带其历史版本一并删除。 */
api.delete("/documents/:id", (req, res) => {
  const doc = getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: "document not found" });
  const versions = doc.task_id ? listDocumentVersions(doc.task_id, doc.kind) : [doc];
  for (const v of versions) {
    if (v.kind === "template") removeTemplateBinary(v.original_blob_path); // 连带删原 .pptx 二进制，无孤儿文件
    deleteDocument(v.id);
  }
  broadcast({ type: "doc:delete", payload: { ids: versions.map((v) => v.id) } });
  res.json({ ok: true, deleted: versions.map((v) => v.id) });
});

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
api.put("/image-provider", requireAdmin, (req, res) => {
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

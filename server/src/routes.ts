import { Router } from "express";
import { createHash } from "node:crypto";
import {
  clearChannelMessages,
  clearMemory,
  closeProject,
  createAgent,
  createMcpServer,
  createProject,
  createSkill,
  createTaskEvent,
  deleteChannel,
  deleteMcpServer,
  deleteSkill,
  getMcpServer,
  getMessage,
  getSkill,
  getProject,
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
  getApproval,
  getChannel,
  getMemory,
  getTask,
  listDocumentVersions,
  insertMessage,
  listAgents,
  listApprovals,
  listChannels,
  listMessages,
  listTaskEvents,
  listTasks,
  resolveApprovalOnce,
  updateApprovalPayload,
  updateTask,
  createVerdict,
  listVerdictsForTask,
  qualitySummary,
} from "./db.js";
import { broadcast } from "./bus.js";
import { requireAdmin, type AuthedRequest } from "./auth.js";
import { fetchCoworkerMe } from "./coworker.js";
import { seedForOwner } from "./seed.js";
import { AGENT_TEMPLATES, getTemplate } from "./agents/templates.js";
import multer from "multer";
import { withOwner, ownerFromUserId } from "./ownerScope.js";
import { dropConnection, testMcpServer, callMcpTool, mcpToolPrefixReady, mcpToolName, stdioAllowedCommands, stdioCommandAllowed } from "./agents/mcp.js";
import { UPLOAD_MAX_BYTES, TEXT_EXTS, DOC_EXTS, extOf, withTempFile, persistTemplateBinary, readTemplateBinary, removeTemplateBinary } from "./uploads.js";
import { parseTemplate, applyTemplateEdits, type TemplateEdit, type ImageEdit } from "./pptx-template.js";
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
import { DEFAULT_IMAGE_BASE_URL, generateImageBytes } from "./agents/images.js";
import { providerBenchmarkPassed, providerBenchmarkSourceTrace } from "./qualityBenchmark.js";
import {
  assessProviderQualityBenchmarkDocument,
  isMock,
  onMessage,
  onBudgetResolved,
  onClarificationResolved,
  onNetworkApprovalResolved,
  onPlanResolved,
  onTaskAssigned,
  onTaskDelivered,
  oneShotComplete,
  buildSkillIndex,
  invalidateTaskNetworkApprovals,
  readSkillBody,
  stopChannel,
  stopTask,
  teamStatus,
  testProviderConnection,
  triggerAgent,
} from "./agents/engine.js";

export const api = Router();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const mcpKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "server";

async function waitForProviderTask(taskId: string, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = getTask(taskId);
    const events = listTaskEvents(taskId);
    if (!task) return { task, events, done: true };
    if (task.status === "review" || task.status === "blocked" || events.some((e) => e.type === "failure")) {
      return { task, events, done: true };
    }
    await sleep(500);
  }
  return { task: getTask(taskId), events: listTaskEvents(taskId), done: false };
}

const PROVIDER_QUALITY_BENCHMARK_BUDGET = Math.max(
  4_000,
  Math.round(Number(process.env.AITEAM_PROVIDER_BENCHMARK_BUDGET) || 20_000),
);

const PROVIDER_QUALITY_BENCHMARK = {
  id: "executive-decision-brief-v1",
  version: 4,
  title: "真实模型质量基准：AiTeam 产品落地决策简报",
  budgetBillable: PROVIDER_QUALITY_BENCHMARK_BUDGET,
  description: [
    "你是 AiTeam 的产品负责人，请仅依据本任务提供的上下文，为创始人写一份可直接用于决策的产品落地简报。",
    "背景：AiTeam 借鉴 Helio 的低门槛协作体验，但核心差异是任务简报、AI 认领、过程留痕、独立复核、自动返工与人类关单。",
    "目标：给出未来 14 天把这一核心工作流推向首批真实用户测试的最小落地方案。不得虚构市场数据、客户反馈或已经完成的事实。",
  ].join("\n"),
  rubric: [
    "1. 开头必须给出不超过 120 字的明确结论与推荐决策。",
    "2. 必须说明目标用户、核心待办和当前产品边界；产品边界须与任务内给出的已实现能力一致，不得把已有能力写成尚未开发。",
    "3. 必须用一张表完整映射 goal→brief→claim→work→review→revise→human close，并标明每步责任人和可验证证据。",
    "4. 必须给出按优先级排序的 14 天计划，包含阶段目标、负责人、退出条件和可量化验收指标。",
    "5. 必须列出至少 3 个关键风险/依赖，每项给出缓解动作和停止条件。",
    "6. 所有外部事实、数字和能力声明必须给出可访问 URL 或任务内证据；没有来源时必须明确标注为假设或待验证，且不得声称使用过审计日志中不存在的工具。",
    "7. 文末必须附逐条自查表，按本验收标准标注满足/不满足及正文证据位置。",
  ],
} as const;

function providerBenchmarkAgentName(prefix: string, providerId: string, providerName: string, model: string, role: string) {
  const suffix = createHash("sha256").update(`${providerId}\0${model}\0${role}`).digest("hex").slice(0, 8);
  return `${`${prefix}-${providerName}`.slice(0, 31)}-${suffix}`;
}

function emitTaskEvent(input: Parameters<typeof createTaskEvent>[0]) {
  const event = createTaskEvent(input);
  broadcast({ type: "task:event", payload: event });
  return event;
}

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
    task_events: listTaskEvents(),
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
  // stdio = 以服务进程身份起子进程，命令必须过白名单（连接层还有二次防御，这里提前给可读报错）
  if (kind === "stdio" && !stdioCommandAllowed(String(command))) {
    return res.status(400).json({
      error: `stdio 命令不在白名单（${stdioAllowedCommands().join("/")}）；自部署可用 AITEAM_MCP_STDIO_ALLOW 环境变量扩展`,
    });
  }
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

api.post("/mcp-servers/:id/task-test", requireAdmin, async (req, res) => {
  const server = getMcpServer(req.params.id);
  if (!server) return res.status(404).json({ error: "not found" });
  const startedAt = Date.now();
  try {
    let channel = req.body?.channel_id ? getChannel(String(req.body.channel_id)) : undefined;
    channel = channel ?? listChannels().find((c) => c.kind === "channel");
    if (!channel) {
      channel = createChannel("MCP 测试", [], "channel");
      broadcast({ type: "channel:new", payload: channel });
    }
    const projectId = req.body?.project_id ? getProject(String(req.body.project_id))?.id ?? null : null;

    const task = createTask({
      channel_id: channel.id,
      project_id: projectId,
      title: `MCP 能力演练：${server.name}`,
      description: "验证该 MCP server 是否能进入 AiTeam 工作线：连接、列工具，并在可识别场景下执行一次样例工具。",
      acceptance_criteria: "必须留下 tool / delivery / verification 事件；文档转换类 MCP 应生成来源文档。",
      created_by: "user",
    });
    emitTaskEvent({
      task_id: task.id,
      channel_id: task.channel_id,
      project_id: task.project_id,
      type: "created",
      summary: "用户启动 MCP 能力演练",
      metadata: { mcp_server_id: server.id, mcp_server: server.name, safety: server.safety, link_check: Boolean(projectId) },
    });
    broadcast({ type: "task:upsert", payload: task });

    if (!server.enabled) {
      const enabled = setMcpServerEnabled(server.id, true);
      if (enabled) broadcast({ type: "channel:update", payload: channel });
    }

    const tools = await testMcpServer(server);
    emitTaskEvent({
      task_id: task.id,
      channel_id: task.channel_id,
      project_id: task.project_id,
      type: "tool",
      summary: `MCP 连接成功，发现 ${tools} 个工具`,
      metadata: { mcp_server_id: server.id, tools },
    });

    const docs = [];
    let sampleOutput = "";
    let converted = false;
    if (mcpKey(server.name) === "markitdown") {
      const sample = Buffer.from("# AiTeam MCP 演练\n\n- 输入：本地样本文档\n- 预期：转换为 Markdown 来源\n", "utf8");
      sampleOutput = await withTempFile(sample, ".txt", (p) =>
        callMcpTool(mcpToolName(server.name, "convert_to_markdown"), { uri: "file://" + p })
      );
      converted = !/^错误：/.test(sampleOutput);
      if (converted) {
        const doc = createDocument({
          channel_id: channel.id,
          title: `MCP 来源演练：${server.name}`,
          kind: "source",
          content: sampleOutput.slice(0, 20000),
          task_id: task.id,
        });
        docs.push(doc);
        broadcast({ type: "doc:upsert", payload: doc });
        emitTaskEvent({
          task_id: task.id,
          channel_id: task.channel_id,
          project_id: task.project_id,
          type: "delivery",
          summary: "MCP 已把样本文档转换为来源文档",
          metadata: { doc_id: doc.id, mcp_server_id: server.id },
        });
      }
    } else {
      emitTaskEvent({
        task_id: task.id,
        channel_id: task.channel_id,
        project_id: task.project_id,
        type: "delivery",
        summary: "MCP 连接和工具清单已验证；具体业务工具将在任务运行时调用",
        metadata: { mcp_server_id: server.id, tools },
      });
    }

    const finalTask = updateTask(task.id, { status: "review" }) ?? task;
    invalidateTaskNetworkApprovals(task.id);
    emitTaskEvent({
      task_id: task.id,
      channel_id: task.channel_id,
      project_id: task.project_id,
      type: "verification",
      summary: converted || mcpKey(server.name) !== "markitdown" ? "MCP 能力演练通过，等待人工复核" : "MCP 连接成功，但样例转换未通过",
      metadata: { mcp_server_id: server.id, converted, tools },
    });
    broadcast({ type: "task:upsert", payload: finalTask });

    res.json({
      ok: tools > 0 && (mcpKey(server.name) === "markitdown" ? converted : true),
      server: sanitizeMcpServer(getMcpServer(server.id) ?? server),
      task: finalTask,
      docs,
      events: listTaskEvents(task.id),
      checks: {
        connected: tools > 0,
        tools,
        converted,
        source_document_created: docs.length > 0,
      },
      latency_ms: Date.now() - startedAt,
      sample: sampleOutput.slice(0, 500),
    });
  } catch (err: any) {
    res.status(502).json({ ok: false, error: String(err?.message ?? err).slice(0, 500), latency_ms: Date.now() - startedAt });
  }
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

api.post("/skills/:id/task-test", requireAdmin, (req, res) => {
  const before = getSkill(req.params.id);
  if (!before) return res.status(404).json({ error: "not found" });
  const skill = before.enabled ? before : updateSkill(before.id, { enabled: true }) ?? before;
  let channel = req.body?.channel_id ? getChannel(String(req.body.channel_id)) : undefined;
  channel = channel ?? listChannels().find((c) => c.kind === "channel");
  if (!channel) {
    channel = createChannel("技能测试", [], "channel");
    broadcast({ type: "channel:new", payload: channel });
  }
  const projectId = req.body?.project_id ? getProject(String(req.body.project_id))?.id ?? null : null;

  const focus = `技能演练 ${skill.name} ${skill.trigger} ${skill.when_to_use} ${skill.desc}`;
  const index = buildSkillIndex(focus, [skill]);
  const body = readSkillBody(skill.id);
  const task = createTask({
    channel_id: channel.id,
    project_id: projectId,
    title: `技能演练：${skill.name}`,
    description: "验证该技能启用后是否能进入 AiTeam 工作线：索引可见、正文可读取、交付物明确引用该方法。",
    acceptance_criteria: "必须留下 tool / delivery / verification 事件，并生成一份 report 交付物。",
    created_by: "user",
  });
  emitTaskEvent({
    task_id: task.id,
    channel_id: task.channel_id,
    project_id: task.project_id,
    type: "created",
    summary: "用户启动技能演练",
    metadata: { skill_id: skill.id, skill_name: skill.name, link_check: Boolean(projectId) },
  });
  emitTaskEvent({
    task_id: task.id,
    channel_id: task.channel_id,
    project_id: task.project_id,
    type: "tool",
    summary: `read_skill 读取「${skill.name}」正文`,
    metadata: { skill_id: skill.id, body_chars: body.length },
  });
  const report = [
    `# 技能演练：${skill.name}`,
    "",
    `结论：${body ? "该技能已启用，索引可见，正文可按需读取。" : "该技能正文为空或不可读取。"}`,
    "",
    "## 索引证据",
    index || "（无索引）",
    "",
    "## 正文摘录",
    body.slice(0, 1200) || "（无正文）",
    "",
    "## 自查表",
    `- 技能启用 -> ${skill.enabled ? "是" : "否"}`,
    `- 索引包含 read_skill -> ${index.includes("read_skill") ? "是" : "否"}`,
    `- 正文可读取 -> ${body ? "是" : "否"}`,
  ].join("\n");
  const doc = createDocument({
    channel_id: channel.id,
    title: `技能演练报告：${skill.name}`,
    kind: "report",
    content: report,
    task_id: task.id,
  });
  broadcast({ type: "doc:upsert", payload: doc });
  emitTaskEvent({
    task_id: task.id,
    channel_id: task.channel_id,
    project_id: task.project_id,
    type: "delivery",
    summary: "技能演练报告已写入文档库",
    metadata: { skill_id: skill.id, doc_id: doc.id },
  });
  const finalTask = updateTask(task.id, { status: "review" }) ?? task;
  invalidateTaskNetworkApprovals(task.id);
  emitTaskEvent({
    task_id: task.id,
    channel_id: task.channel_id,
    project_id: task.project_id,
    type: "verification",
    summary: body && index.includes("read_skill") ? "技能演练通过，等待人工复核" : "技能演练未完全通过",
    metadata: { skill_id: skill.id, indexed: Boolean(index), body_chars: body.length },
  });
  broadcast({ type: "task:upsert", payload: finalTask });

  res.json({
    ok: Boolean(body && index.includes("read_skill")),
    skill,
    task: finalTask,
    docs: [doc],
    events: listTaskEvents(task.id),
    checks: {
      enabled: Boolean(skill.enabled),
      indexed: Boolean(index),
      read_hint: index.includes("read_skill"),
      body_loaded: body.length > 0,
      delivered: true,
    },
  });
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
  const {
    name,
    base_url,
    api_key,
    default_model,
    light_model,
    max_tokens,
    web_tools,
    is_strong,
    price_input_per_million,
    price_output_per_million,
    price_currency,
  } = req.body ?? {};
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
    price_input_per_million: Math.max(0, Number(price_input_per_million) || 0),
    price_output_per_million: Math.max(0, Number(price_output_per_million) || 0),
    price_currency: String(price_currency || "USD").trim().toUpperCase(),
  });
  res.json(sanitizeProvider(provider));
});

api.patch("/providers/:id", requireAdmin, (req, res) => {
  const {
    name,
    base_url,
    api_key,
    default_model,
    light_model,
    max_tokens,
    web_tools,
    is_strong,
    price_input_per_million,
    price_output_per_million,
    price_currency,
  } = req.body ?? {};
  const provider = updateProvider(req.params.id, {
    ...(name !== undefined ? { name: String(name).trim() } : {}),
    ...(base_url !== undefined ? { base_url: String(base_url).trim().replace(/\/$/, "") } : {}),
    ...(api_key !== undefined ? { api_key: String(api_key).trim() } : {}),
    ...(default_model !== undefined ? { default_model: String(default_model).trim() } : {}),
    ...(light_model !== undefined ? { light_model: String(light_model).trim() } : {}),
    ...(max_tokens !== undefined ? { max_tokens: Number(max_tokens) || 16000 } : {}),
    ...(web_tools !== undefined ? { web_tools: web_tools ? 1 : 0 } : {}),
    ...(is_strong !== undefined ? { is_strong: is_strong ? 1 : 0 } : {}),
    ...(price_input_per_million !== undefined ? { price_input_per_million: Math.max(0, Number(price_input_per_million) || 0) } : {}),
    ...(price_output_per_million !== undefined ? { price_output_per_million: Math.max(0, Number(price_output_per_million) || 0) } : {}),
    ...(price_currency !== undefined ? { price_currency: String(price_currency || "USD").trim().toUpperCase() } : {}),
  });
  if (!provider) return res.status(404).json({ error: "provider not found" });
  res.json(sanitizeProvider(provider));
});

api.post("/providers/:id/test", requireAdmin, async (req, res) => {
  try {
    const result = await testProviderConnection(req.params.id);
    res.json(result);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    const status = msg === "provider not found" ? 404 : 400;
    res.status(status).json({ ok: false, error: msg.slice(0, 500) });
  }
});

api.post("/providers/:id/task-test", requireAdmin, async (req, res) => {
  try {
    const provider = getProvider(req.params.id);
    if (!provider) return res.status(404).json({ error: "provider not found" });
    if (!provider.api_key) return res.status(400).json({ error: "provider api key is missing" });
    const workerModel = provider.light_model || provider.default_model;
    const reviewerModel = provider.default_model || workerModel;
    if (!workerModel) return res.status(400).json({ error: "provider default model is missing" });

    let channel = req.body?.channel_id ? getChannel(String(req.body.channel_id)) : undefined;
    channel = channel ?? listChannels().find((c) => c.kind === "channel");
    if (!channel) {
      channel = createChannel("模型测试", [], "channel");
      broadcast({ type: "channel:new", payload: channel });
    }

    const workerRole = "真实交付物基准执行";
    const agentName = providerBenchmarkAgentName("质量基准v3", provider.id, provider.name, workerModel, workerRole);
    let agent = listAgents().find((a) =>
      a.provider_id === provider.id && a.name === agentName && a.model === workerModel && a.role === workerRole,
    );
    if (!agent) {
      agent = createAgent({
        name: agentName,
        emoji: "🧪",
        role: workerRole,
        system_prompt:
          "你负责完成 AiTeam 的固定质量基准。必须严格按任务简报与七项验收标准写一份可用于真实决策的 report，并使用 write_document 交付；不得只在聊天里回答，不得编造事实或省略逐条自查表。",
        provider_id: provider.id,
        model: workerModel,
      });
    }

    const reviewerRole = "真实交付物独立复核";
    const reviewerName = providerBenchmarkAgentName("质量复核v3", provider.id, provider.name, reviewerModel, reviewerRole);
    let reviewer = listAgents().find((a) =>
      a.provider_id === provider.id && a.name === reviewerName && a.model === reviewerModel && a.role === reviewerRole,
    );
    if (!reviewer) {
      reviewer = createAgent({
        name: reviewerName,
        emoji: "🔎",
        role: reviewerRole,
        system_prompt:
          "你是严格、独立的交付质量复核人。逐条核对任务的七项验收标准；任何缺失、空泛、无证据能力声明或伪造数字都必须 submit_verdict=revise，并给出可执行的逐项返工意见。只有全部标准均有正文证据时才允许 pass。",
        provider_id: provider.id,
        model: reviewerModel,
      });
    }

    if (!channel.agent_ids?.includes(agent.id) || !channel.agent_ids?.includes(reviewer.id)) {
      channel = setChannelAgents(channel.id, Array.from(new Set([...(channel.agent_ids ?? []), agent.id, reviewer.id]))) ?? channel;
      broadcast({ type: "channel:update", payload: channel });
    }
    const projectId = req.body?.project_id ? getProject(String(req.body.project_id))?.id ?? null : null;

    const task = createTask({
      channel_id: channel.id,
      project_id: projectId,
      title: `${PROVIDER_QUALITY_BENCHMARK.title}（${provider.name}）`,
      description: PROVIDER_QUALITY_BENCHMARK.description,
      acceptance_criteria: PROVIDER_QUALITY_BENCHMARK.rubric.join("\n"),
      assignee_agent_id: agent.id,
      reviewer_agent_id: reviewer.id,
      model_tier: provider.light_model ? "light" : "standard",
      budget_billable: PROVIDER_QUALITY_BENCHMARK.budgetBillable,
      created_by: "user",
    });
    emitTaskEvent({
      task_id: task.id,
      channel_id: task.channel_id,
      project_id: task.project_id,
      agent_id: agent.id,
      type: "created",
      summary: "用户启动真实模型质量基准",
      metadata: {
        provider_id: provider.id,
        model: workerModel,
        reviewer_model: reviewerModel,
        benchmark_id: PROVIDER_QUALITY_BENCHMARK.id,
        benchmark_version: PROVIDER_QUALITY_BENCHMARK.version,
        rubric_count: PROVIDER_QUALITY_BENCHMARK.rubric.length,
        budget_billable: PROVIDER_QUALITY_BENCHMARK.budgetBillable,
        link_check: Boolean(projectId),
      },
    });
    emitTaskEvent({
      task_id: task.id,
      channel_id: task.channel_id,
      project_id: task.project_id,
      agent_id: agent.id,
      type: "claim",
      summary: `${agent.name} 接手真实模型质量基准`,
      metadata: { provider_id: provider.id, model: workerModel, reviewer_id: reviewer.id, reviewer_model: reviewerModel },
    });
    broadcast({ type: "task:upsert", payload: task });

    const startedAt = Date.now();
    onTaskAssigned(task);
    const { task: finalTask, events, done } = await waitForProviderTask(task.id, 180000);
    const docs = listDocuments().filter((d) => d.task_id === task.id);
    const verdicts = listVerdictsForTask(task.id);
    const eventTypes = new Set(events.map((e) => e.type));
    const pendingApproval = finalTask?.blocked_approval_id ? getApproval(finalTask.blocked_approval_id) : undefined;
    const pendingBudgetApproval = Boolean(
      finalTask?.status === "blocked" && pendingApproval?.kind === "budget" && pendingApproval.status === "pending",
    );
    const delivered = docs.length > 0 && eventTypes.has("delivery");
    const toolObserved = eventTypes.has("tool");
    const verified = verdicts.length > 0;
    // 任务累计用量是工作、返工与复核的唯一归因账本；按 agent/model/time 扫消息会把并发基准串账。
    const taskUsage = readUsage(finalTask?.usage_json ?? task.usage_json);
    const usageSummary = { input: taskUsage.promptTotal, output: taskUsage.output, billable: taskUsage.billable };
    const usageTracked = usageSummary.billable > 0;
    const estimatedCost =
      provider.price_input_per_million > 0 || provider.price_output_per_million > 0
        ? (usageSummary.input * provider.price_input_per_million + usageSummary.output * provider.price_output_per_million) / 1_000_000
        : null;
    const usageSummaryWithCost = {
      ...usageSummary,
      estimated_cost: estimatedCost,
      price_currency: provider.price_currency || "USD",
    };
    const latencyMs = Date.now() - startedAt;
    const qualityContract = task.acceptance_criteria === PROVIDER_QUALITY_BENCHMARK.rubric.join("\n");
    const independentReviewer = Boolean(task.reviewer_agent_id && task.reviewer_agent_id !== task.assignee_agent_id);
    const verdictRecorded = verdicts.length > 0 && verdicts.at(-1)?.result === "pass";
    const withinBudget = usageSummary.billable <= PROVIDER_QUALITY_BENCHMARK.budgetBillable;
    const sourceTrace = providerBenchmarkSourceTrace(events, docs, {
      workerAgentId: agent.id,
      reviewerAgentId: reviewer.id,
    });
    const benchmarkReport = docs.find((doc) => doc.kind === "report");
    const documentContract = benchmarkReport
      ? assessProviderQualityBenchmarkDocument(benchmarkReport.content)
      : { pass: false, gaps: ["没有 report 交付物"] };
    const checks = {
      completed: done && !pendingBudgetApproval,
      delivered,
      tool_observed: toolObserved,
      verified,
      usage_tracked: usageTracked,
      quality_contract: qualityContract,
      independent_reviewer: independentReviewer,
      verdict_recorded: verdictRecorded,
      within_budget: withinBudget,
      source_trace_clean: sourceTrace.clean,
      document_contract: documentContract.pass,
      pending_approval: pendingBudgetApproval,
    };
    const ok = providerBenchmarkPassed(checks);
    const runStatus = ok ? "passed" : pendingBudgetApproval ? "pending_approval" : "failed";
    const benchmark = {
      id: PROVIDER_QUALITY_BENCHMARK.id,
      version: PROVIDER_QUALITY_BENCHMARK.version,
      rubric: [...PROVIDER_QUALITY_BENCHMARK.rubric],
      budget_billable: PROVIDER_QUALITY_BENCHMARK.budgetBillable,
      worker_model: workerModel,
      reviewer_model: reviewerModel,
    };
    const resultEvent = emitTaskEvent({
      task_id: task.id,
      channel_id: task.channel_id,
      project_id: task.project_id,
      agent_id: agent.id,
      type: ok ? "verification" : pendingBudgetApproval ? "blocked" : "failure",
      summary: ok
        ? "真实模型质量基准通过"
        : pendingBudgetApproval
          ? "真实模型质量基准已产出初稿，等待用户决定是否追加预算完成独立复核"
          : "真实模型质量基准未通过",
      metadata: {
        provider_id: provider.id,
        model: workerModel,
        reviewer_model: reviewerModel,
        latency_ms: latencyMs,
        checks,
        usage_summary: usageSummaryWithCost,
        provider_task_test: true,
        run_status: runStatus,
        source_trace: sourceTrace,
        document_contract: documentContract,
        quality_benchmark: benchmark,
        verdict_summary: verdicts.at(-1)
          ? { result: verdicts.at(-1)?.result, reasons: verdicts.at(-1)?.reasons.slice(0, 1000), attempts: verdicts.length }
          : null,
      },
    });

    res.json({
      ok,
      run_status: runStatus,
      pending_approval_id: pendingBudgetApproval ? pendingApproval?.id ?? null : null,
      provider: sanitizeProvider(provider),
      model: workerModel,
      models: { worker: workerModel, reviewer: reviewerModel },
      benchmark,
      latency_ms: latencyMs,
      task: finalTask ?? task,
      docs,
      verdicts,
      events: [...events, resultEvent],
      checks,
      usage_summary: usageSummaryWithCost,
    });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: String(err?.message ?? err).slice(0, 500) });
  }
});

api.delete("/providers/:id", requireAdmin, (req, res) => {
  deleteProvider(req.params.id);
  res.json({ ok: true });
});

api.get("/tasks", (_req, res) => res.json(listTasks()));

api.get("/tasks/:id/events", (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "task not found" });
  res.json(listTaskEvents(task.id));
});

// D1 质量闭环落表的读侧：单任务裁决链 + 工作区质量汇总（面板数据源）
api.get("/tasks/:id/verdicts", (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "task not found" });
  res.json(listVerdictsForTask(task.id));
});
api.get("/quality", (_req, res) => res.json(qualitySummary()));

function missingTaskBriefFields(input: { description: unknown; acceptance_criteria: unknown }): string[] {
  const missing: string[] = [];
  if (!String(input.description ?? "").trim()) missing.push("description");
  if (!String(input.acceptance_criteria ?? "").trim()) missing.push("acceptance_criteria");
  return missing;
}

api.post("/tasks", (req, res) => {
  const { title, description, channel_id, assignee_agent_id, reviewer_agent_id, acceptance_criteria, source_doc_ids, budget_billable } = req.body ?? {};
  if (!title) return res.status(400).json({ error: "title required" });
  const missing = assignee_agent_id
    ? missingTaskBriefFields({ description, acceptance_criteria })
    : [];
  if (missing.length > 0) {
    return res.status(400).json({
      error: "task brief incomplete: assigned tasks require context and acceptance criteria before execution",
      code: "TASK_BRIEF_INCOMPLETE",
      missing,
    });
  }
  if (assignee_agent_id && reviewer_agent_id && assignee_agent_id === reviewer_agent_id) {
    return res.status(400).json({
      error: "task reviewer must be independent from the assignee",
      code: "TASK_REVIEWER_CONFLICT",
    });
  }
  const task = createTask({
    title: String(title),
    description: String(description ?? ""),
    acceptance_criteria: String(acceptance_criteria ?? ""),
    channel_id: channel_id ?? null,
    assignee_agent_id: assignee_agent_id ?? null,
    reviewer_agent_id: reviewer_agent_id ?? null,
    // 定向润色：前端/调用方可直接把来源文档 id 挂到任务上，触发 buildWorkBrief 的受限改写引导
    source_doc_ids: Array.isArray(source_doc_ids) ? source_doc_ids.map(String) : [],
    budget_billable: Number(budget_billable) > 0 ? Math.round(Number(budget_billable)) : 0,
    created_by: "user",
  });
  emitTaskEvent({
    task_id: task.id,
    channel_id: task.channel_id,
    project_id: task.project_id,
    type: "created",
    summary: "用户创建了任务",
  });
  if (task.assignee_agent_id) {
    emitTaskEvent({
      task_id: task.id,
      channel_id: task.channel_id,
      project_id: task.project_id,
      agent_id: task.assignee_agent_id,
      type: "claim",
      summary: `任务指派给 ${getAgent(task.assignee_agent_id)?.name ?? "AI 同事"}`,
    });
  }
  if (task.reviewer_agent_id) {
    emitTaskEvent({
      task_id: task.id,
      channel_id: task.channel_id,
      project_id: task.project_id,
      agent_id: task.reviewer_agent_id,
      type: "verification",
      summary: `用户指定复核人：${getAgent(task.reviewer_agent_id)?.name ?? "AI 同事"}`,
    });
  }
  broadcast({ type: "task:upsert", payload: task });
  if (task.assignee_agent_id) onTaskAssigned(task);
  res.json(task);
});

function pickScenarioAgent(agents: ReturnType<typeof listAgents>, patterns: RegExp[], fallbackIndex: number) {
  return (
    agents.find((a) => patterns.some((p) => p.test(`${a.name} ${a.role}`))) ??
    agents[fallbackIndex] ??
    agents[0]
  );
}

const SCENARIOS = [
  {
    id: "helio-core",
    title: "协作演练",
    desc: "三步跑通认领、依赖推进、复核和人类关闭。",
  },
  {
    id: "research-report",
    title: "调研报告",
    desc: "调研、对比表、分析报告、复核摘要的知识工作闭环。",
  },
  {
    id: "solution-deck",
    title: "方案演示",
    desc: "需求澄清、方案架构、演示文稿、交付复核。",
  },
] as const;

api.get("/scenarios", (_req, res) => res.json(SCENARIOS));

type ScenarioId = (typeof SCENARIOS)[number]["id"];

/** 配置链路验收：把模型 / MCP / Skills 自检任务收进同一个项目，方便人工复核与关单。 */
api.post("/link-checks", requireAdmin, (req, res) => {
  const requestedChannelId = req.body?.channel_id ? String(req.body.channel_id) : "";
  const channel = requestedChannelId
    ? getChannel(requestedChannelId)
    : listChannels().find((c) => c.kind === "channel") ?? listChannels()[0];
  if (!channel) return res.status(400).json({ error: "channel required" });
  const lead = listAgents()[0];
  const project = createProject({
    channel_id: channel.id,
    lead_agent_id: lead?.id ?? null,
    title: "配置链路验收：模型 / MCP / Skills",
    goal: "验证真实模型、MCP 插件和技能能进入同一任务运行线：产生结构化事件、交付物、复核状态，并由人类最终关单。",
    status: "running",
    autonomy: "auto",
  });
  const sys = insertMessage({
    channel_id: channel.id,
    author_type: "system",
    content: `🧪 已启动「${project.title}」：模型、MCP、Skills 自检任务会挂入同一个项目，等待人工复核与关单。`,
  });
  broadcast({ type: "message:new", payload: sys });
  broadcast({ type: "project:upsert", payload: project });
  res.json({ project });
});

/** 受控场景：从产品内一键启动 goal → plan → claim → work → review → close 的任务运行线。 */
api.post("/scenarios/:id/start", (req, res) => {
  const scenarioId = String(req.params.id) as ScenarioId;
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) return res.status(404).json({ error: "scenario not found" });
  const acceptanceMode = Boolean(req.body?.acceptance) && scenarioId === "helio-core";
  const requestedChannelId = req.body?.channel_id ? String(req.body.channel_id) : "";
  const channel = requestedChannelId
    ? getChannel(requestedChannelId)
    : listChannels().find((c) => c.kind === "channel") ?? listChannels()[0];
  if (!channel) return res.status(400).json({ error: "channel required" });

  const agents = listAgents();
  if (agents.length === 0) return res.status(400).json({ error: "at least one agent required" });
  const lead = pickScenarioAgent(agents, [/产品|PM|经理|规划|product/i], 0);
  const builder = pickScenarioAgent(agents, [/工程|开发|实现|engineer|dev/i], 1);
  const reviewer = pickScenarioAgent(agents, [/审核|评审|复核|review|QA|测试/i], 2);
  const researcher = pickScenarioAgent(agents, [/调研|分析|SEO|增长|research|analyst/i], 3);
  const writer = pickScenarioAgent(agents, [/文案|内容|写作|SEO|writer|content/i], 3);
  const projectTitle =
    acceptanceMode
      ? "闭环验收：AI 同事任务运行线"
      : scenarioId === "research-report"
      ? "调研报告：从问题到可复核交付"
      : scenarioId === "solution-deck"
        ? "方案演示：从需求到可讲解材料"
        : "协作演练：AI 同事任务运行线";
  const projectGoal =
    acceptanceMode
      ? "产品内验收 AI 同事在同一频道里认领任务、按依赖推进、留下结构化审计轨迹，交付后等待人类复核并最终关闭。"
      : scenarioId === "research-report"
      ? "验证 AI 同事围绕同一调研目标分工：先定口径，再调研与对比，最后交付报告并等待人类关单。"
      : scenarioId === "solution-deck"
        ? "验证需求澄清、方案设计、演示文稿与复核摘要能在同一任务运行线中推进。"
        : "验证 AI 同事在同一频道里认领任务、按依赖推进、留下结构化审计轨迹，并等待人类最终关闭。";
  const existingProject = listProjects().find((p) => p.channel_id === channel.id && p.title === projectTitle && p.status !== "done");
  if (existingProject) {
    const tasks = listTasks().filter((task) => task.project_id === existingProject.id);
    return res.json({ project: existingProject, tasks, reused: true });
  }

  const project = createProject({
    channel_id: channel.id,
    lead_agent_id: lead.id,
    title: projectTitle,
    goal: projectGoal,
    status: "running",
    autonomy: "auto",
  });

  const specs =
    scenarioId === "research-report"
      ? [
          {
            key: "scope",
            title: "确定调研问题与验收口径",
            description: "明确调研对象、比较维度、输出格式和哪些事实需要标来源。",
            assignee: lead.id,
            reviewer: reviewer.id,
            deps: [],
            acceptance: "包含目标、范围、比较维度、来源要求和最终交付格式。",
          },
          {
            key: "research",
            title: "收集资料并形成来源清单",
            description: "按口径收集候选信息，输出带来源的要点清单。",
            assignee: researcher.id,
            reviewer: reviewer.id,
            deps: ["scope"],
            acceptance: "每个关键事实都应有来源或明确标注待核实。",
          },
          {
            key: "matrix",
            title: "整理对比表与初步结论",
            description: "把资料整理成可导出的表格，并给出初步判断。",
            assignee: builder.id,
            reviewer: reviewer.id,
            deps: ["research"],
            acceptance: "输出维度清晰的对比表，结论能追溯到来源清单。",
          },
          {
            key: "report",
            title: "撰写最终调研报告",
            description: "综合来源清单和对比表，形成结论先行的报告。",
            assignee: writer.id,
            reviewer: reviewer.id,
            deps: ["matrix"],
            acceptance: "报告包含摘要、证据、对比、建议和风险边界。",
          },
        ]
      : scenarioId === "solution-deck"
        ? [
            {
              key: "needs",
              title: "澄清目标、受众和成功标准",
              description: "明确演示对象、业务目标、约束和必须回答的问题。",
              assignee: lead.id,
              reviewer: reviewer.id,
              deps: [],
              acceptance: "输出受众、目标、约束、成功标准和待确认项。",
            },
            {
              key: "solution",
              title: "设计解决方案与实施路径",
              description: "给出架构/流程、阶段计划、风险和资源需求。",
              assignee: builder.id,
              reviewer: reviewer.id,
              deps: ["needs"],
              acceptance: "方案应能落地，包含边界、里程碑和风险控制。",
            },
            {
              key: "deck",
              title: "制作汇报演示文稿",
              description: "把方案转成可讲解的 slides 结构和正文。",
              assignee: writer.id,
              reviewer: reviewer.id,
              deps: ["solution"],
              acceptance: "演示稿应有标题页、问题、方案、路径、风险和结论页。",
            },
            {
              key: "review",
              title: "复核演示并整理关闭摘要",
              description: "检查方案与演示是否一致，给出通过/返工意见。",
              assignee: reviewer.id,
              reviewer: lead.id,
              deps: ["deck"],
              acceptance: "输出复核结论、需修改项或可关闭摘要。",
            },
          ]
        : [
            {
              key: "brief",
              title: "梳理目标与验收口径",
              description: "把用户目标拆成可验收的短清单，明确哪些动作需要人类确认。",
              assignee: lead.id,
              reviewer: reviewer.id,
              deps: [],
              acceptance: "输出包含目标、边界、验收口径、风险动作审批点。",
            },
            {
              key: "draft",
              title: "形成执行方案与交付草稿",
              description: "基于第一步口径产出可执行方案和首版交付物。",
              assignee: builder.id,
              reviewer: reviewer.id,
              deps: ["brief"],
              acceptance: "输出方案应能被 reviewer 复核，且清楚标出下一步。",
            },
            {
              key: "gate",
              title: "复核交付并整理关闭摘要",
              description: "复核前两步交付质量，整理给人类关闭项目的摘要。",
              assignee: reviewer.id,
              reviewer: lead.id,
              deps: ["brief", "draft"],
              acceptance: "输出是否通过、返工建议或关闭摘要。",
            },
          ];

  const byKey = new Map<string, string>();
  const tasks = specs.map((s) => {
    const task = createTask({
      channel_id: channel.id,
      project_id: project.id,
      title: s.title,
      description: s.description,
      assignee_agent_id: s.assignee,
      reviewer_agent_id: s.reviewer,
      created_by: "user",
      depends_on: s.deps.map((key) => byKey.get(key)).filter(Boolean) as string[],
      acceptance_criteria: s.acceptance,
    });
    byKey.set(s.key, task.id);
    return task;
  });

  const sys = insertMessage({
    channel_id: channel.id,
    author_type: "system",
    content: `🧪 已启动「${project.title}」：${tasks.length} 个子任务将由 AI 同事认领/执行，最终等待人类关闭。`,
  });
  broadcast({ type: "message:new", payload: sys });
  broadcast({ type: "project:upsert", payload: project });
  for (const task of tasks) {
    emitTaskEvent({
      task_id: task.id,
      channel_id: task.channel_id,
      project_id: task.project_id,
      type: "created",
      summary: `用户启动「${scenario.title}」场景并创建子任务`,
      metadata: { scenario: scenario.id, acceptance: acceptanceMode },
    });
    if (task.assignee_agent_id) {
      emitTaskEvent({
        task_id: task.id,
        channel_id: task.channel_id,
        project_id: task.project_id,
        agent_id: task.assignee_agent_id,
        type: "claim",
        summary: `场景任务由 ${getAgent(task.assignee_agent_id)?.name ?? "AI 同事"} 认领`,
        metadata: { scenario: scenario.id, acceptance: acceptanceMode },
      });
    }
    broadcast({ type: "task:upsert", payload: task });
  }
  for (const task of tasks) onTaskAssigned(task);
  res.json({ project, tasks });
});

api.patch("/tasks/:id", (req, res) => {
  const { title, description, status, assignee_agent_id, reviewer_agent_id, acceptance_criteria } = req.body ?? {};
  const prev = getTask(req.params.id);
  if (!prev) return res.status(404).json({ error: "task not found" });
  const nextAssignee = assignee_agent_id !== undefined ? assignee_agent_id : prev.assignee_agent_id;
  const briefTouched = assignee_agent_id !== undefined || description !== undefined || acceptance_criteria !== undefined;
  const missing = nextAssignee && briefTouched
    ? missingTaskBriefFields({
        description: description !== undefined ? description : prev.description,
        acceptance_criteria: acceptance_criteria !== undefined ? acceptance_criteria : prev.acceptance_criteria,
      })
    : [];
  if (missing.length > 0) {
    return res.status(400).json({
      error: "task brief incomplete: assigned tasks require context and acceptance criteria before execution",
      code: "TASK_BRIEF_INCOMPLETE",
      missing,
    });
  }
  const nextReviewer = reviewer_agent_id !== undefined ? reviewer_agent_id : prev.reviewer_agent_id;
  const responsibilityTouched = assignee_agent_id !== undefined || reviewer_agent_id !== undefined;
  if (responsibilityTouched && nextAssignee && nextReviewer && nextAssignee === nextReviewer) {
    return res.status(400).json({
      error: "task reviewer must be independent from the assignee",
      code: "TASK_REVIEWER_CONFLICT",
    });
  }
  if (status !== undefined) {
    const nextStatus = String(status);
    const allowed: Record<string, string[]> = {
      todo: ["todo", "cancelled"],
      doing: ["cancelled"],
      review: ["done", "cancelled"],
      // blocked→todo 是"审批已处理但未恢复"（如拒绝追加预算后想调整预算重跑）的人工恢复口；
      // 仍有 pending 阻塞审批时下方统一拦截，防止绕过待输入直接重启。
      blocked: ["todo", "cancelled"],
      done: ["todo", "review"],
      cancelled: ["todo"],
    };
    if (!["todo", "doing", "review", "blocked", "done", "cancelled"].includes(nextStatus)) {
      return res.status(400).json({ error: `invalid task status: ${nextStatus}` });
    }
    if (nextStatus === "blocked") {
      return res.status(400).json({ error: "blocked status must be entered through clarification flow" });
    }
    if (!allowed[prev.status]?.includes(nextStatus)) {
      return res.status(400).json({ error: `invalid task transition: ${prev.status} -> ${nextStatus}` });
    }
    if (nextStatus === "done" || nextStatus === "cancelled" || (nextStatus === "todo" && prev.status === "blocked")) {
      const pendingApprovals = listApprovals().filter((approval) =>
        approval.status === "pending" &&
        (approval.ref_id === prev.id || approval.id === prev.blocked_approval_id)
      );
      if (pendingApprovals.length > 0) {
        return res.status(400).json({
          error: "task has pending approvals",
          approval_ids: pendingApprovals.map((a) => a.id),
        });
      }
    }
  }
  const { budget_billable } = req.body ?? {};
  if (budget_billable !== undefined && (prev.status === "done" || prev.status === "cancelled")) {
    return res.status(400).json({ error: "terminal task budget is immutable; restore the task before editing budget" });
  }
  if (status === "cancelled" && prev.status === "doing") stopTask(prev.id);
  const task = updateTask(req.params.id, {
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(acceptance_criteria !== undefined ? { acceptance_criteria } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(status === "todo" && prev.status === "blocked" ? { blocked_approval_id: null } : {}),
    ...(assignee_agent_id !== undefined ? { assignee_agent_id } : {}),
    ...(reviewer_agent_id !== undefined ? { reviewer_agent_id } : {}),
    ...(budget_billable !== undefined ? { budget_billable: Number(budget_billable) > 0 ? Math.round(Number(budget_billable)) : 0 } : {}),
  });
  if (!task) return res.status(404).json({ error: "task not found" });
  const assigneeChanged = task.assignee_agent_id !== prev.assignee_agent_id;
  const statusChanged = task.status !== prev.status;
  const contextRevoked = assigneeChanged || statusChanged;
  if (contextRevoked) invalidateTaskNetworkApprovals(task.id);
  if (assigneeChanged) {
    emitTaskEvent({
      task_id: task.id,
      channel_id: task.channel_id,
      project_id: task.project_id,
      agent_id: task.assignee_agent_id,
      type: task.assignee_agent_id ? "claim" : "handoff",
      summary: task.assignee_agent_id
        ? `用户指派给 ${getAgent(task.assignee_agent_id)?.name ?? "AI 同事"}`
        : "用户取消了任务指派",
    });
  }
  if (reviewer_agent_id !== undefined && task.reviewer_agent_id !== prev?.reviewer_agent_id) {
    emitTaskEvent({
      task_id: task.id,
      channel_id: task.channel_id,
      project_id: task.project_id,
      agent_id: task.reviewer_agent_id ?? task.assignee_agent_id,
      type: "verification",
      summary: task.reviewer_agent_id
        ? `用户指定复核人：${getAgent(task.reviewer_agent_id)?.name ?? "AI 同事"}`
        : "用户恢复自动复核",
    });
  }
  if (task.status !== prev?.status) {
    if (task.status === "blocked") {
      emitTaskEvent({
        task_id: task.id,
        channel_id: task.channel_id,
        project_id: task.project_id,
        agent_id: task.assignee_agent_id,
        type: "blocked",
        summary: "任务进入等待用户输入状态",
      });
    } else if (task.status === "todo" && prev.status === "blocked") {
      emitTaskEvent({
        task_id: task.id,
        channel_id: task.channel_id,
        project_id: task.project_id,
        agent_id: task.assignee_agent_id,
        type: "handoff",
        summary: "用户调整后恢复任务并重新尝试",
        metadata: { previous_approval_id: prev.blocked_approval_id },
      });
    } else if (task.status === "review") {
      emitTaskEvent({
        task_id: task.id,
        channel_id: task.channel_id,
        project_id: task.project_id,
        agent_id: task.assignee_agent_id,
        type: "delivery",
        summary: "任务提交到人工评审",
      });
    } else if (task.status === "done") {
      emitTaskEvent({
        task_id: task.id,
        channel_id: task.channel_id,
        project_id: task.project_id,
        agent_id: task.assignee_agent_id,
        type: "user_close",
        summary: "用户关闭了任务",
      });
    } else if (task.status === "cancelled") {
      emitTaskEvent({
        task_id: task.id,
        channel_id: task.channel_id,
        project_id: task.project_id,
        agent_id: task.assignee_agent_id,
        type: "cancelled",
        summary: "用户取消并归档了任务",
      });
    }
  }
  broadcast({ type: "task:upsert", payload: task });
  // 用户把任务指派给了新的 AI 同事 → 对方自动开工
  if (
    task.assignee_agent_id &&
    (assigneeChanged || (prev.status === "blocked" && task.status === "todo"))
  ) onTaskAssigned(task);
  // 人工把任务推进到交付态 → 解锁依赖它的任务 / 触发项目汇总
  const delivered = task.status === "review" || task.status === "done";
  const wasDelivered = prev?.status === "review" || prev?.status === "done";
  if (delivered && !wasDelivered) onTaskDelivered(task);
  res.json(task);
});

api.post("/tasks/:id/stop", (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "task not found" });
  stopTask(task.id);
  res.json({ ok: true });
});

/** 待评审任务退回返工：reviewer/human 明确要求修订，任务回到 todo 并保留审计轨迹 */
api.post("/tasks/:id/revise", (req, res) => {
  const prev = getTask(req.params.id);
  if (!prev) return res.status(404).json({ error: "task not found" });
  if (prev.status !== "review") return res.status(400).json({ error: `task must be in review before revision, got ${prev.status}` });
  const reason = String(req.body?.reason ?? "").trim() || "复核要求返工";
  const revisions = (prev.revision_count ?? 0) + 1;
  const task = updateTask(prev.id, { status: "todo", revision_count: revisions, blocked_approval_id: null });
  if (!task) return res.status(404).json({ error: "task not found" });
  invalidateTaskNetworkApprovals(task.id);
  // D1：人工退回同样入 verdicts 表——质量度量要能区分"机器验收退回"与"人不满意退回"
  createVerdict({
    task_id: task.id,
    project_id: task.project_id,
    verifier_agent_id: task.reviewer_agent_id,
    worker_agent_id: task.assignee_agent_id,
    attempt: revisions,
    result: "revise",
    reasons: reason,
    source: "human",
  });
  emitTaskEvent({
    task_id: task.id,
    channel_id: task.channel_id,
    project_id: task.project_id,
    agent_id: task.reviewer_agent_id ?? task.assignee_agent_id,
    type: "verification",
    summary: `复核退回返工：${reason}`,
    metadata: { result: "revise", reasons: reason, revision_count: revisions },
  });
  emitTaskEvent({
    task_id: task.id,
    channel_id: task.channel_id,
    project_id: task.project_id,
    agent_id: task.assignee_agent_id,
    type: "handoff",
    summary: "任务已退回负责人修订",
    metadata: { revision_count: revisions },
  });
  if (task.channel_id) {
    const assignee = task.assignee_agent_id ? getAgent(task.assignee_agent_id) : undefined;
    insertMessage({
      channel_id: task.channel_id,
      author_type: "system",
      content: `↩️ 任务「${task.title}」被退回返工（第 ${revisions} 次）：${reason}${assignee ? `。已交回 ${assignee.name}` : ""}`,
    });
  }
  broadcast({ type: "task:upsert", payload: task });
  if (task.assignee_agent_id) onTaskAssigned(task);
  res.json(task);
});

/** 项目级批量关单（human-only）：一次决策把整个项目的剩余任务与项目本身置 done */
api.post("/projects/:id/close", (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "project not found" });
  const projectTasks = listTasks().filter((t) => t.project_id === project.id);
  const notDelivered = projectTasks.filter(
    (t) => t.status !== "review" && t.status !== "done" && t.status !== "cancelled",
  );
  if (notDelivered.length > 0) {
    return res.status(400).json({
      error: "project has unfinished tasks",
      task_ids: notDelivered.map((t) => t.id),
    });
  }
  const projectTaskIds = new Set(projectTasks.map((t) => t.id));
  const pendingApprovals = listApprovals().filter((a) => (
    a.status === "pending" &&
    a.ref_id &&
    (a.ref_id === project.id || projectTaskIds.has(a.ref_id))
  ));
  if (pendingApprovals.length > 0) {
    return res.status(400).json({
      error: "project has pending approvals",
      approval_ids: pendingApprovals.map((a) => a.id),
    });
  }
  for (const task of projectTasks) invalidateTaskNetworkApprovals(task.id);
  const { project: closedProject, tasks } = closeProject(req.params.id);
  if (!closedProject) return res.status(404).json({ error: "project not found" });
  for (const t of tasks) {
    emitTaskEvent({
      task_id: t.id,
      channel_id: t.channel_id,
      project_id: t.project_id,
      agent_id: t.assignee_agent_id,
      type: "user_close",
      summary: "用户批量关闭了项目任务",
    });
    broadcast({ type: "task:upsert", payload: t });
  }
  broadcast({ type: "project:upsert", payload: closedProject });
  res.json({ project: closedProject, tasks });
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
  const imgRaw = (req.body?.imageEdits ?? []) as unknown;
  const imageEdits: ImageEdit[] = Array.isArray(imgRaw)
    ? imgRaw.map((e) => ({
        slideIdx: Number((e as ImageEdit).slideIdx),
        imageIdx: Number((e as ImageEdit).imageIdx),
        dataBase64: String((e as ImageEdit).dataBase64 ?? "").replace(/^data:[^,]*,/, ""), // 容忍 data:URL 前缀
        ext: String((e as ImageEdit).ext ?? "png"),
      })).filter((e) => Number.isInteger(e.slideIdx) && Number.isInteger(e.imageIdx) && e.dataBase64)
    : [];
  try {
    const original = readTemplateBinary(doc.original_blob_path);
    const out = await applyTemplateEdits(original, edits, imageEdits);
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
    // 健壮提取：模型偶尔在 JSON 前后加说明文字或代码围栏——取最外层 {…} 子串再 parse（本端点产物恒为对象）。
    const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
    const jsonText = a >= 0 && b > a ? raw.slice(a, b + 1) : raw.trim();
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

// 为模板某图片位生成配图（Seedream）：返回 base64，前端预览并随 template-export 的 imageEdits 一起嵌入。
api.post("/documents/:id/template-image-generate", async (req, res) => {
  const doc = getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: "document not found" });
  if (doc.kind !== "template") return res.status(400).json({ error: "该文档不是 .pptx 模板" });
  const prompt = String(req.body?.prompt ?? "").trim();
  if (!prompt) return res.status(400).json({ error: "请填写配图描述（prompt）" });
  const size = String(req.body?.size ?? "");
  const r = await generateImageBytes(prompt, size);
  if ("error" in r) return res.status(502).json({ error: r.error });
  res.json(r); // { dataBase64, ext, assetUrl }
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

function mergeClarificationResponse(payload: string, response: string): string {
  try {
    const parsed = JSON.parse(payload || "{}") as Record<string, unknown>;
    const proposed = typeof parsed.proposed_default === "string" ? parsed.proposed_default : "";
    const userResponse = response.trim() || proposed.trim();
    return JSON.stringify({ ...parsed, user_response: userResponse }, null, 2);
  } catch {
    return JSON.stringify({ question: payload, user_response: response.trim() }, null, 2);
  }
}

api.post("/approvals/:id/resolve", (req, res) => {
  if (typeof req.body?.approve !== "boolean") {
    return res.status(400).json({ error: "approve must be boolean" });
  }
  const approve = req.body.approve;
  const before = getApproval(req.params.id);
  if (before?.status === "pending" && before.kind === "clarification" && approve) {
    const response = typeof req.body?.response === "string" ? req.body.response : "";
    updateApprovalPayload(before.id, mergeClarificationResponse(before.payload, response));
  }
  const resolved = resolveApprovalOnce(req.params.id, approve);
  if (!resolved) return res.status(404).json({ error: "approval not found" });
  const { approval, changed } = resolved;
  const wasApproved = approval.status === "approved";
  if (changed && approval.kind === "network") onNetworkApprovalResolved(approval);
  if (changed) broadcast({ type: "approval:upsert", payload: approval });
  if (changed && approval.channel_id) {
    const agent = getAgent(approval.agent_id);
    const sys = insertMessage({
      channel_id: approval.channel_id,
      author_type: "system",
      content: `${wasApproved ? "✅ 用户批准了" : "❌ 用户拒绝了"} ${agent?.name ?? "AI"} 的审批请求「${approval.title}」`,
    });
    broadcast({ type: "message:new", payload: sys });
    if (approval.kind === "plan" && approval.ref_id) {
      onPlanResolved(approval.ref_id, wasApproved); // 计划把关：批准开工 / 退回唤起 Lead
    } else if (approval.kind === "action") {
      triggerAgent(approval.agent_id, approval.channel_id);
    }
  }
  if (changed && approval.kind === "clarification") onClarificationResolved(approval, wasApproved);
  if (changed && approval.kind === "budget") onBudgetResolved(approval, wasApproved); // 预算追加：批准恢复执行/拒绝保持暂停
  res.json(approval);
});

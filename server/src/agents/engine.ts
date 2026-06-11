import Anthropic from "@anthropic-ai/sdk";
import {
  Agent,
  Channel,
  Message,
  Task,
  appendMemory,
  createApproval,
  createDocument,
  createTask,
  getAgent,
  getChannel,
  getDocument,
  getMemory,
  getTask,
  insertMessage,
  listAgents,
  listChannels,
  listDocuments,
  listMessages,
  listTasks,
  updateMessage,
  updateTask,
} from "../db.js";
import { broadcast } from "../bus.js";

const MAX_CHAIN_DEPTH = Number(process.env.AGENT_CHAIN_DEPTH ?? 2);
const TRANSCRIPT_WINDOW = 40;
const MAX_WORK_ITERATIONS = 8;
const MAX_CONCURRENT_WORK = 8;

const apiKey = process.env.ANTHROPIC_API_KEY;
const client = apiKey ? new Anthropic({ apiKey }) : null;
export const isMockMode = !client;

function supportsAdaptiveThinking(model: string): boolean {
  return /fable|mythos|opus-4-[678]|sonnet-4-6/.test(model);
}

/** 单次 Agent 运行的上下文：工具执行需要知道在替谁、在哪个频道、为哪个任务工作。 */
interface RunCtx {
  agent: Agent;
  channel: Channel;
  taskId: string | null;
  createdDocIds: string[];
}

// ---------------------------------------------------------------------------
// 路由与触发
// ---------------------------------------------------------------------------

function parseMentions(text: string, candidates: Agent[]): Agent[] {
  return candidates.filter((a) => text.includes(`@${a.name}`));
}

function channelAgents(channel: Channel): Agent[] {
  return (channel.agent_ids ?? []).map((id) => getAgent(id)).filter((a): a is Agent => Boolean(a));
}

/** 用户或 Agent 发出新消息后调用：决定哪些 Agent 应答并触发它们。 */
export function onMessage(message: Message) {
  const channel = getChannel(message.channel_id);
  if (!channel) return;
  const agents = channelAgents(channel);
  if (agents.length === 0) return;

  let responders: Agent[] = [];
  if (message.author_type === "user") {
    const mentioned = parseMentions(message.content, agents);
    if (mentioned.length > 0) responders = mentioned;
    else if (channel.kind === "dm" && channel.dm_agent_id) {
      const a = getAgent(channel.dm_agent_id);
      if (a) responders = [a];
    } else {
      responders = [agents[0]]; // 频道默认负责人：首位 AI 成员
    }
  } else if (message.author_type === "agent") {
    if (message.reply_depth >= MAX_CHAIN_DEPTH) return;
    responders = parseMentions(message.content, agents).filter((a) => a.id !== message.author_id);
  }

  const seen = new Set<string>();
  for (const agent of responders) {
    if (seen.has(agent.id)) continue;
    seen.add(agent.id);
    const depth = message.author_type === "agent" ? message.reply_depth + 1 : 0;
    void runAgent(agent, channel, depth).catch((err) => reportFailure(agent, channel, err));
  }
}

/** 外部事件（如审批结果）后主动唤起某个 Agent 跟进。 */
export function triggerAgent(agentId: string, channelId: string, extraSystem?: string) {
  const agent = getAgent(agentId);
  const channel = getChannel(channelId);
  if (!agent || !channel) return;
  void runAgent(agent, channel, 1, extraSystem).catch((err) => reportFailure(agent, channel, err));
}

function reportFailure(agent: Agent, channel: Channel, err: any) {
  console.error(`[engine] ${agent.name} failed:`, err);
  audit(channel.id, `⚠️ ${agent.name} 执行失败：${err?.message ?? err}`);
  status(agent, channel.id, "idle");
}

// ---------------------------------------------------------------------------
// 任务工作循环：任务指派给 Agent 后，它在后台自主认领并完成
// ---------------------------------------------------------------------------

const runningTasks = new Set<string>();
const agentQueues = new Map<string, Promise<void>>();

/** 任务被指派（或创建时即带负责人）后调用。每个 Agent 串行干活，全局并发受限。 */
export function onTaskAssigned(task: Task) {
  if (!task.assignee_agent_id) return;
  if (task.status === "review" || task.status === "done") return;
  if (runningTasks.has(task.id)) return;
  const agent = getAgent(task.assignee_agent_id);
  if (!agent) return;
  if (runningTasks.size >= MAX_CONCURRENT_WORK) {
    if (task.channel_id) audit(task.channel_id, `⏸️ 并发已满，任务「${task.title}」暂未自动开工`);
    return;
  }
  runningTasks.add(task.id);
  const prev = agentQueues.get(agent.id) ?? Promise.resolve();
  const next = prev
    .then(() => runTaskWork(agent, task.id))
    .catch((err) => {
      const t = getTask(task.id);
      const channelId = t?.channel_id;
      if (channelId) audit(channelId, `⚠️ ${agent.name} 处理任务「${task.title}」失败：${err?.message ?? err}`);
      console.error(`[engine] task work failed:`, err);
    })
    .finally(() => runningTasks.delete(task.id));
  agentQueues.set(agent.id, next);
}

async function runTaskWork(agent: Agent, taskId: string) {
  let task = getTask(taskId);
  if (!task || task.status === "done" || task.status === "review") return;

  // 任务必须有可见的工作频道；没有则落到首个频道
  let channel = task.channel_id ? getChannel(task.channel_id) : undefined;
  if (!channel) {
    channel = listChannels().find((c) => c.kind === "channel");
    if (!channel) return;
    task = updateTask(task.id, { channel_id: channel.id }) ?? task;
    broadcast({ type: "task:upsert", payload: task });
  }

  audit(channel.id, `🚀 ${agent.name} 开始处理任务「${task.title}」`);
  const doing = updateTask(task.id, { status: "doing" });
  if (doing) broadcast({ type: "task:upsert", payload: doing });

  const ctx: RunCtx = { agent, channel, taskId: task.id, createdDocIds: [] };
  const transcript = buildTranscript(channel.id, 20);
  const prompt = [
    `你被指派了一个任务，请现在完成它。`,
    ``,
    `任务：${task.title}`,
    `详情：${task.description || "（无）"}`,
    `所在频道：#${channel.name}`,
    ``,
    `<transcript>（频道最近讨论，供你了解背景）`,
    transcript,
    `</transcript>`,
    ``,
    `工作要求：`,
    `1. 如需要事实、数据或最新外部信息，先用 web_search / web_fetch 调研，不要凭空编造；`,
    `2. 用 write_document 产出一份完整、可直接使用的交付物文档（Markdown 正文要详尽）；`,
    `3. 文档写完后，在回复正文给出简短交付摘要：做了什么、关键结论、需要谁跟进什么；`,
    `4. 任务状态由系统管理，不要调用 update_task 改本任务状态；关单（done）只能由人类完成；`,
    `5. 如发现衍生工作，可用 create_task 开新任务并指派给合适的同事。`,
  ].join("\n");

  await streamRun(ctx, prompt, MAX_WORK_ITERATIONS);

  // 交付：转入待评审，并唤起评审同事
  const after = getTask(task.id);
  if (after && after.status === "doing") {
    const review = updateTask(task.id, { status: "review" });
    if (review) {
      broadcast({ type: "task:upsert", payload: review });
      audit(channel.id, `📦 ${agent.name} 已交付任务「${review.title}」，转入待评审`);
    }
  }
  requestPeerReview(agent, channel, task.id, ctx.createdDocIds);
}

/** 同行评审：交付后自动唤起另一位同事针对交付物全文给意见。 */
function requestPeerReview(worker: Agent, channel: Channel, taskId: string, docIds: string[]) {
  const task = getTask(taskId);
  if (!task) return;
  const others = channelAgents(channel).filter((a) => a.id !== worker.id);
  if (others.length === 0) return;
  const reviewer =
    others.find((a) => a.name.includes("评审")) ??
    others.find((a) => a.id === task.created_by) ??
    others[0];

  const doc = docIds.length > 0 ? getDocument(docIds[docIds.length - 1]) : undefined;
  const extraSystem = doc
    ? `## 待评审交付物《${doc.title}》全文\n\n${doc.content.slice(0, 12000)}`
    : undefined;
  audit(channel.id, `🔎 请 ${reviewer.name} 评审 ${worker.name} 对任务「${task.title}」的交付`);
  triggerAgent(reviewer.id, channel.id, extraSystem);
}

// ---------------------------------------------------------------------------
// 上下文构建
// ---------------------------------------------------------------------------

function fmtTime(ts: number) {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

function authorLabel(m: Message): string {
  if (m.author_type === "user") return "用户";
  if (m.author_type === "system") return "[系统]";
  const a = m.author_id ? getAgent(m.author_id) : undefined;
  return a ? `${a.name}(AI)` : "AI";
}

function buildTranscript(channelId: string, window = TRANSCRIPT_WINDOW): string {
  const msgs = listMessages(channelId, window).filter((m) => m.status !== "streaming");
  return msgs.map((m) => `[${fmtTime(m.created_at)}] ${authorLabel(m)}: ${m.content}`).join("\n\n");
}

function buildDynamicContext(agent: Agent, channel: Channel): string {
  const teammates = channelAgents(channel)
    .filter((a) => a.id !== agent.id)
    .map((a) => `- @${a.name}（${a.role}）`)
    .join("\n");
  const tasks = listTasks(channel.id)
    .slice(0, 20)
    .map((t) => {
      const assignee = t.assignee_agent_id ? getAgent(t.assignee_agent_id)?.name ?? "?" : "未分配";
      return `- [${t.status}] ${t.title}（id: ${t.id}，负责人: ${assignee}）`;
    })
    .join("\n");
  const docs = listDocuments()
    .filter((d) => !d.channel_id || d.channel_id === channel.id)
    .slice(0, 10)
    .map((d) => `- 《${d.title}》（id: ${d.id}，作者: ${d.agent_id ? getAgent(d.agent_id)?.name ?? "?" : "用户"}）`)
    .join("\n");
  const memory = getMemory(agent.id);
  return [
    `## 当前工作区上下文`,
    `频道：#${channel.name}（${channel.kind === "dm" ? "与用户的私信" : "团队频道"}）`,
    teammates ? `频道内其他 AI 同事：\n${teammates}` : `频道内没有其他 AI 同事。`,
    tasks ? `频道任务看板：\n${tasks}` : `任务看板目前为空。`,
    docs ? `工作区文档（可用 read_document 阅读全文）：\n${docs}` : "",
    memory ? `## 你的长期记忆\n${memory}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// 工具面
// ---------------------------------------------------------------------------

const TOOLS: Anthropic.ToolUnion[] = [
  {
    name: "create_task",
    description:
      "在团队任务看板上创建一个任务。当讨论中出现明确的待办事项时调用；指派给 AI 同事后对方会自动开工。",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "任务标题，简洁的动宾短语" },
        description: { type: "string", description: "任务详情，包含足够的背景与验收标准（负责人将据此独立完成）" },
        assignee: { type: "string", description: "负责人的名字（AI 同事名，或留空表示未分配）" },
      },
      required: ["title"],
    },
  },
  {
    name: "update_task",
    description:
      "更新看板上的任务：推进状态、改负责人、改标题/描述。task_id 来自上下文中的任务列表。注意：done（关单）只能由人类操作。",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "任务 id" },
        status: { type: "string", enum: ["todo", "doing", "review"] },
        title: { type: "string" },
        description: { type: "string" },
        assignee: { type: "string", description: "负责人名字" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "write_document",
    description:
      "把一份正式交付物（报告、PRD、方案、评估等）写入工作区文档库。文档应当完整、可直接使用，而不是片段。",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "文档标题" },
        content: { type: "string", description: "完整的 Markdown 正文" },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "read_document",
    description: "按 id 阅读工作区文档库中某份文档的全文。文档列表见上下文。",
    input_schema: {
      type: "object" as const,
      properties: { doc_id: { type: "string" } },
      required: ["doc_id"],
    },
  },
  {
    name: "request_approval",
    description:
      "向用户发起审批请求。任何对外或高风险动作（发邮件、对外发布、部署、产生费用）必须先调用本工具，等待用户批准，不要直接宣称已完成。",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "一句话说明请求批准的动作" },
        details: { type: "string", description: "动作的完整内容（如邮件全文、发布文案）" },
      },
      required: ["title", "details"],
    },
  },
  {
    name: "save_memory",
    description: "把值得长期记住的结论写入你的记忆（用户偏好、项目背景、关键决策）。每次一条，简洁。",
    input_schema: {
      type: "object" as const,
      properties: { note: { type: "string", description: "要记住的一条笔记" } },
      required: ["note"],
    },
  },
];

// 服务端工具：真实联网调研能力（由 Anthropic 服务端执行，无需本地实现）
const WEB_TOOLS: Anthropic.ToolUnion[] = [
  { type: "web_search_20260209", name: "web_search" },
  { type: "web_fetch_20260209", name: "web_fetch" },
];

function findAgentByName(name?: string): Agent | undefined {
  if (!name) return undefined;
  return listAgents().find((a) => a.name === name.replace(/^@/, "").trim());
}

function execTool(ctx: RunCtx, name: string, input: any): string {
  const { agent, channel } = ctx;
  switch (name) {
    case "create_task": {
      const assignee = findAgentByName(input.assignee);
      const task = createTask({
        channel_id: channel.id,
        title: String(input.title ?? "").slice(0, 200),
        description: String(input.description ?? ""),
        status: "todo",
        assignee_agent_id: assignee?.id ?? null,
        created_by: agent.id,
      });
      broadcast({ type: "task:upsert", payload: task });
      audit(channel.id, `🗂️ ${agent.name} 创建了任务「${task.title}」${assignee ? `，指派给 ${assignee.name}` : ""}`);
      if (assignee) onTaskAssigned(task);
      return `已创建任务（id: ${task.id}）${assignee ? `，${assignee.name} 将自动开工` : ""}`;
    }
    case "update_task": {
      if (input.status === "done") return "错误：关单（done）是 human-only 操作，请提请用户在看板上确认关闭。";
      const prev = getTask(String(input.task_id));
      if (!prev) return `错误：找不到任务 ${input.task_id}`;
      const assignee = findAgentByName(input.assignee);
      const task = updateTask(prev.id, {
        ...(input.status ? { status: input.status } : {}),
        ...(input.title ? { title: String(input.title) } : {}),
        ...(input.description !== undefined ? { description: String(input.description) } : {}),
        ...(input.assignee !== undefined ? { assignee_agent_id: assignee?.id ?? null } : {}),
      });
      if (!task) return `错误：找不到任务 ${input.task_id}`;
      broadcast({ type: "task:upsert", payload: task });
      audit(channel.id, `🗂️ ${agent.name} 更新了任务「${task.title}」→ ${task.status}`);
      // 换了新负责人 → 触发对方自动开工（避免自己改自己导致的重复触发）
      if (task.assignee_agent_id && task.assignee_agent_id !== prev.assignee_agent_id && task.id !== ctx.taskId) {
        onTaskAssigned(task);
      }
      return `已更新任务（id: ${task.id}，状态: ${task.status}）`;
    }
    case "write_document": {
      const doc = createDocument({
        channel_id: channel.id,
        task_id: ctx.taskId,
        agent_id: agent.id,
        title: String(input.title ?? "未命名").slice(0, 200),
        content: String(input.content ?? ""),
      });
      ctx.createdDocIds.push(doc.id);
      broadcast({ type: "doc:upsert", payload: doc });
      audit(channel.id, `📄 ${agent.name} 写好了文档《${doc.title}》（${doc.content.length} 字）`);
      return `文档已保存（id: ${doc.id}）。`;
    }
    case "read_document": {
      const doc = getDocument(String(input.doc_id));
      if (!doc) return `错误：找不到文档 ${input.doc_id}`;
      return `《${doc.title}》\n\n${doc.content.slice(0, 20000)}`;
    }
    case "request_approval": {
      const approval = createApproval({
        channel_id: channel.id,
        agent_id: agent.id,
        title: String(input.title ?? "").slice(0, 200),
        payload: String(input.details ?? ""),
      });
      broadcast({ type: "approval:upsert", payload: approval });
      audit(channel.id, `🔒 ${agent.name} 发起了审批请求「${approval.title}」，等待用户处理（见收件箱）`);
      return `审批请求已提交（id: ${approval.id}），状态 pending。在用户批准前不要执行该动作。`;
    }
    case "save_memory": {
      appendMemory(agent.id, String(input.note ?? ""));
      return "已写入记忆。";
    }
    default:
      return `未知工具：${name}`;
  }
}

function toolLabel(name: string): string {
  switch (name) {
    case "create_task": return "正在创建任务…";
    case "update_task": return "正在更新任务…";
    case "write_document": return "正在撰写文档…";
    case "read_document": return "正在查阅文档…";
    case "request_approval": return "正在发起审批请求…";
    case "save_memory": return "正在记录笔记…";
    default: return `正在使用 ${name}…`;
  }
}

// ---------------------------------------------------------------------------
// 运行核心：流式 LLM 循环（聊天应答与任务工作共用）
// ---------------------------------------------------------------------------

function audit(channelId: string, text: string) {
  const msg = insertMessage({ channel_id: channelId, author_type: "system", content: text });
  broadcast({ type: "message:new", payload: msg });
}

function status(agent: Agent, channelId: string, state: "thinking" | "tool" | "responding" | "idle", detail?: string) {
  broadcast({ type: "agent:status", payload: { agent_id: agent.id, channel_id: channelId, state, detail } });
}

async function runAgent(agent: Agent, channel: Channel, depth: number, extraSystem?: string) {
  const ctx: RunCtx = { agent, channel, taskId: null, createdDocIds: [] };
  const transcript = buildTranscript(channel.id);
  const prompt = `以下是频道 #${channel.name} 的最近对话记录：\n\n<transcript>\n${transcript}\n</transcript>\n\n现在请你以「${agent.name}」的身份，针对最新一条消息给出回复。直接输出回复内容本身，不要带姓名前缀或时间戳。`;
  const done = await streamRun(ctx, prompt, 6, depth, extraSystem);

  // 代理链：本条回复中 @ 了其他同事则接力
  if (done) onMessage(done);
}

/**
 * 以 agent 身份在频道里执行一轮流式回复（含工具循环），返回落库后的完整消息。
 */
async function streamRun(
  ctx: RunCtx,
  userPrompt: string,
  maxIterations: number,
  depth = 0,
  extraSystem?: string
): Promise<Message | null> {
  const { agent, channel } = ctx;
  status(agent, channel.id, "thinking");

  const row = insertMessage({
    channel_id: channel.id,
    author_type: "agent",
    author_id: agent.id,
    status: "streaming",
    reply_depth: depth,
  });
  broadcast({ type: "message:new", payload: row });

  let content = "";
  const emit = (delta: string) => {
    content += delta;
    broadcast({ type: "message:delta", payload: { id: row.id, channel_id: channel.id, delta } });
  };

  try {
    let usage = { input_tokens: 0, output_tokens: 0 };
    if (!client) {
      await mockRun(ctx, emit);
    } else {
      usage = await llmLoop(ctx, userPrompt, maxIterations, emit, extraSystem);
    }
    const usageJson = JSON.stringify(usage);
    updateMessage(row.id, { content, status: "complete", usage_json: usageJson });
    broadcast({ type: "message:done", payload: { id: row.id, channel_id: channel.id, content, usage_json: usageJson } });
    status(agent, channel.id, "idle");
    return { ...row, content, status: "complete", reply_depth: depth };
  } catch (err) {
    updateMessage(row.id, { content: content || "（回复中断）", status: "error" });
    broadcast({
      type: "message:done",
      payload: { id: row.id, channel_id: channel.id, content: content || "（回复中断）", usage_json: null },
    });
    status(agent, channel.id, "idle");
    throw err;
  }
}

async function llmLoop(
  ctx: RunCtx,
  userPrompt: string,
  maxIterations: number,
  emit: (delta: string) => void,
  extraSystem?: string
): Promise<{ input_tokens: number; output_tokens: number }> {
  if (!client) throw new Error("no client");
  const { agent, channel } = ctx;

  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: agent.system_prompt, cache_control: { type: "ephemeral" } },
    { type: "text", text: buildDynamicContext(agent, channel) + (extraSystem ? `\n\n${extraSystem}` : "") },
  ];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];
  const tools: Anthropic.ToolUnion[] = [...TOOLS, ...WEB_TOOLS];

  const usage = { input_tokens: 0, output_tokens: 0 };
  let firstText = true;
  let emitted = false;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const stream = client.messages.stream({
      model: agent.model,
      max_tokens: 16000,
      ...(supportsAdaptiveThinking(agent.model) ? { thinking: { type: "adaptive" as const } } : {}),
      system,
      messages,
      tools,
    });

    stream.on("text", (delta) => {
      if (firstText) {
        status(agent, channel.id, "responding");
        firstText = false;
      }
      emit(delta);
      emitted = true;
    });

    const final = await stream.finalMessage();
    usage.input_tokens +=
      final.usage.input_tokens +
      (final.usage.cache_read_input_tokens ?? 0) +
      (final.usage.cache_creation_input_tokens ?? 0);
    usage.output_tokens += final.usage.output_tokens;

    if (final.stop_reason === "pause_turn") {
      // 服务端工具（web_search 等）跑满单次迭代上限，续跑即可
      messages.push({ role: "assistant", content: final.content });
      continue;
    }

    const toolUses = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (final.stop_reason !== "tool_use" || toolUses.length === 0) break;

    messages.push({ role: "assistant", content: final.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      status(agent, channel.id, "tool", toolLabel(tu.name));
      let result: string;
      try {
        result = execTool(ctx, tu.name, tu.input);
      } catch (err: any) {
        result = `工具执行失败：${err?.message ?? err}`;
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    messages.push({ role: "user", content: results });
    if (emitted) emit("\n\n"); // 工具段落之间留空行，保持 Markdown 结构
  }
  return usage;
}

// ---------------------------------------------------------------------------
// Mock 模式
// ---------------------------------------------------------------------------

async function mockRun(ctx: RunCtx, emit: (delta: string) => void) {
  const { agent } = ctx;
  if (ctx.taskId) {
    const task = getTask(ctx.taskId);
    const doc = createDocument({
      channel_id: ctx.channel.id,
      task_id: ctx.taskId,
      agent_id: agent.id,
      title: `（Mock）${task?.title ?? "交付物"}`,
      content: `# ${task?.title ?? "交付物"}\n\n这是 Mock 模式生成的演示交付物。配置 \`ANTHROPIC_API_KEY\` 后，${agent.name} 会真实调研并撰写完整文档。`,
    });
    ctx.createdDocIds.push(doc.id);
    broadcast({ type: "doc:upsert", payload: doc });
    audit(ctx.channel.id, `📄 ${agent.name} 写好了文档《${doc.title}》`);
  }
  const text = ctx.taskId
    ? `（Mock 模式）任务已按演示流程处理完毕：我完成了调研与交付物撰写（见文档库），任务将转入待评审。配置 \`ANTHROPIC_API_KEY\` 后我会真实执行这项工作。`
    : `（Mock 模式）你好，我是 **${agent.name}**（${agent.role}）。

当前服务端未配置 \`ANTHROPIC_API_KEY\`，所以这是一条模拟回复，用于演示完整的协作流程：

| 能力 | 状态 |
|---|---|
| 流式输出 / @路由 / 代理接力 | ✅ 正在演示 |
| 任务自动开工 → 交付 → 同行评审 | ✅ 指派任务即可演示 |
| 联网调研 / 文档交付 / 审批门 / 记忆 | ✅ 配置 Key 后由我真实驱动 |`;
  for (const chunk of text.match(/[\s\S]{1,12}/g) ?? []) {
    emit(chunk);
    await new Promise((r) => setTimeout(r, 20));
  }
}

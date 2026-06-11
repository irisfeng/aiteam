import Anthropic from "@anthropic-ai/sdk";
import {
  Agent,
  Channel,
  Message,
  appendMemory,
  createApproval,
  createTask,
  getAgent,
  getChannel,
  getMemory,
  insertMessage,
  listAgents,
  listMessages,
  listTasks,
  updateMessage,
  updateTask,
} from "../db.js";
import { broadcast } from "../bus.js";

const MAX_CHAIN_DEPTH = Number(process.env.AGENT_CHAIN_DEPTH ?? 2);
const TRANSCRIPT_WINDOW = 40;
const apiKey = process.env.ANTHROPIC_API_KEY;
const client = apiKey ? new Anthropic({ apiKey }) : null;

export const isMockMode = !client;

function supportsAdaptiveThinking(model: string): boolean {
  return /fable|mythos|opus-4-[678]|sonnet-4-6/.test(model);
}

/** 在文本中解析对频道内其他 Agent 的 @提及（名字可含空格，按已知名字精确匹配）。 */
function parseMentions(text: string, candidates: Agent[]): Agent[] {
  return candidates.filter((a) => text.includes(`@${a.name}`));
}

function channelAgents(channel: Channel): Agent[] {
  return (channel.agent_ids ?? []).map((id) => getAgent(id)).filter((a): a is Agent => Boolean(a));
}

function fmtTime(ts: number) {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

function authorLabel(m: Message): string {
  if (m.author_type === "user") return "用户";
  if (m.author_type === "system") return "[系统]";
  const a = m.author_id ? getAgent(m.author_id) : undefined;
  return a ? `${a.name}(AI)` : "AI";
}

function buildTranscript(channelId: string): string {
  const msgs = listMessages(channelId, TRANSCRIPT_WINDOW).filter((m) => m.status !== "streaming");
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
  const memory = getMemory(agent.id);
  return [
    `## 当前工作区上下文`,
    `频道：#${channel.name}（${channel.kind === "dm" ? "与用户的私信" : "团队频道"}）`,
    teammates ? `频道内其他 AI 同事：\n${teammates}` : `频道内没有其他 AI 同事。`,
    tasks ? `频道任务看板：\n${tasks}` : `任务看板目前为空。`,
    memory ? `## 你的长期记忆\n${memory}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "create_task",
    description:
      "在团队任务看板上创建一个任务。当讨论中出现明确的待办事项时调用，让工作可被追踪。",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "任务标题，简洁的动宾短语" },
        description: { type: "string", description: "任务详情，可含验收标准" },
        assignee: { type: "string", description: "负责人的名字（AI 同事名，或留空表示未分配）" },
        status: { type: "string", enum: ["todo", "doing", "review", "done"], description: "初始状态，默认 todo" },
      },
      required: ["title"],
    },
  },
  {
    name: "update_task",
    description: "更新看板上的任务：推进状态、改负责人、改标题/描述。task_id 来自上下文中的任务列表。",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "任务 id" },
        status: { type: "string", enum: ["todo", "doing", "review", "done"] },
        title: { type: "string" },
        description: { type: "string" },
        assignee: { type: "string", description: "负责人名字" },
      },
      required: ["task_id"],
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

function findAgentByName(name?: string): Agent | undefined {
  if (!name) return undefined;
  return listAgents().find((a) => a.name === name.replace(/^@/, "").trim());
}

function execTool(agent: Agent, channel: Channel, name: string, input: any): string {
  switch (name) {
    case "create_task": {
      const assignee = findAgentByName(input.assignee);
      const task = createTask({
        channel_id: channel.id,
        title: String(input.title ?? "").slice(0, 200),
        description: String(input.description ?? ""),
        status: ["todo", "doing", "review", "done"].includes(input.status) ? input.status : "todo",
        assignee_agent_id: assignee?.id ?? null,
        created_by: agent.id,
      });
      broadcast({ type: "task:upsert", payload: task });
      audit(channel.id, `🗂️ ${agent.name} 创建了任务「${task.title}」`);
      return `已创建任务（id: ${task.id}）`;
    }
    case "update_task": {
      const assignee = findAgentByName(input.assignee);
      const task = updateTask(String(input.task_id), {
        ...(input.status ? { status: input.status } : {}),
        ...(input.title ? { title: String(input.title) } : {}),
        ...(input.description !== undefined ? { description: String(input.description) } : {}),
        ...(input.assignee !== undefined ? { assignee_agent_id: assignee?.id ?? null } : {}),
      });
      if (!task) return `错误：找不到任务 ${input.task_id}`;
      broadcast({ type: "task:upsert", payload: task });
      audit(channel.id, `🗂️ ${agent.name} 更新了任务「${task.title}」→ ${task.status}`);
      return `已更新任务（id: ${task.id}，状态: ${task.status}）`;
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

function audit(channelId: string, text: string) {
  const msg = insertMessage({ channel_id: channelId, author_type: "system", content: text });
  broadcast({ type: "message:new", payload: msg });
}

function status(agent: Agent, channelId: string, state: "thinking" | "tool" | "responding" | "idle", detail?: string) {
  broadcast({ type: "agent:status", payload: { agent_id: agent.id, channel_id: channelId, state, detail } });
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
    void runAgent(agent, channel, depth).catch((err) => {
      console.error(`[engine] ${agent.name} failed:`, err);
      const msg = insertMessage({
        channel_id: channel.id,
        author_type: "system",
        content: `⚠️ ${agent.name} 回复失败：${err?.message ?? err}`,
      });
      broadcast({ type: "message:new", payload: msg });
      status(agent, channel.id, "idle");
    });
  }
}

/** 外部事件（如审批结果）后主动唤起某个 Agent 跟进。 */
export function triggerAgent(agentId: string, channelId: string) {
  const agent = getAgent(agentId);
  const channel = getChannel(channelId);
  if (!agent || !channel) return;
  void runAgent(agent, channel, 0).catch((err) => {
    console.error(`[engine] trigger ${agent.name} failed:`, err);
    status(agent, channel.id, "idle");
  });
}

async function runAgent(agent: Agent, channel: Channel, depth: number) {
  status(agent, channel.id, "thinking");

  // 流式占位消息
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
      await mockReply(agent, emit);
    } else {
      usage = await llmReply(agent, channel, emit, () => status(agent, channel.id, "responding"), (d) =>
        status(agent, channel.id, "tool", d)
      );
    }
    const usageJson = JSON.stringify(usage);
    updateMessage(row.id, { content, status: "complete", usage_json: usageJson });
    broadcast({ type: "message:done", payload: { id: row.id, channel_id: channel.id, content, usage_json: usageJson } });
    status(agent, channel.id, "idle");

    // 代理链：本条回复中 @ 了其他同事则接力
    const done = { ...row, content, status: "complete" as const, reply_depth: depth };
    onMessage(done);
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

async function llmReply(
  agent: Agent,
  channel: Channel,
  emit: (delta: string) => void,
  onResponding: () => void,
  onTool: (detail: string) => void
): Promise<{ input_tokens: number; output_tokens: number }> {
  if (!client) throw new Error("no client");

  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: agent.system_prompt, cache_control: { type: "ephemeral" } },
    { type: "text", text: buildDynamicContext(agent, channel) },
  ];
  const transcript = buildTranscript(channel.id);
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `以下是频道 #${channel.name} 的最近对话记录：\n\n<transcript>\n${transcript}\n</transcript>\n\n现在请你以「${agent.name}」的身份，针对最新一条消息给出回复。直接输出回复内容本身，不要带姓名前缀或时间戳。`,
    },
  ];

  const usage = { input_tokens: 0, output_tokens: 0 };
  let firstText = true;

  for (let iteration = 0; iteration < 6; iteration++) {
    const stream = client.messages.stream({
      model: agent.model,
      max_tokens: 16000,
      ...(supportsAdaptiveThinking(agent.model) ? { thinking: { type: "adaptive" as const } } : {}),
      system,
      messages,
      tools: TOOLS,
    });

    stream.on("text", (delta) => {
      if (firstText) {
        onResponding();
        firstText = false;
      }
      emit(delta);
    });

    const final = await stream.finalMessage();
    usage.input_tokens += final.usage.input_tokens + (final.usage.cache_read_input_tokens ?? 0) + (final.usage.cache_creation_input_tokens ?? 0);
    usage.output_tokens += final.usage.output_tokens;

    const toolUses = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (final.stop_reason !== "tool_use" || toolUses.length === 0) break;

    messages.push({ role: "assistant", content: final.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      onTool(toolLabel(tu.name));
      let result: string;
      try {
        result = execTool(agent, channel, tu.name, tu.input);
      } catch (err: any) {
        result = `工具执行失败：${err?.message ?? err}`;
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    messages.push({ role: "user", content: results });
    // 工具段落之间留空行，保持 Markdown 结构
    emit("\n\n");
  }
  return usage;
}

function toolLabel(name: string): string {
  switch (name) {
    case "create_task":
      return "正在创建任务…";
    case "update_task":
      return "正在更新任务…";
    case "request_approval":
      return "正在发起审批请求…";
    case "save_memory":
      return "正在记录笔记…";
    default:
      return `正在使用 ${name}…`;
  }
}

async function mockReply(agent: Agent, emit: (delta: string) => void) {
  const text = `（Mock 模式）你好，我是 **${agent.name}**（${agent.role}）。

当前服务端未配置 \`ANTHROPIC_API_KEY\`，所以这是一条模拟回复，用于演示完整的协作流程：

| 能力 | 状态 |
|---|---|
| 流式输出 | ✅ 正在演示 |
| @提及路由与代理接力 | ✅ 可用 |
| 任务看板 / 审批门 / 记忆 | ✅ 配置 Key 后由我真实驱动 |

配置环境变量后重启服务，我就能真正开始工作了。`;
  for (const chunk of text.match(/[\s\S]{1,12}/g) ?? []) {
    emit(chunk);
    await new Promise((r) => setTimeout(r, 25));
  }
}

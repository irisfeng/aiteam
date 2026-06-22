import Anthropic from "@anthropic-ai/sdk";
import {
  Agent,
  Channel,
  Message,
  Routine,
  Skill,
  Task,
  agentDailyStats,
  appendMemory,
  createRoutine,
  getProvider,
  listProviders,
  listRoutines,
  listSkills,
  markRoutineRun,
  createApproval,
  createDocument,
  createProject,
  createTask,
  getAgent,
  getChannel,
  getDocument,
  getMemory,
  getMessage,
  getProject,
  getSkill,
  getTask,
  insertMessage,
  listAgents,
  listChannels,
  listDocuments,
  listMessages,
  listInFlightTasksAllOwners,
  listRoutinesAllOwners,
  listTasks,
  taskDependsOn,
  updateMessage,
  updateProject,
  updateTask,
} from "../db.js";
import { broadcast } from "../bus.js";
import { currentOwner, withOwner } from "../ownerScope.js";
import { parseSlides, slidesManifest } from "../pptx.js";
import { callMcpTool, isMcpTool, mcpToolDefs, mcpToolPrefixReady, mcpSafetyGate, searchQuerySignature } from "./mcp.js";
import { IMAGE_TOOL, generateImage, imageGenAvailable } from "./images.js";
import { getSkillTemplate } from "../registry.js";

const MAX_CHAIN_DEPTH = Number(process.env.AGENT_CHAIN_DEPTH ?? 2);
const MAX_REVISIONS = Number(process.env.TASK_MAX_REVISIONS ?? 1);
const TRANSCRIPT_WINDOW = 30;
/** 每次运行的 MCP 插件调用上限（外部检索按次计费，防烧爆） */
const MCP_CALLS_PER_RUN = Number(process.env.AITEAM_MCP_CALLS_PER_RUN ?? 5);
/** 每次运行的图片生成上限（文生图按张计费） */
const IMAGES_PER_RUN = Number(process.env.AITEAM_IMAGES_PER_RUN ?? 3);
const MAX_WORK_ITERATIONS = 8;
const MAX_CONCURRENT_WORK = 8;

/**
 * 剔除落单的 UTF-16 代理项（unpaired surrogate）。
 * 文档/转写按 .slice(0,N) 截断时，截断点可能落在 emoji 等代理对中间，留下半个代理；
 * JSON.stringify 会把它序列化成 \udXXX，DeepSeek 等严格端点会以
 * 400「unexpected end of hex escape」拒收整段请求。回传给模型前统一清洗。
 */
const stripLoneSurrogates = (s: string): string =>
  s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

/** 拆一行 CSV（容忍双引号包裹的逗号与 "" 转义） */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * write_document 落库前的 kind 契约校验：坏格式不入库，返回可执行的修订提示让模型自纠
 * （从源头挡住 slides 无分页 / sheet 列数不齐这类要到渲染期才暴露的问题）。返回 null = 通过。
 */
export function validateDocContent(kind: "report" | "slides" | "sheet" | "html", content: string): string | null {
  const c = content.trim();
  if (!c) return "正文为空。";
  if (kind === "html") {
    // 格式：至少是可渲染的 HTML 片段/文档
    if (!/<(!doctype|html|div|section|svg|style|body|main|article|h[1-6]|p|ul|ol|table|canvas|header|footer|nav)\b/i.test(c))
      return "html 交付物需是可直接渲染的 HTML 片段或文档（至少含一个 HTML 标签）。";
    // 安全：内容是模型生成的不可信 HTML——堵住存储型 XSS 的三个面（预览 iframe 已 sandbox，这里再做内容侧防御）
    if (/<script\b[^>]*\bsrc\s*=/i.test(c))
      return "html 交付物禁止外链 <script src=...>，请把脚本内联，或改用纯 CSS / SVG。";
    if (/[\s/]on\w+\s*=/i.test(c)) // [\s/]：HTML5 允许 / 作属性分隔，需同时挡 <svg/onload=...> 绕过
      return "html 交付物禁止内联事件处理器（onload/onerror/onclick 等），请改用 <script> 块或纯 CSS。";
    if (/javascript:/i.test(c))
      return "html 交付物禁止 javascript: URI。";
    return null;
  }
  if (kind === "slides") {
    if (!/\n\s*---\s*\n/.test(content))
      return "slides 需要用单独一行 --- 分页（首页标题页，之后每页一个要点群），当前没有检测到任何分页符。";
    const pages = parseSlides(content);
    if (pages.length < 1) return "slides 没有解析出任何有效页面。";
    if (pages.every((p) => !p.title)) return "slides 每页应有标题（以 # 开头），当前未检测到任何页标题。";
    return unsourcedNumbersHint(content);
  }
  if (kind === "sheet") {
    if (c.startsWith("|")) return null; // Markdown 表格是另一种合法形式，放行
    const lines = c.split("\n").filter((l) => l.trim() !== "");
    if (lines.length < 2) return "sheet 需要表头 + 至少一行数据。";
    const headerCols = splitCsvLine(lines[0]).length;
    if (headerCols < 2) return "sheet 表头至少 2 列（标准 CSV，逗号分隔）。";
    for (let i = 1; i < lines.length; i++) {
      const n = splitCsvLine(lines[i]).length;
      if (n !== headerCols)
        return `sheet 第 ${i + 1} 行有 ${n} 列，与表头 ${headerCols} 列不一致（含逗号的字段请用双引号包裹）。`;
    }
    return null;
  }
  return unsourcedNumbersHint(c); // report：格式无要求，但多处量化数据需有来源（防对外交付物编造数字）
}

/**
 * 内容质量软门（C2）：交付物含多处量化数据（市场规模/占比/金额等）却零来源标注 → 返回自纠提示。
 * 阈值保守（≥5 处且全文无任何来源/示意标注才触发）以免误伤；接受"示意值/待核实/估算"等显式标注豁免。
 * 仅 report/slides 适用（sheet/html 由各自分支放行）。这是"有标注"而非"为真"的下限，须配 verifier/接地（后续批次）。
 */
function unsourcedNumbersHint(c: string): string | null {
  const quant = (c.match(/\d[\d.,]*\s*(?:亿元|万元|亿|万|％|%|倍|元|美元|美金|\$|￥|¥)/g) || []).length;
  if (quant < 5) return null;
  const hasSource = /(https?:\/\/|来源|出处|资料来源|引用自|参见|据[^。；\n]{0,12}(报告|数据|统计|调研|测算|官方|官网|披露|年报|季报|白皮书|研究院|咨询)|\[\d+\])/.test(c);
  const exempt = /(示意值|示意数据|示例数据|仅供示意|占位数据|待核实|粗略估算|假设场景)/.test(c);
  if (hasSource || exempt) return null;
  return `检测到约 ${quant} 处量化数据（市场规模 / 占比 / 金额等）但全文无任何来源标注。请为关键数字补来源（链接 / 出处 /“据 X 报告”），无法核实的改写为“示意值，待核实”或删去——对外交付物里的无源数字会损害可信度。`;
}

const envKey = process.env.ANTHROPIC_API_KEY;
const envClient = envKey ? new Anthropic({ apiKey: envKey }) : null;

/** 全局 Mock：既无官方环境变量 key，也没有任何带 key 的自定义 provider。 */
export function isMock(): boolean {
  return !envClient && !listProviders().some((p) => p.api_key);
}

/** 单次运行的模型通道：client、是否官方（决定服务端工具/缓存可用性）、模型与输出上限。 */
interface Runtime {
  client: Anthropic | null;
  official: boolean;
  /** 是否启用 Anthropic 服务端联网工具（官方恒可用；兼容端点按 provider.web_tools） */
  webTools: boolean;
  /** 来源 provider id（env 官方为 null）——用于联网工具失败后的按通道熔断 */
  providerId: string | null;
  model: string;
  maxTokens: number;
}

/**
 * 兼容端点的联网工具适配阶梯：0=搜索+抓取 → 1=仅搜索 → 2=仅搜索(旧版类型) → 3=停用。
 * DeepSeek 官方文档确认其 Anthropic 端点原生支持 Claude 的 Web Search，但 web_fetch 与
 * 新版本号支持不一；实测 4xx 时自动降一档重试并留痕。官方通道恒为 0。
 */
const webToolsStage = new Map<string, number>();
const WEB_STAGE_LABEL = ["搜索+抓取", "仅搜索", "仅搜索（兼容版）", "停用"];
function webToolsFor(stage: number): Anthropic.ToolUnion[] {
  switch (stage) {
    case 0:
      return [
        { type: "web_search_20260209", name: "web_search" },
        { type: "web_fetch_20260209", name: "web_fetch" },
      ];
    case 1:
      return [{ type: "web_search_20260209", name: "web_search" }];
    case 2:
      return [{ type: "web_search_20250305", name: "web_search" } as unknown as Anthropic.ToolUnion];
    default:
      return [];
  }
}

interface RuntimeOpts {
  /** 验收/汇总走最强通道 */
  preferStrong?: boolean;
  /** light = 轻量低成本模型（重复性/格式化任务），standard = 全力模型 */
  tier?: "light" | "standard";
}

/**
 * 模型分级路由（choose model wisely）：
 * - preferStrong：验收/汇总是质量闭环的下限，官方通道可用时强制最强模型
 *   （AITEAM_STRONG_MODEL 可覆盖，默认 claude-opus-4-8）；
 * - tier=light：重复性/格式化/单一明确的执行任务走轻量模型
 *   （provider.light_model，官方默认 AITEAM_LIGHT_MODEL || claude-haiku-4-5），大幅降本。
 */
function resolveRuntime(agent: Agent, opts: RuntimeOpts = {}): Runtime {
  const light = opts.tier === "light";
  const fromProvider = (p: NonNullable<ReturnType<typeof getProvider>>, agentModel: string): Runtime => ({
    client: new Anthropic({ apiKey: p.api_key, baseURL: p.base_url || undefined }),
    official: !p.base_url, // 自定义 base_url 一律按"非官方"做缓存等门控
    webTools: !p.base_url || Boolean(p.web_tools),
    providerId: p.id,
    model: light ? p.light_model || p.default_model || agentModel : agentModel || p.default_model || "claude-opus-4-8",
    maxTokens: p.max_tokens || 16000,
  });
  if (opts.preferStrong) {
    if (envClient) {
      return {
        client: envClient,
        official: true,
        webTools: true,
        providerId: null,
        model: process.env.AITEAM_STRONG_MODEL || "claude-opus-4-8",
        maxTokens: 16000,
      };
    }
    // 无官方 key：用户标记了「强通道」的供应商承担验收/汇总（用其 default_model 全力档）
    const strong = listProviders().find((p) => p.api_key && p.is_strong);
    if (strong) return fromProvider(strong, strong.default_model || agent.model);
  }
  if (agent.provider_id) {
    const p = getProvider(agent.provider_id);
    if (p?.api_key) return fromProvider(p, agent.model);
  }
  if (envClient) {
    return {
      client: envClient,
      official: true,
      webTools: true,
      providerId: null,
      model: light ? process.env.AITEAM_LIGHT_MODEL || "claude-haiku-4-5" : agent.model || "claude-opus-4-8",
      maxTokens: 16000,
    };
  }
  // 无官方 key 时：回退到首个带 key 的供应商（工作区默认通道），
  // 模型用供应商默认值——内置同事的 claude-* 模型名在第三方端点上可能不存在
  const fallback = listProviders().find((p) => p.api_key);
  if (fallback) return fromProvider(fallback, fallback.default_model || agent.model);
  return { client: null, official: true, webTools: true, providerId: null, model: agent.model, maxTokens: 16000 };
}

function supportsAdaptiveThinking(model: string): boolean {
  return /fable|mythos|opus-4-[678]|sonnet-4-6/.test(model);
}

/** 单次 Agent 运行的上下文：工具执行需要知道在替谁、在哪个频道、为哪个任务工作。 */
interface RunCtx {
  agent: Agent;
  channel: Channel;
  kind: "chat" | "work" | "verify" | "synthesis";
  taskId: string | null;
  createdDocIds: string[];
  verdict: { result: "pass" | "revise"; reasons: string } | null;
}

function newCtx(agent: Agent, channel: Channel, kind: RunCtx["kind"], taskId: string | null = null): RunCtx {
  return { agent, channel, kind, taskId, createdDocIds: [], verdict: null };
}

// ---------------------------------------------------------------------------
// 聊天路由与触发
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
    void runChat(agent, channel, depth).catch((err) => reportFailure(agent, channel, err));
  }
}

/** 外部事件（如审批结果）后主动唤起某个 Agent 跟进。 */
export function triggerAgent(agentId: string, channelId: string, extraSystem?: string) {
  const agent = getAgent(agentId);
  const channel = getChannel(channelId);
  if (!agent || !channel) return;
  void runChat(agent, channel, 1, extraSystem).catch((err) => reportFailure(agent, channel, err));
}

function reportFailure(agent: Agent, channel: Channel, err: any) {
  console.error(`[engine] ${agent.name} failed:`, err);
  audit(channel.id, `⚠️ ${agent.name} 执行失败：${err?.message ?? err}`);
  status(agent, channel.id, "idle");
}

async function runChat(agent: Agent, channel: Channel, depth: number, extraSystem?: string) {
  const ctx = newCtx(agent, channel, "chat");
  const transcript = buildTranscript(channel.id);
  const prompt = `以下是频道 #${channel.name} 的最近对话记录：\n\n<transcript>\n${transcript}\n</transcript>\n\n现在请你以「${agent.name}」的身份，针对最新一条消息给出回复。直接输出回复内容本身，不要带姓名前缀或时间戳。`;
  const done = await streamRun(ctx, prompt, 6, depth, { extraSystem });
  // 代理链：本条回复中 @ 了其他同事则接力
  if (done) onMessage(done);
}

// ---------------------------------------------------------------------------
// 任务工作循环：指派 → 自主执行 → 验收 → （返工 →）交付 → 解锁依赖/项目汇总
// ---------------------------------------------------------------------------

const runningTasks = new Set<string>();
const agentQueues = new Map<string, Promise<void>>();
const currentWork = new Map<string, string>(); // agentId -> 正在执行的 taskId
const queuedCount = new Map<string, number>(); // agentId -> 排队中的任务数
const cancelledTasks = new Set<string>(); // 用户按下停止开关的任务
const cancelledChannels = new Set<string>(); // 用户在频道里按下停止（覆盖聊天回复 + 该频道的任务运行）
const activeStreams = new Map<string, Set<{ abort(): void }>>(); // channelId -> 正在跑的流（可 abort 中断）

/** 登记一个在跑的流，返回注销函数（运行结束时调用，顺带清理频道停止标志）。 */
function registerStream(channelId: string, stream: { abort(): void }): () => void {
  let set = activeStreams.get(channelId);
  if (!set) { set = new Set(); activeStreams.set(channelId, set); }
  set.add(stream);
  return () => {
    set!.delete(stream);
    if (set!.size === 0) { activeStreams.delete(channelId); cancelledChannels.delete(channelId); }
  };
}

/** 停止开关（kill switch）：运行中的任务在下一个迭代边界停下；排队中的任务直接不再开工。 */
export function stopTask(taskId: string) {
  cancelledTasks.add(taskId);
}

/**
 * 频道级停止：中断该频道里正在跑的全部 agent 运行（含没有 taskId 的聊天回复）——
 * abort 在飞的流（能停正在吐字的那一轮），并置频道停止标志让多轮循环在边界也停。
 * 返回是否有可停止的运行。
 */
export function stopChannel(channelId: string): boolean {
  const set = activeStreams.get(channelId);
  if (!set || set.size === 0) return false;
  cancelledChannels.add(channelId);
  for (const s of set) { try { s.abort(); } catch { /* ignore */ } }
  return true;
}

/** 预算护栏（借鉴 Paperclip 的硬切断）：今日 token 总用量超限则不再自动开工。 */
function budgetExhausted(): boolean {
  const budget = Number(process.env.AITEAM_DAILY_TOKEN_BUDGET ?? 0);
  if (!budget) return false;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  let total = 0;
  // 用加权计费 token（缓存读/写折算）估真实成本，不再把缓存读当全价 input 而提前熔断（见 QW3）。
  for (const s of agentDailyStats(startOfDay.getTime()).values()) total += s.billable;
  return total >= budget;
}

function depsSatisfied(task: Task): boolean {
  return taskDependsOn(task).every((id) => {
    const dep = getTask(id);
    return !dep || dep.status === "review" || dep.status === "done";
  });
}

/** 任务被指派（或创建时即带负责人）后调用。依赖未满足的任务会等依赖交付后自动开工。 */
export function onTaskAssigned(task: Task) {
  if (!task.assignee_agent_id) return;
  if (task.status === "review" || task.status === "done") return;
  if (runningTasks.has(task.id)) return;
  if (!depsSatisfied(task)) return; // 依赖交付时由 onTaskDelivered 解锁
  const agent = getAgent(task.assignee_agent_id);
  if (!agent) return;
  // 项目处于"计划待批"状态时不开工，等用户批准
  if (task.project_id && getProject(task.project_id)?.status === "planned") return;
  if (budgetExhausted()) {
    if (task.channel_id) audit(task.channel_id, `🧯 今日 token 预算已用尽（AITEAM_DAILY_TOKEN_BUDGET），任务「${task.title}」暂停自动开工`);
    return;
  }
  if (runningTasks.size >= MAX_CONCURRENT_WORK) {
    if (task.channel_id) audit(task.channel_id, `⏸️ 并发已满，任务「${task.title}」暂未自动开工`);
    return;
  }
  // 捕获当前 owner：队列里的 .then 会在另一个请求/运行解析 prev 时才执行，
  // 届时 AsyncLocalStorage 上下文已丢失，必须用 withOwner 重建，否则 db 查询会 fail-closed 抛错。
  const ownerId = currentOwner();
  runningTasks.add(task.id);
  queuedCount.set(agent.id, (queuedCount.get(agent.id) ?? 0) + 1);
  const prev = agentQueues.get(agent.id) ?? Promise.resolve();
  const next = prev
    .then(() => withOwner(ownerId, () => {
      queuedCount.set(agent.id, Math.max(0, (queuedCount.get(agent.id) ?? 1) - 1));
      currentWork.set(agent.id, task.id);
      return runTaskWork(agent, task.id);
    }))
    .catch((err) => withOwner(ownerId, () => {
      console.error(`[engine] task work failed:`, err);
      // 失败的任务不能卡在 doing：退回待办，重新指派负责人即可重试
      const t = getTask(task.id);
      if (t && t.status === "doing") setTaskStatus(task.id, "todo");
      if (t?.channel_id)
        audit(t.channel_id, `⚠️ ${agent.name} 处理任务「${task.title}」失败：${err?.message ?? err}。任务已退回待办，重新指派负责人即可重试。`);
    }))
    .finally(() => {
      runningTasks.delete(task.id);
      if (currentWork.get(agent.id) === task.id) currentWork.delete(agent.id);
    });
  agentQueues.set(agent.id, next);
}

/** 团队视图：每位 AI 同事的实时工作状态与今日产出。 */
export function teamStatus() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const stats = agentDailyStats(startOfDay.getTime());
  return listAgents().map((a) => {
    const taskId = currentWork.get(a.id);
    const task = taskId ? getTask(taskId) : undefined;
    const s = stats.get(a.id);
    return {
      agent_id: a.id,
      state: task ? "working" : "idle",
      current_task: task ? { id: task.id, title: task.title } : null,
      queued: queuedCount.get(a.id) ?? 0,
      delivered_today: s?.delivered ?? 0,
      tokens_today: { input: s?.input ?? 0, output: s?.output ?? 0 },
    };
  });
}

/** Durability（借鉴 Microsoft Agent Framework）：服务重启时，恢复上次运行中被打断的任务。 */
export function recoverInFlightTasks() {
  // 跨 owner 清扫，再用各自 owner 重建上下文恢复
  for (const task of listInFlightTasksAllOwners()) {
    withOwner(task.owner_id, () => {
      if (task.channel_id) audit(task.channel_id, `🔁 服务重启，恢复执行任务「${task.title}」`);
      onTaskAssigned(task);
    });
  }
}

/** 任务交付（review/done）后调用：解锁依赖它的任务，并检查项目是否可汇总。 */
export function onTaskDelivered(task: Task) {
  for (const t of listTasks()) {
    if (t.status !== "todo" || !t.assignee_agent_id) continue;
    if (!taskDependsOn(t).includes(task.id)) continue;
    if (depsSatisfied(t)) {
      if (t.channel_id) audit(t.channel_id, `⛓️ 任务「${t.title}」的依赖已交付，自动开工`);
      onTaskAssigned(t);
    }
  }
  if (task.project_id) checkProject(task.project_id);
}

function setTaskStatus(taskId: string, statusValue: Task["status"]): Task | undefined {
  const t = updateTask(taskId, { status: statusValue });
  if (t) broadcast({ type: "task:upsert", payload: t });
  return t;
}

async function runTaskWork(agent: Agent, taskId: string) {
  let task = getTask(taskId);
  if (!task || task.status === "done" || task.status === "review") return;
  if (cancelledTasks.delete(taskId)) {
    if (task.channel_id) audit(task.channel_id, `⏹ 任务「${task.title}」已被用户停止（未开工）`);
    return;
  }

  // 任务必须有可见的工作频道。channel_id 丢失 / 指向已删频道时，按优先级兜底——
  // 绝不盲目落到"首个频道(#general)"，否则项目任务会把过程消息窜到无关频道（实测的"窜台"）。
  let channel = task.channel_id ? getChannel(task.channel_id) : undefined;
  if (!channel) {
    const proj = task.project_id ? getProject(task.project_id) : undefined;
    channel =
      (proj?.channel_id ? getChannel(proj.channel_id) : undefined) ?? // 1) 项目立项所在频道（最贴合）
      listChannels().find((c) => c.kind === "channel" && channelAgents(c).some((a) => a.id === agent.id)) ?? // 2) 负责人所在频道
      listChannels().find((c) => c.kind === "channel"); // 3) 最后兜底
    if (!channel) return;
    task = updateTask(task.id, { channel_id: channel.id }) ?? task;
    broadcast({ type: "task:upsert", payload: task });
  }

  audit(channel.id, `🚀 ${agent.name} 开始处理任务「${task.title}」${task.model_tier === "light" ? "（⚡ 轻量通道）" : ""}`);
  setTaskStatus(task.id, "doing");

  let feedback: string | null = null; // 上一轮验收意见（返工时注入）
  let lastDocIds: string[] = [];

  for (let attempt = 0; attempt <= MAX_REVISIONS; attempt++) {
    const ctx = newCtx(agent, channel, "work", task.id);
    const prompt = feedback ? buildReworkBrief(task, channel, feedback) : buildWorkBrief(task, channel);
    await streamRun(ctx, prompt, MAX_WORK_ITERATIONS, 0, { tier: task.model_tier === "light" ? "light" : "standard" });
    lastDocIds = ctx.createdDocIds.length > 0 ? ctx.createdDocIds : lastDocIds;

    if (cancelledTasks.delete(task.id)) {
      setTaskStatus(task.id, "todo");
      audit(channel.id, `⏹ 任务「${task.title}」已被用户停止，退回待办`);
      return;
    }

    const verdict = await runVerification(agent, channel, task.id, lastDocIds);
    if (verdict.result === "pass") {
      if (verdict.reasons) audit(channel.id, `✅ 验收通过：任务「${task.title}」`);
      break;
    }
    feedback = verdict.reasons || "验收未通过，请对照验收标准修订。";
    const fresh = getTask(task.id);
    const revisions = (fresh?.revision_count ?? 0) + 1;
    updateTask(task.id, { revision_count: revisions });
    if (attempt >= MAX_REVISIONS) {
      audit(channel.id, `⚠️ 任务「${task.title}」已达返工上限（${MAX_REVISIONS} 次），转入待评审请人工把关`);
      break;
    }
    audit(channel.id, `↩️ 验收未通过，任务「${task.title}」退回 ${agent.name} 修订（第 ${revisions} 次）`);
  }

  // 交付点（验收已结束）：正常情况任务仍为 doing。但 DeepSeek 等 agent 可能无视系统约束、
  // 自调 update_task 把本任务状态改成 review；若此时只认 "doing"，系统就不会补发交付/解锁依赖，
  // 整个项目会卡死在「最后一个前置任务已 review 但下游纹丝不动」。故 doing/review 都要走交付解锁。
  const after = getTask(task.id);
  if (after && (after.status === "doing" || after.status === "review")) {
    const review = after.status === "review" ? after : setTaskStatus(task.id, "review");
    if (review) {
      audit(channel.id, `📦 ${agent.name} 已交付任务「${review.title}」，转入待评审`);
      onTaskDelivered(review);
    }
  }
}

export function buildWorkBrief(task: Task, channel: Channel): string {
  const depDocs = taskDependsOn(task)
    .map((id) => getTask(id))
    .filter((t): t is Task => Boolean(t))
    .flatMap((t) => listDocuments().filter((d) => d.task_id === t.id).map((d) => ({ dep: t, doc: d })));
  const depSection =
    depDocs.length > 0
      ? `\n## 前置任务的交付物（你的工作以此为输入）\n` +
        depDocs.map(({ dep, doc }) => `### 来自「${dep.title}」：《${doc.title}》\n${doc.content.slice(0, 4000)}`).join("\n\n")
      : "";
  // 定向润色 grounding：本任务若挂了 source_doc_ids，则是对这些来源文档做"有目标、限定范围的受限改写"，
  // 把来源全文注入简报（配额 8000 字 > dep 的 4000），让产出有真实输入锚，而非从零生成泛泛而谈。
  let srcIds: string[] = [];
  try { const p = JSON.parse(task.source_doc_ids || "[]"); if (Array.isArray(p)) srcIds = p.map(String); } catch { /* ignore */ }
  const sourceDocs = srcIds.map((id) => getDocument(id)).filter((d): d is NonNullable<ReturnType<typeof getDocument>> => Boolean(d));
  const polishMode = sourceDocs.length > 0;
  const sourceSection = polishMode
    ? `\n## 来源文档（本任务是对以下内容做【有目标、限定范围的润色/改写】，grounding 在此——不得发明、不得越界）\n` +
      sourceDocs.map((d) => `### 来源《${d.title}》（id: ${d.id}）\n${d.content.slice(0, 8000)}`).join("\n\n")
    : "";
  const transcript = buildTranscript(channel.id, 20);
  // 目标链（借鉴 Paperclip）：让任务知道自己服务于什么目标
  const project = task.project_id ? getProject(task.project_id) : undefined;
  return [
    `你被指派了一个任务，请现在完成它。`,
    ``,
    project ? `所属项目：「${project.title}」—— 项目目标：${project.goal || "（见任务详情）"}\n你的任务是该目标的一环，交付物要服务于整体目标。` : "",
    `任务：${task.title}`,
    `详情：${task.description || "（无）"}`,
    task.acceptance_criteria ? `验收标准（交付物将被逐条核验）：\n${task.acceptance_criteria}` : "",
    `所在频道：#${channel.name}`,
    depSection,
    sourceSection,
    polishMode
      ? `⚠️ 本任务是【定向润色 / 受限改写】：产出是对上面"来源文档"的修订，不是另写一篇。① 通读来源，严格按"详情/验收标准"限定的目标与范围改，范围外原样保留；② 新增事实/数据须来自来源或显式调研并标来源，禁凭空补全；③ 交付物开头给「改动清单」：逐条 [改了哪段]→[怎么改]→[依据来源何处]，并列「刻意未改动」部分。如已启用「定向润色/受限改写法」技能，按其方法执行。`
      : "",
    ``,
    `<transcript>（频道最近讨论，供你了解背景）`,
    transcript,
    `</transcript>`,
    ``,
    `工作要求：`,
    `1. 开工前先查阅你的长期记忆（见系统上下文，"核实过的事实/通用规则"优先遵循），并扫一遍工作区文档库（见上下文文档列表），有相关材料先用 read_document 复用，不要从零臆造；`,
    `2. 如需要事实、数据或最新外部信息，先用 web_search / web_fetch 或可用插件调研，不要凭空编造；外部检索按次计费——先想清楚要查什么、合并关键词，单任务尽量不超过 3 次；能从已有文档（read_document）获得的不要重复检索。研究/写作类任务按"多视角列问题 → 搭大纲 → 成文"推进，重要事实注明来源；找不到可靠来源的关键数字，宁可写"示意值，待核实"或不写，绝不编造看似精确的数字（市场规模/占比/ROI 等）；仅国内模型部署下服务端 web_search 可能不可用且其结果不被多轮保留——若已配检索类插件（如 web-search-prime / 博查），优先用插件检索（结果可留存、可引用）；`,
    `3. 用 write_document 产出完整、可直接使用的交付物，按任务性质选格式 kind：报告/方案用 report，需要演示就交 slides（Marp 分页），数据/报表交 sheet（CSV），网页/落地页/前端原型/HTML 演示(横向翻页 deck)/可交互可视化交 html（单文件、样式与脚本内联、禁外链 script 与内联事件处理器，可在预览区实时查看）——必要时可以多份组合（如 report + slides）；正文要详尽，逐条覆盖验收标准；${imageGenAvailable() ? "需要视觉表达（封面/概念示意/PPT 配图/图文混排）时可用 generate_image 生成 1-2 张点睛配图，把返回的 Markdown 图片行原样放进 report 或 html 正文（数据图表交 sheet 即可，不要用文生图画图表）；" : ""}`,
    `4. 交付前用 save_memory 记录至多 1 条本次任务沉淀的「核实过的事实」或「通用规则」（不要记流水账）；`,
    `5. 交付物正文一律结论先行（开头给核心结论 / TL;DR）、要点 MECE，关键事实与数据注明来源和检索日期；并在回复正文附「交付自查表」：逐条列出验收标准 → 满足 / 不满足 → 证据位置（章节或文档内定位），最后一句说明需要谁跟进什么；`,
    `6. 任务状态由系统管理，不要调用 update_task 改本任务状态；关单（done）只能由人类完成；`,
    `7. 如发现衍生工作，可用 create_task 开新任务并指派给合适的同事。`,
  ]
    .filter(Boolean)
    .map((line) => stripLoneSurrogates(line as string))
    .join("\n");
}

function buildReworkBrief(task: Task, channel: Channel, feedback: string): string {
  const myDocs = listDocuments().filter((d) => d.task_id === task.id);
  const last = myDocs[0];
  return [
    `你对任务「${task.title}」的交付未通过验收，请修订后重新交付。`,
    ``,
    task.acceptance_criteria ? `验收标准：\n${task.acceptance_criteria}` : "",
    `校验者意见：\n${feedback}`,
    last ? `\n你上一版交付物《${last.title}》（id: ${last.id}，可用 read_document 重读全文）` : "",
    ``,
    `要求：针对意见逐条修复，用 write_document 重新提交完整的新版本（不是补丁），并在回复中说明改了什么。`,
  ]
    .filter(Boolean)
    .map((line) => stripLoneSurrogates(line as string))
    .join("\n");
}

// ---------------------------------------------------------------------------
// 验收循环：干净上下文的校验者按 rubric 逐条核验（verifier ≠ self-critique）
// ---------------------------------------------------------------------------

/** 校验者未产出结构化裁决时的兜底裁决：fail-closed，绝不默认通过（见 docs/harness-analysis.html · QW1）。 */
export const NO_VERDICT_FALLBACK: { result: "revise"; reasons: string } = {
  result: "revise",
  reasons: "校验者未产出结构化裁决，按未通过处理。请补全交付内容与逐条自查表后重新提交。",
};

/** 按交付物类型选对口校验者（V3·按 kind 路由）：
 *  视觉物(slides/html)→设计审核优先；内容物(report/sheet)→校对审核优先；代码类→代码评审。
 *  ——避免把 PPT/方案的验收默认丢给"代码评审"（不对口）。都不在则回退 创建者 / 任意他人 / 本人(solo 自检)。
 *  纯函数，导出供回归测试。 */
export function pickVerifier(
  others: Agent[],
  kind: string | null | undefined,
  createdBy: string | null,
  worker: Agent
): Agent {
  const sig = (a: Agent) => `${a.name} ${a.role}`;
  const design = (a: Agent) => /设计审核|视觉|design/i.test(sig(a));
  const content = (a: Agent) => /校对|审核|质检|复核|事实|proofread|qa/i.test(sig(a)) && !/代码评审|code/i.test(a.name);
  const code = (a: Agent) => /代码评审|code.?review/i.test(sig(a));
  const visual = kind === "slides" || kind === "html";
  const order = visual ? [design, content, code] : [content, design, code];
  for (const pred of order) { const v = others.find(pred); if (v) return v; }
  return others.find((a) => a.id === createdBy) ?? others[0] ?? worker;
}

async function runVerification(
  worker: Agent,
  channel: Channel,
  taskId: string,
  docIds: string[]
): Promise<{ result: "pass" | "revise"; reasons: string }> {
  const task = getTask(taskId);
  if (!task) return { result: "pass", reasons: "" };
  if (isMock()) return { result: "pass", reasons: "" }; // 全局 Mock 跳过验收

  const others = channelAgents(channel).filter((a) => a.id !== worker.id);
  // SOLO/DM（无其他同事）不再无条件放行（V1）：由本人在净上下文里做 fail-closed 自校验。
  const soloSelfCheck = others.length === 0;

  // 先锚定该任务的「当前版」交付物（listDocuments 已只返当前版），再按其 kind 选对口校验者。
  // 优先 report，否则取最新当前版；兜底用本轮 createdDocIds 末位。
  const taskDocs = listDocuments().filter((d) => d.task_id === taskId);
  const doc =
    taskDocs.find((d) => d.kind === "report") ??
    taskDocs[0] ??
    (docIds.length > 0 ? getDocument(docIds[docIds.length - 1]) : undefined);
  if (!doc) return { result: "revise", reasons: "没有找到交付物文档：必须用 write_document 提交正式交付物。" };

  // V3：按交付物类型选对口校验者（视觉物→设计审核 / 内容物→校对审核 / 代码类→代码评审），团队永不自评。
  const verifier = pickVerifier(others, doc.kind, task.created_by, worker);

  audit(channel.id, `🔎 ${verifier.name} 开始${soloSelfCheck ? "自检" : "验收"}任务「${task.title}」的交付物`);

  // V2：slides 交付物附"渲染清单"（机器读出的页数/要素），让验收对照"声称 vs 实产"、抓静默丢页与表演性自查。
  const renderInfo =
    doc.kind === "slides"
      ? (() => {
          const m = slidesManifest(doc.content);
          return `渲染清单（机器读出，用于核对"声称 vs 实产"）：源页 ${m.sourcePages}、实渲幻灯片 ${m.renderedSlides}（含续页 ${m.continuationSlides}）、数字卡 ${m.statCards}、表格 ${m.tables}、配图 ${m.images}、带讲者备注页 ${m.pagesWithNotes}/${m.sourcePages}。`;
        })()
      : "";

  // 关键：干净上下文 —— 只给 rubric + 交付物，不带频道闲聊，避免被讨论氛围带偏
  const prompt = [
    `你是本次交付的校验者。请独立、严格地核验以下交付物是否满足任务要求。`,
    soloSelfCheck ? `（本次无其他同事可担任校验者，由你对自己的交付做自检：请切换到挑剔的第三方视角，宁严勿松——这是交付前的唯一质量闸。）` : ``,
    ``,
    `任务：${task.title}`,
    `详情：${task.description || "（无）"}`,
    task.acceptance_criteria
      ? `验收标准（逐条核验）：\n${task.acceptance_criteria}`
      : `（未写明验收标准 —— 按任务标题与详情判断交付物是否完整、可直接使用、无明显错误）`,
    ``,
    `交付物《${doc.title}》全文：`,
    `<deliverable>`,
    stripLoneSurrogates(doc.content.slice(0, 16000)),
    `</deliverable>`,
    renderInfo,
    ``,
    `核验时另须执行（不可放水）：`,
    `· 量化主张须有来源：正文中市场规模 / 占比 / 金额 / ROI 等关键数字，若无来源标注且未标"示意值/待核实"，判 revise 并逐条点名（C3）；`,
    doc.kind === "slides"
      ? `· 对照上面的渲染清单：若交付或自查表声称的页数 / 要素（页数、表格、数字卡、讲者备注覆盖）与渲染清单明显不符，判 revise；slides→pptx 不支持自定义字号 / CSS 变量，自查表不得声称这类渲染器产不出的属性（V2）。`
      : ``,
    ``,
    `请逐条给出核验结论（满足/不满足及理由），随后必须调用 submit_verdict 提交最终裁决：`,
    `- 全部关键标准满足 → result: "pass"`,
    `- 存在不满足的关键标准 → result: "revise"，并在 reasons 中给出可执行的修订意见`,
  ]
    .filter(Boolean)
    .join("\n");

  const verifierTools: Anthropic.ToolUnion[] = [
    {
      name: "submit_verdict",
      description: "提交验收裁决。核验完成后必须调用本工具，且只调用一次。",
      input_schema: {
        type: "object" as const,
        properties: {
          result: { type: "string", enum: ["pass", "revise"], description: "pass=验收通过；revise=退回修订" },
          reasons: { type: "string", description: "裁决理由；revise 时给出逐条可执行的修订意见" },
        },
        required: ["result", "reasons"],
      },
    },
    TOOLS.find((t) => "name" in t && t.name === "read_document")!,
  ];

  const ctx = newCtx(verifier, channel, "verify", task.id);
  // 验收是质量闭环的下限：官方通道可用时强制走最强模型
  await streamRun(ctx, prompt, 3, 0, { toolsOverride: verifierTools, preferStrong: true });
  if (!ctx.verdict) {
    // 不结构化裁决不能默认通过——强约束重试一轮，明确要求只能用 submit_verdict 收尾
    const retryPrompt = [
      `你上一轮没有提交结构化裁决。现在必须且只能通过调用 submit_verdict 工具给出最终裁决，禁止用纯文本结尾。`,
      `任务：${task.title}`,
      task.acceptance_criteria
        ? `验收标准（逐条核验）：\n${task.acceptance_criteria}`
        : `（无明确验收标准，按完整性 / 可直接使用 / 无明显错误判断）`,
      `交付物《${doc.title}》全文：`,
      `<deliverable>`,
      stripLoneSurrogates(doc.content.slice(0, 16000)),
      `</deliverable>`,
      `逐条核验后立即调用 submit_verdict（result: pass 或 revise，reasons 给理由 / 修订意见）。`,
    ].join("\n");
    await streamRun(ctx, retryPrompt, 3, 0, { toolsOverride: verifierTools, preferStrong: true });
  }
  if (!ctx.verdict) {
    // 两轮仍无结构化裁决：fail-closed，退回返工兜住，绝不放水（质量下限关键修复）
    audit(channel.id, `⚠️ ${verifier.name} 两轮均未提交结构化裁决，按未通过处理并退回修订`);
    return NO_VERDICT_FALLBACK;
  }
  return ctx.verdict;
}

// ---------------------------------------------------------------------------
// 项目模式：Lead 拆解（start_project）→ [计划把关] → DAG 调度 → 全部交付 → 自动汇总
// ---------------------------------------------------------------------------

/** plan 类审批落定后调用：批准 → 启动项目；拒绝 → 唤起 Lead 调整。 */
export function onPlanResolved(projectId: string, approved: boolean) {
  const project = getProject(projectId);
  if (!project || project.status !== "planned") return;
  const channel = project.channel_id ? getChannel(project.channel_id) : undefined;
  if (approved) {
    const updated = updateProject(projectId, { status: "running" });
    if (updated) broadcast({ type: "project:upsert", payload: updated });
    if (channel) audit(channel.id, `▶️ 项目「${project.title}」计划已获批准，开工`);
    for (const t of listTasks().filter((x) => x.project_id === projectId)) onTaskAssigned(t);
  } else if (channel) {
    audit(channel.id, `✋ 项目「${project.title}」计划被退回——请结合用户在频道里的意见调整计划后重新立项`);
    if (project.lead_agent_id) triggerAgent(project.lead_agent_id, channel.id);
  }
}

function checkProject(projectId: string) {
  const project = getProject(projectId);
  if (!project || project.status !== "running") return;
  const tasks = listTasks().filter((t) => t.project_id === projectId);
  if (tasks.length === 0) return;
  if (!tasks.every((t) => t.status === "review" || t.status === "done")) return;

  const updated = updateProject(projectId, { status: "review" });
  if (updated) broadcast({ type: "project:upsert", payload: updated });

  const lead = project.lead_agent_id ? getAgent(project.lead_agent_id) : undefined;
  const channel = project.channel_id ? getChannel(project.channel_id) : undefined;
  if (!lead || !channel) return;

  audit(channel.id, `🎯 项目「${project.title}」全部任务已交付，${lead.name} 开始汇总`);
  void runSynthesis(lead, channel, project.id).catch((err) => reportFailure(lead, channel, err));
}

async function runSynthesis(lead: Agent, channel: Channel, projectId: string) {
  const project = getProject(projectId);
  if (!project) return;
  const tasks = listTasks().filter((t) => t.project_id === projectId);
  const docs = listDocuments().filter((d) => d.task_id && tasks.some((t) => t.id === d.task_id));
  const taskList = tasks
    .map((t) => {
      const assignee = t.assignee_agent_id ? getAgent(t.assignee_agent_id)?.name ?? "?" : "未分配";
      const tDocs = docs.filter((d) => d.task_id === t.id).map((d) => `《${d.title}》(id: ${d.id})`);
      return `- ${t.title}（负责人 ${assignee}）交付物：${tDocs.join("、") || "无"}`;
    })
    .join("\n");

  const ctx = newCtx(lead, channel, "synthesis", null);
  const prompt = [
    `你发起的项目「${project.title}」全部任务已交付，请进行最终汇总。`,
    ``,
    `项目目标：${project.goal || "（见各任务）"}`,
    `任务与交付物清单：\n${taskList}`,
    ``,
    `要求：`,
    `1. 用 read_document 通读所有交付物全文；`,
    `2. 用 write_document 产出一份《${project.title} · 最终汇总报告》：综合各交付物的结论，`,
    `   消解相互矛盾之处，给出整体结论与建议的下一步行动清单；`,
    `3. 在回复正文给出给用户看的简短项目交付摘要。`,
  ].join("\n");

  // 汇总同样走最强通道
  await streamRun(ctx, prompt, MAX_WORK_ITERATIONS, 0, { preferStrong: true });

  const summaryDocId = ctx.createdDocIds[ctx.createdDocIds.length - 1] ?? null;
  const updated = updateProject(projectId, { summary_doc_id: summaryDocId });
  if (updated) broadcast({ type: "project:upsert", payload: updated });
  audit(channel.id, `🏁 项目「${project.title}」已汇总交付，等待用户确认关闭`);
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

function clip(text: string, max: number): string {
  return text.length > max
    ? `${stripLoneSurrogates(text.slice(0, max))}…[已截断，全文 ${text.length} 字，对应交付物请用 read_document 查阅]`
    : text;
}

function buildTranscript(channelId: string, window = TRANSCRIPT_WINDOW): string {
  const msgs = listMessages(channelId, window).filter((m) => m.status !== "streaming");
  return msgs
    .map((m, i) => {
      let quote = "";
      if (m.reply_to) {
        const target = getMessage(m.reply_to);
        if (target) quote = `[回复 ${authorLabel(target)} 的消息「${target.content.slice(0, 40)}…」] `;
      }
      // 降本核心：旧消息截断到 500 字（完整产出都在文档库），最新 2 条保留语境
      const body = clip(m.content, i >= msgs.length - 2 ? 4000 : 500);
      return `[${fmtTime(m.created_at)}] ${authorLabel(m)}: ${quote}${body}`;
    })
    .join("\n\n");
}

/** 内置技能的触发关键词：出现在任务简报/用户消息中才注入该专项方法。
 *  无映射的技能（通用「交付自查清单」+ 用户自定义技能）默认始终注入，不回归。 */
const SKILL_KEYWORDS: Record<string, string[]> = {
  深度调研法: ["调研", "检索", "搜索", "搜一下", "资料", "来源", "事实", "核实", "竞品", "市场", "行业", "最新", "对比", "数据"],
  金字塔写作法: ["写", "撰写", "报告", "文案", "方案", "prd", "文章", "稿", "总结", "演示", "slides", "ppt", "汇报", "白皮书", "长文"],
  结构化头脑风暴: ["创意", "头脑风暴", "脑暴", "构思", "设计", "选型", "策划", "点子", "发散", "方案"],
};
/** 该技能是否与当前工作焦点相关（用于索引排序：命中靠前）。
 *  trigger 优先（扩库后内置/自定义统一走这条）；trigger 为空回退硬编码 SKILL_KEYWORDS[name]（迁移期兜底）。 */
export function skillRelevant(
  skill: { name?: string; trigger?: string; when_to_use?: string },
  focus: string
): boolean {
  const f = focus.toLowerCase();
  const kws = (skill.trigger || "").split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
  if (kws.length > 0) return kws.some((k) => f.includes(k.toLowerCase()));
  const fallback = skill.name ? SKILL_KEYWORDS[skill.name] : undefined;
  if (fallback) return fallback.some((k) => f.includes(k.toLowerCase()));
  return true; // 既无 trigger 又无映射 → 通用技能，视为相关（参与注入，排序中性）
}

/** capability 技能依赖是否就绪：resources_json 引用的 MCP 工具前缀可达、或原生工具可用。 */
export function capabilityReady(sk: { resources_json?: string }): boolean {
  let res: string[] = [];
  try {
    const parsed = JSON.parse(sk.resources_json || "[]");
    if (Array.isArray(parsed)) res = parsed.map(String);
  } catch { /* 容错：坏 JSON 视为无依赖 */ }
  if (res.length === 0) return true;
  return res.every((r) => {
    if (r.startsWith("mcp__")) return mcpToolPrefixReady(r);
    if (r === "generate_image") return imageGenAvailable();
    return true; // 其余内置原生工具默认可用
  });
}

/**
 * 技能索引（L1）构建：渐进式披露——只把 名/何时用/触发词 + read_skill 提示常驻进上下文，
 * 正文 body 由同事按需用 read_skill 拉取，解除 v1「技能数 × 长度 ≤ 预算」死锁。
 * 相关性只用于排序（命中靠前），不再丢弃技能；超长单项 continue 跳过而非 break 终止。导出供回归测试。
 */
export function buildSkillIndex(focus: string, skills?: Skill[]): string {
  const enabled = skills ?? listSkills().filter((sk) => sk.enabled);
  const ranked = [...enabled].sort((a, b) => Number(skillRelevant(b, focus)) - Number(skillRelevant(a, focus)));
  let idxBudget = Number(process.env.AITEAM_SKILL_INDEX_BUDGET ?? 6000);
  let block = "";
  for (const sk of ranked) {
    const ready = sk.kind === "capability" ? capabilityReady(sk) : true;
    const item =
      `### 技能：${sk.name}（id: ${sk.id}）\n` +
      `何时用：${sk.when_to_use || sk.desc}\n` +
      (sk.trigger ? `触发词：${sk.trigger}\n` : "") +
      (sk.kind === "capability" ? `类型：能力型${ready ? "" : "（⚠️依赖未就绪，暂不可用）"}\n` : "") +
      `→ 需要其具体方法/步骤时调用 read_skill("${sk.id}") 取正文`;
    if (item.length > idxBudget) continue;
    idxBudget -= item.length;
    block += (block ? "\n\n" : "") + item;
  }
  return block;
}

/** read_skill 的正文解析（L2）：启用技能返回 body（旧库回退 content/desc），否则空串。导出供回归测试。 */
export function readSkillBody(id: string): string {
  const sk = getSkill(id);
  if (!sk || !sk.enabled) return "";
  let out = sk.body || sk.content || sk.desc;
  // L3：resources_json 里的 `tpl:<id>` 引用 → 把内置模板正文附带返回（按需，不进常驻索引）
  let refs: string[] = [];
  try {
    const parsed = JSON.parse(sk.resources_json || "[]");
    if (Array.isArray(parsed)) refs = parsed.map(String);
  } catch { /* 坏 JSON 忽略 */ }
  for (const r of refs) {
    if (!r.startsWith("tpl:")) continue;
    const tpl = getSkillTemplate(r.slice(4));
    if (tpl) {
      // 围栏长度取「比模板内任意连续反引号都多 1」，防模板正文含 ``` 时把代码块提前闭合
      const longest = (tpl.content.match(/`+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
      const fence = "`".repeat(Math.max(3, longest + 1));
      out += `\n\n## 可复用模板：${tpl.name}\n${tpl.desc}\n${fence}${tpl.lang}\n${tpl.content}\n${fence}`;
    }
  }
  return out;
}

// 交付与导出红线：注入每一轮动态上下文（覆盖所有现存/新建同事、聊天与任务两条路径），
// 因为 agent.system_prompt 是建号时烘焙进 DB 的、改 SHARED_RULES 不影响存量同事。
// 根除截图里"导出不可用 / 甩 CLI 给用户"那类臆造阻塞。
const DELIVERY_RULES = `## 交付与导出（平台已内置，按此回答用户，不要臆造限制）
- 交付物用 write_document 写入文档库后，用户在「文档」面板打开即可查看；其中 **slides 文档在查看页有一键「⬇ .pptx」按钮，导出的是可编辑的真 .pptx（PowerPoint/WPS/Keynote 直接打开，文本/表格/讲者备注均可编辑），完全内置、无需任何 MCP / 插件 / 命令行**。report/sheet 可导出 Markdown / CSV / Word，html 在预览区沙箱渲染。
- 绝不要声称"导出不可用 / 依赖未就绪 / 需要 pptxgenjs 等服务"，也绝不要让用户自己去跑命令行（如 marp-cli）来导出——这些说法都是错的。
- 用户问"在哪看 / 怎么导出"时，直接指引他到「文档」面板打开该文档、点标题栏的导出按钮（slides 点 ⬇ .pptx），不要把整篇正文倒进聊天。`;

// 输入/上传途径红线（与交付红线同理）：纠正 agent 别承诺平台做不到的输入方式，尤其"贴图看图"。
const INPUT_RULES = `## 用户给资料的途径（按此引导，别承诺做不到的）
- 文件资料（PDF/Word/PPT/Excel/txt/md/csv 等）：用户可在**聊天输入框的 📎** 或「文档 → 📎 上传来源」上传；系统会**抽取其文本**存为「来源」文档，你用 read_document 读全文（解析非纯文本需管理员已启用 markitdown 插件）。
- **截图 / 图片无法被读取**：系统只抽文本、不解析图像，模型也收不到图像像素——遇到界面/截图，请让用户**用文字描述**画面布局、字段、流程；不要让用户贴图、也不要声称你能看图。`;

// 多人协作红线（团队频道）：目标级请求优先 start_project 拆解给多角色协作，而非一人包办——这是产品核心，别退化成单人。
const COLLAB_RULES = `## 多人协作（团队频道的"目标级"请求，优先立项而非一人包办）
- 当用户提出"完整解决方案 / 整套方案 / 对外演示 / 系统性多环节产出"这类**目标**（不是单点问答/小改）时，作为 Lead **优先用 start_project** 拆成带依赖的任务、分派给对口同事协作，不要自己从头做到尾。典型拆法：调研员查市场/竞品(带源) → 工程师做技术选型与架构 → 产品经理/解决方案助手整合方案(report) → PPT 助手做演示 slides → 校对审核/代码评审验收 → 你(Lead)汇总。
- 判据：目标需要 ≥2 种专长、或含"调研+撰写+演示+把关"多环节 → **立项**；闲聊/答疑/小改 → 直接回复，别滥用立项。
- 价值：每个环节由对口专家产出、并经独立验收，质量高于一人包办（也才会触发验收闭环）。`;

function buildDynamicContext(agent: Agent, channel: Channel, focus = ""): string {
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
  const skillsBlock = buildSkillIndex(focus);
  const nowStr = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }); // 分钟级粒度：秒级时间戳会破坏供应商的自动前缀缓存
  return [
    `## 当前工作区上下文`,
    `当前时间：${nowStr}（Asia/Shanghai）—— 涉及时间判断时以此为准`,
    `频道：#${channel.name}（${channel.kind === "dm" ? "与用户的私信" : "团队频道"}）`,
    teammates ? `频道内其他 AI 同事：\n${teammates}` : `频道内没有其他 AI 同事。`,
    tasks ? `频道任务看板：\n${tasks}` : `任务看板目前为空。`,
    docs ? `工作区文档（可用 read_document 阅读全文）：\n${docs}` : "",
    DELIVERY_RULES,
    INPUT_RULES,
    channel.kind !== "dm" ? COLLAB_RULES : "",
    memory ? `## 你的长期记忆（先查阅，"核实过的事实/通用规则"优先遵循）\n${memory}` : "",
    skillsBlock ? `## 已启用的技能（索引——需要某条的具体方法/步骤时用 read_skill(id) 取正文再遵循）\n${skillsBlock}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// 工具面
// ---------------------------------------------------------------------------

const TOOLS: Anthropic.ToolUnion[] = [
  {
    name: "start_project",
    description:
      "立项：把一个目标一次性拆解为带依赖关系的任务计划。任务会按依赖图自动调度（无依赖的立即开工，依赖项交付后自动解锁），全部交付后由你自动汇总最终报告。适用于需要多位同事分工协作的目标；单个待办用 create_task 即可。拆解纪律：每个交付物恰好一位负责人；子任务范围互斥不重叠；能复用前置交付物就建依赖（depends_on），绝不让多人重复调研同一主题。autonomy 档位：auto=全自主闭环直接开工；approve_plan=计划先送用户批准再开工（重大/高成本项目、或用户要求把关时使用）。",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "项目名" },
        goal: { type: "string", description: "项目目标与整体验收口径" },
        autonomy: { type: "string", enum: ["auto", "approve_plan"], description: "自主度，默认 auto" },
        tasks: {
          type: "array",
          description: "任务计划（按依赖顺序排列）",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string", description: "充分的背景与要求，负责人将据此独立完成" },
              acceptance_criteria: { type: "string", description: "逐条可核验的验收标准（验收循环将逐条把关）" },
              assignee: { type: "string", description: "负责人名字（AI 同事名）" },
              depends_on: {
                type: "array",
                items: { type: "integer" },
                description: "依赖的任务在本数组中的下标（0 起），只能引用排在前面的任务",
              },
              model_tier: {
                type: "string",
                enum: ["standard", "light"],
                description:
                  "为该任务明智地选择模型档位以降本：分析/创作/调研/需要判断 → standard（全力模型）；重复性/格式整理/数据搬运/单一明确的执行 → light（轻量模型）。默认 standard。",
              },
            },
            required: ["title", "assignee"],
          },
        },
      },
      required: ["title", "tasks"],
    },
  },
  {
    name: "create_task",
    description:
      "在团队任务看板上创建单个任务。指派给 AI 同事后对方会自动开工；写清验收标准，交付物将被逐条核验。若是基于某份已有文档做润色/改写/补全（而非从零生成），用 source_doc_ids 指明来源文档——系统会把来源全文注入负责人的工作简报，并要求其受限改写、附改动清单，避免泛泛而谈。",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "任务标题，简洁的动宾短语" },
        description: { type: "string", description: "任务详情，包含足够的背景（负责人将据此独立完成）" },
        acceptance_criteria: { type: "string", description: "逐条可核验的验收标准；定向润色任务应写明范围（如：仅润色第 3 节、保留原结论、不新增原文未出现的数据）" },
        assignee: { type: "string", description: "负责人的名字（AI 同事名，或留空表示未分配）" },
        source_doc_ids: {
          type: "array",
          items: { type: "string" },
          description: "来源文档 id 数组（上下文文档列表里的 id）。填了即为『定向润色/受限改写』任务：负责人 grounding 在这些文档、限定范围改、不发明、附改动清单。",
        },
        model_tier: {
          type: "string",
          enum: ["standard", "light"],
          description: "模型档位：重复性/格式化/单一明确的执行任务用 light 降本；分析/创作/调研用 standard（默认）",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "update_task",
    description:
      "更新看板上的任务：推进状态、改负责人、改标题/描述/验收标准。task_id 来自上下文中的任务列表。注意：done（关单）只能由人类操作。",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "任务 id" },
        status: { type: "string", enum: ["todo", "doing", "review"] },
        title: { type: "string" },
        description: { type: "string" },
        acceptance_criteria: { type: "string" },
        assignee: { type: "string", description: "负责人名字" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "write_document",
    description:
      "把一份正式交付物写入工作区文档库。文档应当完整、可直接使用，而不是片段。按交付物性质选择 kind：report=报告/PRD/方案（Markdown）；slides=演示文稿（Marp：单独一行 --- 分页，首页标题页；**正文用 Markdown、不要写原始 HTML**；关键数字单独成行写 `值 :: 标签`（如 `268亿元 :: 市场规模`）→ 自动渲成数字卡；对比/选型用 Markdown 表格；只含一个 # 标题的页=章节幕页；讲者备注用 `<!-- note: 备注内容 -->`（内容写在注释里）；交付后用户在「文档」面板一键导出可编辑 .pptx，内置、无需 MCP/插件/命令行）；sheet=表格/报表（标准 CSV：首行表头，逗号分隔，含逗号的字段用双引号包裹，可直接导入 Excel）；html=网页/落地页/前端原型/HTML 演示(横向翻页 deck)/可交互可视化（单文件 HTML，样式与脚本内联，可在预览区实时查看）。注意：返工时对同一任务、同一 kind 再次调用本工具，会作为该交付物的新版本覆盖旧版（旧版进历史、列表只显最新），所以请提交完整新版而非补丁；若确需在同一任务下保留多份并列文档，请用不同 kind 或开新任务。",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "文档标题" },
        content: { type: "string", description: "完整正文：report 为 Markdown；slides 为 --- 分页的 Marp Markdown（纯 Markdown、禁原始 HTML；数字卡用 `值 :: 标签` 行、对比用表格、讲者备注用 `<!-- note: … -->`）；sheet 为 CSV；html 为单文件 HTML（样式/脚本内联，禁外链 <script src> 与内联事件处理器 onload/onclick 等）" },
        kind: { type: "string", enum: ["report", "slides", "sheet", "html"], description: "交付物格式，默认 report" },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "read_skill",
    description:
      "读取某个技能的完整方法正文（L2）。当工作区上下文的「已启用的技能」索引里有与当前任务相关的技能、你需要它的具体步骤/模板/参数时调用。能力型技能(capability)的正文会说明该调用哪个工具/MCP、参数怎么填、不可达时如何降级。skill_id 见技能索引中的 id。",
    input_schema: {
      type: "object" as const,
      properties: { skill_id: { type: "string", description: "技能 id（取自上下文技能索引）" } },
      required: ["skill_id"],
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
    name: "schedule_routine",
    description:
      "创建一个每天定时执行的例行职责（如每日站会汇总、定期数据汇报、监控提醒）。到点后你会被自动唤起，在频道里执行该职责。",
    input_schema: {
      type: "object" as const,
      properties: {
        time: { type: "string", description: '每日触发时刻，24 小时制 "HH:MM"（Asia/Shanghai）' },
        instruction: { type: "string", description: "到点后要执行的职责描述（写给未来的你）" },
      },
      required: ["time", "instruction"],
    },
  },
  {
    name: "save_memory",
    description:
      "把一条值得长期记住的「核实过的事实」或「通用规则」写入你的记忆（如：用户偏好、项目背景、验证过的打法）。不要记未经验证的猜测或流水账；如与旧记忆冲突，写明修正。",
    input_schema: {
      type: "object" as const,
      properties: { note: { type: "string", description: "一条蒸馏后的笔记，格式建议：[事实]… 或 [规则]…" } },
      required: ["note"],
    },
  },
];

function findAgentByName(name?: string): Agent | undefined {
  if (!name) return undefined;
  return listAgents().find((a) => a.name === name.replace(/^@/, "").trim());
}

function execTool(ctx: RunCtx, name: string, input: any): string {
  const { agent, channel } = ctx;
  switch (name) {
    case "start_project": {
      const items: any[] = Array.isArray(input.tasks) ? input.tasks : [];
      if (items.length === 0) return "错误：tasks 不能为空。";
      const autonomy = input.autonomy === "approve_plan" ? "approve_plan" : "auto";
      const project = createProject({
        channel_id: channel.id,
        lead_agent_id: agent.id,
        title: String(input.title ?? "未命名项目").slice(0, 200),
        goal: String(input.goal ?? ""),
        autonomy,
        status: autonomy === "approve_plan" ? "planned" : "running",
      });
      broadcast({ type: "project:upsert", payload: project });
      const created: Task[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const assignee = findAgentByName(it.assignee);
        const deps = (Array.isArray(it.depends_on) ? it.depends_on : [])
          .filter((d: any) => Number.isInteger(d) && d >= 0 && d < i)
          .map((d: number) => created[d].id);
        const task = createTask({
          channel_id: channel.id,
          title: String(it.title ?? `任务 ${i + 1}`).slice(0, 200),
          description: String(it.description ?? ""),
          acceptance_criteria: String(it.acceptance_criteria ?? ""),
          assignee_agent_id: assignee?.id ?? null,
          created_by: agent.id,
          project_id: project.id,
          depends_on: deps,
          model_tier: it.model_tier === "light" ? "light" : "standard",
        });
        created.push(task);
        broadcast({ type: "task:upsert", payload: task });
      }
      const plan = created
        .map((t, i) => {
          const deps = taskDependsOn(t).map((id) => created.findIndex((c) => c.id === id) + 1);
          const assignee = t.assignee_agent_id ? getAgent(t.assignee_agent_id)?.name : "未分配";
          return `${i + 1}. ${t.title} → ${assignee}${deps.length ? `（依赖 ${deps.join("、")}）` : ""}`;
        })
        .join("\n");
      audit(channel.id, `🧩 ${agent.name} 立项「${project.title}」，共 ${created.length} 个任务：\n${plan}`);
      const taskLines = created.map((t, i) => `${i + 1}. ${t.title}（id: ${t.id}）`).join("\n");
      if (autonomy === "approve_plan") {
        const approval = createApproval({
          channel_id: channel.id,
          agent_id: agent.id,
          title: `项目计划待批准：「${project.title}」`,
          payload: `项目目标：${project.goal || "（见任务）"}\n\n任务计划：\n${plan}`,
          kind: "plan",
          ref_id: project.id,
        });
        broadcast({ type: "approval:upsert", payload: approval });
        audit(channel.id, `🔒 项目「${project.title}」的计划已送用户批准（见收件箱），批准后自动开工`);
        return `项目已创建（id: ${project.id}，approve_plan 模式）。计划已送用户批准，批准前不会开工。任务计划：\n${taskLines}`;
      }
      for (const t of created) onTaskAssigned(t); // 无依赖的立即开工
      return `项目已创建（id: ${project.id}）。任务计划：\n${taskLines}\n无依赖且已指派的任务已自动开工；依赖项交付后会自动解锁后续任务；全部交付后你会被唤起做最终汇总。`;
    }
    case "create_task": {
      const assignee = findAgentByName(input.assignee);
      const task = createTask({
        channel_id: channel.id,
        title: String(input.title ?? "").slice(0, 200),
        description: String(input.description ?? ""),
        acceptance_criteria: String(input.acceptance_criteria ?? ""),
        status: "todo",
        assignee_agent_id: assignee?.id ?? null,
        created_by: agent.id,
        model_tier: input.model_tier === "light" ? "light" : "standard",
        source_doc_ids: Array.isArray(input.source_doc_ids) ? input.source_doc_ids.map(String) : [],
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
        ...(input.acceptance_criteria !== undefined ? { acceptance_criteria: String(input.acceptance_criteria) } : {}),
        ...(input.assignee !== undefined ? { assignee_agent_id: assignee?.id ?? null } : {}),
      });
      if (!task) return `错误：找不到任务 ${input.task_id}`;
      broadcast({ type: "task:upsert", payload: task });
      audit(channel.id, `🗂️ ${agent.name} 更新了任务「${task.title}」→ ${task.status}`);
      if (task.assignee_agent_id && task.assignee_agent_id !== prev.assignee_agent_id && task.id !== ctx.taskId) {
        onTaskAssigned(task);
      }
      return `已更新任务（id: ${task.id}，状态: ${task.status}）`;
    }
    case "write_document": {
      const kind = ["report", "slides", "sheet", "html"].includes(input.kind) ? input.kind : "report";
      const content = String(input.content ?? "");
      // 契约校验：坏格式不落库，作为 tool_result 返回引导自纠（不计入交付物，不广播）
      const formatErr = validateDocContent(kind, content);
      if (formatErr) {
        return `⚠️ 文档未保存——格式不符合 kind=${kind} 的要求：${formatErr}\n请修正后重新调用 write_document 提交完整内容（不是补丁）。`;
      }
      const doc = createDocument({
        channel_id: channel.id,
        task_id: ctx.taskId,
        agent_id: agent.id,
        title: String(input.title ?? "未命名").slice(0, 200),
        content,
        kind,
      });
      ctx.createdDocIds.push(doc.id);
      broadcast({ type: "doc:upsert", payload: doc });
      const kindLabel = kind === "slides" ? "演示文稿" : kind === "sheet" ? "数据表" : "文档";
      audit(channel.id, `${kind === "slides" ? "🖥️" : kind === "sheet" ? "📊" : "📄"} ${agent.name} 写好了${kindLabel}《${doc.title}》（${doc.content.length} 字）`);
      return `${kindLabel}已保存（id: ${doc.id}，kind: ${kind}）。`;
    }
    case "read_document": {
      const doc = getDocument(String(input.doc_id));
      if (!doc) return `错误：找不到文档 ${input.doc_id}`;
      return stripLoneSurrogates(`《${doc.title}》\n\n${doc.content.slice(0, 20000)}`);
    }
    case "read_skill": {
      // 渐进式披露 L2/L3：按需拉技能正文 + 附带的可复用模板。只读、零计费（同步分支，不计 MCP_CALLS_PER_RUN）。
      const sk = getSkill(String(input.skill_id));
      if (!sk || !sk.enabled) return `未找到该技能或未启用（id: ${input.skill_id}）。`;
      return stripLoneSurrogates(`【技能：${sk.name}】\n${readSkillBody(sk.id)}`);
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
    case "schedule_routine": {
      const time = String(input.time ?? "");
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return '错误：time 必须是 24 小时制 "HH:MM"。';
      const routine = createRoutine({
        channel_id: channel.id,
        agent_id: agent.id,
        time,
        instruction: String(input.instruction ?? ""),
      });
      audit(channel.id, `⏰ ${agent.name} 设置了每日 ${time} 的例行任务：${routine.instruction.slice(0, 80)}`);
      return `例行任务已创建（id: ${routine.id}），每天 ${time}（Asia/Shanghai）自动执行。`;
    }
    case "submit_verdict": {
      const result = input.result === "revise" ? "revise" : "pass";
      ctx.verdict = { result, reasons: String(input.reasons ?? "") };
      return `裁决已记录：${result}`;
    }
    default:
      return `未知工具：${name}`;
  }
}

// ---------------------------------------------------------------------------
// 例行任务调度：每分钟检查一次，到点唤起对应 Agent 执行职责
// ---------------------------------------------------------------------------

function shanghaiNow(): { hhmm: string; date: string } {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { hhmm: `${get("hour")}:${get("minute")}`, date: `${get("year")}-${get("month")}-${get("day")}` };
}

export function startScheduler() {
  setInterval(() => {
    const { hhmm, date } = shanghaiNow();
    // 跨 owner 清扫，每条到点的例行任务在各自 owner 上下文里执行
    for (const routine of listRoutinesAllOwners()) {
      if (routine.time !== hhmm || routine.last_run_date === date) continue;
      withOwner(routine.owner_id, () => {
        markRoutineRun(routine.id, date);
        void runRoutine(routine).catch((err) => console.error("[engine] routine failed:", err));
      });
    }
  }, 30_000);
}

async function runRoutine(routine: Routine) {
  const agent = getAgent(routine.agent_id);
  const channel = getChannel(routine.channel_id);
  if (!agent || !channel) return;
  audit(channel.id, `⏰ 例行任务触发（每日 ${routine.time}）：${agent.name} 开始执行`);
  const ctx = newCtx(agent, channel, "chat");
  const transcript = buildTranscript(channel.id, 20);
  const prompt = [
    `现在是你的例行任务时间（每日 ${routine.time}）。请执行以下职责，并把结果直接发到频道：`,
    ``,
    routine.instruction,
    ``,
    `<transcript>（频道近况，供参考）`,
    transcript,
    `</transcript>`,
    ``,
    `注意：上下文里有当前的任务看板与文档列表；如职责涉及汇总进展，请以看板与最新讨论为准，实事求是。`,
  ].join("\n");
  // 例行任务多为汇总/提醒类，走轻量通道降本
  await streamRun(ctx, prompt, 6, 0, { tier: "light" });
}

function toolLabel(name: string): string {
  switch (name) {
    case "start_project": return "正在拆解项目计划…";
    case "create_task": return "正在创建任务…";
    case "update_task": return "正在更新任务…";
    case "write_document": return "正在撰写文档…";
    case "read_document": return "正在查阅文档…";
    case "request_approval": return "正在发起审批请求…";
    case "save_memory": return "正在沉淀经验…";
    case "schedule_routine": return "正在设置例行任务…";
    case "submit_verdict": return "正在提交验收裁决…";
    case "generate_image": return "正在生成配图…";
    default: {
      const mcp = name.match(/^mcp__(.+?)__(.+)$/);
      return mcp ? `正在使用插件 ${mcp[1]}:${mcp[2]}…` : `正在使用 ${name}…`;
    }
  }
}

// ---------------------------------------------------------------------------
// 运行核心：流式 LLM 循环（聊天 / 干活 / 验收 / 汇总共用）
// ---------------------------------------------------------------------------

function audit(channelId: string, text: string) {
  const msg = insertMessage({ channel_id: channelId, author_type: "system", content: text });
  broadcast({ type: "message:new", payload: msg });
}

function status(agent: Agent, channelId: string, state: "thinking" | "tool" | "responding" | "idle", detail?: string) {
  broadcast({ type: "agent:status", payload: { agent_id: agent.id, channel_id: channelId, state, detail } });
}

interface StreamRunOpts extends RuntimeOpts {
  extraSystem?: string;
  toolsOverride?: Anthropic.ToolUnion[];
}

async function streamRun(
  ctx: RunCtx,
  userPrompt: string,
  maxIterations: number,
  depth = 0,
  opts: StreamRunOpts = {}
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
    let usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
    const rt = resolveRuntime(agent, opts);
    if (!rt.client) {
      await mockRun(ctx, emit);
    } else {
      usage = await llmLoop(ctx, rt, userPrompt, maxIterations, emit, opts.extraSystem, opts.toolsOverride);
    }
    const usageJson = JSON.stringify(usage);
    updateMessage(row.id, { content, status: "complete", usage_json: usageJson, model: rt.client ? rt.model : "mock" });
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
  rt: Runtime,
  userPrompt: string,
  maxIterations: number,
  emit: (delta: string) => void,
  extraSystem?: string,
  toolsOverride?: Anthropic.ToolUnion[]
): Promise<{ input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }> {
  const client = rt.client;
  if (!client) throw new Error("no client");
  const { agent, channel } = ctx;

  // 能力门控：服务端 web 工具按通道可用性；提示缓存仅官方 Anthropic API 启用
  // 用本次工作焦点（任务简报 / 用户消息）做技能相关性筛选——只注入相关专项方法
  let dynamicCtx = buildDynamicContext(agent, channel, userPrompt);
  if (!rt.webTools) dynamicCtx += `\n\n注意：当前模型通道不支持 web_search/web_fetch 联网调研，依据已有上下文与常识工作，不确定的事实要明确说明未经核实。`;
  const system: Anthropic.TextBlockParam[] = [
    rt.official
      ? { type: "text", text: agent.system_prompt, cache_control: { type: "ephemeral" } }
      : { type: "text", text: agent.system_prompt },
    { type: "text", text: dynamicCtx + (extraSystem ? `\n\n${extraSystem}` : "") },
  ];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];
  const stageKey = rt.providerId ?? "env";
  let webStage = rt.official ? 0 : webToolsStage.get(stageKey) ?? 0;
  let mcpDefs: Anthropic.Tool[] = [];
  if (!toolsOverride) {
    try {
      mcpDefs = await mcpToolDefs(); // MCP 插件工具（懒连接，失败自动跳过）
    } catch (err) {
      console.error("[engine] mcp tools unavailable:", err);
    }
  }
  const buildTools = (): Anthropic.ToolUnion[] =>
    toolsOverride ?? [
      ...TOOLS,
      ...(imageGenAvailable() ? [IMAGE_TOOL] : []),
      ...(rt.webTools ? webToolsFor(webStage) : []),
      ...mcpDefs,
    ];
  let tools: Anthropic.ToolUnion[] = buildTools();
  const isWebTool = (t: Anthropic.ToolUnion) => "type" in t && typeof t.type === "string" && t.type.startsWith("web_");
  // 兼容端点不接受服务端内容块（搜索结果/server tool 等）回传——回传前剥离，只保留文本与客户端工具调用。
  // 但 thinking/redacted_thinking 必须原样回传：DeepSeek 等会自带 thinking 块，多轮工具循环里若被剥掉，
  // 端点会以 400「content[].thinking must be passed back」拒绝整段对话。
  const echoContent = (content: Anthropic.Message["content"]) =>
    (rt.official
      ? content
      : content.filter(
          (b) => b.type === "text" || b.type === "tool_use" || b.type === "thinking" || b.type === "redacted_thinking"
        )) as Anthropic.MessageParam["content"];

  const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
  let firstText = true;
  let emitted = false;
  let steerSince = Date.now(); // 运行中插话：此刻之后的用户消息会注入下一轮迭代
  let transientRetries = 0; // 瞬时网络错误（terminated/重置/5xx）重试计数
  let mcpCalls = 0; // 本次运行已消耗的外部插件调用数
  let imageCalls = 0; // 本次运行已生成的图片数（按张计费，设上限）
  // 跨插件检索去重（本次运行内）：同一查询若已被某搜索插件成功检索过，再用别的搜索插件查同一查询
  // 直接回上次结果、不再花钱。仅记成功结果——失败不入，保证可换插件兜底（如智谱套餐失效→博查重试同查询）。
  const searchMemo = new Map<string, string>();
  const SEARCH_DEDUP = process.env.AITEAM_SEARCH_DEDUP !== "0";

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // 停止开关：在迭代边界停下（任务停止 或 频道停止）
    if ((ctx.taskId && cancelledTasks.has(ctx.taskId)) || cancelledChannels.has(channel.id)) {
      emit("\n\n⏹ 已按用户要求停止。");
      break;
    }
    const stream = client.messages.stream({
      model: rt.model,
      max_tokens: rt.maxTokens,
      ...(supportsAdaptiveThinking(rt.model) ? { thinking: { type: "adaptive" as const } } : {}),
      system,
      messages,
      tools,
    });
    const unregister = registerStream(channel.id, stream);

    stream.on("text", (delta) => {
      if (firstText) {
        status(agent, channel.id, "responding");
        firstText = false;
      }
      emit(delta);
      emitted = true;
    });

    let final: Anthropic.Message;
    try {
      final = await stream.finalMessage();
    } catch (err: any) {
      const errStatus = err?.status ?? err?.response?.status;
      const errMsg = String(err?.message ?? err);
      // 频道/任务停止导致的 abort：最优先识别，不当成错误也不重试，直接收尾停下
      if (cancelledChannels.has(channel.id) || (ctx.taskId && cancelledTasks.has(ctx.taskId)) || err?.name === "AbortError" || /abort/i.test(errMsg)) {
        emit("\n\n⏹ 已停止。");
        break;
      }
      // 兼容端点联网工具适配阶梯：4xx 自动降一档重试（搜索+抓取 → 仅搜索 → 兼容版 → 停用）
      if (rt.providerId && !rt.official && tools.some(isWebTool) && errStatus >= 400 && errStatus < 500) {
        webStage = Math.min(webStage + 1, 3);
        webToolsStage.set(stageKey, webStage);
        tools = buildTools();
        audit(channel.id, `ℹ️ 联网工具适配：通道拒绝当前组合（${errMsg.slice(0, 60)}），降级为「${WEB_STAGE_LABEL[webStage]}」重试`);
        iteration--;
        continue;
      }
      // 瞬时网络错误（连接中断 terminated / 重置 / 5xx / 限流）：退避重试，不让长任务白跑
      const transient =
        errStatus === undefined ||
        errStatus >= 500 ||
        errStatus === 429 ||
        /terminated|ECONNRESET|ETIMEDOUT|fetch failed|socket|aborted|network/i.test(errMsg);
      if (transient && transientRetries < 3) {
        transientRetries++;
        status(agent, channel.id, "thinking", `连接中断，第 ${transientRetries} 次重试…`);
        await new Promise((r) => setTimeout(r, 2000 * transientRetries));
        iteration--;
        continue;
      }
      throw err;
    } finally {
      unregister(); // 本轮流结束，注销（顺带在频道无活跃流时清掉停止标志）
    }
    // 计费分列：缓存读/写单独累计，input_tokens 只记纯输入。预算护栏据此加权，不再把 1/10 价的缓存读当全价（见 QW3）。
    usage.input_tokens += final.usage.input_tokens;
    usage.cache_read_tokens += final.usage.cache_read_input_tokens ?? 0;
    usage.cache_creation_tokens += final.usage.cache_creation_input_tokens ?? 0;
    usage.output_tokens += final.usage.output_tokens;

    if (final.stop_reason === "pause_turn") {
      // 服务端工具（web_search 等）跑满单次迭代上限，续跑即可
      messages.push({ role: "assistant", content: echoContent(final.content) });
      continue;
    }

    const toolUses = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (final.stop_reason !== "tool_use" || toolUses.length === 0) break;

    messages.push({ role: "assistant", content: echoContent(final.content) });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      status(agent, channel.id, "tool", toolLabel(tu.name));
      let result: string;
      try {
        if (isMcpTool(tu.name)) {
          const gated = mcpSafetyGate(tu.name);
          if (gated) {
            // 高危插件（exec/network）：引擎层硬拦截（非提示词），强制改走 request_approval 审批门。
            result = `⛔ 插件「${gated.name}」属高危（${gated.safety === "exec" ? "本地执行" : "外发数据"}），不能直接调用。请改用 request_approval 提交本次动作的完整内容与目的，经用户批准后再执行。`;
            audit(channel.id, `⛔ ${agent.name} 试图直接调用高危插件「${gated.name}」(${gated.safety})，已拦截——须走审批门`);
          } else {
            const sig = SEARCH_DEDUP ? searchQuerySignature(tu.input) : null;
            if (sig && searchMemo.has(sig)) {
              // 同一查询已检索过（可能是别的搜索插件）→ 回上次结果，省去重复计费的一次往返。
              const mcp = tu.name.match(/^mcp__(.+?)__(.+)$/);
              audit(channel.id, `↩️ ${agent.name} 重复检索「${sig.slice(0, 24)}…」已去重（省 1 次计费，复用上次结果）`);
              result =
                `↩️ 本次运行已检索过相同查询「${sig.slice(0, 60)}」，为避免重复计费，直接返回上次结果（如需更多信息请换不同的查询角度，不要对同一问题换搜索插件重复查）：\n\n` +
                searchMemo.get(sig);
            } else if (mcpCalls >= MCP_CALLS_PER_RUN) {
              result = `⚠️ 本次运行的外部插件调用已达上限（${MCP_CALLS_PER_RUN} 次）。外部检索按次计费，请基于已获得的信息完成工作，不要再尝试调用插件。`;
            } else {
              mcpCalls++;
              result = await callMcpTool(tu.name, tu.input);
              // 持久化审计：插件调用此前只发瞬态 status，事后无法从时间线/账本判断用没用某插件。
              // 仿配图那条落一行可核查的 system 消息——只记 server:tool 名，绝不写参数/密钥/返回内容。
              const mcp = tu.name.match(/^mcp__(.+?)__(.+)$/);
              audit(channel.id, `🔌 ${agent.name} 调用了插件 ${mcp ? `${mcp[1]}:${mcp[2]}` : tu.name}`);
              // 仅缓存成功结果（失败不入 memo → 允许换插件用同查询兜底，不破坏降级链）
              const failed = result.startsWith("MCP 工具执行失败") || result.startsWith("工具返回错误") || result.startsWith("错误：");
              if (sig && !failed) searchMemo.set(sig, result);
            }
          }
        } else if (tu.name === "generate_image") {
          if (imageCalls >= IMAGES_PER_RUN) {
            result = `⚠️ 本次运行的图片生成已达上限（${IMAGES_PER_RUN} 张，按张计费）。请用已生成的图完成交付。`;
          } else {
            imageCalls++;
            result = await generateImage(tu.input);
            audit(channel.id, `🎨 ${agent.name} 生成了一张配图（${String((tu.input as any)?.prompt ?? "").slice(0, 60)}）`);
          }
        } else {
          result = execTool(ctx, tu.name, tu.input);
        }
      } catch (err: any) {
        result = `工具执行失败：${err?.message ?? err}`;
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    messages.push({ role: "user", content: results });
    if (emitted) emit("\n\n"); // 工具段落之间留空行，保持 Markdown 结构

    // 运行中插话：把用户在频道里的新消息注入下一轮迭代（人随时可干预）
    const interjections = listMessages(channel.id, 10).filter(
      (m) => m.author_type === "user" && m.created_at > steerSince
    );
    if (interjections.length > 0) {
      steerSince = Date.now();
      messages.push({
        role: "user",
        content: `[用户插话——请立即纳入考虑，必要时调整做法或中止当前方向]\n${interjections.map((m) => m.content).join("\n")}`,
      });
    }

    // 校验者一旦提交裁决即可收口
    if (ctx.kind === "verify" && ctx.verdict) break;
  }
  return usage;
}

// ---------------------------------------------------------------------------
// Mock 模式
// ---------------------------------------------------------------------------

async function mockRun(ctx: RunCtx, emit: (delta: string) => void) {
  const { agent } = ctx;
  let text: string;
  if (ctx.kind === "work" && ctx.taskId) {
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
    text = `（Mock 模式）任务已按演示流程处理完毕：调研 → 交付物撰写（见文档库）→ 转待评审。配置 \`ANTHROPIC_API_KEY\` 后我会真实执行这项工作。`;
  } else if (ctx.kind === "synthesis") {
    const doc = createDocument({
      channel_id: ctx.channel.id,
      task_id: null,
      agent_id: agent.id,
      title: `（Mock）项目最终汇总报告`,
      content: `# 项目最终汇总报告\n\nMock 模式演示：全部任务交付后由 Lead 自动汇总。`,
    });
    ctx.createdDocIds.push(doc.id);
    broadcast({ type: "doc:upsert", payload: doc });
    text = `（Mock 模式）项目汇总完成，最终报告已写入文档库。`;
  } else {
    text = `（Mock 模式）你好，我是 **${agent.name}**（${agent.role}）。

当前服务端未配置 \`ANTHROPIC_API_KEY\`，这是模拟回复，用于演示完整协作流程：

| 能力 | 状态 |
|---|---|
| 流式输出 / @路由 / 代理接力 | ✅ 正在演示 |
| 任务自动开工 → 交付 → 验收循环 | ✅ 指派任务即可演示 |
| 项目模式（拆解→依赖调度→自动汇总） | ✅ 配置 Key 后由我真实驱动 |`;
  }
  for (const chunk of text.match(/[\s\S]{1,12}/g) ?? []) {
    emit(chunk);
    await new Promise((r) => setTimeout(r, 20));
  }
}

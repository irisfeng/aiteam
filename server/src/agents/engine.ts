import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  Agent,
  Approval,
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
  createBlockingNetworkApproval,
  consumeApproval,
  createDocument,
  createProject,
  createTask,
  createTaskEvent,
  getAgent,
  getApproval,
  getChannel,
  getDocument,
  getMemory,
  getMessage,
  getProject,
  getSkill,
  getTask,
  invalidateNetworkApprovalsForTask as invalidateNetworkApprovalsForTaskInDb,
  insertMessage,
  listAgents,
  listApprovals,
  listChannels,
  listDocuments,
  listMessages,
  listTaskEvents,
  listVerdictsForTask,
  listInFlightTasksAllOwners,
  listRoutinesAllOwners,
  listTasks,
  taskDependsOn,
  updateMessage,
  updateProject,
  updateTask,
  addTaskUsage,
  createVerdict,
  estimateTaskBillable,
  readUsage,
  taskSpentBillable,
} from "../db.js";
import { broadcast } from "../bus.js";
import { currentOwner, withOwner } from "../ownerScope.js";
import { parseSlides, slidesManifest } from "../pptx.js";
import { callMcpTool, isMcpTool, mcpToolDefs, mcpToolPrefixReady, mcpSafetyGate, mcpServerForTool, searchQuerySignature } from "./mcp.js";
import { IMAGE_TOOL, generateImage, imageGenAvailable } from "./images.js";
import { getSkillTemplate } from "../registry.js";

const MAX_CHAIN_DEPTH = Number(process.env.AGENT_CHAIN_DEPTH ?? 2);
const MAX_REVISIONS = Number(process.env.TASK_MAX_REVISIONS ?? 1);
const TRANSCRIPT_WINDOW = 30;
/** 每次运行的 MCP 插件调用上限（外部检索按次计费，防烧爆） */
const MCP_CALLS_PER_RUN = Number(process.env.AITEAM_MCP_CALLS_PER_RUN ?? 5);
/** 每次运行的图片生成上限（文生图按张计费） */
const IMAGES_PER_RUN = Number(process.env.AITEAM_IMAGES_PER_RUN ?? 2);
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
  const placeholder = unresolvedPlaceholderHint(c);
  if (placeholder) return placeholder;
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
    const headers = splitCsvLine(lines[0]).map((value) => value.trim());
    if (headers.some((value) => !value)) return "sheet 表头存在空列名；每一列都必须有明确名称。";
    if (new Set(headers).size !== headers.length) return "sheet 表头存在重复列名；请为每一列使用唯一、可理解的名称。";
    for (let i = 1; i < lines.length; i++) {
      const n = splitCsvLine(lines[i]).length;
      if (n !== headerCols)
        return `sheet 第 ${i + 1} 行有 ${n} 列，与表头 ${headerCols} 列不一致（含逗号的字段请用双引号包裹）。`;
    }
    return null;
  }
  return unsourcedNumbersHint(c); // report：格式无要求，但多处量化数据需有来源（防对外交付物编造数字）
}

/** 对外交付底线：明显占位符不能进入文档库。"待核实/待确认"是诚实边界，不在此拦截。 */
function unresolvedPlaceholderHint(content: string): string | null {
  const match = content.match(/(?:\bTODO\b|\bTBD\b|lorem\s+ipsum|\[(?:待补充|占位|此处插入[^\]]*)\]|<placeholder>)/i);
  if (!match) return null;
  return `检测到未清理的占位内容“${match[0]}”。请补齐真实内容或明确写成“待确认项 + 负责人 + 截止条件”，不要把模板残留作为正式交付。`;
}

export function deliverableQualityRubric(kind: string): string[] {
  const common = [
    "结论、建议和下一步必须可直接用于目标读者的真实场景，不得以模板话术或自我表扬代替内容",
    "关键事实、数字和外部主张须有可追溯来源；无法核实的内容要明确标为假设或待确认",
    "不得残留 TODO、TBD、占位文案、空章节或与任务无关的示例内容",
  ];
  const byKind: Record<string, string[]> = {
    report: [
      "报告/方案：开头给目标读者、使用场景与执行摘要；正文结构支持快速决策，结尾给责任人、风险和下一步",
      "Word/PDF 导出后也应成立：标题层级、表格、列表和长段落清晰，不依赖聊天上下文才能理解",
    ],
    slides: [
      "PPT：形成完整叙事而非报告切片；每页只有一个核心观点，标题表达结论，信息层级与留白可支撑现场讲述",
      "数字、表格、图示、配图与讲者备注按内容需要使用；不得用装饰图掩盖空洞内容，并核对真实渲染页数与元素",
    ],
    sheet: [
      "Excel/数据表：列名唯一且含义清楚，单位、统计口径、时间范围、来源和缺失值处理可理解",
      "计算、排序与汇总应可复核；面向决策时给关键指标或配套结论，不把未经解释的原始表当成完成品",
    ],
    html: [
      "设计页面：视觉方向与 brief 一致，信息层级、字体、色彩、间距和组件状态形成统一系统，不使用默认模板感或无意义装饰",
      "在目标尺寸下无溢出、遮挡、低对比或不可读内容；关键操作与内容在脚本受限预览中仍可理解",
    ],
    template: [
      "品牌模板：替换内容不得破坏原有母版、版式、配色与层级；所有文本槽位需检查溢出和错位",
    ],
  };
  return [...common, ...(byKind[kind] ?? ["格式、结构和表达须符合该交付物的真实使用方式，并能独立打开和评审"])];
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

type RuntimeClient = Anthropic | OpenAICompatClient;

/** 单次运行的模型通道：client、是否官方（决定服务端工具/缓存可用性）、模型与输出上限。 */
interface Runtime {
  client: RuntimeClient | null;
  official: boolean;
  /** 是否启用 Anthropic 服务端联网工具（官方恒可用；兼容端点按 provider.web_tools） */
  webTools: boolean;
  /** 来源 provider id（env 官方为 null）——用于联网工具失败后的按通道熔断 */
  providerId: string | null;
  model: string;
  maxTokens: number;
}

function textFromAnthropicContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text ?? "")
    .join("\n");
}

function openAiToolFromAnthropic(tool: Anthropic.ToolUnion) {
  const t = tool as any;
  if (!t?.name || !t?.input_schema) return null;
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema,
    },
  };
}

class OpenAICompatStream extends EventEmitter {
  private finalPromise: Promise<Anthropic.Message>;
  private controller = new AbortController();

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly params: Anthropic.MessageCreateParams
  ) {
    super();
    this.finalPromise = this.run();
  }

  abort() {
    this.controller.abort();
  }

  finalMessage() {
    return this.finalPromise;
  }

  private toOpenAIMessages() {
    const out: any[] = [];
    const systemText = textFromAnthropicContent(this.params.system);
    if (systemText) out.push({ role: "system", content: systemText });
    for (const m of this.params.messages as Anthropic.MessageParam[]) {
      const content = m.content as any;
      if (typeof content === "string") {
        out.push({ role: m.role, content });
        continue;
      }
      if (!Array.isArray(content)) {
        out.push({ role: m.role, content: "" });
        continue;
      }
      const toolResults = content.filter((b: any) => b?.type === "tool_result");
      if (m.role === "user" && toolResults.length > 0) {
        for (const tr of toolResults) {
          out.push({ role: "tool", tool_call_id: tr.tool_use_id, content: textFromAnthropicContent(tr.content) || String(tr.content ?? "") });
        }
        continue;
      }
      const toolUses = content.filter((b: any) => b?.type === "tool_use");
      if (m.role === "assistant" && toolUses.length > 0) {
        out.push({
          role: "assistant",
          content: textFromAnthropicContent(content) || null,
          tool_calls: toolUses.map((tu: any) => ({
            id: tu.id,
            type: "function",
            function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
          })),
        });
        continue;
      }
      out.push({ role: m.role, content: textFromAnthropicContent(content) });
    }
    return out;
  }

  private async run(): Promise<Anthropic.Message> {
    const tools = (this.params.tools ?? []).map(openAiToolFromAnthropic).filter(Boolean);
    // 空闲超时：连续 timeoutMs 无任何字节到达才中止——流式响应总时长可以远超单次超时，但静默挂死会被切断。
    this.touchIdle();
    try {
      return await this.request(tools);
    } finally {
      if (this.idleTimer) clearTimeout(this.idleTimer);
    }
  }

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly idleTimeoutMs = Math.max(1000, Number(process.env.AITEAM_PROVIDER_TIMEOUT_MS) || 120_000);

  private touchIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.controller.abort(), this.idleTimeoutMs);
  }

  private post(body: string) {
    return fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: this.controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body,
    });
  }

  private requestBody(tools: any[], stream: boolean) {
    return JSON.stringify({
      model: this.params.model,
      messages: this.toOpenAIMessages(),
      max_tokens: this.params.max_tokens,
      ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    });
  }

  private async request(tools: any[]): Promise<Anthropic.Message> {
    // 真流式优先（DeepSeek/硅基流动/百炼等国内主流兼容通道都支持 SSE）；
    // 个别网关会对 stream/stream_options 报 4xx——降级为一次性响应重试。
    let res = await this.post(this.requestBody(tools, true));
    if (!res.ok && res.status >= 400 && res.status < 500 && !this.controller.signal.aborted) {
      res = await this.post(this.requestBody(tools, false));
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`OpenAI-compatible provider HTTP ${res.status}: ${body.slice(0, 500)}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    // 简单网关可能忽略 stream 参数直接回 JSON，按实际 content-type 分流
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) return this.consumeSse(res);

    const json = await res.json() as any;
    const msg = json.choices?.[0]?.message ?? {};
    const text = msg.content ? String(msg.content) : "";
    if (text) this.emit("text", text);
    return this.buildMessage(
      json.id,
      text,
      (msg.tool_calls ?? []).map((tc: any) => ({ id: tc.id ?? "", name: tc.function?.name ?? "", args: tc.function?.arguments ?? "" })),
      { input_tokens: json.usage?.prompt_tokens ?? 0, output_tokens: json.usage?.completion_tokens ?? 0 },
    );
  }

  /** 逐行解析 SSE：content 增量实时 emit("text")（前端由此获得逐字流），tool_calls 按 index 累积参数分片。 */
  private async consumeSse(res: Response): Promise<Anthropic.Message> {
    if (!res.body) throw new Error("OpenAI-compatible provider returned empty SSE body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let id = "";
    let text = "";
    const toolCalls: { id: string; name: string; args: string }[] = [];
    let usage = { input_tokens: 0, output_tokens: 0 };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      this.touchIdle();
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue; // 半包或注释行，忽略
        }
        if (chunk.id) id = chunk.id;
        if (chunk.usage) {
          usage = {
            input_tokens: chunk.usage.prompt_tokens ?? 0,
            output_tokens: chunk.usage.completion_tokens ?? 0,
          };
        }
        const delta = chunk.choices?.[0]?.delta ?? {};
        if (typeof delta.content === "string" && delta.content) {
          text += delta.content;
          this.emit("text", delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const i = typeof tc.index === "number" ? tc.index : 0;
          const slot = (toolCalls[i] ??= { id: "", name: "", args: "" });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
      }
    }
    return this.buildMessage(id, text, toolCalls.filter(Boolean), usage);
  }

  private buildMessage(
    id: string | undefined,
    text: string,
    toolCalls: { id: string; name: string; args: string }[],
    usage: { input_tokens: number; output_tokens: number },
  ): Anthropic.Message {
    const content: Anthropic.Message["content"] = [];
    if (text) content.push({ type: "text", text } as Anthropic.TextBlock);
    for (const tc of toolCalls) {
      // 模型可能产出非法 JSON 参数；不能让整轮 finalMessage() 抛掉，转成可继续的工具入参错误。
      let input: unknown = {};
      try {
        input = JSON.parse(tc.args || "{}");
      } catch {
        input = { __invalid_arguments: tc.args.slice(0, 2000) };
      }
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input } as Anthropic.ToolUseBlock);
    }
    return {
      id: id || `openai_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: this.params.model,
      content,
      stop_reason: (toolCalls.length ? "tool_use" : "end_turn") as Anthropic.Message["stop_reason"],
      stop_sequence: null,
      usage,
    } as Anthropic.Message;
  }
}

class OpenAICompatClient {
  messages = {
    create: async (params: Anthropic.MessageCreateParamsNonStreaming) => {
      const stream = new OpenAICompatStream(this.baseUrl, this.apiKey, params as Anthropic.MessageCreateParams);
      return stream.finalMessage();
    },
    stream: (params: Anthropic.MessageCreateParams) => new OpenAICompatStream(this.baseUrl, this.apiKey, params),
  };

  constructor(private readonly apiKey: string, private readonly baseUrl: string) {}
}

function providerUsesOpenAICompat(baseUrl: string): boolean {
  const u = baseUrl.toLowerCase();
  if (!u) return false;
  if (u.includes("anthropic")) return false;
  return u.includes("compatible-mode/v1") || u.includes("siliconflow") || /\/v1\/?$/.test(u);
}

function providerProtocol(baseUrl: string): "anthropic-compatible" | "openai-compatible" {
  return providerUsesOpenAICompat(baseUrl) ? "openai-compatible" : "anthropic-compatible";
}

function runtimeFromProvider(p: NonNullable<ReturnType<typeof getProvider>>, agentModel: string, light = false): Runtime {
  const openaiCompat = providerUsesOpenAICompat(p.base_url);
  return {
    client: openaiCompat
      ? new OpenAICompatClient(p.api_key, p.base_url)
      : new Anthropic({ apiKey: p.api_key, baseURL: p.base_url || undefined }),
    official: !p.base_url,
    webTools: openaiCompat ? false : !p.base_url || Boolean(p.web_tools),
    providerId: p.id,
    model: light ? p.light_model || p.default_model || agentModel : agentModel || p.default_model || "claude-opus-4-8",
    maxTokens: p.max_tokens || 16000,
  };
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

export function preferredStrongProviderId(
  agentProviderId: string | null | undefined,
  providers: Array<{ id: string; api_key: string; is_strong: number | boolean }>,
) {
  const boundStrong = agentProviderId
    ? providers.find((provider) => provider.id === agentProviderId && provider.api_key && provider.is_strong)
    : undefined;
  return boundStrong?.id ?? providers.find((provider) => provider.api_key && provider.is_strong)?.id ?? null;
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
  const fromProvider = (p: NonNullable<ReturnType<typeof getProvider>>, agentModel: string): Runtime =>
    runtimeFromProvider(p, agentModel, light);
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
    // 显式复核者的供应商若也被标为强通道，必须尊重其模型绑定；否则多个强通道并存时，
    // listProviders 的插入顺序会把 SiliconFlow GLM 复核悄悄路由到更早创建的 DeepSeek。
    const providers = listProviders();
    const strongId = preferredStrongProviderId(agent.provider_id, providers);
    const strong = strongId ? providers.find((provider) => provider.id === strongId) : undefined;
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
  halted: "blocked" | "stopped" | null;
}

function newCtx(agent: Agent, channel: Channel, kind: RunCtx["kind"], taskId: string | null = null): RunCtx {
  return { agent, channel, kind, taskId, createdDocIds: [], verdict: null, halted: null };
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
const resumeAfterRun = new Set<string>();
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
  invalidateTaskNetworkApprovals(taskId);
}

/**
 * 关闭任务上下文绑定的 network 审批并把最终状态推送给前端。
 * DB 更新是单语句原子操作；广播只负责让当前连接立即收敛到数据库真相。
 */
export function invalidateTaskNetworkApprovals(taskId: string): number {
  const changed = invalidateNetworkApprovalsForTaskInDb(taskId);
  if (changed > 0) {
    for (const approval of listApprovals()) {
      if (approval.kind === "network" && approval.ref_id === taskId) {
        broadcast({ type: "approval:upsert", payload: approval });
      }
    }
  }
  return changed;
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

function taskHasSourceDocs(task: Pick<Task, "source_doc_ids">): boolean {
  try {
    const ids = JSON.parse(task.source_doc_ids || "[]");
    return Array.isArray(ids) && ids.length > 0;
  } catch {
    return false;
  }
}

export function mcpRequiresApprovalForTask(task: Pick<Task, "source_doc_ids"> | undefined, toolName: string): boolean {
  const server = mcpServerForTool(toolName);
  if (server?.safety !== "network") return false;
  if (process.env.AITEAM_APPROVE_NETWORK_MCP === "1") return true;
  return Boolean(task && taskHasSourceDocs(task));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
}

interface NetworkGrantV1 {
  v: 1;
  server_id: string;
  server_name: string;
  server_target: string;
  server_fingerprint: string;
  tool: string;
  input: unknown;
  call_fingerprint: string;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(value))).digest("hex");
}

function networkServerFingerprint(server: NonNullable<ReturnType<typeof mcpServerForTool>>): string {
  return sha256({
    id: server.id,
    name: server.name,
    kind: server.kind,
    url: server.url,
    auth_token: server.auth_token,
    command: server.command,
    args_json: server.args_json,
    env_json: server.env_json,
    safety: server.safety,
  });
}

function createNetworkGrant(toolName: string, input: unknown): NetworkGrantV1 | null {
  const server = mcpServerForTool(toolName);
  if (!server || server.safety !== "network") return null;
  const normalizedInput = canonicalJson(input);
  const serverFingerprint = networkServerFingerprint(server);
  return {
    v: 1,
    server_id: server.id,
    server_name: server.name,
    server_target: server.kind === "http" ? server.url : `stdio:${server.command}`,
    server_fingerprint: serverFingerprint,
    tool: toolName,
    input: normalizedInput,
    call_fingerprint: sha256({
      server_fingerprint: serverFingerprint,
      tool: toolName,
      input: normalizedInput,
    }),
  };
}

function approvalContainsNetworkGrant(approval: Approval): boolean {
  if (approval.kind !== "network") return false;
  try {
    const payload = JSON.parse(approval.payload || "{}") as { network_grant?: unknown };
    return Boolean(payload.network_grant && typeof payload.network_grant === "object");
  } catch {
    return false;
  }
}

function networkGrantFromApproval(approval: Approval, requireApproved = true): NetworkGrantV1 | null {
  if (
    approval.kind !== "network" ||
    (requireApproved && approval.status !== "approved") ||
    approval.consumed_at
  ) return null;
  try {
    const payload = JSON.parse(approval.payload || "{}") as {
      network_grant?: Partial<NetworkGrantV1>;
    };
    const grant = payload.network_grant;
    if (
      grant?.v !== 1 ||
      typeof grant.server_id !== "string" ||
      typeof grant.server_name !== "string" ||
      typeof grant.server_target !== "string" ||
      typeof grant.server_fingerprint !== "string" ||
      typeof grant.tool !== "string" ||
      typeof grant.call_fingerprint !== "string"
    ) return null;
    const current = createNetworkGrant(grant.tool, grant.input);
    if (
      !current ||
      current.server_id !== grant.server_id ||
      current.server_name !== grant.server_name ||
      current.server_target !== grant.server_target ||
      current.server_fingerprint !== grant.server_fingerprint ||
      current.call_fingerprint !== grant.call_fingerprint
    ) return null;
    return current;
  } catch {
    return null;
  }
}

function matchingApprovedNetworkGrant(
  taskId: string | null | undefined,
  toolName: string,
  input: unknown,
  agentId?: string,
): Approval | null {
  if (!taskId || !isMcpTool(toolName)) return null;
  const expected = createNetworkGrant(toolName, input);
  if (!expected) return null;
  for (const approval of listApprovals()) {
    if (approval.ref_id !== taskId || (agentId && approval.agent_id !== agentId)) continue;
    const grant = networkGrantFromApproval(approval);
    if (
      !grant ||
      grant.server_id !== expected.server_id ||
      grant.tool !== expected.tool ||
      grant.call_fingerprint !== expected.call_fingerprint
    ) continue;
    return approval;
  }
  return null;
}

/**
 * 任务级网络外发授权必须绑定具体 MCP 工具和完整参数。
 * 任意 action 批准、不同工具或不同查询都不能复用成网络外发通行证。
 */
export function taskHasApprovedNetworkGrant(
  taskId: string | null | undefined,
  toolName: string,
  input: unknown,
  agentId?: string,
): boolean {
  return Boolean(matchingApprovedNetworkGrant(taskId, toolName, input, agentId));
}

function taskExecutionIsCurrent(taskId: string, agentId: string): boolean {
  if (cancelledTasks.has(taskId)) return false;
  const task = getTask(taskId);
  return Boolean(
    task &&
    task.status === "doing" &&
    task.assignee_agent_id === agentId &&
    task.blocked_approval_id === null
  );
}

/** 在真正网络外呼前同步消费一次性授权；失败调用也必须重新审批。 */
export function consumeApprovedNetworkGrant(
  taskId: string | null | undefined,
  toolName: string,
  input: unknown,
  agentId?: string,
): boolean {
  if (!taskId || !agentId || !taskExecutionIsCurrent(taskId, agentId)) return false;
  const match = matchingApprovedNetworkGrant(taskId, toolName, input, agentId);
  if (!match) return false;
  return consumeApproval(match.id);
}

/** 由实际被拦截的 network MCP 调用生成审批范围，并暂停任务等待用户决定。 */
export function requestNetworkApprovalForTask(
  agent: Agent,
  task: Task,
  toolName: string,
  input: unknown,
  title: string,
  details: string,
): { approvalId: string; task: Task } | null {
  const grant = createNetworkGrant(toolName, input);
  if (!grant) throw new Error("network approval requires an enabled safety=network MCP tool");
  if (cancelledTasks.has(task.id)) return null;
  const created = createBlockingNetworkApproval({
    task_id: task.id,
    agent_id: agent.id,
    title: title.slice(0, 200),
    payload: JSON.stringify({ details, network_grant: grant }, null, 2),
  });
  if (!created) return null;
  const { approval, task: next } = created;
  broadcast({ type: "approval:upsert", payload: approval });
  broadcast({ type: "task:upsert", payload: next });
  emitTaskEvent(
    next,
    "blocked",
    `${agent.name} 请求批准一次网络外发调用`,
    { approval_id: approval.id, tool: toolName, call_fingerprint: grant.call_fingerprint },
    agent.id,
  );
  emitTaskEvent(
    next,
    "approval",
    `已创建单次 network MCP 审批「${approval.title}」`,
    { approval_id: approval.id, tool: toolName, call_fingerprint: grant.call_fingerprint },
    agent.id,
  );
  if (next.channel_id) audit(next.channel_id, `⏸️ 任务「${next.title}」暂停，等待批准网络调用 ${toolName}`);
  return { approvalId: approval.id, task: next };
}

/** 任务被指派（或创建时即带负责人）后调用。依赖未满足的任务会等依赖交付后自动开工。 */
export function onTaskAssigned(task: Task) {
  if (!task.assignee_agent_id) return;
  if (task.status === "review" || task.status === "done" || task.status === "blocked" || task.status === "cancelled") return;
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
      if (t) emitTaskEvent(t, "failure", `${agent.name} 处理任务失败，任务退回待办`, { error: String(err?.message ?? err).slice(0, 300) }, agent.id);
      if (t?.channel_id)
        audit(t.channel_id, `⚠️ ${agent.name} 处理任务「${task.title}」失败：${err?.message ?? err}。任务已退回待办，重新指派负责人即可重试。`);
    }))
    .finally(() => {
      const stoppedBeforeResume = cancelledTasks.delete(task.id);
      const shouldResume = resumeAfterRun.delete(task.id);
      runningTasks.delete(task.id);
      if (currentWork.get(agent.id) === task.id) currentWork.delete(agent.id);
      if (!stoppedBeforeResume && shouldResume) {
        void withOwner(ownerId, () => {
          const latest = getTask(task.id);
          if (latest?.status === "todo" && latest.blocked_approval_id === null) onTaskAssigned(latest);
        });
      }
    });
  agentQueues.set(agent.id, next);
}

/**
 * 审批恢复可能发生在原任务 runTaskWork 刚写入 blocked、但 finally 尚未清掉 runningTasks 的窗口。
 * 直接调用 onTaskAssigned 会被去重后永久丢失，因此必须等当前队列收尾后再按最新任务状态重试。
 */
function resumeAssignedTask(task: Task) {
  if (!task.assignee_agent_id) return;
  if (runningTasks.has(task.id)) {
    resumeAfterRun.add(task.id);
    return;
  }
  onTaskAssigned(task);
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
  // delivery/review 已结束本次执行尝试；未使用的单次网络授权不能带入返工或重新打开后的下一次运行。
  invalidateTaskNetworkApprovals(task.id);
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
  const previous = getTask(taskId);
  const t = updateTask(taskId, { status: statusValue });
  if (t && previous?.status === "doing" && statusValue !== "doing") {
    invalidateTaskNetworkApprovals(taskId);
  }
  if (t) broadcast({ type: "task:upsert", payload: t });
  return t;
}

function emitTaskEvent(task: Task, type: Parameters<typeof createTaskEvent>[0]["type"], summary: string, metadata?: unknown, agentId?: string | null) {
  const event = createTaskEvent({
    task_id: task.id,
    channel_id: task.channel_id,
    project_id: task.project_id,
    agent_id: agentId ?? task.assignee_agent_id,
    type,
    summary,
    metadata,
  });
  broadcast({ type: "task:event", payload: event });
  return event;
}

/** 消费一次任务停止标记并统一收尾；返回 true 表示当前 worker 必须立即退出。 */
function finishStoppedTask(task: Task, channel: Channel, agent: Agent): boolean {
  if (!cancelledTasks.delete(task.id)) return false;
  // stop 必须压过审批/输入落定触发的延迟恢复；否则这里消费 stop 后，
  // finally 仍可能看到 resumeAfterRun 并把刚退回待办的任务重新启动。
  resumeAfterRun.delete(task.id);
  const latest = getTask(task.id);
  if (latest?.status === "cancelled") {
    audit(channel.id, `⏹ 任务「${task.title}」已取消并归档`);
    return true;
  }
  const todo = setTaskStatus(task.id, "todo") ?? latest ?? task;
  emitTaskEvent(todo, "handoff", "用户停止了运行，任务退回待办", undefined, agent.id);
  audit(channel.id, `⏹ 任务「${task.title}」已被用户停止，退回待办`);
  return true;
}

/**
 * 模型 await 返回后重新核验执行权。无工具最终响应期间也可能发生取消、关单或改派，
 * 旧 worker 只能在任务仍 doing 且负责人未变时继续验收/交付。
 */
function finishRevokedTaskExecution(task: Task, channel: Channel, agent: Agent): boolean {
  const latest = getTask(task.id);
  if (latest?.status === "doing" && latest.assignee_agent_id === agent.id) return false;
  if (latest?.status === "doing" && latest.assignee_agent_id !== agent.id) {
    const reassigned = setTaskStatus(task.id, "todo") ?? latest;
    emitTaskEvent(
      reassigned,
      "handoff",
      "任务负责人已变化，旧运行停止并交给新负责人",
      undefined,
      agent.id,
    );
    if (reassigned.assignee_agent_id) resumeAssignedTask(reassigned);
  }
  return true;
}

const PROVIDER_QUALITY_BENCHMARK_PREFIX = "真实模型质量基准：AiTeam 产品落地决策简报";
export const PROVIDER_QUALITY_REVIEW_RESERVE_BILLABLE = Math.max(
  1_000,
  Math.round(Number(process.env.AITEAM_PROVIDER_BENCHMARK_REVIEW_RESERVE) || 6_000),
);
const configuredProviderQualityMaxRevisions = process.env.AITEAM_PROVIDER_BENCHMARK_MAX_REVISIONS;
const parsedProviderQualityMaxRevisions = Number(configuredProviderQualityMaxRevisions);
const PROVIDER_QUALITY_MAX_REVISIONS = Math.max(
  0,
  Math.round(configuredProviderQualityMaxRevisions === undefined
    ? MAX_REVISIONS
    : Number.isFinite(parsedProviderQualityMaxRevisions)
      ? parsedProviderQualityMaxRevisions
      : MAX_REVISIONS),
);

export function isProviderQualityBenchmarkTask(task: Task): boolean {
  return task.title.startsWith(PROVIDER_QUALITY_BENCHMARK_PREFIX);
}

export type ProviderQualityDocumentAssessment = { pass: boolean; gaps: string[] };

const BENCHMARK_SCHEMA_FIELDS: Record<string, ReadonlySet<string>> = {
  tasks: new Set([
    "id", "owner_id", "channel_id", "title", "description", "status", "assignee_agent_id", "reviewer_agent_id",
    "blocked_approval_id", "created_by", "acceptance_criteria", "depends_on", "model_tier", "source_doc_ids",
    "project_id", "revision_count", "usage_json", "budget_billable", "estimate_billable", "created_at", "updated_at",
  ]),
  task_events: new Set(["id", "owner_id", "task_id", "channel_id", "project_id", "agent_id", "type", "summary", "metadata_json", "created_at"]),
  documents: new Set(["id", "owner_id", "channel_id", "task_id", "agent_id", "title", "content", "kind", "version", "superseded_by", "binary_format", "original_blob_path", "template_meta", "created_at", "updated_at"]),
  approvals: new Set(["id", "owner_id", "channel_id", "agent_id", "title", "payload", "status", "kind", "ref_id", "resolved_at", "consumed_at", "created_at"]),
  verdicts: new Set(["id", "owner_id", "task_id", "project_id", "doc_id", "verifier_agent_id", "worker_agent_id", "attempt", "result", "reasons", "source", "created_at"]),
  providers: new Set(["id", "name", "base_url", "api_key", "default_model", "light_model", "max_tokens", "is_official", "web_tools", "is_strong", "price_input_per_million", "price_output_per_million", "price_currency", "created_at"]),
  users: new Set(["id", "email", "password_hash", "display_name", "role", "created_at"]),
  app_settings: new Set(["key", "value"]),
};
const BENCHMARK_TASK_EVENT_TYPES = new Set([
  "created", "claim", "start", "tool", "blocked", "handoff", "delivery", "verification", "approval", "user_close", "cancelled", "failure",
]);
const BENCHMARK_TASK_STATUSES = new Set(["todo", "doing", "review", "blocked", "done", "cancelled"]);

function unsupportedImplementationClaims(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\b/gi)) {
    const table = match[1].toLowerCase();
    const field = match[2].toLowerCase();
    if (BENCHMARK_SCHEMA_FIELDS[table] && !BENCHMARK_SCHEMA_FIELDS[table].has(field)) found.add(`${table}.${field}`);
  }
  for (const match of text.matchAll(/(?:数据库|sqlite|sql|存入|写入|保存(?:在|至)?|落入|查询|新增|创建)[^。\n|]{0,40}\b([a-z][a-z0-9_]*)\b\s*(?:数据)?表/gi)) {
    const table = match[1].toLowerCase();
    if (!BENCHMARK_SCHEMA_FIELDS[table]) found.add(`${table} 表`);
  }
  for (const match of text.matchAll(/`?([a-z][a-z0-9_]*)`?\s*事件/gi)) {
    const eventType = match[1].toLowerCase();
    if (eventType !== "task_events" && !BENCHMARK_TASK_EVENT_TYPES.has(eventType)) found.add(`${eventType} 事件`);
  }
  if (/(?:`?verification`?\s*事件)[^。\n|]{0,80}\bverdict\b|\bverdict\b[^。\n|]{0,80}(?:`?verification`?\s*事件)/i.test(text)) {
    found.add("verification.verdict");
  }
  if (/(?:`?created`?\s*事件)[^。\n|]{0,80}(?:包含|含有)[^。\n|]{0,50}`?(?:goal|brief)`?/i.test(text)) {
    found.add("created.goal/brief");
  }
  if (/(?:`?tool`?\s*事件)[^。\n|]{0,80}(?:非空)?数组/i.test(text)) found.add("tool 事件数组");
  for (const context of text.matchAll(/(?:event\.type\s*字段判断|任务生命周期事件)[^。\n|]{0,220}/gi)) {
    for (const identifier of context[0].matchAll(/`?\b([a-z][a-z0-9_]*)\b`?/gi)) {
      const value = identifier[1].toLowerCase();
      if (["event", "type", "task_events"].includes(value)) continue;
      if (!BENCHMARK_TASK_EVENT_TYPES.has(value)) found.add(`${value} 事件`);
    }
  }
  for (const match of text.matchAll(/\bstatus\s*=\s*([a-z][a-z0-9_]*)\b/gi)) {
    const status = match[1].toLowerCase();
    if (!BENCHMARK_TASK_STATUSES.has(status)) found.add(`status=${status}`);
  }
  for (const identifier of ["brief_generated", "final_close", "task_owner", "vendor_configs"]) {
    if (new RegExp(`\\b${identifier}\\b`, "i").test(text)) found.add(identifier);
  }
  return [...found].slice(0, 8);
}

function providerQualityBenchmarkImplementationFacts(): string[] {
  return [
    "任务目标、简报和验收信息来自 tasks 的 title、description、acceptance_criteria；created 只是事件类型，禁止声称 created 事件含 goal/brief 字段。",
    "返工没有 revise 事件类型；返工证据是新文档版本、verification 事件、tasks.revision_count 和 verdicts 裁决。",
    "独立裁决保存在 verdicts 表；verification 事件本身没有 verdict 字段。",
    "每次工具调用是一条 type=tool 的 task_events 记录，不是 tool 事件数组。",
    `本固定基准当前最多自动返工 ${PROVIDER_QUALITY_MAX_REVISIONS} 次；其他次数、时限、人数、比例和停止条件只能标为建议阈值，不能写成已实现系统规则。`,
  ];
}

function markdownSection(text: string, titlePattern: RegExp): string {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const heading = lines[index].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!heading) continue;
    const title = heading[2].replace(
      /^(?:(?:第\s*)?[一二三四五六七八九十百]+(?:\s*章)?[、.．):：]?|\d+(?:\.\d+)*[.、)]?)\s*/,
      "",
    );
    if (!titlePattern.test(title)) continue;
    const level = heading[1].length;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const next = lines[cursor].match(/^(#{1,6})\s+/);
      if (next && next[1].length <= level) {
        end = cursor;
        break;
      }
    }
    return lines.slice(index + 1, end).join("\n").trim();
  }
  return "";
}

/**
 * 固定质量基准的确定性下限。它不替代独立模型复核，只先拦截“篇幅像报告、证据仍为空”的交付，
 * 避免为明显缺项的文档消耗强模型额度。规则只覆盖七项 rubric 中可机器核验的结构与声明边界。
 */
export function assessProviderQualityBenchmarkDocument(content: string): ProviderQualityDocumentAssessment {
  const text = content.replace(/\r/g, "").trim();
  const gaps: string[] = [];
  const nonWhitespaceLength = Array.from(text.replace(/\s+/g, "")).length;
  if (nonWhitespaceLength < 2_200 || nonWhitespaceLength > 3_800) {
    gaps.push(`全文必须控制在 2200–3800 个非空白字符（含 Markdown 标记），当前 ${nonWhitespaceLength}`);
  }

  const conclusion = markdownSection(text, /^(?:结论|推荐决策|核心决策)/i)
    ?.replace(/\|[^\n]*/g, "")
    .replace(/[`*_#>-]/g, "")
    .replace(/\s+/g, "") ?? "";
  if (!conclusion) gaps.push("缺少结论/推荐决策章节及明确正文");
  else if (Array.from(conclusion).length < 70 || Array.from(conclusion).length > 100) {
    gaps.push(`开头结论必须为 70–100 个非空白字符，当前 ${Array.from(conclusion).length}`);
  }

  for (const label of ["目标用户", "核心待办", "产品边界"]) {
    if (!text.includes(label)) gaps.push(`缺少“${label}”的明确说明`);
  }

  const workflowSection = markdownSection(text, /工作流.*证据|核心工作流/);
  const workflowSteps = ["goal", "brief", "claim", "work", "review", "revise", "human close"];
  const missingSteps = workflowSteps.filter((step) =>
    !new RegExp(`^\\|\\s*${step.replace(" ", "\\s+")}\\s*\\|`, "im").test(workflowSection),
  );
  if (missingSteps.length > 0) gaps.push(`七步工作流表缺少独立行：${missingSteps.join("、")}`);
  if (!workflowSection || !/(?:责任人|负责人)/.test(workflowSection) || !/(?:可验证证据|证据)/.test(workflowSection)) {
    gaps.push("七步工作流必须用表格同时标明责任人和可验证证据");
  }

  const planSection = markdownSection(text, /(?:14\s*天.*计划|计划.*14\s*天)/i);
  if (!planSection) gaps.push("缺少 14 天落地计划");
  for (const label of ["优先级", "负责人", "退出条件", "建议阈值"]) {
    if (!planSection.includes(label)) gaps.push(`14 天计划缺少“${label}”`);
  }
  const planRows = planSection.split("\n").filter((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith("|") &&
      !/^\|?\s*:?-{3}/.test(trimmed) &&
      !/(?:优先级).*(?:阶段目标)/.test(trimmed);
  });
  if (planSection && planRows.length < 3) {
    gaps.push("14 天计划至少需要 3 个按优先级/时间拆分的执行阶段");
  }

  const riskSection = markdownSection(text, /风险/);
  const riskRows = riskSection.split("\n").filter((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith("|") && !/^-?\|?\s*:?-{3}/.test(trimmed) && !/(?:风险).*(?:缓解动作)/.test(trimmed);
  });
  const nestedRisks = [...riskSection.matchAll(/^#{2,6}\s*(?:风险|依赖)\s*\d+/gmi)].length;
  const riskCount = nestedRisks > 0 ? nestedRisks : riskRows.length;
  if (!riskSection || riskCount < 3 || !riskSection.includes("缓解动作") || !riskSection.includes("停止条件")) {
    gaps.push("关键风险不足 3 项，或缺少逐项缓解动作/停止条件");
  }

  const sourceSection = markdownSection(text, /^(?:来源与假设|来源和假设)/);
  if (!sourceSection) gaps.push("缺少“来源与假设”章节");
  if (!sourceSection.split("\n").some((line) => line.trim() === "本次未使用外部资料。")) {
    gaps.push("“来源与假设”必须用独立一行逐字声明：本次未使用外部资料。");
  }
  if (!/(?:任务简报|运行事件)/.test(text)) gaps.push("未说明内部事实来自任务简报或运行事件");
  const unqualifiedExternalClaim = text.split(/[。！？\n]/).find((sentence) =>
    /(?:数据显示|调研表明|市场规模|客户反馈(?:显示|表明)|根据[^，。]{0,30}报告)/.test(sentence) &&
    !/(?:https?:\/\/|假设|待验证|待核实|建议阈值|不得虚构)/.test(sentence),
  );
  if (unqualifiedExternalClaim) gaps.push("存在未给 URL、也未标为假设/待验证的外部事实声明");

  const unsupportedClaims = unsupportedImplementationClaims(text);
  if (unsupportedClaims.length > 0) {
    gaps.push(`存在与当前实现不符或任务未提供的精确字段/事件/状态声明：${unsupportedClaims.join("、")}`);
  }

  const substantiveLines = text.split("\n")
    .map((line) => line.replace(/^#{1,6}\s*/, "").trim())
    .filter((line) => line.length >= 80 && !line.startsWith("|"));
  const normalizedLineCounts = new Map<string, number>();
  for (const line of substantiveLines) {
    const normalized = line.replace(/[\s，。；：、！？,.!?:;（）()“”"'`*_#>-]/g, "").toLowerCase();
    normalizedLineCounts.set(normalized, (normalizedLineCounts.get(normalized) ?? 0) + 1);
  }
  if ([...normalizedLineCounts.values()].some((count) => count >= 3)) {
    gaps.push("存在同一大段内容重复 3 次以上的填充，必须改为各阶段独立、可执行的信息");
  }
  if (/\[(?:仅一个|分别明确|说明如何|至少三项|另起一段)[^\]]*\]|\|\s*\.\.\.\s*\|/.test(text)) {
    gaps.push("交付物仍包含固定骨架占位符，必须替换为真实内容");
  }

  const selfCheck = markdownSection(text, /自查/);
  if (!selfCheck) gaps.push("缺少文末逐条自查表");
  else {
    const missingItems = Array.from({ length: 7 }, (_, index) => index + 1).filter((item) =>
      !new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?\\|?\\s*(?:\\*{1,2}|_{1,2})?\\s*${item}\\s*(?:[.、）)]|\\|)`, "m").test(selfCheck),
    );
    if (missingItems.length > 0) gaps.push(`自查表缺少验收项：${missingItems.join("、")}`);
    if (!/(?:正文证据位置|证据位置|章节)/.test(selfCheck)) gaps.push("自查表没有给出正文证据位置");
  }

  return { pass: gaps.length === 0, gaps };
}

const PROVIDER_QUALITY_EVIDENCE_NORMALIZATIONS: Array<[RegExp, string, string]> = [
  [/\btasks\.goal\b/gi, "任务目标", "tasks.goal→任务目标"],
  [/\bgoal_created\b/gi, "created", "goal_created→created"],
  [/\bbrief_generated\b/gi, "created", "brief_generated→created"],
  [/\bclaim_started\b/gi, "claim", "claim_started→claim"],
  [/\bwork_in_progress\b/gi, "tool", "work_in_progress→tool"],
  [/\breview_started\b/gi, "verification", "review_started→verification"],
  [/\brevise_started\b/gi, "verification", "revise_started→verification"],
  [/\bfinal_closed\b/gi, "user_close", "final_closed→user_close"],
  [/\bfinal_close\b/gi, "user_close", "final_close→user_close"],
  [/\brevise\b(\s*)事件/gi, "verification$1事件", "revise 事件→verification 事件"],
  [/\bclose\b(\s*)事件/gi, "user_close$1事件", "close 事件→user_close 事件"],
  [/\bstatus\s*=\s*closed\b/gi, "status=done", "status=closed→status=done"],
  [/\btask_owner\b/gi, "当前负责人", "task_owner→当前负责人"],
  [/\bvendor_configs\b/gi, "providers", "vendor_configs→providers"],
];

/**
 * 固定基准只对已知旧别名做窄范围、可审计的词汇校准；未知声明仍由机器契约 fail-closed。
 * 这不是润色器，也不会补写缺失章节、来源或质量内容。
 */
export function normalizeProviderQualityBenchmarkDocument(content: string) {
  let normalized = content;
  const replacements: string[] = [];
  for (const [pattern, replacement, label] of PROVIDER_QUALITY_EVIDENCE_NORMALIZATIONS) {
    const count = normalized.match(pattern)?.length ?? 0;
    if (count === 0) continue;
    normalized = normalized.replace(pattern, replacement);
    replacements.push(`${label}×${count}`);
  }
  return { content: normalized, replacements };
}

function providerQualityBenchmarkTools(): Anthropic.ToolUnion[] {
  const writeDocument = TOOLS.find((tool) => "name" in tool && tool.name === "write_document");
  return writeDocument ? [writeDocument] : [];
}

export function providerQualityBenchmarkScaffold(): string {
  return [
    "请严格使用以下 Markdown 骨架；保留全部章节、表头、固定结论和七个英文步骤名。七步表中的责任人与证据词汇已经按当前实现校准，只能解释其业务意义，不得替换成自行猜测的字段或事件名。可在其他章节扩写，但不要新增一段开头摘要：",
    "# AiTeam 14 天产品落地决策简报",
    "## 结论与推荐决策",
    "建议立即以“任务简报→AI认领→过程留痕→独立复核→自动返工→人工关单”为唯一首测主线，用14天验证真实用户能否稳定获得可审计、可返工、可交付的决策成果；未达三重验收即停止扩展功能。",
    "## 目标用户、核心待办与产品边界",
    "[分别明确写出：目标用户、核心待办、产品边界]",
    "## 核心工作流与证据",
    "| 步骤 | 责任人 | 可验证证据 | 失败处理 |",
    "|---|---|---|---|",
    "| goal | 人类发起人 | 任务标题、目标与 created 事件 | 缺少目标则不进入执行 |",
    "| brief | 人类发起人 | 任务描述、预期交付物与验收标准 | 信息不全则退回补充 |",
    "| claim | AI 执行者 | claim 事件与当前负责人 | 未认领不得执行 |",
    "| work | AI 执行者 | tool 事件与 documents 当前版交付物 | 阻塞则等待输入 |",
    "| review | 独立复核人 | verification 事件与 verdicts 结构化裁决 | 未通过则进入 revise |",
    "| revise | AI 执行者 | 新文档版本、verification 事件与返工计数 | 达上限转人工复核 |",
    "| human close | 人类发起人 | 人工确认清单与 user_close 事件 | 三重验收未完成不得关单 |",
    "## 按优先级排序的 14 天计划",
    "| 优先级/时间 | 阶段目标 | 负责人 | 退出条件 | 可量化验收指标（建议阈值） |",
    "|---|---|---|---|---|",
    "| P0 / 第 1–3 天 | ... | ... | ... | ... |",
    "| P0 / 第 4–7 天 | ... | ... | ... | ... |",
    "| P1 / 第 8–14 天 | ... | ... | ... | ... |",
    "## 执行与验证细则",
    "[说明如何采集证据、判断失败并处理最早断点，确保全文达到要求的信息量]",
    "## 关键风险、缓解动作与停止条件",
    "| 风险/依赖 | 缓解动作 | 停止条件 |",
    "|---|---|---|",
    "| ... | ... | ... |",
    "[至少三项]",
    "## 来源与假设",
    "本次未使用外部资料。",
    "[另起一段说明内部事实边界、未调用的外部工具，以及所有数字均为建议阈值]",
    "## 交付自查表",
    "| 标准 | 状态 | 正文证据位置 |",
    "|---|---|---|",
    "| 1 | 满足/不满足 | ... |",
    "| 2 | 满足/不满足 | ... |",
    "| 3 | 满足/不满足 | ... |",
    "| 4 | 满足/不满足 | ... |",
    "| 5 | 满足/不满足 | ... |",
    "| 6 | 满足/不满足 | ... |",
    "| 7 | 满足/不满足 | ... |",
  ].join("\n");
}

export function buildProviderQualityBenchmarkBrief(task: Task): string {
  return [
    "你正在完成 AiTeam 的固定、隔离质量基准。以下内容就是全部可信输入，不需要也不允许读取工作区其他文档、技能、记忆或联网资料。",
    "",
    `任务：${task.title}`,
    `详情：${task.description || "（无）"}`,
    task.acceptance_criteria ? `验收标准：\n${task.acceptance_criteria}` : "",
    "",
    "可作为事实使用的内部证据仅限：",
    "- 本任务由人类发起并带有结构化简报与验收标准；",
    "- 执行者已通过 claim 事件认领，过程工具调用会写入 task_events；",
    "- 任务显式指定独立 reviewer，未通过会由引擎触发返工；",
    "- 最终关单由人类确认；",
    "- 当前产品已经有 Electron 桌面客户端和 `/aiteam/` 响应式 Web 工作区，不是 CLI 原型；",
    "- 工作区已经包含目标输入、任务看板、收件箱、文档、团队和用量界面；",
    "- 当前已经使用 SQLite 持久化任务、文档、task_events、审批、用户与供应商配置；",
    "- 当前已经有 standalone 登录、admin/member 角色门控、任务负责人、独立复核人、返工、审批和人工关单；",
    "- 当前已经支持模型供应商、Skills、MCP 和可选 Seedream 生图；网络 MCP 受单次审批约束。",
    "- Helio 只作为交互机制的灵感来源；本基准没有提供任何 Helio 或市场事实，禁止写竞品能力、融资、用户、市场规模等外部主张。",
    "- 精确实现口径（写工作流证据时必须逐条遵守）：",
    ...providerQualityBenchmarkImplementationFacts().map((fact) => `  - ${fact}`),
    "",
    "输出约束：",
    "1. 写成 2200–3800 个非空白字符（含 Markdown 标记）的中文创始人决策简报，结论先行、信息密度高，拒绝堆篇幅；开头“结论与推荐决策”章节只能放一个 70–100 个非空白字符的纯文本段落，不加引用、注释、第二段或“共 X 字”自报计数。",
    "2. 计划和指标可以作为待验证的决策阈值，但必须明确标为“建议阈值”，不能伪装成已有数据。",
    "3. 产品边界必须以上述已实现能力为起点，禁止把已有桌面/Web UI、SQLite、登录权限或任务闭环写成尚未开发。",
    "4. 只可复述上方提供的能力，不得自行编造数据库字段名、事件类型、状态值、生产部署状态或用户反馈；例如不要写 tasks.goal、brief_generated、final_close、status=closed 等未提供细节。",
    "4a. 上方逐条列出的产品能力与精确实现口径本身就是本任务可信证据；不要反过来把它们标成‘未在任务上下文中提供’或‘待验证’。",
    "5. “来源与假设”章节必须逐字包含独立句子“本次未使用外部资料。”，并说明内部事实来自任务简报与运行事件；不得声称调用过 web_search、web_fetch、MCP 或任何未提供工具。",
    "6. 只调用一次 write_document，kind=report，把完整正文放入文档；不要在工具调用前后输出长篇正文。",
    "7. 文末逐条自查七项验收标准，不能用“已满足”代替正文证据位置，也不要声称未实际计算的字数。",
    "8. 七步工作流必须各占表格一行，14 天计划至少拆成三个阶段；不得保留骨架占位符，也不得复制同一大段内容来凑篇幅。",
    "",
    providerQualityBenchmarkScaffold(),
  ].filter(Boolean).join("\n");
}

export function buildProviderQualityBenchmarkReworkBrief(task: Task, feedback: string): string {
  const current = listDocuments().find((doc) => doc.task_id === task.id && doc.kind === "report");
  return [
    buildProviderQualityBenchmarkBrief(task),
    "",
    "返工说明：固定质量基准的上一版未通过复核。你处于隔离上下文，上方可信输入、输出约束和固定骨架仍须全部遵守；请依据下方意见重写完整报告，并再次只调用一次 write_document 交付。",
    `复核意见：\n${feedback}`,
    current ? `上一版全文（只用于修订，不代表其中事实可信）：\n<previous>\n${current.content.slice(0, 12000)}\n</previous>` : "",
    "返工时先删除上一版中所有复核指出的内容，再按固定骨架从头生成；不得因复用上一版而保留未经上方可信输入支持的精确实现声明。",
  ].filter(Boolean).join("\n\n");
}

function pauseTaskAfterWorkIfBudgetReached(agent: Agent, taskId: string, reserveForVerification = 0): boolean {
  const live = getTask(taskId);
  if (!live || live.status !== "doing") return live?.status === "blocked";
  const budget = live.budget_billable > 0 ? live.budget_billable : Number(process.env.AITEAM_TASK_TOKEN_BUDGET ?? 0);
  if (budget <= 0) return false;
  const spent = taskSpentBillable(live);
  if (spent < budget && spent + reserveForVerification <= budget) return false;
  requestBudgetPauseForTask(agent, live, spent, budget, reserveForVerification > 0
    ? { resumePhase: "verification", reviewReserveBillable: reserveForVerification }
    : undefined);
  return true;
}

export function shouldResumeAtVerification(taskId: string): boolean {
  const approval = listApprovals()
    .filter((item) => item.kind === "budget" && item.ref_id === taskId && item.status === "approved" && item.resolved_at)
    .sort((a, b) => (b.resolved_at ?? 0) - (a.resolved_at ?? 0))[0];
  if (approval?.resolved_at) {
    let resumePhase = "";
    try {
      const payload = JSON.parse(approval.payload || "{}") as { resume_phase?: unknown };
      resumePhase = typeof payload.resume_phase === "string" ? payload.resume_phase : "";
    } catch {
      resumePhase = "";
    }
    if (resumePhase === "verification") {
      const docs = listDocuments().filter((doc) => doc.task_id === taskId);
      if (docs.length > 0 && !listVerdictsForTask(taskId).some((verdict) => verdict.created_at >= approval.resolved_at!)) return true;
    }
  }

  // Electron / 服务端若在强模型复核期间退出，当前版文档已经通过机器预检；重启后只能重跑复核，
  // 不能把 doing 误当成尚未生成并再次调用执行模型。用“当前版之后开始复核、但尚无裁决”识别该断点。
  const task = getTask(taskId);
  if (!task || task.status !== "doing" || !isProviderQualityBenchmarkTask(task)) return false;
  const latestDoc = listDocuments()
    .filter((doc) => doc.task_id === taskId)
    .sort((a, b) => b.created_at - a.created_at)[0];
  if (!latestDoc) return false;
  const interruptedReview = listTaskEvents(taskId)
    .filter((event) => event.type === "verification" && event.created_at >= latestDoc.created_at && event.summary.includes("开始验收交付物"))
    .sort((a, b) => b.created_at - a.created_at)[0];
  if (!interruptedReview) return false;
  return !listVerdictsForTask(taskId).some((verdict) => verdict.created_at >= interruptedReview.created_at);
}

async function runTaskWork(agent: Agent, taskId: string) {
  let task = getTask(taskId);
  if (!task) return;
  if (task.status === "cancelled") {
    cancelledTasks.delete(taskId);
    resumeAfterRun.delete(taskId);
    return;
  }
  if (task.status === "done" || task.status === "review" || task.status === "blocked") return;
  if (cancelledTasks.delete(taskId)) {
    resumeAfterRun.delete(taskId);
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

  // D2 开工估价：按历史同档已交付任务的实际消耗给中位数预期（无历史不硬编数字）。
  // 只在首次开工时写入（阻塞恢复/重启恢复会重进本函数，别把估价刷成新值导致口径漂移）。
  let estimate = task.estimate_billable;
  if (!estimate) {
    estimate = estimateTaskBillable(task.model_tier);
    if (estimate > 0) task = updateTask(task.id, { estimate_billable: estimate }) ?? task;
  }
  const resumeAtVerification = shouldResumeAtVerification(task.id);
  audit(
    channel.id,
    resumeAtVerification
      ? `🔎 ${agent.name} 恢复任务「${task.title}」，从已生成交付物的独立复核继续，不重复生成初稿`
      : `🚀 ${agent.name} 开始处理任务「${task.title}」${task.model_tier === "light" ? "（⚡ 轻量通道）" : ""}${estimate > 0 ? `（按历史同档任务预计 ~${estimate.toLocaleString()} 计费 token）` : ""}`
  );
  emitTaskEvent(
    task,
    "start",
    resumeAtVerification ? `${agent.name} 从独立复核继续任务` : `${agent.name} 开始处理任务`,
    { model_tier: task.model_tier, estimate_billable: estimate || undefined, ...(resumeAtVerification ? { resume_phase: "verification" } : {}) },
    agent.id,
  );
  setTaskStatus(task.id, "doing");

  let feedback: string | null = null; // 上一轮验收意见（返工时注入）
  let lastDocIds: string[] = resumeAtVerification
    ? listDocuments().filter((doc) => doc.task_id === task.id).map((doc) => doc.id)
    : [];
  const qualityBenchmark = isProviderQualityBenchmarkTask(task);
  const revisionLimit = qualityBenchmark ? PROVIDER_QUALITY_MAX_REVISIONS : MAX_REVISIONS;
  let skipWorkOnce = resumeAtVerification;
  const initialAttempt = resumeAtVerification ? Math.min(task.revision_count, revisionLimit) : 0;

  for (let attempt = initialAttempt; attempt <= revisionLimit; attempt++) {
    if (!skipWorkOnce) {
      const ctx = newCtx(agent, channel, "work", task.id);
      const prompt = qualityBenchmark
        ? feedback
          ? buildProviderQualityBenchmarkReworkBrief(task, feedback)
          : buildProviderQualityBenchmarkBrief(task)
        : feedback
          ? buildReworkBrief(task, channel, feedback)
          : buildWorkBrief(task, channel);
      await streamRun(ctx, prompt, qualityBenchmark ? 1 : MAX_WORK_ITERATIONS, 0, {
        tier: task.model_tier === "light" ? "light" : "standard",
        ...(qualityBenchmark
          ? { toolsOverride: providerQualityBenchmarkTools(), contextMode: "isolated" as const, maxTokens: 6000 }
          : {}),
      });
      lastDocIds = ctx.createdDocIds.length > 0 ? ctx.createdDocIds : lastDocIds;
      const afterRun = getTask(task.id);
      if (ctx.halted === "blocked" || afterRun?.status === "blocked") return;
      if (finishStoppedTask(task, channel, agent)) return;
      if (finishRevokedTaskExecution(task, channel, agent) || ctx.halted === "stopped") return;
    } else {
      skipWorkOnce = false;
    }

    const verdict = await runVerification(agent, channel, task.id, lastDocIds, attempt);
    // 验收也是可耗时的模型运行；stop 可能在 await 期间到达，必须在处理 pass/revise 前再检查一次。
    if (verdict.result === "paused") return;
    if (finishStoppedTask(task, channel, agent)) return;
    if (finishRevokedTaskExecution(task, channel, agent)) return;
    if (verdict.result === "pass") {
      if (verdict.reasons) audit(channel.id, `✅ 验收通过：任务「${task.title}」`);
      break;
    }
    feedback = verdict.reasons || "验收未通过，请对照验收标准修订。";
    const fresh = getTask(task.id);
    const revisions = (fresh?.revision_count ?? 0) + 1;
    updateTask(task.id, { revision_count: revisions });
    if (attempt >= revisionLimit) {
      // D1 返工差距结构化：达上限不再只说"请人工把关"——把最后一轮未解决的差距原样带给人，
      // 人工复核不用回频道翻验收长文（差距全文在事件 metadata，audit 只给首行摘要）。
      const gapBrief = feedback.replace(/\s+/g, " ").slice(0, 120);
      emitTaskEvent(task, "verification", `已达返工上限（${revisionLimit} 次），转待评审。未解决差距见 metadata`, { result: "gap", reasons: feedback.slice(0, 2000), revision_count: revisions }, agent.id);
      audit(channel.id, `⚠️ 任务「${task.title}」已达返工上限（${revisionLimit} 次），转入待评审请人工把关。未解决差距：${gapBrief}…`);
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
      emitTaskEvent(review, "delivery", `${agent.name} 已交付任务，转入待评审`, { doc_ids: lastDocIds }, agent.id);
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
  const approvedNetworkGrants = listApprovals()
    .filter(
      (approval) =>
        approval.ref_id === task.id &&
        approval.agent_id === task.assignee_agent_id &&
        approval.status === "approved" &&
        !approval.consumed_at,
    )
    .map((approval) => networkGrantFromApproval(approval))
    .filter((grant): grant is NetworkGrantV1 => Boolean(grant));
  const networkGrantSection = approvedNetworkGrants.length > 0
    ? `\n## 用户刚批准的单次网络调用\n` +
      approvedNetworkGrants
        .map((grant) => `- 工具：${grant.tool}\n  参数：${JSON.stringify(grant.input)}\n  要求：优先原样执行；授权只可使用一次，改工具或改参数必须重新审批。`)
        .join("\n")
    : "";
  const transcript = buildTranscript(channel.id, 20);
  // 目标链（借鉴 Paperclip）：让任务知道自己服务于什么目标
  const project = task.project_id ? getProject(task.project_id) : undefined;
  const assigneeName = task.assignee_agent_id ? getAgent(task.assignee_agent_id)?.name ?? "未知" : "未分配";
  const reviewerName = task.reviewer_agent_id ? getAgent(task.reviewer_agent_id)?.name ?? "未知" : "系统自动选择";
  const recentEvents = listTaskEvents(task.id)
    .slice(-8)
    .map((e) => `- ${fmtTime(e.created_at)} [${e.type}] ${e.summary}`)
    .join("\n");
  return [
    `你被指派了一个任务，请现在完成它。`,
    ``,
    project ? `所属项目：「${project.title}」—— 项目目标：${project.goal || "（见任务详情）"}\n你的任务是该目标的一环，交付物要服务于整体目标。` : "",
    `任务：${task.title}`,
    `详情：${task.description || "（无）"}`,
    `负责人：${assigneeName}`,
    `指定复核人：${reviewerName}`,
    task.acceptance_criteria ? `验收标准（交付物将被逐条核验）：\n${task.acceptance_criteria}` : "",
    `所在频道：#${channel.name}`,
    recentEvents ? `最近任务活动：\n${recentEvents}` : "",
    depSection,
    sourceSection,
    networkGrantSection,
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
    `7. 如果你被明确委派但任务未归属你，先用 claim_task 接手；如果被事实、权限、选择或安全边界阻塞，调用 request_clarification 暂停任务并向用户要输入，不要烧迭代或假装完成；`,
    `8. 如发现衍生工作，可用 create_task 开新任务并指派给合适的同事。`,
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

/**
 * 验收去人设（docs/harness-analysis.html · 校验者去人设）：verify 运行不再使用被选中同事的
 * 日常人设 system prompt，统一替换为这份固定校验者指令——判准与"谁碰巧当校验者"解耦，
 * 同一交付物换任何人复核，结论都应可重复。人选仍按交付物类型对口路由（pickVerifier），
 * 领域敏感度保留在"选谁"，判准统一在"怎么判"。
 */
export const VERIFIER_SYSTEM_PROMPT = [
  `你是一名独立的交付校验者。本次运行中你唯一的职责是：以挑剔的第三方视角，按验收标准逐条核验交付物，并通过 submit_verdict 提交结构化裁决。`,
  `判准恒定，不受团队氛围与个人风格影响：`,
  `- 只认可验证的证据：声称的数字要有来源，声称的产出要与实际交付一致；`,
  `- 不因文风流畅、篇幅可观或态度诚恳加分，不因返工麻烦而放水；`,
  `- 事实拿不准时倾向 revise，并指出需要补充的证据，而不是善意脑补；`,
  `- 理由必须具体、可执行：指出哪一条标准、差在哪里、怎么补。`,
].join("\n");

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

export function resolveTaskReviewer(task: Task, others: Agent[], kind: string | null | undefined, worker: Agent): Agent {
  const explicit = task.reviewer_agent_id ? getAgent(task.reviewer_agent_id) : undefined;
  return explicit ?? pickVerifier(others, kind, task.created_by, worker);
}

async function runVerification(
  worker: Agent,
  channel: Channel,
  taskId: string,
  docIds: string[],
  attempt = 0
): Promise<{ result: "pass" | "revise" | "paused"; reasons: string }> {
  const task = getTask(taskId);
  if (!task) return { result: "pass", reasons: "" };
  if (isMock()) return { result: "pass", reasons: "" }; // 全局 Mock 跳过验收

  const others = channelAgents(channel).filter((a) => a.id !== worker.id);
  // SOLO/DM（无其他同事）不再无条件放行（V1）：由本人在净上下文里做 fail-closed 自校验。
  const soloSelfCheck = others.length === 0;

  // 裁决统一从这里落表（D1）：频道消息流不可聚合，质量度量以 verdicts 表为准。
  const recordVerdict = (result: "pass" | "revise", reasons: string, source: "auto" | "solo" | "fallback", verifierId: string | null, docId: string | null) => {
    createVerdict({
      task_id: task.id,
      project_id: task.project_id,
      doc_id: docId,
      verifier_agent_id: verifierId,
      worker_agent_id: worker.id,
      attempt,
      result,
      reasons,
      source,
    });
  };

  // 先锚定该任务的「当前版」交付物（listDocuments 已只返当前版），再按其 kind 选对口校验者。
  // 优先 report，否则取最新当前版；兜底用本轮 createdDocIds 末位。
  const taskDocs = listDocuments().filter((d) => d.task_id === taskId);
  const doc =
    taskDocs.find((d) => d.kind === "report") ??
    taskDocs[0] ??
    (docIds.length > 0 ? getDocument(docIds[docIds.length - 1]) : undefined);
  if (!doc) {
    const reasons = "没有找到交付物文档：必须用 write_document 提交正式交付物。";
    recordVerdict("revise", reasons, "fallback", null, null);
    return { result: "revise", reasons };
  }

  if (isProviderQualityBenchmarkTask(task)) {
    const assessment = assessProviderQualityBenchmarkDocument(doc.content);
    if (!assessment.pass) {
      // 已经实际触线时先暂停，避免机器预检失败后又直接发起一轮付费返工。
      if (pauseTaskAfterWorkIfBudgetReached(worker, task.id)) return { result: "paused", reasons: "等待预算审批" };
      const reasons = `机器契约预检未通过：\n${assessment.gaps.map((gap, index) => `${index + 1}. ${gap}`).join("\n")}`;
      emitTaskEvent(
        task,
        "verification",
        `机器契约预检要求返工（${assessment.gaps.length} 项差距）`,
        { result: "revise", stage: "document_contract", gaps: assessment.gaps, doc_id: doc.id },
        null,
      );
      recordVerdict("revise", reasons, "fallback", null, doc.id);
      return { result: "revise", reasons };
    }
    emitTaskEvent(
      task,
      "verification",
      "机器契约预检通过，进入独立强模型复核",
      { result: "pass", stage: "document_contract", gaps: [], doc_id: doc.id },
      null,
    );
    // 只有机器可核验的下限已满足，才为强模型语义复核预留额度并发起付费调用。
    if (pauseTaskAfterWorkIfBudgetReached(worker, task.id, PROVIDER_QUALITY_REVIEW_RESERVE_BILLABLE)) {
      return { result: "paused", reasons: "等待独立复核预算审批" };
    }
  }
  // 多交付物全核验（D1）：report+slides+sheet 组合交付时，其余当前版一并注入（此前只核主文档，
  // 副交付物是免检通道）。主文档给大头预算，其余按剩余预算截断注入。
  const extraDocs = taskDocs.filter((d) => d.id !== doc.id);
  const observedTools = Array.from(new Set(listTaskEvents(task.id)
    .filter((event) => event.type === "tool")
    .map((event) => {
      try {
        const meta = JSON.parse(event.metadata_json || "{}") as { tool?: unknown };
        return typeof meta.tool === "string" ? meta.tool : "";
      } catch {
        return "";
      }
    })
    .filter(Boolean)));

  // 显式 reviewer 优先；未指定时按交付物类型选对口校验者。
  const verifier = resolveTaskReviewer(task, others, doc.kind, worker);

  audit(channel.id, `🔎 ${verifier.name} 开始${soloSelfCheck ? "自检" : "验收"}任务「${task.title}」的交付物`);
  emitTaskEvent(task, "verification", `${verifier.name} 开始验收交付物《${doc.title}》`, { doc_id: doc.id, kind: doc.kind }, verifier.id);

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
    `交付类型质量标准（结合任务规模判断；不适用项说明理由，不机械凑数）：\n${deliverableQualityRubric(doc.kind).map((item) => `- ${item}`).join("\n")}`,
    isProviderQualityBenchmarkTask(task)
      ? `本固定基准的可信实现口径（这是任务证据，不得要求作者改标为待验证）：\n${providerQualityBenchmarkImplementationFacts().map((fact) => `- ${fact}`).join("\n")}`
      : ``,
    ``,
    `交付物《${doc.title}》（${doc.kind}）全文：`,
    `<deliverable>`,
    stripLoneSurrogates(doc.content.slice(0, extraDocs.length > 0 ? 12000 : 16000)),
    `</deliverable>`,
    ...extraDocs.slice(0, 3).flatMap((d) => [
      ``,
      `同任务交付物《${d.title}》（${d.kind}，一并核验，不是参考资料）：`,
      `该交付物质量标准：\n${deliverableQualityRubric(d.kind).map((item) => `- ${item}`).join("\n")}`,
      `<deliverable>`,
      stripLoneSurrogates(d.content.slice(0, 3000)),
      `</deliverable>`,
    ]),
    renderInfo,
    `本任务真实工具事件：${observedTools.length > 0 ? observedTools.join(", ") : "无"}。这是审计账本；交付物若声称使用了清单外的检索、插件或工具，必须判 revise。`,
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
  ];

  const ctx = newCtx(verifier, channel, "verify", task.id);
  // 验收是质量闭环的下限：官方通道可用时强制走最强模型
  await streamRun(ctx, prompt, 1, 0, {
    toolsOverride: verifierTools,
    preferStrong: true,
    contextMode: "isolated",
    maxTokens: 2000,
  });
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
    await streamRun(ctx, retryPrompt, 1, 0, {
      toolsOverride: verifierTools,
      preferStrong: true,
      contextMode: "isolated",
      maxTokens: 2000,
    });
  }
  if (!ctx.verdict) {
    // 两轮仍无结构化裁决：fail-closed，退回返工兜住，绝不放水（质量下限关键修复）
    audit(channel.id, `⚠️ ${verifier.name} 两轮均未提交结构化裁决，按未通过处理并退回修订`);
    emitTaskEvent(task, "verification", `${verifier.name} 未提交结构化裁决，按未通过处理`, { result: "revise" }, verifier.id);
    recordVerdict("revise", NO_VERDICT_FALLBACK.reasons, "fallback", verifier.id, doc.id);
    return NO_VERDICT_FALLBACK;
  }
  emitTaskEvent(task, "verification", `${verifier.name} 验收${ctx.verdict.result === "pass" ? "通过" : "要求返工"}`, { result: ctx.verdict.result, reasons: ctx.verdict.reasons }, verifier.id);
  recordVerdict(ctx.verdict.result, ctx.verdict.reasons, soloSelfCheck ? "solo" : "auto", verifier.id, doc.id);
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

function clarificationResponse(approval: Approval): string {
  try {
    const parsed = JSON.parse(approval.payload || "{}") as { user_response?: unknown; proposed_default?: unknown };
    const response = typeof parsed.user_response === "string" ? parsed.user_response.trim() : "";
    if (response) return response;
    return typeof parsed.proposed_default === "string" ? parsed.proposed_default.trim() : "";
  } catch {
    return "";
  }
}

/**
 * D2 预算护栏：任务累计消耗触线 → 暂停任务并开 budget 审批（复用 clarification 的 blocked/恢复通道）。
 * 语义：批准 = 在当前消耗之上追加一个预算周期继续跑；拒绝 = 保持暂停（人工在看板改预算或收尾）。
 */
export function requestBudgetPauseForTask(
  agent: Agent,
  task: Task,
  spent: number,
  budget: number,
  options?: { resumePhase?: "work" | "verification"; reviewReserveBillable?: number },
): { approvalId: string; task: Task } {
  if (task.status === "blocked" && task.blocked_approval_id) {
    const active = getApproval(task.blocked_approval_id);
    if (active?.kind === "budget" && active.status === "pending") return { approvalId: active.id, task };
  }
  // 预算触线意味着当前执行上下文已暂停；此前批准但尚未消费的 network grant
  // 不得跨越新的预算决策继续生效。
  invalidateTaskNetworkApprovals(task.id);
  const reviewReserve = Math.max(0, Math.round(options?.reviewReserveBillable ?? 0));
  const resumeAtVerification = options?.resumePhase === "verification" && reviewReserve > 0;
  const remaining = Math.max(0, budget - spent);
  const approval = createApproval({
    channel_id: task.channel_id,
    agent_id: agent.id,
    title: `${resumeAtVerification ? "独立复核预算不足" : "超预算暂停"}：「${task.title.slice(0, 100)}」`,
    payload: JSON.stringify(
      {
        spent_billable: spent,
        budget_billable: budget,
        ...(resumeAtVerification
          ? { resume_phase: "verification", review_reserve_billable: reviewReserve, remaining_billable: remaining }
          : {}),
        note: resumeAtVerification
          ? "初稿已保留；批准 = 追加同额预算并直接进入独立复核，不重复生成初稿；拒绝 = 保持暂停。"
          : "批准 = 追加同额预算并继续执行；拒绝 = 保持暂停（可在看板调整预算或直接转人工收尾）。",
      },
      null,
      2
    ),
    kind: "budget",
    ref_id: task.id,
  });
  const next = updateTask(task.id, { status: "blocked", blocked_approval_id: approval.id }) ?? task;
  broadcast({ type: "approval:upsert", payload: approval });
  broadcast({ type: "task:upsert", payload: next });
  const pauseSummary = resumeAtVerification
    ? `已生成初稿；剩余 ${remaining.toLocaleString()} 不足独立复核预留 ${reviewReserve.toLocaleString()}（计费 token），暂停待批`
    : `累计消耗 ${spent.toLocaleString()} 已达预算 ${budget.toLocaleString()}（计费 token），暂停待批`;
  emitTaskEvent(next, "blocked", pauseSummary, {
    approval_id: approval.id,
    spent_billable: spent,
    budget_billable: budget,
    ...(resumeAtVerification ? { resume_phase: "verification", review_reserve_billable: reviewReserve } : {}),
  }, agent.id);
  if (next.channel_id) audit(next.channel_id, `⏸️ 任务「${next.title}」${pauseSummary}`);
  return { approvalId: approval.id, task: next };
}

export function onBudgetResolved(approval: Approval, approved: boolean) {
  if (approval.kind !== "budget" || !approval.ref_id) return;
  const task = getTask(approval.ref_id);
  if (!task) return;
  if (task.status !== "blocked" || task.blocked_approval_id !== approval.id) return;
  let resumePhase: "work" | "verification" = "work";
  try {
    const payload = JSON.parse(approval.payload || "{}") as { resume_phase?: unknown };
    if (payload.resume_phase === "verification") resumePhase = "verification";
  } catch { /* malformed legacy payload resumes from work */ }
  if (approved) {
    const spent = taskSpentBillable(task);
    const grant = task.budget_billable > 0 ? task.budget_billable : Number(process.env.AITEAM_TASK_TOKEN_BUDGET ?? 0);
    // 新预算 = 当前消耗 + 一个周期：既不会立刻再触线，也保留护栏（而不是一批准就变无限）
    const next = updateTask(task.id, { status: "todo", blocked_approval_id: null, budget_billable: spent + Math.max(grant, 1) }) ?? task;
    broadcast({ type: "task:upsert", payload: next });
    const summary = resumePhase === "verification"
      ? `用户批准追加预算，任务从独立复核继续（新预算 ${next.budget_billable.toLocaleString()} 计费 token）`
      : `用户批准追加预算，任务恢复（新预算 ${next.budget_billable.toLocaleString()} 计费 token）`;
    emitTaskEvent(next, "approval", summary, {
      approval_id: approval.id,
      status: "approved",
      budget_billable: next.budget_billable,
      resume_phase: resumePhase,
    }, approval.agent_id);
    if (next.channel_id) {
      audit(
        next.channel_id,
        resumePhase === "verification"
          ? `▶️ 用户批准追加预算，任务「${next.title}」从独立复核继续（新预算 ${next.budget_billable.toLocaleString()} 计费 token）`
          : `▶️ 用户批准追加预算，任务「${next.title}」恢复执行（新预算 ${next.budget_billable.toLocaleString()} 计费 token）`,
      );
    }
    resumeAssignedTask(next);
  } else {
    emitTaskEvent(task, "approval", "用户拒绝追加预算，任务保持暂停", { approval_id: approval.id, status: "rejected" }, approval.agent_id);
    if (task.channel_id) audit(task.channel_id, `⏸️ 用户拒绝追加预算，任务「${task.title}」保持暂停——可在看板调整预算或转人工收尾`);
  }
}

/**
 * 单次 network MCP 审批恢复原任务，不进入无 taskId 的普通 chat。
 * 返回 true 表示该 action 是结构化网络审批，路由层不应再走 generic triggerAgent。
 */
export function onNetworkApprovalResolved(approval: Approval): boolean {
  if (!approvalContainsNetworkGrant(approval)) return false;
  if (!approval.ref_id) {
    if (approval.status === "approved") consumeApproval(approval.id);
    return true;
  }
  const task = getTask(approval.ref_id);
  if (!task || task.status !== "blocked" || task.blocked_approval_id !== approval.id) {
    if (approval.status === "approved") consumeApproval(approval.id);
    return true;
  }
  const approved = approval.status === "approved";
  const grant = networkGrantFromApproval(approval, false);
  const sameAgent = task.assignee_agent_id === approval.agent_id;
  const stopped = cancelledTasks.has(task.id);
  if (approved && grant && sameAgent && !stopped) {
    const next = updateTask(task.id, { status: "todo", blocked_approval_id: null }) ?? task;
    broadcast({ type: "task:upsert", payload: next });
    emitTaskEvent(
      next,
      "approval",
      `用户批准单次网络调用，任务恢复：${grant.tool}`,
      { approval_id: approval.id, status: "approved", tool: grant.tool, call_fingerprint: grant.call_fingerprint },
      approval.agent_id,
    );
    if (next.channel_id) audit(next.channel_id, `▶️ 用户批准一次网络调用，任务「${next.title}」恢复执行`);
    resumeAssignedTask(next);
  } else {
    // 已批准但因停止、改派或 server 配置变化而失效时也必须原子关闭；
    // 否则恢复旧负责人/旧配置后，这张历史批准会“复活”。
    if (approved) consumeApproval(approval.id);
    emitTaskEvent(
      task,
      "approval",
      approved
        ? stopped
          ? "任务已被停止，原网络调用授权失效并保持阻塞"
          : sameAgent
          ? "网络调用授权已失效，任务保持阻塞"
          : "任务负责人已变化，原网络调用授权失效并保持阻塞"
        : "用户拒绝网络调用，任务保持阻塞",
      { approval_id: approval.id, status: approved ? "invalid" : "rejected", same_agent: sameAgent, stopped },
      approval.agent_id,
    );
    if (task.channel_id) {
      audit(
        task.channel_id,
        approved
          ? stopped
            ? `⏸️ 任务「${task.title}」已停止，原网络批准不再有效`
            : sameAgent
            ? `⏸️ 网络插件配置已变化，原批准不再有效；任务「${task.title}」保持阻塞`
            : `⏸️ 任务负责人已变化，原网络批准不再有效；任务「${task.title}」保持阻塞`
          : `⏸️ 用户拒绝网络调用，任务「${task.title}」保持阻塞`,
      );
    }
  }
  return true;
}

export function onClarificationResolved(approval: Approval, approved: boolean) {
  if (approval.kind !== "clarification" || !approval.ref_id) return;
  const task = getTask(approval.ref_id);
  if (!task) return;
  if (task.status !== "blocked" || task.blocked_approval_id !== approval.id) return;
  if (approved) {
    const response = clarificationResponse(approval);
    const next = updateTask(task.id, { status: "todo", blocked_approval_id: null }) ?? task;
    broadcast({ type: "task:upsert", payload: next });
    emitTaskEvent(next, "approval", response ? `用户补充输入后任务恢复：${response}` : "用户批准了 clarification，任务恢复待办并准备继续", { approval_id: approval.id, status: "approved", response }, approval.agent_id);
    if (next.channel_id) audit(next.channel_id, response ? `▶️ 用户已补充输入，任务「${next.title}」恢复执行：${response}` : `▶️ 用户已确认，任务「${next.title}」恢复执行`);
    resumeAssignedTask(next);
  } else {
    emitTaskEvent(task, "approval", "用户拒绝了 clarification，任务保持阻塞", { approval_id: approval.id, status: "rejected" }, approval.agent_id);
    if (task.channel_id) audit(task.channel_id, `⏸️ 用户拒绝了确认请求，任务「${task.title}」保持阻塞，等待进一步输入`);
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

/**
 * 一次性结构化补全（无工具、无流式、非 agent 循环）：供「模板就地改图文·AI 按来源产文案」等场景，
 * 复用现有供应商/模型解析（含用户自托管的兼容端点）。须在 owner 作用域内调用（listAgents/解析皆 owner 隔离）。
 * 返回纯文本，调用方自行解析（如 JSON）。失败抛错（无同事/无供应商/调用异常）。
 */
export async function oneShotComplete(system: string, userPrompt: string, maxTokens = 4000): Promise<string> {
  const agent = listAgents()[0];
  if (!agent) throw new Error("工作区没有可用的 AI 同事（模型通道）");
  const rt = resolveRuntime(agent, {});
  if (!rt.client) throw new Error("未配置可用的模型供应商（设置 → 模型供应商）");
  const resp = await rt.client.messages.create({
    model: rt.model,
    max_tokens: Math.min(maxTokens, rt.maxTokens),
    system,
    messages: [{ role: "user", content: userPrompt }],
  });
  return resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
}

export async function testProviderConnection(providerId: string): Promise<{
  ok: true;
  protocol: "anthropic-compatible" | "openai-compatible";
  model: string;
  latency_ms: number;
  sample: string;
}> {
  const provider = getProvider(providerId);
  if (!provider) throw new Error("provider not found");
  if (!provider.api_key) throw new Error("provider api key is missing");
  const model = provider.default_model || provider.light_model;
  if (!model) throw new Error("provider default model is missing");
  const rt = runtimeFromProvider(provider, model);
  if (!rt.client) throw new Error("provider client unavailable");
  const t0 = Date.now();
  const resp = await rt.client.messages.create({
    model: rt.model,
    max_tokens: Math.min(96, rt.maxTokens),
    system: "You are a model connectivity probe. Reply briefly in Chinese.",
    messages: [{ role: "user", content: "请只回复：AiTeam 模型通道可用。" }],
  });
  const sample = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .slice(0, 200);
  return {
    ok: true,
    protocol: providerProtocol(provider.base_url),
    model: rt.model,
    latency_ms: Date.now() - t0,
    sample,
  };
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
- 价值：每个环节由对口专家产出、并经独立验收，质量高于一人包办（也才会触发验收闭环）。
- **别"讨论要不要立项"——判定该立就直接调 start_project，不要先开会对齐。**`;

// 行动优先红线（最高优先级）：实测发现 agent 收到目标级请求时，倾向"开会讨论 + 抛澄清 + 等用户拍板"，
// 三个目标 0/3 交付、十万 token 零产出。此规则压过下面任何"先澄清/先对齐"倾向，逼其直接产出。
const ACTION_RULES = `## 行动优先（最高优先级，压过下方任何"先澄清/先对齐/等确认"的倾向）
- 用户给的是**目标级请求**（要一个产出：代码/文章/方案/演示/分析等）→ **直接开干、直接交付**，不要停在讨论、也不要等用户拍板。
- 多角色 / 多环节目标 → **立刻调 start_project（autonomy=auto）立项**，别先讨论"要不要立项"；规则就是立。
- 单一交付物目标 → **直接 write_document 出一版**，把"我做了哪些合理假设、还有哪些待你确认"列在交付开头——让用户在成品上改，而不是先回答你一堆问题。
- **禁止把"等用户确认 / 等老板拍板 / 先对齐再做"当作停下来的理由。** 最多问 1 个"不答就真的没法动手"的问题，且必须同时附上基于合理假设的草稿/方案。
- 只有**对外发布、产生费用、不可逆 / 高风险**动作才走 request_approval；内部产出一律先做出来。`;

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
    // ① 稳定前缀：跨调用尽量逐字一致 → 命中第三方端点的自动前缀缓存（cache_read 计费约 1/10）。
    //    勿在此之前放任何易变内容（时间/看板/文档），否则其后整段（含规则/技能/工具）都脱离缓存。
    ACTION_RULES,
    DELIVERY_RULES,
    INPUT_RULES,
    channel.kind !== "dm" ? COLLAB_RULES : "",
    memory ? `## 你的长期记忆（先查阅，"核实过的事实/通用规则"优先遵循）\n${memory}` : "",
    skillsBlock ? `## 已启用的技能（索引——需要某条的具体方法/步骤时用 read_skill(id) 取正文再遵循）\n${skillsBlock}` : "",
    // ② 易变上下文置于最后：时间/看板/文档变动只破坏其自身之后，不再殃及上面的可缓存前缀。
    `## 当前工作区上下文`,
    `当前时间：${nowStr}（Asia/Shanghai）—— 涉及时间判断时以此为准`,
    `频道：#${channel.name}（${channel.kind === "dm" ? "与用户的私信" : "团队频道"}）`,
    teammates ? `频道内其他 AI 同事：\n${teammates}` : `频道内没有其他 AI 同事。`,
    tasks ? `频道任务看板：\n${tasks}` : `任务看板目前为空。`,
    docs ? `工作区文档（可用 read_document 阅读全文）：\n${docs}` : "",
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
              reviewer: { type: "string", description: "可选：指定复核人名字；留空则系统按交付物类型自动选择" },
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
        reviewer: { type: "string", description: "可选：指定复核人名字；留空则系统按交付物类型自动选择" },
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
    name: "claim_task",
    description:
      "认领任务：当任务未分配，或用户/负责人明确把任务委派给你时调用。认领会设置负责人、写入任务活动日志，并防止其他 AI 同事重复开工。不能抢占已经分配给其他同事的任务。",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "任务 id" },
        reason: { type: "string", description: "为什么由你接手，简短说明即可" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "request_clarification",
    description:
      "任务被事实缺口、权限、安全边界、用户选择或缺少必要输入阻塞时调用。系统会把任务置为 blocked，创建一个 clarification 审批/待办，用户回应后再恢复任务。不要用它替代普通交付；能基于合理假设先做草稿时应先做。",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "被阻塞的任务 id；当前任务可省略但建议填写" },
        question: { type: "string", description: "需要用户回答的具体问题" },
        context: { type: "string", description: "为什么这个输入会阻塞继续推进，以及不确认的风险" },
        proposed_default: { type: "string", description: "可选：如果用户批准，建议采用的默认做法" },
      },
      required: ["question"],
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
        reviewer: { type: "string", description: "复核人名字；留空/不传表示不改" },
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
      "读取某个技能的完整方法正文（L2）。当工作区上下文的「已启用的技能」索引里有与当前任务相关的技能、你需要它的具体步骤/模板/参数时调用。能力型技能(capability)的正文会说明该调用哪个工具/MCP、参数怎么填、不可达时如何降级。skill_id 见技能索引中的 id；也可传某技能正文里给出的『模板 id』（如『演示风格选择法』选定的 html-deck-* 精装模板）来按需单取该模板正文。",
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
      "向用户发起审批请求。任何对外或高风险动作（发邮件、对外发布、部署、产生费用）必须先调用本工具，等待用户批准，不要直接宣称已完成。network MCP 的外发审批由引擎在拦截真实调用时自动创建，不要手工伪造工具范围。",
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

export function claimTaskForAgent(agent: Agent, taskId: string, reason = ""): { ok: true; task: Task } | { ok: false; error: string } {
  const task = getTask(taskId);
  if (!task) return { ok: false, error: `找不到任务 ${taskId}` };
  if (task.status === "done" || task.status === "cancelled") {
    return { ok: false, error: `任务已${task.status === "done" ? "关闭" : "取消"}，请先恢复到待办再认领。` };
  }
  if (task.assignee_agent_id && task.assignee_agent_id !== agent.id) {
    const owner = getAgent(task.assignee_agent_id);
    return { ok: false, error: `任务已由 ${owner?.name ?? "其他 AI 同事"} 负责，不能重复认领。` };
  }
  const next = updateTask(task.id, { assignee_agent_id: agent.id }) ?? task;
  broadcast({ type: "task:upsert", payload: next });
  emitTaskEvent(next, "claim", `${agent.name} 认领了任务${reason ? `：${reason}` : ""}`, { reason }, agent.id);
  if (next.channel_id) audit(next.channel_id, `🙋 ${agent.name} 认领了任务「${next.title}」${reason ? `：${reason}` : ""}`);
  if (next.status === "todo") onTaskAssigned(next);
  return { ok: true, task: next };
}

export function requestClarificationForTask(
  agent: Agent,
  task: Task,
  question: string,
  context = "",
  proposedDefault = ""
): { approvalId: string; task: Task } {
  if (task.status === "blocked" && task.blocked_approval_id) {
    const active = getApproval(task.blocked_approval_id);
    if (active?.kind === "clarification" && active.status === "pending") {
      return { approvalId: active.id, task };
    }
  }
  // 用户补充输入可能改变任务语义；旧执行上下文中的一次性外发授权必须先关闭，
  // 即使进程在随后创建 clarification 审批前退出也只会过度收紧，不会放宽权限。
  invalidateTaskNetworkApprovals(task.id);
  const approval = createApproval({
    channel_id: task.channel_id,
    agent_id: agent.id,
    title: `需要确认：${question.slice(0, 120)}`,
    payload: JSON.stringify({ question, context, proposed_default: proposedDefault }, null, 2),
    kind: "clarification",
    ref_id: task.id,
  });
  const next = updateTask(task.id, { status: "blocked", blocked_approval_id: approval.id }) ?? task;
  broadcast({ type: "approval:upsert", payload: approval });
  broadcast({ type: "task:upsert", payload: next });
  emitTaskEvent(next, "blocked", `${agent.name} 请求用户输入：${question}`, { approval_id: approval.id, context, proposed_default: proposedDefault }, agent.id);
  emitTaskEvent(next, "approval", "已创建 clarification 待办，等待用户回应", { approval_id: approval.id }, agent.id);
  if (next.channel_id) audit(next.channel_id, `⏸️ ${agent.name} 暂停任务「${next.title}」，等待用户确认：${question}`);
  return { approvalId: approval.id, task: next };
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
        const reviewer = findAgentByName(it.reviewer);
        const deps = (Array.isArray(it.depends_on) ? it.depends_on : [])
          .filter((d: any) => Number.isInteger(d) && d >= 0 && d < i)
          .map((d: number) => created[d].id);
        const task = createTask({
          channel_id: channel.id,
          title: String(it.title ?? `任务 ${i + 1}`).slice(0, 200),
          description: String(it.description ?? ""),
          acceptance_criteria: String(it.acceptance_criteria ?? ""),
          assignee_agent_id: assignee?.id ?? null,
          reviewer_agent_id: reviewer?.id ?? null,
          created_by: agent.id,
          project_id: project.id,
          depends_on: deps,
          model_tier: it.model_tier === "light" ? "light" : "standard",
        });
        created.push(task);
        emitTaskEvent(task, "created", `${agent.name} 创建了项目子任务`, { project_id: project.id }, agent.id);
        if (assignee) emitTaskEvent(task, "claim", `任务指派给 ${assignee.name}`, { source: "start_project" }, assignee.id);
        broadcast({ type: "task:upsert", payload: task });
      }
      const plan = created
        .map((t, i) => {
          const deps = taskDependsOn(t).map((id) => created.findIndex((c) => c.id === id) + 1);
          const assignee = t.assignee_agent_id ? getAgent(t.assignee_agent_id)?.name : "未分配";
          const reviewer = t.reviewer_agent_id ? getAgent(t.reviewer_agent_id)?.name : "自动复核";
          return `${i + 1}. ${t.title} → ${assignee} / 复核 ${reviewer}${deps.length ? `（依赖 ${deps.join("、")}）` : ""}`;
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
      const reviewer = findAgentByName(input.reviewer);
      const task = createTask({
        channel_id: channel.id,
        title: String(input.title ?? "").slice(0, 200),
        description: String(input.description ?? ""),
        acceptance_criteria: String(input.acceptance_criteria ?? ""),
        status: "todo",
        assignee_agent_id: assignee?.id ?? null,
        reviewer_agent_id: reviewer?.id ?? null,
        created_by: agent.id,
        model_tier: input.model_tier === "light" ? "light" : "standard",
        source_doc_ids: Array.isArray(input.source_doc_ids) ? input.source_doc_ids.map(String) : [],
      });
      emitTaskEvent(task, "created", `${agent.name} 创建了任务`, undefined, agent.id);
      if (assignee) emitTaskEvent(task, "claim", `任务指派给 ${assignee.name}`, { source: "create_task" }, assignee.id);
      broadcast({ type: "task:upsert", payload: task });
      audit(channel.id, `🗂️ ${agent.name} 创建了任务「${task.title}」${assignee ? `，指派给 ${assignee.name}` : ""}${reviewer ? `，复核人 ${reviewer.name}` : ""}`);
      if (assignee) onTaskAssigned(task);
      return `已创建任务（id: ${task.id}）${assignee ? `，${assignee.name} 将自动开工` : ""}`;
    }
    case "claim_task": {
      const taskId = String(input.task_id ?? ctx.taskId ?? "");
      if (!taskId) return "错误：task_id 不能为空。";
      const result = claimTaskForAgent(agent, taskId, String(input.reason ?? ""));
      if (!result.ok) return `错误：${result.error}`;
      return `已认领任务（id: ${result.task.id}）。`;
    }
    case "request_clarification": {
      const taskId = String(input.task_id ?? ctx.taskId ?? "");
      if (!taskId) return "错误：task_id 不能为空。";
      const task = getTask(taskId);
      if (!task) return `错误：找不到任务 ${taskId}`;
      if (task.status === "review" || task.status === "done" || task.status === "cancelled") return "错误：任务已交付、关闭或取消，不能再请求 clarification。";
      const question = String(input.question ?? "").trim();
      if (!question) return "错误：question 不能为空。";
      const { approvalId } = requestClarificationForTask(
        agent,
        task,
        question,
        String(input.context ?? ""),
        String(input.proposed_default ?? "")
      );
      ctx.halted = "blocked";
      return `已暂停任务并创建 clarification（approval id: ${approvalId}）。在用户回应前不要继续执行该任务。`;
    }
    case "update_task": {
      if (input.status === "done") return "错误：关单（done）是 human-only 操作，请提请用户在看板上确认关闭。";
      if (input.status === "blocked") return "错误：blocked 状态必须通过 request_clarification 进入（否则任务会卡住且没有恢复路径）。";
      const prev = getTask(String(input.task_id));
      if (!prev) return `错误：找不到任务 ${input.task_id}`;
      const assignee = findAgentByName(input.assignee);
      const reviewer = findAgentByName(input.reviewer);
      const requestedAssignee = input.assignee !== undefined ? assignee?.id ?? null : prev.assignee_agent_id;
      const statusChanged = input.status !== undefined && input.status !== prev.status;
      const assigneeChanged = input.assignee !== undefined && requestedAssignee !== prev.assignee_agent_id;
      const contextChanged = statusChanged || assigneeChanged;
      const hasPendingApproval = listApprovals().some(
        (approval) =>
          approval.status === "pending" &&
          (approval.ref_id === prev.id || approval.id === prev.blocked_approval_id),
      );
      if (contextChanged && (prev.status === "blocked" || hasPendingApproval)) {
        return "错误：任务有待处理审批或正处于 blocked；只有用户可以先处理审批，再调整负责人或恢复任务。";
      }
      const task = updateTask(prev.id, {
        ...(input.status ? { status: input.status } : {}),
        ...(input.title ? { title: String(input.title) } : {}),
        ...(input.description !== undefined ? { description: String(input.description) } : {}),
        ...(input.acceptance_criteria !== undefined ? { acceptance_criteria: String(input.acceptance_criteria) } : {}),
        ...(input.assignee !== undefined ? { assignee_agent_id: assignee?.id ?? null } : {}),
        ...(input.reviewer !== undefined ? { reviewer_agent_id: reviewer?.id ?? null } : {}),
      });
      if (!task) return `错误：找不到任务 ${input.task_id}`;
      if (contextChanged) invalidateTaskNetworkApprovals(task.id);
      if (task.assignee_agent_id !== prev.assignee_agent_id) {
        emitTaskEvent(task, task.assignee_agent_id ? "claim" : "handoff", task.assignee_agent_id ? `${agent.name} 指派任务给 ${getAgent(task.assignee_agent_id)?.name ?? "AI 同事"}` : `${agent.name} 取消了任务指派`, undefined, task.assignee_agent_id ?? agent.id);
      }
      if (input.reviewer !== undefined && task.reviewer_agent_id !== prev.reviewer_agent_id) {
        emitTaskEvent(task, "verification", `${agent.name} 指定复核人：${task.reviewer_agent_id ? getAgent(task.reviewer_agent_id)?.name ?? "AI 同事" : "自动选择"}`, undefined, task.reviewer_agent_id ?? agent.id);
      }
      broadcast({ type: "task:upsert", payload: task });
      audit(channel.id, `🗂️ ${agent.name} 更新了任务「${task.title}」→ ${task.status}`);
      if (task.assignee_agent_id && task.assignee_agent_id !== prev.assignee_agent_id && task.id !== ctx.taskId) {
        onTaskAssigned(task);
      }
      return `已更新任务（id: ${task.id}，状态: ${task.status}）`;
    }
    case "write_document": {
      const kind = ["report", "slides", "sheet", "html"].includes(input.kind) ? input.kind : "report";
      let content = String(input.content ?? "");
      const benchmarkTask = ctx.taskId ? getTask(ctx.taskId) : undefined;
      const evidenceNormalization = benchmarkTask && kind === "report" && isProviderQualityBenchmarkTask(benchmarkTask)
        ? normalizeProviderQualityBenchmarkDocument(content)
        : { content, replacements: [] as string[] };
      content = evidenceNormalization.content;
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
      if (ctx.taskId) {
        const task = getTask(ctx.taskId);
        if (task) {
          if (evidenceNormalization.replacements.length > 0) {
            emitTaskEvent(
              task,
              "verification",
              `机器校准 ${evidenceNormalization.replacements.length} 类证据词汇`,
              { stage: "evidence_normalization", replacements: evidenceNormalization.replacements, doc_id: doc.id },
              null,
            );
          }
          emitTaskEvent(task, "delivery", `${agent.name} 写入交付物《${doc.title}》`, { doc_id: doc.id, kind, evidence_normalizations: evidenceNormalization.replacements }, agent.id);
        }
      }
      audit(channel.id, `${kind === "slides" ? "🖥️" : kind === "sheet" ? "📊" : "📄"} ${agent.name} 写好了${kindLabel}《${doc.title}》（${doc.content.length} 字）`);
      return `${kindLabel}已保存（id: ${doc.id}，kind: ${kind}）${evidenceNormalization.replacements.length > 0 ? `；已按当前实现校准 ${evidenceNormalization.replacements.length} 类证据词汇并写入审计事件` : ""}。`;
    }
    case "read_document": {
      const doc = getDocument(String(input.doc_id));
      if (!doc) return `错误：找不到文档 ${input.doc_id}`;
      return stripLoneSurrogates(`《${doc.title}》\n\n${doc.content.slice(0, 20000)}`);
    }
    case "read_skill": {
      // 渐进式披露 L2/L3：按需拉技能正文 + 附带的可复用模板。只读、零计费（同步分支，不计 MCP_CALLS_PER_RUN）。
      const sid = String(input.skill_id);
      const sk = getSkill(sid);
      if (sk && sk.enabled) {
        return stripLoneSurrogates(`【技能：${sk.name}】\n${readSkillBody(sk.id)}`);
      }
      // 回退：技能正文里以 id 直引的可复用模板（如『演示风格选择法』选定的某套精装模板）——按需单取一套，
      // 避免把全部模板正文一次性灌进上下文（token 友好）。容忍 agent 误带 `tpl:` 前缀。
      const tpl = getSkillTemplate(sid.startsWith("tpl:") ? sid.slice(4) : sid);
      if (tpl) {
        const longest = (tpl.content.match(/`+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
        const fence = "`".repeat(Math.max(3, longest + 1));
        return stripLoneSurrogates(`【模板：${tpl.name}】\n${tpl.desc}\n${fence}${tpl.lang}\n${tpl.content}\n${fence}`);
      }
      return `未找到该技能或未启用（id: ${sid}）。`;
    }
    case "request_approval": {
      const approval = createApproval({
        channel_id: channel.id,
        agent_id: agent.id,
        title: String(input.title ?? "").slice(0, 200),
        payload: String(input.details ?? ""),
        ref_id: ctx.taskId ?? null,
      });
      broadcast({ type: "approval:upsert", payload: approval });
      if (ctx.taskId) {
        const task = getTask(ctx.taskId);
        if (task) emitTaskEvent(task, "approval", `${agent.name} 发起审批请求「${approval.title}」`, { approval_id: approval.id, kind: approval.kind }, agent.id);
      }
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

export function startScheduler(): () => void {
  const timer = setInterval(() => {
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
  timer.unref();
  return () => clearInterval(timer);
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
    case "claim_task": return "正在认领任务…";
    case "request_clarification": return "正在请求用户输入…";
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
  /** fixed benchmark / verification runs must not inherit workspace chatter, docs or skill indexes */
  contextMode?: "full" | "isolated";
  /** clamp a single response so a small task budget cannot be overshot by a 16k completion */
  maxTokens?: number;
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
    const resolvedRuntime = resolveRuntime(agent, opts);
    const rt = opts.maxTokens
      ? { ...resolvedRuntime, maxTokens: Math.min(resolvedRuntime.maxTokens, Math.max(1, Math.round(opts.maxTokens))) }
      : resolvedRuntime;
    if (!rt.client) {
      await mockRun(ctx, emit);
    } else {
      usage = await llmLoop(ctx, rt, userPrompt, maxIterations, emit, opts.extraSystem, opts.toolsOverride, opts.contextMode);
    }
    const usageJson = JSON.stringify(usage);
    updateMessage(row.id, { content, status: "complete", usage_json: usageJson, model: rt.client ? rt.model : "mock" });
    // D2 任务级成本归因：工作/返工/验收的每一次运行都累计到任务（跨返工不清零），预算护栏与面板同源。
    if (ctx.taskId) {
      const t = addTaskUsage(ctx.taskId, usage);
      if (t) broadcast({ type: "task:upsert", payload: t });
    }
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
  toolsOverride?: Anthropic.ToolUnion[],
  contextMode: "full" | "isolated" = "full"
): Promise<{ input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }> {
  const client = rt.client;
  if (!client) throw new Error("no client");
  const { agent, channel } = ctx;

  // 能力门控：服务端 web 工具按通道可用性；提示缓存仅官方 Anthropic API 启用
  // 用本次工作焦点（任务简报 / 用户消息）做技能相关性筛选——只注入相关专项方法
  const isolated = contextMode === "isolated" || ctx.kind === "verify";
  let dynamicCtx = isolated
    ? [
        "## 隔离运行",
        "本次只允许依据用户提示中明确给出的任务、验收标准、交付物与运行证据判断；不要读取或借用工作区闲聊、其他文档、长期记忆或技能索引。",
        "不得声称调用过未实际提供的工具，不得把模型常识包装成已检索事实；缺少来源时明确写为假设或不使用该主张。",
      ].join("\n")
    : buildDynamicContext(agent, channel, userPrompt);
  if (!rt.webTools) dynamicCtx += `\n\n注意：当前模型通道不支持 web_search/web_fetch 联网调研，依据已有上下文与常识工作，不确定的事实要明确说明未经核实。`;
  // 验收去人设：verify 运行用固定校验者指令替换同事人设（选人仍对口路由，判准统一不漂移）
  const personaPrompt = ctx.kind === "verify" ? VERIFIER_SYSTEM_PROMPT : agent.system_prompt;
  const system: Anthropic.TextBlockParam[] = [
    rt.official
      ? { type: "text", text: personaPrompt, cache_control: { type: "ephemeral" } }
      : { type: "text", text: personaPrompt },
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
    // D2 预算护栏（仅工作运行；验收是质量下限不该被预算掐断）：任务累计 + 本次运行已耗 ≥ 预算 → 暂停待批。
    // 在迭代边界检查而非流中：不打断半个回复，粒度 = 一次模型往返。
    if (ctx.kind === "work" && ctx.taskId) {
      const t = getTask(ctx.taskId);
      const budget = t ? (t.budget_billable > 0 ? t.budget_billable : Number(process.env.AITEAM_TASK_TOKEN_BUDGET ?? 0)) : 0;
      if (t && budget > 0) {
        const spent = taskSpentBillable(t) + readUsage(JSON.stringify(usage)).billable;
        if (spent >= budget) {
          requestBudgetPauseForTask(agent, t, spent, budget);
          ctx.halted = "blocked";
          emit(`\n\n⏸️ 任务累计消耗已达预算上限（${spent.toLocaleString()}/${budget.toLocaleString()} 计费 token），已暂停等待用户批准追加预算。`);
          break;
        }
      }
    }
    const stream = client.messages.stream({
      model: rt.model,
      max_tokens: rt.maxTokens,
      ...(supportsAdaptiveThinking(rt.model) ? { thinking: { type: "adaptive" as const } } : {}),
      system,
      messages,
      tools,
    }) as {
      abort(): void;
      on(event: "text", listener: (delta: string) => void): unknown;
      finalMessage(): Promise<Anthropic.Message>;
    };
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
      if (ctx.halted) {
        results.push({ type: "tool_result", tool_use_id: tu.id, content: "任务已暂停等待用户输入，后续工具未执行。" });
        continue;
      }
      if (ctx.kind === "work" && ctx.taskId) {
        const liveTask = getTask(ctx.taskId);
        const executionRevoked =
          cancelledTasks.has(ctx.taskId) ||
          !liveTask ||
          liveTask.status !== "doing" ||
          liveTask.assignee_agent_id !== agent.id;
        if (executionRevoked) {
          ctx.halted = "stopped";
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: "⏹ 任务已停止、取消或改派；本次工具调用未执行。",
          });
          continue;
        }
      }
      status(agent, channel.id, "tool", toolLabel(tu.name));
      if (ctx.taskId) {
        const task = getTask(ctx.taskId);
        if (task) emitTaskEvent(task, "tool", `${agent.name} 使用工具 ${tu.name}`, { tool: tu.name }, agent.id);
      }
      let result: string;
      try {
        if (isMcpTool(tu.name)) {
          const gated = mcpSafetyGate(tu.name);
          if (gated) {
            // 高危插件（exec/network）：引擎层硬拦截（非提示词），强制改走 request_approval 审批门。
            result = `⛔ 插件「${gated.name}」属高危（${gated.safety === "exec" ? "本地执行" : "外发数据"}），不能直接调用。请改用 request_approval 提交本次动作的完整内容与目的，经用户批准后再执行。`;
            audit(channel.id, `⛔ ${agent.name} 试图直接调用高危插件「${gated.name}」(${gated.safety})，已拦截——须走审批门`);
          } else if (
            mcpRequiresApprovalForTask(ctx.taskId ? getTask(ctx.taskId) : undefined, tu.name) &&
            !consumeApprovedNetworkGrant(ctx.taskId, tu.name, tu.input, agent.id)
          ) {
            const server = mcpServerForTool(tu.name);
            const task = ctx.taskId ? getTask(ctx.taskId) : undefined;
            if (!task) {
              result = `⛔ 插件「${server?.name ?? tu.name}」需要网络外发审批，但当前调用不在任务上下文中。请先创建并认领任务，再从任务内发起该调用。`;
            } else {
              const requested = requestNetworkApprovalForTask(
                agent,
                task,
                tu.name,
                tu.input,
                `批准一次网络调用：${server?.name ?? tu.name}`,
                `该任务请求调用 ${tu.name}，完整参数见 network_grant.input。批准仅对这一工具、目标配置和参数生效一次。`,
              );
              if (!requested) {
                ctx.halted = "stopped";
                result = "⏹ 任务状态或负责人已变化，本次网络调用未执行，也未创建审批。";
              } else {
                ctx.halted = "blocked";
                result = `⏸️ 已自动创建单次网络调用审批（id: ${requested.approvalId}）并暂停任务。用户批准后任务会恢复，并仅执行这一次已列明的调用。`;
                audit(channel.id, `⛔ ${agent.name} 在来源/严格任务中调用网络插件「${server?.name ?? tu.name}」，已生成单次审批并暂停任务`);
              }
            }
          } else {
            const rawSig = SEARCH_DEDUP ? searchQuerySignature(tu.input) : null;
            // memo 键带 owner 前缀：searchMemo 现在是 run 级私有（天然单租户），但键规则与
            // mcp.callCache 对齐——将来提为跨 run 共享缓存时不会漏掉租户维度。展示用 rawSig，不外露 owner 主体。
            const sig = rawSig ? `${currentOwner()}:${rawSig}` : null;
            if (sig && rawSig && searchMemo.has(sig)) {
              // 同一查询已检索过（可能是别的搜索插件）→ 回上次结果，省去重复计费的一次往返。
              const mcp = tu.name.match(/^mcp__(.+?)__(.+)$/);
              audit(channel.id, `↩️ ${agent.name} 重复检索「${rawSig.slice(0, 24)}…」已去重（省 1 次计费，复用上次结果）`);
              result =
                `↩️ 本次运行已检索过相同查询「${rawSig.slice(0, 60)}」，为避免重复计费，直接返回上次结果（如需更多信息请换不同的查询角度，不要对同一问题换搜索插件重复查）：\n\n` +
                searchMemo.get(sig);
            } else if (mcpCalls >= MCP_CALLS_PER_RUN) {
              result = `⚠️ 本次运行的外部插件调用已达上限（${MCP_CALLS_PER_RUN} 次）。外部检索按次计费，请基于已获得的信息完成工作，不要再尝试调用插件。`;
            } else {
              mcpCalls++;
              let dispatchRevoked = false;
              result = await callMcpTool(tu.name, tu.input, {
                canDispatch: () => {
                  const allowed = !ctx.taskId || taskExecutionIsCurrent(ctx.taskId, agent.id);
                  if (!allowed) dispatchRevoked = true;
                  return allowed;
                },
              });
              if (dispatchRevoked) ctx.halted = "stopped";
              // 持久化审计：插件调用此前只发瞬态 status，事后无法从时间线/账本判断用没用某插件。
              // 仿配图那条落一行可核查的 system 消息——只记 server:tool 名，绝不写参数/密钥/返回内容。
              const mcp = tu.name.match(/^mcp__(.+?)__(.+)$/);
              if (!dispatchRevoked) {
                audit(channel.id, `🔌 ${agent.name} 调用了插件 ${mcp ? `${mcp[1]}:${mcp[2]}` : tu.name}`);
              }
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
    if (ctx.halted) break;

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

export function mockTaskDocument(task: Pick<Task, "title" | "description" | "acceptance_criteria">, agentName: string): string {
  const acceptance = task.acceptance_criteria
    .split(/\n|；|;/)
    .map((item) => item.replace(/^[-*•\d.、)\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 6);
  const checklist = acceptance.length > 0
    ? acceptance.map((item, index) => `| ${index + 1} | 待人工核对 | ${item} |`).join("\n")
    : "| 1 | 待人工核对 | 目标、范围与下一步是否清楚 |";
  return [
    `# ${task.title}`,
    "",
    "> **Mock 演示交付**：以下内容只用于体验任务、证据和人工关单流程，不代表真实调研结论。接入模型后才会生成正式内容。",
    "",
    "## 结论先行",
    `建议先由 ${agentName} 按任务简报补齐正式内容，再由独立复核人逐条核验；当前演示稿不可作为真实业务决策依据。`,
    "",
    "## 目标与边界",
    task.description || "以任务标题为目标；Mock 模式不访问外部资料，也不虚构事实、客户反馈或实施结果。",
    "",
    "## 建议执行步骤",
    "1. 核对目标、交付物、验收标准和责任人是否完整。",
    "2. 执行者产出当前版本，并把工具调用与交付事件写入活动日志。",
    "3. 独立复核人给出通过或返工裁决；存在缺口时生成新版本。",
    "4. 人类逐条核对证据后决定关闭或退回，不把流程完成等同于质量通过。",
    "",
    "## 风险与停止条件",
    "- 如果缺少真实来源、结构化复核裁决或可核对证据，应停止关单并退回补充。",
    "- 如果模型预算不足或需要外部网络工具，应先暂停并等待人工批准。",
    "",
    "## 来源与假设",
    "本次未使用外部资料。内容仅来自任务简报与 Mock 流程规则，所有业务判断均待真实执行验证。",
    "",
    "## 交付自查表",
    "| 序号 | 状态 | 验收标准 / 证据位置 |",
    "|---|---|---|",
    checklist,
  ].join("\n");
}

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
      content: task
        ? mockTaskDocument(task, agent.name)
        : `# 交付物\n\n这是 Mock 模式生成的演示交付物。接入模型后才会生成正式内容。`,
    });
    ctx.createdDocIds.push(doc.id);
    broadcast({ type: "doc:upsert", payload: doc });
    if (task) emitTaskEvent(task, "delivery", `${agent.name} 写入 Mock 交付物《${doc.title}》`, { doc_id: doc.id, kind: doc.kind }, agent.id);
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

import { useEffect, useState, type ReactNode } from "react";
import { useWorkspace } from "../store";
import { api, type AgentTemplateInfo, type ImageProviderInfo } from "../api";
import type { Channel } from "../types";
import { McpTab, SkillsTab } from "./IntegrationsTabs";
import { AgentAvatar } from "./Avatar";
import { providerBenchmarkConfirmation, providerBenchmarkRunInput } from "../lib/providerBenchmark";

function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div
        className={`modal-card max-h-[90vh] overflow-y-auto rounded-xl border border-line bg-panel p-5 shadow-xl ${
          wide ? "w-[min(680px,calc(100vw-24px))]" : "w-[min(440px,calc(100vw-24px))]"
        }`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded px-1.5 text-ink-3 hover:bg-sel">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-line bg-panel px-3 py-2 text-[13.5px] outline-none focus:border-accent/50";
const labelCls = "mb-1 mt-3 block text-[12.5px] font-medium text-ink-2 first:mt-0";

function formatTokenCount(value: unknown) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatEstimatedCost(value: unknown, currency: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  const unit = typeof currency === "string" && currency.trim() ? currency.trim().toUpperCase() : "USD";
  const amount = value < 0.01 ? value.toFixed(4) : value.toFixed(2);
  return ` · ≈${unit} ${amount}`;
}

const PROVIDER_PRESETS = [
  {
    id: "deepseek",
    name: "DeepSeek",
    desc: "Anthropic-compatible，适合先跑通工具调用和长任务线。",
    base_url: "https://api.deepseek.com/anthropic",
    default_model: "deepseek-v4-pro",
    light_model: "deepseek-v4-flash",
    web_tools: true,
    is_strong: true,
  },
  {
    id: "siliconflow-glm",
    name: "SiliconFlow GLM",
    desc: "OpenAI-compatible，GLM 长上下文适合方案、研发和评审任务。",
    base_url: "https://api.siliconflow.com/v1",
    default_model: "zai-org/GLM-5.2",
    light_model: "",
    web_tools: false,
    is_strong: true,
  },
  {
    id: "bailian",
    name: "百炼 DashScope",
    desc: "OpenAI-compatible；生产可替换为工作空间专属域名。",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    default_model: "qwen-plus",
    light_model: "qwen-turbo",
    web_tools: false,
    is_strong: true,
  },
] as const;

/** 场景组队模板（Hive 设计：3-4 张场景卡一键组队，零输入成本）。
 *  roleKeys 匹配已有成员；templateIds 指向角色模板库——选卡时自动实例化；
 *  skills 选卡时自动启用配套工作方法（全员生效）；mcp 给出推荐插件提示。 */
const SCENES: {
  icon: string; name: string; desc: string; channel: string;
  roleKeys: string[]; templateIds: string[]; skills: string[]; mcp: string;
}[] = [
  { icon: "🔬", name: "调研与报告", desc: "联网调研 → 分析报告 + 数据表", channel: "research", roleKeys: ["产品", "工程", "分析"], templateIds: ["analyst"], skills: ["深度调研法", "交付自查清单"], mcp: "Tavily 联网搜索" },
  { icon: "🚀", name: "产品立项", desc: "拆解分工 → 并行交付 → 汇总", channel: "project", roleKeys: ["产品", "工程", "评审"], templateIds: [], skills: ["金字塔写作法", "交付自查清单"], mcp: "" },
  { icon: "✍️", name: "内容与增长", desc: "选题 → 成文 → 校对 → SEO", channel: "content", roleKeys: ["SEO", "增长", "内容", "文案", "校对"], templateIds: ["writer", "proofreader"], skills: ["金字塔写作法", "交付自查清单"], mcp: "Tavily 联网搜索" },
  { icon: "🧰", name: "解决方案", desc: "需求澄清 → 选型对比 → 实施方案", channel: "solution", roleKeys: ["方案", "产品", "工程"], templateIds: ["solution"], skills: ["结构化头脑风暴", "交付自查清单"], mcp: "Tavily 联网搜索 / 文件系统" },
];

export function NewChannelModal({ onClose, onCustomRole }: { onClose: () => void; onCustomRole: () => void }) {
  const ws = useWorkspace();
  const [name, setName] = useState("");
  const [scene, setScene] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set(ws.agents.map((a) => a.id)));
  const [templates, setTemplates] = useState<AgentTemplateInfo[]>([]);
  const [sceneHint, setSceneHint] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listAgentTemplates().then(setTemplates).catch(() => undefined);
  }, [ws.agents.length]);

  function sceneAgents(i: number) {
    const keys = SCENES[i].roleKeys;
    return ws.agents.filter((a) => keys.some((k) => a.name.includes(k) || a.role.includes(k)));
  }

  async function pickScene(i: number) {
    setScene(i);
    // 场景需要的模板角色未实例化时自动添加（幂等）
    const added = await Promise.all(SCENES[i].templateIds.map((id) => ws.installTemplate(id).catch(() => null)));
    const ids = new Set(sceneAgents(i).map((a) => a.id));
    for (const a of added) if (a) ids.add(a.id);
    setSelected(ids);
    if (!name.trim() || SCENES.some((s) => s.channel === name.trim())) setName(SCENES[i].channel);
    // 启用该场景配套的工作方法（技能全员生效），并提示推荐 MCP——把"组队/方法/工具"一次配齐
    const want = SCENES[i].skills;
    let enabledNames = want;
    try {
      const skills: { id: string; name: string; enabled: number }[] = await api.listSkills();
      const toEnable = skills.filter((s) => want.includes(s.name) && !s.enabled);
      await Promise.all(toEnable.map((s) => api.toggleSkill(s.id, true)));
      enabledNames = want.filter((n) => skills.some((s) => s.name === n));
    } catch {
      /* 技能接口不可用时仅给提示 */
    }
    setSceneHint(
      `已启用配套工作方法：${enabledNames.join("、")}` +
        (SCENES[i].mcp ? `；建议在 ⚙ 设置 → MCP 接入「${SCENES[i].mcp}」补足联网/文件能力` : "")
    );
  }

  async function addTemplate(tpl: AgentTemplateInfo) {
    const agent = await ws.installTemplate(tpl.id);
    setSelected((prev) => new Set(prev).add(agent.id));
    setTemplates((ts) => ts.map((t) => (t.id === tpl.id ? { ...t, installed: true } : t)));
  }

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await ws.createChannel(name.trim(), [...selected]);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="新建频道" onClose={onClose}>
      <label className={labelCls}>按场景组队（可选）</label>
      <div className="grid grid-cols-2 gap-2">
        {SCENES.map((s, i) => {
          const members = sceneAgents(i);
          const active = scene === i;
          return (
            <button
              key={s.name}
              onClick={() => pickScene(i)}
              className={`rounded-lg border p-2.5 text-left transition-colors ${
                active ? "border-accent bg-accent-soft" : "border-line hover:border-accent/40"
              }`}
            >
              <div className="flex items-center gap-1.5 text-[13px] font-medium">
                <span>{s.icon}</span>
                {s.name}
                {active && <span className="ml-auto font-mono text-[10px] text-accent">已选</span>}
              </div>
              <div className="mt-0.5 text-[11.5px] text-ink-3">{s.desc}</div>
              <div className="mt-1.5 flex items-center gap-1">
                {members.length > 0 ? (
                  members.slice(0, 5).map((a) => <AgentAvatar key={a.id} agent={a} size={18} />)
                ) : (
                  <span className="text-[12px] text-ink-3">—</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
      {sceneHint && (
        <div className="mt-2 rounded-lg bg-accent-soft px-3 py-2 text-[11.5px] leading-relaxed text-ink-2">
          ✨ {sceneHint}
        </div>
      )}
      <label className={labelCls}>频道名</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 asr_stt_finetuning" className={inputCls} />
      <label className={labelCls}>邀请 AI 同事（手动调整后场景选中态解除）</label>
      <div className="flex flex-col gap-1">
        {ws.agents.map((a) => (
          <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13.5px] hover:bg-sel">
            <input
              type="checkbox"
              checked={selected.has(a.id)}
              onChange={(e) => {
                const next = new Set(selected);
                e.target.checked ? next.add(a.id) : next.delete(a.id);
                setSelected(next);
                setScene(null); // 手动增减成员 = 偏离场景模板
              }}
            />
            <span>{a.emoji}</span>
            <span className="font-medium">{a.name}</span>
            <span className="truncate text-[12px] text-ink-3">{a.role}</span>
          </label>
        ))}
      </div>
      {templates.some((t) => !t.installed) && (
        <>
          <label className={labelCls}>扩展角色模板（一键加入团队）</label>
          {[...new Set(templates.filter((t) => !t.installed).map((t) => t.category))].map((cat) => (
            <div key={cat} className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <span className="w-8 shrink-0 font-mono text-[10px] text-ink-3">{cat}</span>
              {templates
                .filter((t) => !t.installed && t.category === cat)
                .map((t) => (
                  <button
                    key={t.id}
                    onClick={() => void addTemplate(t)}
                    className="rounded-full border border-line px-2.5 py-1 text-[12.5px] text-ink-2 transition-colors hover:border-accent/50 hover:text-ink"
                    title={t.desc}
                  >
                    {t.emoji} {t.name}
                  </button>
                ))}
            </div>
          ))}
        </>
      )}
      <button
        onClick={() => {
          onClose();
          onCustomRole();
        }}
        className="mt-3 w-full rounded-lg border border-dashed border-line py-1.5 text-[12.5px] text-ink-3 hover:border-accent/40 hover:text-ink-2"
      >
        ✚ 创作自定义角色（自拟人设与工作方式）
      </button>
      <button
        onClick={() => void create()}
        disabled={!name.trim() || busy}
        className="mt-3 w-full rounded-lg bg-accent py-2 text-[13.5px] font-medium text-white disabled:opacity-40"
      >
        创建频道
      </button>
    </Modal>
  );
}

/** 频道设置：改名 + 增减 AI 成员（按场景快速重组），不止改名字。 */
export function ChannelSettingsModal({ channel, onClose, onCustomRole }: { channel: Channel; onClose: () => void; onCustomRole: () => void }) {
  const ws = useWorkspace();
  const [name, setName] = useState(channel.name);
  const [selected, setSelected] = useState<Set<string>>(new Set(channel.agent_ids ?? []));
  const [scene, setScene] = useState<number | null>(null);
  const [templates, setTemplates] = useState<AgentTemplateInfo[]>([]);
  const [sceneHint, setSceneHint] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listAgentTemplates().then(setTemplates).catch(() => undefined);
  }, [ws.agents.length]);

  function sceneAgents(i: number) {
    const keys = SCENES[i].roleKeys;
    return ws.agents.filter((a) => keys.some((k) => a.name.includes(k) || a.role.includes(k)));
  }
  async function applyScene(i: number) {
    setScene(i);
    const added = await Promise.all(SCENES[i].templateIds.map((id) => ws.installTemplate(id).catch(() => null)));
    const ids = new Set(sceneAgents(i).map((a) => a.id));
    for (const a of added) if (a) ids.add(a.id);
    setSelected(ids);
    const want = SCENES[i].skills;
    let enabledNames = want;
    try {
      const skills: { id: string; name: string; enabled: number }[] = await api.listSkills();
      const toEnable = skills.filter((s) => want.includes(s.name) && !s.enabled);
      await Promise.all(toEnable.map((s) => api.toggleSkill(s.id, true)));
      enabledNames = want.filter((n) => skills.some((s) => s.name === n));
    } catch { /* 技能接口不可用时仅提示 */ }
    setSceneHint(
      `已套用场景成员，并启用配套工作方法：${enabledNames.join("、")}` +
        (SCENES[i].mcp ? `；建议在 ⚙ 设置 → MCP 接入「${SCENES[i].mcp}」` : "")
    );
  }
  async function addTemplate(tpl: AgentTemplateInfo) {
    const agent = await ws.installTemplate(tpl.id);
    setSelected((prev) => new Set(prev).add(agent.id));
    setTemplates((ts) => ts.map((t) => (t.id === tpl.id ? { ...t, installed: true } : t)));
  }
  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await ws.updateChannel(channel.id, { name: name.trim(), agent_ids: [...selected] });
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`频道设置 · #${channel.name}`} onClose={onClose}>
      <label className={labelCls}>频道名</label>
      <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
      <label className={labelCls}>按场景快速重组（可选，一键替换成员 + 启用配套方法）</label>
      <div className="grid grid-cols-2 gap-2">
        {SCENES.map((s, i) => {
          const active = scene === i;
          return (
            <button
              key={s.name}
              onClick={() => void applyScene(i)}
              className={`rounded-lg border p-2.5 text-left transition-colors ${active ? "border-accent bg-accent-soft" : "border-line hover:border-accent/40"}`}
            >
              <div className="flex items-center gap-1.5 text-[13px] font-medium">
                <span>{s.icon}</span>
                {s.name}
                {active && <span className="ml-auto font-mono text-[10px] text-accent">已套用</span>}
              </div>
              <div className="mt-0.5 text-[11.5px] text-ink-3">{s.desc}</div>
            </button>
          );
        })}
      </div>
      {sceneHint && (
        <div className="mt-2 rounded-lg bg-accent-soft px-3 py-2 text-[11.5px] leading-relaxed text-ink-2">✨ {sceneHint}</div>
      )}
      <label className={labelCls}>频道成员（勾选 = 在本频道，可随时增减）</label>
      <div className="flex flex-col gap-1">
        {ws.agents.map((a) => (
          <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13.5px] hover:bg-sel">
            <input
              type="checkbox"
              checked={selected.has(a.id)}
              onChange={(e) => {
                const next = new Set(selected);
                e.target.checked ? next.add(a.id) : next.delete(a.id);
                setSelected(next);
                setScene(null);
              }}
            />
            <AgentAvatar agent={a} size={20} />
            <span className="font-medium">{a.name}</span>
            <span className="truncate text-[12px] text-ink-3">{a.role}</span>
          </label>
        ))}
      </div>
      {templates.some((t) => !t.installed) && (
        <>
          <label className={labelCls}>扩展角色模板（加入团队并选入本频道）</label>
          {[...new Set(templates.filter((t) => !t.installed).map((t) => t.category))].map((cat) => (
            <div key={cat} className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <span className="w-8 shrink-0 font-mono text-[10px] text-ink-3">{cat}</span>
              {templates
                .filter((t) => !t.installed && t.category === cat)
                .map((t) => (
                  <button
                    key={t.id}
                    onClick={() => void addTemplate(t)}
                    className="rounded-full border border-line px-2.5 py-1 text-[12.5px] text-ink-2 transition-colors hover:border-accent/50 hover:text-ink"
                    title={t.desc}
                  >
                    {t.emoji} {t.name}
                  </button>
                ))}
            </div>
          ))}
        </>
      )}
      <button
        onClick={() => { onClose(); onCustomRole(); }}
        className="mt-3 w-full rounded-lg border border-dashed border-line py-1.5 text-[12.5px] text-ink-3 hover:border-accent/40 hover:text-ink-2"
      >
        ✚ 创作自定义角色
      </button>
      <button
        onClick={() => void save()}
        disabled={!name.trim() || busy}
        className="mt-3 w-full rounded-lg bg-accent py-2 text-[13.5px] font-medium text-white disabled:opacity-40"
      >
        保存
      </button>
    </Modal>
  );
}

const RECOMMENDED_MODELS = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"];

export function NewAgentModal({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("🤖");
  const [role, setRole] = useState("");
  const [prompt, setPrompt] = useState("");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim() || !prompt.trim() || busy) return;
    setBusy(true);
    try {
      await ws.createAgent({
        name: name.trim(),
        emoji,
        role: role.trim(),
        system_prompt: prompt.trim(),
        provider_id: providerId || null,
        model: model.trim() || undefined,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="新建 AI 同事" onClose={onClose}>
      <div className="flex gap-2">
        <div className="w-16">
          <label className={labelCls}>头像</label>
          <input value={emoji} onChange={(e) => setEmoji(e.target.value)} className={`${inputCls} text-center`} />
        </div>
        <div className="flex-1">
          <label className={labelCls}>名字</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 数据分析师" className={inputCls} />
        </div>
      </div>
      <label className={labelCls}>角色（一句话）</label>
      <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="例如 数据洞察与报表" className={inputCls} />
      <label className={labelCls}>人设与工作方式（系统提示词）</label>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={5}
        placeholder="你是「数据分析师」，擅长…回复风格…"
        className={`${inputCls} resize-none`}
      />
      <div className="flex gap-2">
        <div className="flex-1">
          <label className={labelCls}>模型通道</label>
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)} className={inputCls}>
            <option value="">Anthropic 官方（推荐）</option>
            {ws.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label className={labelCls}>模型（可留空用默认）</label>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={providerId ? "供应商默认模型" : "claude-opus-4-8"}
            list="model-suggestions"
            className={inputCls}
          />
          <datalist id="model-suggestions">
            {RECOMMENDED_MODELS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
      </div>
      {providerId && (
        <div className="mt-1.5 text-[11.5px] text-ink-3">
          提示：第三方/本地通道不支持联网调研（web_search）。干活与验收类角色建议用 claude-opus-4-8。
        </div>
      )}
      <button
        onClick={() => void create()}
        disabled={!name.trim() || !prompt.trim() || busy}
        className="mt-4 w-full rounded-lg bg-accent py-2 text-[13.5px] font-medium text-white disabled:opacity-40"
      >
        创建
      </button>
    </Modal>
  );
}

export type SettingsTab = "providers" | "mcp" | "skills";

export function SettingsModal({
  onClose,
  onOpenTask,
  initialTab = "providers",
}: {
  onClose: () => void;
  onOpenTask?: (taskId: string) => void;
  initialTab?: SettingsTab;
}) {
  const ws = useWorkspace();
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [lightModel, setLightModel] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [priceInputPerMillion, setPriceInputPerMillion] = useState("");
  const [priceOutputPerMillion, setPriceOutputPerMillion] = useState("");
  const [priceCurrency, setPriceCurrency] = useState("USD");
  const [webTools, setWebTools] = useState(false);
  const [isStrong, setIsStrong] = useState(false);
  const [runTaskAfterSave, setRunTaskAfterSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [providerTest, setProviderTest] = useState<Record<string, string>>({});
  const [providerTaskTest, setProviderTaskTest] = useState<Record<string, { text: string; taskId?: string }>>({});
  const [providerTaskBusy, setProviderTaskBusy] = useState<Record<string, boolean>>({});

  useEffect(() => setTab(initialTab), [initialTab]);

  function resetForm() {
    setEditingId(null);
    setName("");
    setBaseUrl("");
    setApiKey("");
    setDefaultModel("");
    setLightModel("");
    setMaxTokens("");
    setPriceInputPerMillion("");
    setPriceOutputPerMillion("");
    setPriceCurrency("USD");
    setWebTools(false);
    setIsStrong(false);
    setRunTaskAfterSave(false);
    setError("");
  }

  function applyProviderPreset(preset: (typeof PROVIDER_PRESETS)[number]) {
    setEditingId(null);
    setName(preset.name);
    setBaseUrl(preset.base_url);
    setDefaultModel(preset.default_model);
    setLightModel(preset.light_model);
    setMaxTokens("");
    setPriceInputPerMillion("");
    setPriceOutputPerMillion("");
    setPriceCurrency("USD");
    setWebTools(preset.web_tools);
    setIsStrong(preset.is_strong);
    setError("");
  }

  function startEdit(id: string) {
    const p = ws.providers.find((x) => x.id === id);
    if (!p) return;
    setEditingId(id);
    setName(p.name);
    setBaseUrl(p.base_url);
    setApiKey(""); // 留空 = 保持原 key
    setDefaultModel(p.default_model);
    setLightModel(p.light_model ?? "");
    setMaxTokens(p.max_tokens && p.max_tokens !== 16000 ? String(p.max_tokens) : "");
    setPriceInputPerMillion(p.price_input_per_million > 0 ? String(p.price_input_per_million) : "");
    setPriceOutputPerMillion(p.price_output_per_million > 0 ? String(p.price_output_per_million) : "");
    setPriceCurrency(p.price_currency || "USD");
    setWebTools(Boolean(p.web_tools));
    setIsStrong(Boolean(p.is_strong));
    setError("");
  }

  async function submit() {
    if (!name.trim() || busy) return;
    if (!editingId && !apiKey.trim()) return;
    setBusy(true);
    setError("");
    const data = {
      name: name.trim(),
      base_url: baseUrl.trim(),
      api_key: apiKey.trim(), // 编辑时留空 = 不改 key
      default_model: defaultModel.trim(),
      light_model: lightModel.trim(),
      max_tokens: Number(maxTokens) || undefined,
      price_input_per_million: Math.max(0, Number(priceInputPerMillion) || 0),
      price_output_per_million: Math.max(0, Number(priceOutputPerMillion) || 0),
      price_currency: priceCurrency.trim().toUpperCase() || "USD",
      web_tools: webTools,
      is_strong: isStrong,
    };
    try {
      const saved = editingId ? await ws.updateProvider(editingId, data) : await ws.createProvider(data);
      if (runTaskAfterSave) {
        // 供应商已保存成功；演练失败只记在演练结果里，不能报成「保存失败」诱导重复保存。
        await runProviderTaskTest(saved.id);
      }
      resetForm();
    } catch (e: any) {
      setError(e?.message ?? "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function testProvider(id: string) {
    setProviderTest((s) => ({ ...s, [id]: "测试中…" }));
    try {
      const r = await api.testProvider(id);
      setProviderTest((s) => ({
        ...s,
        [id]: `可用 · ${r.protocol === "openai-compatible" ? "OpenAI" : "Anthropic"} · ${r.model} · ${r.latency_ms}ms`,
      }));
    } catch (e: any) {
      setProviderTest((s) => ({ ...s, [id]: `失败：${String(e?.message ?? e).slice(0, 120)}` }));
    }
  }

  async function runProviderTaskTest(id: string) {
    if (providerTaskBusy[id]) return;
    setProviderTaskBusy((s) => ({ ...s, [id]: true }));
    setProviderTaskTest((s) => ({ ...s, [id]: { text: "正在读取本次预算，不会先调用模型…" } }));
    try {
      const plan = await api.providerTaskTestPlan(id);
      if (!window.confirm(providerBenchmarkConfirmation(plan))) {
        setProviderTaskTest((s) => ({ ...s, [id]: { text: "已取消 · 未调用模型、未创建任务" } }));
        return;
      }
      setProviderTaskTest((s) => ({ ...s, [id]: { text: `质量基准运行中…上限 ${formatTokenCount(plan.budget_billable)} billable，触线即暂停` } }));
      const r = await ws.runProviderTaskTest(id, providerBenchmarkRunInput(plan));
      const checks = [
        r.checks.delivered ? "交付" : "未交付",
        r.checks.tool_observed ? "工具" : "无工具",
        r.checks.quality_contract ? "7项契约" : "契约缺失",
        r.checks.document_contract ? "机器预检" : "结构缺项",
        r.checks.independent_reviewer ? "独立复核" : "复核冲突",
        r.checks.verdict_recorded ? "通过" : r.checks.pending_approval ? "待复核" : "未通过",
        r.checks.source_trace_clean ? "来源可追溯" : "来源声明冲突",
        r.checks.pending_approval ? "复核预算待批" : r.checks.within_budget ? "预算内" : "已触线",
        r.checks.usage_tracked ? "用量" : "无用量",
      ].join(" / ");
      setProviderTaskTest((s) => ({
        ...s,
        [id]: {
          text: `${r.run_status === "passed" ? "通过" : r.run_status === "pending_approval" ? "已产出初稿，等待预算审批" : "未通过"} · ${r.task.status} · ${checks} · ${r.latency_ms}ms · ${formatTokenCount(r.usage_summary?.billable)} billable${formatEstimatedCost(r.usage_summary?.estimated_cost, r.usage_summary?.price_currency)}`,
          taskId: r.task.id,
        },
      }));
    } catch (e: any) {
      setProviderTaskTest((s) => ({ ...s, [id]: { text: `失败：${String(e?.message ?? e).slice(0, 160)}` } }));
    } finally {
      setProviderTaskBusy((s) => ({ ...s, [id]: false }));
    }
  }

  const tabBtn = (key: typeof tab, label: string) => (
    <button
      onClick={() => setTab(key)}
      className={`rounded-lg px-3 py-1 text-[13px] ${tab === key ? "bg-sel font-medium text-ink" : "text-ink-2 hover:bg-sel/60"}`}
    >
      {label}
    </button>
  );

  return (
    <Modal title="设置" onClose={onClose} wide>
      <div className="mb-3 flex gap-1 border-b border-line pb-2">
        {tabBtn("providers", "模型供应商")}
        {tabBtn("mcp", "MCP 插件")}
        {tabBtn("skills", "技能")}
      </div>
      {tab === "mcp" && <McpTab onOpenTask={onOpenTask} />}
      {tab === "skills" && <SkillsTab onOpenTask={onOpenTask} />}
      {tab === "providers" && (
        <div>
      <div className="text-[12.5px] leading-relaxed text-ink-2">
        连接模型后，AI 同事会从演示模式切换为真实工作；API Key 只保存在服务端。
        <span className="font-medium"> 主模型</span>负责分析、创作和复核，
        <span className="font-medium">轻量模型</span>负责重复任务以降低成本。DeepSeek、SiliconFlow、百炼及其他兼容端点均可接入。
      </div>

      {ws.providers.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {ws.providers.map((p) => (
            <div
              key={p.id}
              className={`rounded-lg border px-3 py-2.5 text-[13px] ${editingId === p.id ? "border-accent/60 bg-accent-soft/40" : "border-line"}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-ink">{p.name}</div>
                  <div className="mt-0.5 break-all text-[11.5px] leading-snug text-ink-3">
                    {p.base_url || "api.anthropic.com"}
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (editingId === p.id) resetForm();
                    void ws.deleteProvider(p.id);
                  }}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[11.5px] text-ink-3 hover:bg-sel hover:text-red-500"
                  title="删除后，引用它的同事将回退到官方通道"
                >
                  删除
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-[11.5px] text-ink-2">
                <span className="rounded bg-sel px-2 py-1">主模型 · {p.default_model || "未设置"}</span>
                {p.light_model && <span className="rounded bg-sel px-2 py-1">轻量 · {p.light_model}</span>}
                {(p.price_input_per_million > 0 || p.price_output_per_million > 0) && (
                  <span className="rounded bg-sel px-2 py-1">
                    {p.price_currency || "USD"}/百万 · 输入 {p.price_input_per_million || 0} · 输出 {p.price_output_per_million || 0}
                  </span>
                )}
              </div>
              {providerTest[p.id] && (
                <div className="mt-2 rounded bg-sel/60 px-2 py-1.5 text-[11.5px] leading-snug text-ink-2">连通测试：{providerTest[p.id]}</div>
              )}
              {providerTaskTest[p.id] && (
                <div className="mt-2 rounded bg-sel/60 px-2 py-1.5 text-[11.5px] leading-snug text-ink-2">质量基准：{providerTaskTest[p.id].text}</div>
              )}
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void testProvider(p.id)}
                  className="whitespace-nowrap rounded-md border border-line px-2.5 py-1.5 text-[12px] text-ink-2 hover:bg-sel hover:text-ink"
                  title="发送一次最小模型请求，验证 Base URL、Key、模型名与协议适配"
                >
                  连通测试
                </button>
                <button
                  onClick={() => void runProviderTaskTest(p.id)}
                  disabled={Boolean(providerTaskBusy[p.id])}
                  className="whitespace-nowrap rounded-md border border-accent/40 bg-accent-soft px-2.5 py-1.5 text-[12px] text-accent hover:border-accent disabled:opacity-40"
                  title="先查看并确认实际预算，再运行固定隔离业务题；取消不会调用模型"
                >
                  {providerTaskBusy[p.id] ? "基准运行中…" : "运行质量基准"}
                </button>
                <button
                  onClick={() => startEdit(p.id)}
                  className="whitespace-nowrap rounded-md border border-line px-2.5 py-1.5 text-[12px] text-ink-2 hover:bg-sel hover:text-ink"
                >
                  编辑配置
                </button>
                {providerTaskTest[p.id]?.taskId && (
                  <button
                    onClick={() => onOpenTask?.(providerTaskTest[p.id]!.taskId!)}
                    className="whitespace-nowrap rounded-md px-2.5 py-1.5 text-[12px] text-accent hover:bg-accent-soft"
                    title="打开该模型演练任务的详情、活动日志和交付物"
                  >
                    查看结果
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 text-[12.5px] font-medium text-ink">
        {editingId ? `编辑：${name || "供应商"}` : "新增供应商"}
        {editingId && (
          <button onClick={resetForm} className="rounded px-1.5 text-[12px] font-normal text-ink-3 hover:bg-sel">
            取消编辑
          </button>
        )}
      </div>

      {!editingId && (
        <>
          <label className={labelCls}>推荐预设</label>
          <div className="grid gap-2 sm:grid-cols-3">
            {PROVIDER_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyProviderPreset(preset)}
                className={`rounded-lg border p-2 text-left transition-colors ${
                  name === preset.name && baseUrl === preset.base_url
                    ? "border-accent bg-accent-soft"
                    : "border-line hover:border-accent/40 hover:bg-sel/60"
                }`}
                title={`${preset.base_url} · ${preset.default_model}`}
              >
                <div className="text-[12.5px] font-semibold">{preset.name}</div>
                <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-ink-3">{preset.desc}</div>
              </button>
            ))}
          </div>
          <div className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
            预设只负责填入协议路径和模型名；Key 仍需你手动填写并点击「测试」确认。模型列表可能随供应商更新，字段可直接改。
          </div>
        </>
      )}

      <label className={labelCls}>名称</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 DeepSeek / SiliconFlow / 百炼" className={inputCls} />
      <label className={labelCls}>Base URL（自动识别 Anthropic-compatible / OpenAI-compatible）</label>
      <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/anthropic 或 https://api.siliconflow.cn/v1" className={inputCls} />
      <label className={labelCls}>API Key（仅存服务端，不会下发前端）</label>
      <input
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        type="password"
        placeholder={editingId ? "留空 = 保持原 Key 不变" : "sk-…"}
        className={inputCls}
      />
      <div className="flex gap-2">
        <div className="flex-1">
          <label className={labelCls}>默认模型（分析/创作）</label>
          <input value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} placeholder="deepseek-v4-pro / THUDM/GLM-4.1V-9B-Thinking / qwen-plus" className={inputCls} />
        </div>
        <div className="flex-1">
          <label className={labelCls}>轻量模型（重复性任务，可选）</label>
          <input value={lightModel} onChange={(e) => setLightModel(e.target.value)} placeholder="deepseek-v4-flash / Qwen/Qwen3-8B / qwen-turbo" className={inputCls} />
        </div>
      </div>
      <label className={labelCls}>单次输出上限 max_tokens（可选）</label>
      <input
        value={maxTokens}
        onChange={(e) => setMaxTokens(e.target.value)}
        placeholder="默认 16000（DeepSeek V4 支持 384K，可不填）；本地模型按运行时上限"
        className={inputCls}
      />
      <label className={labelCls}>价格（可选，用于模型演练估算成本）</label>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_96px]">
        <input
          value={priceInputPerMillion}
          onChange={(e) => setPriceInputPerMillion(e.target.value)}
          placeholder="输入 / 1M tokens"
          inputMode="decimal"
          className={inputCls}
        />
        <input
          value={priceOutputPerMillion}
          onChange={(e) => setPriceOutputPerMillion(e.target.value)}
          placeholder="输出 / 1M tokens"
          inputMode="decimal"
          className={inputCls}
        />
        <input
          value={priceCurrency}
          onChange={(e) => setPriceCurrency(e.target.value.toUpperCase())}
          placeholder="USD"
          className={inputCls}
        />
      </div>
      <div className="mt-1 text-[11px] leading-relaxed text-ink-3">
        按供应商控制台价格手动填写；不填则只显示 billable tokens，不估算金额。
      </div>
      <label className="mt-3 flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-2">
        <input type="checkbox" checked={webTools} onChange={(e) => setWebTools(e.target.checked)} />
        该端点支持 Anthropic 服务端联网工具（web_search/web_fetch）。仅 Anthropic-compatible 端点建议勾选；
        OpenAI-compatible 通道会自动关闭该项，联网请优先用 MCP。
      </label>
      <label className="mt-2 flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-2">
        <input type="checkbox" checked={isStrong} onChange={(e) => setIsStrong(e.target.checked)} />
        ⭐ 用作强通道：没有官方 Anthropic key 时，验收与项目汇总优先走该供应商的默认模型
        （质量闭环的下限，建议指给最强的一家）。
      </label>
      <label className="mt-2 flex cursor-pointer items-start gap-2 text-[12.5px] text-ink-2">
        <input className="mt-0.5" type="checkbox" checked={runTaskAfterSave} onChange={(e) => setRunTaskAfterSave(e.target.checked)} />
        <span>
          保存后立即跑质量基准：固定业务题由轻量模型产出、强模型独立复核并自动返工，
          同时验证工具、来源追溯、交付、验收和用量；运行前会展示实际 token 上限、复核预留和可估算金额，
          余额不足会保留初稿并暂停，批准后直接从复核继续，不重复生成。
        </span>
      </label>
      {error && <div className="mt-2 text-[12px] text-red-500">{error}</div>}
      <button
        onClick={() => void submit()}
        disabled={!name.trim() || (!editingId && !apiKey.trim()) || busy}
        className="mt-4 w-full rounded-lg bg-accent py-2 text-[13.5px] font-medium text-white disabled:opacity-40"
      >
        {busy ? "处理中…" : runTaskAfterSave ? "保存并跑质量基准" : editingId ? "保存修改" : "添加供应商"}
      </button>

      <ImageProviderSection />
        </div>
      )}
    </Modal>
  );
}

/** 图像生成供应商（Seedream / 火山方舟，OpenAI images 协议）。配置后全员获得 generate_image 工具。 */
function ImageProviderSection() {
  const [info, setInfo] = useState<ImageProviderInfo | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.getImageProvider().then((p) => {
      setInfo(p);
      setBaseUrl(p.base_url);
      setModel(p.model);
    }).catch(() => undefined);
  }, []);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await api.saveImageProvider({ base_url: baseUrl, api_key: apiKey, model });
      setInfo((prev) => ({ ...next, default_base_url: prev?.default_base_url }));
      setApiKey("");
    } catch (e: any) {
      setError(e?.message ?? "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-ink">
        🎨 图像生成（Seedream）
        {info?.has_key && <span className="rounded bg-sel px-1.5 py-px font-mono text-[10px] text-accent">已启用</span>}
      </div>
      <div className="mt-1 text-[12px] leading-relaxed text-ink-3">
        接入字节火山方舟的 Seedream 文生图后，AI 同事获得 generate_image 工具，可为报告/PPT 生成配图
        （按张计费，默认单次运行上限 2 张，工具每次只采用 1 张；Seedream 5.0 Pro 使用默认单图模式）。Base URL 可填写 API 根地址或完整
        /images/generations 端点；模型栏填写方舟控制台展示的模型 ID 或接入点 ID。
      </div>
      <label className={labelCls}>Base URL</label>
      <input
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder={info?.default_base_url || "https://ark.cn-beijing.volces.com/api/v3"}
        className={inputCls}
      />
      <label className={labelCls}>API Key（仅存服务端，不会下发前端）</label>
      <input
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        type="password"
        placeholder={info?.has_key ? "留空 = 保持原 Key 不变" : "方舟 API Key"}
        className={inputCls}
      />
      <label className={labelCls}>模型 / 接入点 ID</label>
      <input
        value={model}
        onChange={(e) => setModel(e.target.value)}
        placeholder="例如 doubao-seedream-5-0-pro-260628（以方舟控制台为准）"
        className={inputCls}
      />
      {error && <div className="mt-2 text-[12px] text-red-500">{error}</div>}
      <button
        onClick={() => void save()}
        disabled={busy || (!info?.has_key && !apiKey.trim()) || !model.trim()}
        className="mt-3 w-full rounded-lg border border-accent/50 py-1.5 text-[13px] font-medium text-accent hover:bg-accent-soft disabled:opacity-40"
      >
        保存图像生成配置
      </button>
    </div>
  );
}

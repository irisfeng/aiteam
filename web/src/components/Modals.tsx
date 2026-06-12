import { useEffect, useState, type ReactNode } from "react";
import { useWorkspace } from "../store";
import { api, type AgentTemplateInfo } from "../api";

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div
        className="modal-card max-h-[90vh] w-[440px] overflow-y-auto rounded-xl border border-line bg-panel p-5 shadow-xl"
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

/** 场景组队模板（Hive 设计：3-4 张场景卡一键组队，零输入成本）。
 *  roleKeys 匹配已有成员；templateIds 指向角色模板库——选卡时自动实例化。 */
const SCENES: { icon: string; name: string; desc: string; channel: string; roleKeys: string[]; templateIds: string[] }[] = [
  { icon: "🔬", name: "调研与报告", desc: "联网调研 → 分析报告 + 数据表", channel: "research", roleKeys: ["产品", "工程", "分析"], templateIds: ["analyst"] },
  { icon: "🚀", name: "产品立项", desc: "拆解分工 → 并行交付 → 汇总", channel: "project", roleKeys: ["产品", "工程", "评审"], templateIds: [] },
  { icon: "✍️", name: "内容与增长", desc: "选题 → 成文 → 校对 → SEO", channel: "content", roleKeys: ["SEO", "增长", "内容", "文案", "校对"], templateIds: ["writer", "proofreader"] },
  { icon: "🧰", name: "解决方案", desc: "需求澄清 → 选型对比 → 实施方案", channel: "solution", roleKeys: ["方案", "产品", "工程"], templateIds: ["solution"] },
];

export function NewChannelModal({ onClose, onCustomRole }: { onClose: () => void; onCustomRole: () => void }) {
  const ws = useWorkspace();
  const [name, setName] = useState("");
  const [scene, setScene] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set(ws.agents.map((a) => a.id)));
  const [templates, setTemplates] = useState<AgentTemplateInfo[]>([]);
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
              <div className="mt-1 text-[12px]">{members.map((a) => a.emoji).join(" ") || "—"}</div>
            </button>
          );
        })}
      </div>
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
          <div className="flex flex-wrap gap-1.5">
            {templates
              .filter((t) => !t.installed)
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

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [lightModel, setLightModel] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [webTools, setWebTools] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function resetForm() {
    setEditingId(null);
    setName("");
    setBaseUrl("");
    setApiKey("");
    setDefaultModel("");
    setLightModel("");
    setMaxTokens("");
    setWebTools(false);
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
    setWebTools(Boolean(p.web_tools));
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
      web_tools: webTools,
    };
    try {
      if (editingId) await ws.updateProvider(editingId, data);
      else await ws.createProvider(data);
      resetForm();
    } catch (e: any) {
      setError(e?.message ?? "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="模型供应商" onClose={onClose}>
      <div className="text-[12.5px] leading-relaxed text-ink-2">
        默认推荐 Anthropic 官方（环境变量 <code className="rounded bg-panel px-1">ANTHROPIC_API_KEY</code>）。
        也可接入任何 <span className="font-medium">Anthropic 协议兼容</span>端点：DeepSeek / GLM / Kimi /
        MiniMax，或经 LiteLLM 网关接入 OpenAI 协议供应商与本地模型（Ollama、vLLM…）。
        <span className="font-medium">默认模型</span>承担分析/创作，<span className="font-medium">轻量模型</span>承担
        重复性/格式化任务（拆解时由 Lead 逐任务智能选择，大幅降本）。
      </div>

      {ws.providers.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {ws.providers.map((p) => (
            <div
              key={p.id}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px] ${editingId === p.id ? "border-accent/60 bg-accent-soft/40" : "border-line"}`}
            >
              <span className="font-medium">{p.name}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
                {p.base_url || "api.anthropic.com"} · {p.default_model || "未设默认模型"}
                {p.light_model ? ` · ⚡${p.light_model}` : ""}
              </span>
              <button
                onClick={() => startEdit(p.id)}
                className="rounded px-1.5 text-[12px] text-ink-2 hover:bg-sel hover:text-ink"
                title="编辑该供应商"
              >
                编辑
              </button>
              <button
                onClick={() => {
                  if (editingId === p.id) resetForm();
                  void ws.deleteProvider(p.id);
                }}
                className="rounded px-1.5 text-ink-3 hover:bg-sel hover:text-ink"
                title="删除（引用它的同事将回退到官方通道）"
              >
                ✕
              </button>
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

      <label className={labelCls}>名称</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 DeepSeek / 本地 Ollama" className={inputCls} />
      <label className={labelCls}>Base URL（Anthropic 协议兼容端点）</label>
      <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/anthropic" className={inputCls} />
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
          <input value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} placeholder="deepseek-v4-pro" className={inputCls} />
        </div>
        <div className="flex-1">
          <label className={labelCls}>轻量模型（重复性任务，可选）</label>
          <input value={lightModel} onChange={(e) => setLightModel(e.target.value)} placeholder="deepseek-v4-flash" className={inputCls} />
        </div>
      </div>
      <label className={labelCls}>单次输出上限 max_tokens（可选）</label>
      <input
        value={maxTokens}
        onChange={(e) => setMaxTokens(e.target.value)}
        placeholder="默认 16000（DeepSeek V4 支持 384K，可不填）；本地模型按运行时上限"
        className={inputCls}
      />
      <label className="mt-3 flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-2">
        <input type="checkbox" checked={webTools} onChange={(e) => setWebTools(e.target.checked)} />
        该端点支持服务端联网工具（web_search/web_fetch）。DeepSeek 官方 Anthropic 端点声明原生支持，可勾选；
        若实测不支持会自动停用并继续工作。
      </label>
      {error && <div className="mt-2 text-[12px] text-red-500">{error}</div>}
      <button
        onClick={() => void submit()}
        disabled={!name.trim() || (!editingId && !apiKey.trim()) || busy}
        className="mt-4 w-full rounded-lg bg-accent py-2 text-[13.5px] font-medium text-white disabled:opacity-40"
      >
        {editingId ? "保存修改" : "添加供应商"}
      </button>
    </Modal>
  );
}

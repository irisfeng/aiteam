import { useState, type ReactNode } from "react";
import { useWorkspace } from "../store";

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30" onMouseDown={onClose}>
      <div
        className="w-[420px] rounded-xl border border-line bg-white p-5 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded px-1.5 text-ink-3 hover:bg-panel">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-line bg-white px-3 py-2 text-[13.5px] outline-none focus:border-accent/50";
const labelCls = "mb-1 mt-3 block text-[12.5px] font-medium text-ink-2 first:mt-0";

export function NewChannelModal({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set(ws.agents.map((a) => a.id)));
  const [busy, setBusy] = useState(false);

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
      <label className={labelCls}>频道名</label>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 asr_stt_finetuning" className={inputCls} />
      <label className={labelCls}>邀请 AI 同事</label>
      <div className="flex flex-col gap-1">
        {ws.agents.map((a) => (
          <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13.5px] hover:bg-panel">
            <input
              type="checkbox"
              checked={selected.has(a.id)}
              onChange={(e) => {
                const next = new Set(selected);
                e.target.checked ? next.add(a.id) : next.delete(a.id);
                setSelected(next);
              }}
            />
            <span>{a.emoji}</span>
            <span className="font-medium">{a.name}</span>
            <span className="truncate text-[12px] text-ink-3">{a.role}</span>
          </label>
        ))}
      </div>
      <button
        onClick={() => void create()}
        disabled={!name.trim() || busy}
        className="mt-4 w-full rounded-lg bg-accent py-2 text-[13.5px] font-medium text-white disabled:opacity-40"
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
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function add() {
    if (!name.trim() || !apiKey.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await ws.createProvider({
        name: name.trim(),
        base_url: baseUrl.trim(),
        api_key: apiKey.trim(),
        default_model: defaultModel.trim(),
      });
      setName("");
      setBaseUrl("");
      setApiKey("");
      setDefaultModel("");
    } catch (e: any) {
      setError(e?.message ?? "添加失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="模型供应商" onClose={onClose}>
      <div className="text-[12.5px] leading-relaxed text-ink-2">
        默认推荐 Anthropic 官方（环境变量 <code className="rounded bg-panel px-1">ANTHROPIC_API_KEY</code>）。
        也可接入任何 <span className="font-medium">Anthropic 协议兼容</span>端点：DeepSeek / GLM / Kimi /
        MiniMax 官方兼容端点，或经 LiteLLM 网关接入 OpenAI 协议供应商与本地模型（Ollama、vLLM…）。
        注意：第三方通道不支持联网调研（web_search 为 Anthropic 服务端工具）。
      </div>

      {ws.providers.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {ws.providers.map((p) => (
            <div key={p.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px]">
              <span className="font-medium">{p.name}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
                {p.base_url || "api.anthropic.com"} · {p.default_model || "未设默认模型"}
              </span>
              <button
                onClick={() => void ws.deleteProvider(p.id)}
                className="rounded px-1.5 text-ink-3 hover:bg-panel hover:text-ink"
                title="删除（引用它的同事将回退到官方通道）"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <label className={labelCls}>名称</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 DeepSeek / 本地 Ollama" className={inputCls} />
      <label className={labelCls}>Base URL（Anthropic 协议兼容端点）</label>
      <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/anthropic" className={inputCls} />
      <label className={labelCls}>API Key（仅存服务端，不会下发前端）</label>
      <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" placeholder="sk-…" className={inputCls} />
      <label className={labelCls}>默认模型</label>
      <input value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} placeholder="例如 deepseek-chat" className={inputCls} />
      {error && <div className="mt-2 text-[12px] text-red-500">{error}</div>}
      <button
        onClick={() => void add()}
        disabled={!name.trim() || !apiKey.trim() || busy}
        className="mt-4 w-full rounded-lg bg-accent py-2 text-[13.5px] font-medium text-white disabled:opacity-40"
      >
        添加供应商
      </button>
    </Modal>
  );
}

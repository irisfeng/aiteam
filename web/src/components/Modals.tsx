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

export function NewAgentModal({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("🤖");
  const [role, setRole] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim() || !prompt.trim() || busy) return;
    setBusy(true);
    try {
      await ws.createAgent({ name: name.trim(), emoji, role: role.trim(), system_prompt: prompt.trim() });
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

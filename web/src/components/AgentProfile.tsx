import { useEffect, useState } from "react";
import { useWorkspace } from "../store";
import { API_BASE } from "../api";
import type { Agent } from "../types";
import { AgentAvatar, memberColor } from "./Avatar";

/** Agent 档案面板（借鉴 Osaurus：Agent 是一等公民——身份/提示词/模型/记忆全部可视） */
export function AgentProfileModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const ws = useWorkspace();
  const [memory, setMemory] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/agents/${agent.id}/memory`)
      .then((r) => r.json())
      .then((d) => setMemory(d.content ?? ""))
      .catch(() => setMemory(""));
  }, [agent.id]);

  async function clearMemory() {
    if (!confirm(`确认清空 ${agent.name} 的长期记忆？此操作不可恢复。`)) return;
    await fetch(`${API_BASE}/agents/${agent.id}/memory`, { method: "DELETE" });
    setMemory("");
  }

  const provider = ws.providers.find((p) => p.id === agent.provider_id);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onMouseDown={onClose}>
      <div
        className="modal-card flex max-h-full w-[520px] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <AgentAvatar agent={agent} size={44} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[16px] font-semibold" style={{ color: memberColor(agent.id) }}>
                {agent.name}
              </span>
              <span className="rounded border border-line bg-sel px-1 font-mono text-[10px] leading-4 text-ink-2">AI</span>
            </div>
            <div className="truncate text-[12.5px] text-ink-3">{agent.role}</div>
          </div>
          <button
            onClick={() => {
              onClose();
              void ws.openDm(agent.id);
            }}
            className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white"
          >
            私信
          </button>
          <button onClick={onClose} className="rounded px-1.5 text-ink-3 hover:bg-sel">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="flex items-center gap-2 text-[12.5px] text-ink-2">
            <span className="font-medium">模型通道</span>
            <span className="rounded border border-line bg-sel px-1.5 font-mono text-[11px] leading-5">{agent.model}</span>
            <span className="text-ink-3">{provider ? `@ ${provider.name}` : "@ 官方 / 工作区默认"}</span>
          </div>

          <button
            onClick={() => setShowPrompt((s) => !s)}
            className="mt-4 flex w-full items-center gap-1 text-left text-[12.5px] font-medium text-ink-2 hover:text-ink"
          >
            {showPrompt ? "▾" : "▸"} 人设与工作方式（系统提示词）
          </button>
          {showPrompt && (
            <pre className="mt-1.5 max-h-44 overflow-y-auto whitespace-pre-wrap rounded-lg bg-sel p-3 text-[12px] leading-relaxed text-ink-2">
              {agent.system_prompt}
            </pre>
          )}

          <div className="mt-4 flex items-center gap-2">
            <span className="text-[12.5px] font-medium text-ink-2">长期记忆</span>
            <span className="font-mono text-[10.5px] text-ink-3">{memory === null ? "…" : `${memory.length} 字`}</span>
            {memory ? (
              <button onClick={() => void clearMemory()} className="ml-auto rounded px-1.5 text-[11.5px] text-ink-3 hover:bg-sel hover:text-red-500">
                清空
              </button>
            ) : null}
          </div>
          <pre className="mt-1.5 max-h-60 min-h-[3.5rem] overflow-y-auto whitespace-pre-wrap rounded-lg bg-sel p-3 font-mono text-[11.5px] leading-relaxed text-ink-2">
            {memory === null ? "加载中…" : memory || "（还没有记忆——交付任务后会自动沉淀「核实过的事实」与「通用规则」）"}
          </pre>
        </div>
      </div>
    </div>
  );
}

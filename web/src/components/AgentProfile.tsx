import { useEffect, useState } from "react";
import { useWorkspace } from "../store";
import { API_BASE } from "../api";
import type { Agent } from "../types";
import { AgentAvatar, memberColor } from "./Avatar";

/** Agent 档案面板（借鉴 Osaurus：Agent 是一等公民——身份/提示词/模型/记忆全部可视） */
export function AgentProfileModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const ws = useWorkspace();
  const liveAgent = ws.agents.find((item) => item.id === agent.id) ?? agent;
  const [memory, setMemory] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [editRouting, setEditRouting] = useState(false);
  const [savingRouting, setSavingRouting] = useState(false);
  const [routeError, setRouteError] = useState("");
  const [primaryProviderId, setPrimaryProviderId] = useState(liveAgent.provider_id ?? "");
  const [primaryModel, setPrimaryModel] = useState(liveAgent.model);
  const [fallbackProviderId, setFallbackProviderId] = useState(liveAgent.fallback_provider_id ?? "");
  const [fallbackModel, setFallbackModel] = useState(liveAgent.fallback_model ?? "");
  const [strongProviderId, setStrongProviderId] = useState(liveAgent.strong_provider_id ?? "");
  const [strongModel, setStrongModel] = useState(liveAgent.strong_model ?? "");

  useEffect(() => {
    fetch(`${API_BASE}/agents/${agent.id}/memory`)
      .then((r) => r.json())
      .then((d) => setMemory(d.content ?? ""))
      .catch(() => setMemory(""));
  }, [agent.id]);

  useEffect(() => {
    if (editRouting) return;
    setPrimaryProviderId(liveAgent.provider_id ?? "");
    setPrimaryModel(liveAgent.model);
    setFallbackProviderId(liveAgent.fallback_provider_id ?? "");
    setFallbackModel(liveAgent.fallback_model ?? "");
    setStrongProviderId(liveAgent.strong_provider_id ?? "");
    setStrongModel(liveAgent.strong_model ?? "");
  }, [editRouting, liveAgent]);

  async function clearMemory() {
    if (!confirm(`确认清空 ${agent.name} 的长期记忆？此操作不可恢复。`)) return;
    await fetch(`${API_BASE}/agents/${agent.id}/memory`, { method: "DELETE" });
    setMemory("");
  }

  const provider = ws.providers.find((p) => p.id === liveAgent.provider_id);
  const fallbackProvider = ws.providers.find((p) => p.id === liveAgent.fallback_provider_id);
  const strongProvider = ws.providers.find((p) => p.id === liveAgent.strong_provider_id);

  function chooseProvider(
    id: string,
    setProviderId: (value: string) => void,
    setModel: (value: string) => void,
    preserveOfficialModel = false,
  ) {
    setProviderId(id);
    const selected = ws.providers.find((item) => item.id === id);
    if (selected?.default_model) setModel(selected.default_model);
    else if (!preserveOfficialModel) setModel("");
  }

  async function saveRouting() {
    setSavingRouting(true);
    setRouteError("");
    try {
      const updated = await ws.updateAgent(liveAgent.id, {
        provider_id: primaryProviderId || null,
        model: primaryModel.trim(),
        fallback_provider_id: fallbackProviderId || null,
        fallback_model: fallbackModel.trim(),
        strong_provider_id: strongProviderId || null,
        strong_model: strongModel.trim(),
      });
      setPrimaryProviderId(updated.provider_id ?? "");
      setPrimaryModel(updated.model);
      setFallbackProviderId(updated.fallback_provider_id ?? "");
      setFallbackModel(updated.fallback_model ?? "");
      setStrongProviderId(updated.strong_provider_id ?? "");
      setStrongModel(updated.strong_model ?? "");
      setEditRouting(false);
    } catch (err) {
      setRouteError(err instanceof Error ? err.message : "模型路由保存失败");
    } finally {
      setSavingRouting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onMouseDown={onClose}>
      <div
        className="modal-card flex max-h-full w-[620px] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <AgentAvatar agent={agent} size={44} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[16px] font-semibold" style={{ color: memberColor(agent.id) }}>
                {liveAgent.name}
              </span>
              <span className="rounded border border-line bg-sel px-1 font-mono text-[10px] leading-4 text-ink-2">AI</span>
            </div>
            <div className="truncate text-[12.5px] text-ink-3">{liveAgent.role}</div>
          </div>
          <button
            onClick={() => {
              onClose();
              void ws.openDm(liveAgent.id);
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
            <span className="rounded border border-line bg-sel px-1.5 font-mono text-[11px] leading-5">{liveAgent.model}</span>
            <span className="text-ink-3">{provider ? `@ ${provider.name}` : "@ 官方 / 工作区默认"}</span>
            <button
              onClick={() => setEditRouting((value) => !value)}
              className="ml-auto rounded border border-line px-2 py-1 text-[11.5px] text-ink-2 hover:bg-sel"
            >
              {editRouting ? "收起" : "配置路由"}
            </button>
          </div>

          <div className="mt-2 rounded-lg border border-line bg-sel/40 p-3 text-[11.5px] leading-relaxed text-ink-2">
            <div className="font-medium text-ink">按工作价值分层，而不是全员共用一个模型</div>
            <div className="mt-1 grid gap-0.5 sm:grid-cols-2">
              <span>轻量整理：{provider?.light_model || liveAgent.model}</span>
              <span>普通执行：{liveAgent.model}</span>
              <span>主通道失效：{fallbackProvider ? `${liveAgent.fallback_model || fallbackProvider.default_model} @ ${fallbackProvider.name}` : "工作区默认兜底"}</span>
              <span>复核/汇总升级：{strongProvider ? `${liveAgent.strong_model || strongProvider.default_model} @ ${strongProvider.name}` : "工作区强通道"}</span>
            </div>
          </div>

          {editRouting && (
            <div className="mt-3 rounded-lg border border-accent/30 bg-accent-soft/40 p-3">
              {[
                {
                  label: "普通执行 · 主通道",
                  hint: "角色日常工作；light 任务会自动改用该 Provider 的轻量模型。",
                  providerId: primaryProviderId,
                  model: primaryModel,
                  setProviderId: setPrimaryProviderId,
                  setModel: setPrimaryModel,
                  providerPlaceholder: "官方 / 工作区默认",
                  preserveOfficialModel: true,
                },
                {
                  label: "故障兜底",
                  hint: "主通道未配置或缺 Key 时启用；运行中错误不会自动跨模型重放，避免重复副作用。",
                  providerId: fallbackProviderId,
                  model: fallbackModel,
                  setProviderId: setFallbackProviderId,
                  setModel: setFallbackModel,
                  providerPlaceholder: "工作区默认兜底",
                  preserveOfficialModel: false,
                },
                {
                  label: "关键节点升级",
                  hint: "独立复核与最终汇总使用；应绑定推理更强、最好与执行通道不同的模型。",
                  providerId: strongProviderId,
                  model: strongModel,
                  setProviderId: setStrongProviderId,
                  setModel: setStrongModel,
                  providerPlaceholder: "工作区强通道",
                  preserveOfficialModel: false,
                },
              ].map((route) => (
                <div key={route.label} className="mb-3 last:mb-0">
                  <div className="text-[12px] font-medium text-ink">{route.label}</div>
                  <div className="mb-1 text-[10.5px] text-ink-3">{route.hint}</div>
                  <div className="grid grid-cols-[1fr_1.1fr] gap-2">
                    <select
                      value={route.providerId}
                      onChange={(event) => chooseProvider(event.target.value, route.setProviderId, route.setModel, route.preserveOfficialModel)}
                      className="rounded-md border border-line bg-panel px-2 py-1.5 text-[11.5px] outline-none focus:border-accent"
                    >
                      <option value="">{route.providerPlaceholder}</option>
                      {ws.providers.map((item) => (
                        <option key={item.id} value={item.id}>{item.name}{item.is_strong ? " · 强" : ""}</option>
                      ))}
                    </select>
                    <input
                      value={route.model}
                      onChange={(event) => route.setModel(event.target.value)}
                      placeholder="模型 ID"
                      className="rounded-md border border-line bg-panel px-2 py-1.5 font-mono text-[11px] outline-none focus:border-accent"
                    />
                  </div>
                </div>
              ))}
              {routeError && <div className="mb-2 text-[11px] text-red-500">{routeError}</div>}
              <div className="flex justify-end gap-2">
                <button onClick={() => setEditRouting(false)} className="rounded px-2.5 py-1 text-[11.5px] text-ink-3 hover:bg-sel">取消</button>
                <button
                  onClick={() => void saveRouting()}
                  disabled={savingRouting || !primaryModel.trim()}
                  className="rounded bg-accent px-3 py-1 text-[11.5px] font-medium text-white disabled:opacity-50"
                >
                  {savingRouting ? "保存中…" : "保存路由"}
                </button>
              </div>
            </div>
          )}

          <button
            onClick={() => setShowPrompt((s) => !s)}
            className="mt-4 flex w-full items-center gap-1 text-left text-[12.5px] font-medium text-ink-2 hover:text-ink"
          >
            {showPrompt ? "▾" : "▸"} 人设与工作方式（系统提示词）
          </button>
          {showPrompt && (
            <pre className="mt-1.5 max-h-44 overflow-y-auto whitespace-pre-wrap rounded-lg bg-sel p-3 text-[12px] leading-relaxed text-ink-2">
              {liveAgent.system_prompt}
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

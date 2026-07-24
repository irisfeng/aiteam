import { useWorkspace } from "../store";

/** 演示模式横幅：未接入任何模型 key 时常驻提醒，一键去设置接入 */
export function MockBanner({ onSettings }: { onSettings: () => void }) {
  const ws = useWorkspace();
  if (!ws.mockMode) return null;
  return (
    <div className="flex items-center gap-2 border-b border-accent/30 bg-accent-soft px-4 py-1.5 text-[12.5px] text-ink-2">
      <span>🧪 演示模式：未接入模型 key，AI 回复为模拟内容（流程可点）。</span>
      <button onClick={onSettings} className="font-medium text-accent underline-offset-2 hover:underline">
        接入模型 →
      </button>
    </div>
  );
}

import { useState } from "react";
import { useWorkspace } from "../store";
import { BrandMark } from "./Brand";

const SEEN_KEY = "aiteam_onboarded_v1";

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

/** 首次引导：直接指向任务运行线。看过一次后不再弹（localStorage）。 */
export function WelcomeOverlay({
  onSettings,
  onNewChannel,
  onOpenTasks,
  suppress = false,
}: {
  onSettings: () => void;
  onNewChannel: () => void;
  onOpenTasks: () => void;
  suppress?: boolean;
}) {
  const ws = useWorkspace();
  const [open, setOpen] = useState(() => !localStorage.getItem(SEEN_KEY));
  if (suppress || !open) return null;

  const dismiss = () => {
    localStorage.setItem(SEEN_KEY, "1");
    setOpen(false);
  };
  const go = (fn: () => void) => {
    dismiss();
    fn();
  };
  return (
    <div className="fixed right-4 bottom-4 z-[60] max-h-[calc(100vh-2rem)] w-[min(520px,calc(100vw-2rem))] overflow-auto rounded-xl border border-line bg-panel shadow-xl">
      <div className="overflow-hidden">
        <div className="border-b border-line bg-accent-soft/50 px-5 pt-5 pb-4">
          <div className="mb-3 flex items-center gap-3">
            <BrandMark size={36} />
            <div className="min-w-0">
              <div className="text-[17px] font-semibold">从任务运行线开始</div>
              <div className="text-[12px] text-ink-3">AI 同事认领任务、留痕、交付；你处理审批并最终关单。</div>
            </div>
            <button
              type="button"
              onClick={dismiss}
              className="ml-auto rounded-md px-2 py-1 text-[13px] text-ink-3 hover:bg-sel hover:text-ink"
              aria-label="关闭首次引导"
              title="关闭"
            >
              ✕
            </button>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {["目标", "认领", "交付", "关单"].map((label, i) => (
              <div key={label} className="rounded-lg border border-line bg-panel px-2 py-1.5">
                <div className="font-mono text-[10px] text-ink-3">0{i + 1}</div>
                <div className="text-[12px] font-medium">{label}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-3 px-5 py-4">
          <Step n="1" title="打开任务线" desc="查看待办、阻塞、待评审、交付物、审批和活动日志；可直接启动闭环验收。">
            <button onClick={() => go(onOpenTasks)} className="shrink-0 rounded-lg bg-accent px-3 py-1 text-[12px] font-medium text-white hover:opacity-90">
              进入
            </button>
          </Step>
          <Step n="2" title="接入模型" desc="可先用演示模式跑流程；接入 DeepSeek、SiliconFlow、百炼或 Anthropic 后再跑真实任务。">
            <button onClick={() => go(onSettings)} className="shrink-0 rounded-lg border border-accent/50 px-3 py-1 text-[12px] font-medium text-accent hover:bg-accent-soft">
              配置
            </button>
          </Step>
          <Step n="3" title="按场景组队" desc="调研、立项、内容、方案等频道会自动带上合适的 AI 同事和工作方法。">
            <button onClick={() => go(onNewChannel)} className="shrink-0 rounded-lg border border-accent/50 px-3 py-1 text-[12px] font-medium text-accent hover:bg-accent-soft">
              新建频道
            </button>
          </Step>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <span className="text-[11.5px] text-ink-3">高风险动作、澄清输入和项目关闭都保留人类确认。</span>
          <button onClick={() => go(onOpenTasks)} className="rounded-lg bg-accent px-4 py-1.5 text-[13px] font-medium text-white">
            看任务线
          </button>
        </div>
      </div>
    </div>
  );
}

function Step({ n, title, desc, children }: { n: string; title: string; desc: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent font-mono text-[12px] font-semibold text-white">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium">{title}</div>
        <div className="text-[12px] leading-relaxed text-ink-3">{desc}</div>
      </div>
      {children}
    </div>
  );
}

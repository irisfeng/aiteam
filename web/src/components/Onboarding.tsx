import { useState } from "react";
import { useWorkspace } from "../store";
import { AgentAvatar } from "./Avatar";

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

/** 首次引导：欢迎卡 + 三步上手；用毛球精灵当迎宾。看过一次后不再弹（localStorage） */
export function WelcomeOverlay({
  onSettings,
  onNewChannel,
}: {
  onSettings: () => void;
  onNewChannel: () => void;
}) {
  const ws = useWorkspace();
  const [open, setOpen] = useState(() => !localStorage.getItem(SEEN_KEY));
  if (!open) return null;

  const dismiss = () => {
    localStorage.setItem(SEEN_KEY, "1");
    setOpen(false);
  };
  const go = (fn: () => void) => {
    dismiss();
    fn();
  };

  const mascots = ws.agents.slice(0, 4);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-6" onMouseDown={dismiss}>
      <div
        className="modal-card w-[480px] overflow-hidden rounded-2xl border border-line bg-panel shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center gap-3 border-b border-line bg-accent-soft/50 px-6 pt-7 pb-5">
          <div className="flex -space-x-1.5">
            {(mascots.length ? mascots : [undefined, undefined, undefined]).map((a, i) => (
              <AgentAvatar key={a?.id ?? i} agent={a} size={44} state="thinking" />
            ))}
          </div>
          <div className="text-[18px] font-semibold">欢迎来到 AITeam</div>
          <div className="text-center text-[13px] leading-relaxed text-ink-3">
            一支随叫随到的 AI 同事团队——在频道里讨论、在看板上干活、在文档库交付。
            你可以全程把关，也可以让它们自主闭环。
          </div>
        </div>

        <div className="flex flex-col gap-3 px-6 py-5">
          <Step n="1" title="接入模型" desc="官方 Anthropic key，或 DeepSeek 等第三方 / 本地模型。不接也能跑演示。">
            <button onClick={() => go(onSettings)} className="shrink-0 rounded-lg border border-accent/50 px-3 py-1 text-[12px] font-medium text-accent hover:bg-accent-soft">
              去接入
            </button>
          </Step>
          <Step n="2" title="按场景组队" desc="调研 / 立项 / 内容 / 方案——一键拉起对应同事、自动启用配套工作方法。">
            <button onClick={() => go(onNewChannel)} className="shrink-0 rounded-lg border border-accent/50 px-3 py-1 text-[12px] font-medium text-accent hover:bg-accent-soft">
              新建频道
            </button>
          </Step>
          <Step n="3" title="派活或立项" desc="频道里 @某同事 说目标，或在看板新建任务——指派即自动开工、机器验收、人来关单。" />
        </div>

        <div className="flex items-center justify-between border-t border-line px-6 py-3">
          <span className="text-[11.5px] text-ink-3">随时可在设置里重新查看用法</span>
          <button onClick={dismiss} className="rounded-lg bg-accent px-4 py-1.5 text-[13px] font-medium text-white">
            开始使用
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

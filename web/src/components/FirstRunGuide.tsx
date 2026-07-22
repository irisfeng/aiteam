import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, KeyRound, ShieldCheck, Sparkles, Target } from "lucide-react";
import { BrandMark } from "./Brand";

export type FirstRunAudience = "admin" | "member";

const FIRST_RUN_KEY = "aiteam-first-run-pending";

export function queueFirstRun(audience: FirstRunAudience) {
  localStorage.setItem(FIRST_RUN_KEY, audience);
}

export function readQueuedFirstRun(): FirstRunAudience | null {
  const value = localStorage.getItem(FIRST_RUN_KEY);
  return value === "admin" || value === "member" ? value : null;
}

export function clearQueuedFirstRun() {
  localStorage.removeItem(FIRST_RUN_KEY);
}

const FLOW = [
  { icon: Target, label: "说清目标", desc: "描述期望交付、截止时间和约束" },
  { icon: Sparkles, label: "AI 推进", desc: "同事认领、执行并留下过程证据" },
  { icon: ShieldCheck, label: "复核关单", desc: "独立验收，最后由你确认完成" },
] as const;

export function FirstRunGuide({
  audience,
  userName,
  hasProvider,
  onConnectModel,
  onStart,
  onLater,
}: {
  audience: FirstRunAudience;
  userName: string;
  hasProvider: boolean;
  onConnectModel: () => void;
  onStart: () => void;
  onLater: () => void;
}) {
  const [step, setStep] = useState(0);
  const isAdmin = audience === "admin";
  const total = 3;

  return (
    <div className="flex h-full flex-1 items-center justify-center overflow-y-auto bg-paper px-4 py-10">
      <div className="w-full max-w-[760px]">
        <div className="text-center">
          <BrandMark size={44} className="mx-auto mb-4" />
          <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-ink sm:text-[34px]">
            欢迎来到 AiTeam，{userName || "新同事"}
          </h1>
          <p className="mt-2 text-[13px] text-ink-3">先用 3 步认识工作方式，再开始第一项任务。</p>
        </div>

        <section className="mx-auto mt-8 overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_20px_60px_rgba(0,0,0,0.10)]">
          <div className="border-b border-line px-6 py-5 sm:px-8">
            <div className="flex items-center justify-between gap-4">
              <span className="text-[12px] font-medium text-ink-3">第 {step + 1} / {total} 步</span>
              <div className="flex gap-1.5" aria-label={`第 ${step + 1} / ${total} 步`}>
                {Array.from({ length: total }, (_, index) => (
                  <span key={index} className={`h-1.5 rounded-full transition-all ${index === step ? "w-7 bg-accent" : index < step ? "w-3 bg-accent/45" : "w-3 bg-line"}`} />
                ))}
              </div>
            </div>
          </div>

          <div className="min-h-[330px] px-6 py-7 sm:px-8">
            {step === 0 && (
              <div>
                <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">不是聊天窗口，而是一条可复核的工作线</h2>
                <p className="mt-2 max-w-[620px] text-[13.5px] leading-6 text-ink-2">
                  你把目标交给 AI 同事，系统会记录认领、执行、交付和复核；AI 可以推进，但最终关单始终由你确认。
                </p>
                <div className="mt-6 grid gap-3 sm:grid-cols-3">
                  {FLOW.map(({ icon: Icon, label, desc }, index) => (
                    <div key={label} className="rounded-xl border border-line bg-paper p-4">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft text-accent">
                        <Icon size={17} strokeWidth={1.8} />
                      </div>
                      <div className="mt-3 text-[13.5px] font-semibold text-ink">{index + 1}. {label}</div>
                      <div className="mt-1 text-[11.5px] leading-5 text-ink-3">{desc}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {step === 1 && (
              <div>
                <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">
                  {isAdmin ? "接入第一个模型" : "模型由管理员统一维护"}
                </h2>
                <p className="mt-2 max-w-[620px] text-[13.5px] leading-6 text-ink-2">
                  {isAdmin
                    ? "只需选择供应商并粘贴 API Key；模型名、协议和高级参数已有推荐值，需要时再展开修改。"
                    : "你无需填写 Key 或理解模型参数。管理员接入后，团队会自动使用可用通道；未接入时也可以先体验完整流程。"}
                </p>
                <div className={`mt-6 rounded-xl border p-5 ${hasProvider ? "border-emerald-400/40 bg-emerald-50/70 dark:bg-emerald-950/20" : "border-line bg-paper"}`}>
                  <div className="flex items-start gap-3">
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${hasProvider ? "bg-emerald-500 text-white" : "bg-accent-soft text-accent"}`}>
                      {hasProvider ? <Check size={18} /> : <KeyRound size={18} strokeWidth={1.8} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] font-semibold text-ink">{hasProvider ? "模型已接入" : isAdmin ? "尚未接入模型" : "当前可先使用演示模式"}</div>
                      <div className="mt-1 text-[12px] leading-5 text-ink-3">
                        {hasProvider ? "真实模型通道已可用，后续可在设置中测试连通性和运行质量基准。" : "演示模式不会调用真实模型，也不会产生模型费用。"}
                      </div>
                    </div>
                    {isAdmin && !hasProvider && (
                      <button type="button" onClick={onConnectModel} className="shrink-0 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-medium text-white hover:opacity-90">
                        接入模型
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {step === 2 && (
              <div>
                <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">从一个真实目标开始</h2>
                <p className="mt-2 max-w-[620px] text-[13.5px] leading-6 text-ink-2">
                  在工作台写下目标、交付物和截止时间。方案、报告、PPT、数据表与设计页面都会进入文档区，并经过对应的结构与质量检查。
                </p>
                <div className="mt-6 rounded-xl border border-line bg-paper p-5">
                  <div className="text-[12px] font-medium text-ink-3">建议你的第一句话这样写</div>
                  <div className="mt-2 text-[14px] leading-6 text-ink">
                    “为下周评审准备一份产品落地方案和 10 页以内的 PPT，关键数字注明来源，周五前给我初稿。”
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-line px-6 py-4 sm:px-8">
            <button type="button" onClick={step === 0 ? onLater : () => setStep((value) => value - 1)} className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12.5px] text-ink-3 hover:bg-sel hover:text-ink">
              {step === 0 ? "稍后再看" : <><ArrowLeft size={14} /> 返回</>}
            </button>
            {step < total - 1 ? (
              <button type="button" onClick={() => setStep((value) => value + 1)} className="flex items-center gap-1 rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90">
                下一步 <ArrowRight size={14} />
              </button>
            ) : (
              <button type="button" onClick={onStart} className="flex items-center gap-1 rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90">
                开始第一个任务 <ArrowRight size={14} />
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

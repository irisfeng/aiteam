import { useEffect, useRef } from "react";
import type { Agent, AgentStatus } from "../types";

/** 成员专属色相（每位成员一个稳定色相，落在同一套低饱和莫兰迪体系里——色相数量不限）。
 *  用 FNV-1a 散列 + 黄金角映射，让相近 id 也分到差异明显的色相，避免多人撞同一种粉/桃。 */
export function memberHue(id: string): number {
  let s = 2166136261;
  for (let i = 0; i < id.length; i++) s = Math.imul(s ^ id.charCodeAt(i), 16777619);
  const frac = ((s >>> 0) % 100000) / 100000;
  return (frac * 137.508 * 6) % 360; // 黄金角散布，色相充分拉开
}

/** 名字/标注用的成员色（与小球同色相，低饱和优雅） */
export function memberColor(id: string, alpha = 1): string {
  return `oklch(0.6 0.09 ${memberHue(id)} / ${alpha})`;
}

/** 由 id 派生的确定性伪随机——决定每颗小球的浮动/眨眼节奏，稳定且错峰 */
function seeded(id: string): () => number {
  let s = 0;
  for (let i = 0; i < id.length; i++) s = (s * 31 + id.charCodeAt(i)) >>> 0;
  s = (s ^ 0x9e3779b9) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---- 眼睛跟随鼠标：单例监听，rAF 节流，所有已注册小球的眼睛一起轻轻转向光标 ----
const orbEls = new Set<HTMLElement>();
let bound = false;
let raf = 0;
let mx = -1;
let my = -1;
function applyLook() {
  raf = 0;
  if (mx < 0) return;
  orbEls.forEach((orb) => {
    const rect = orb.getBoundingClientRect();
    if (!rect.width) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = mx - cx;
    const dy = my - cy;
    const dist = Math.hypot(dx, dy) || 1;
    const ease = Math.min(1, dist / 190);
    const tx = (dx / dist) * rect.width * 0.032 * ease;
    const ty = (dy / dist) * rect.height * 0.026 * ease;
    const t = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px)`;
    orb.querySelectorAll<HTMLElement>("[data-eye]").forEach((eye) => (eye.style.transform = t));
  });
}
function onMove(e: PointerEvent | MouseEvent) {
  mx = e.clientX;
  my = e.clientY;
  if (!raf) raf = requestAnimationFrame(applyLook);
}
function registerOrb(el: HTMLElement): () => void {
  orbEls.add(el);
  if (!bound) {
    window.addEventListener("pointermove", onMove, { passive: true });
    bound = true;
  }
  return () => {
    orbEls.delete(el);
  };
}

const ACTIVE_STATES: AgentStatus["state"][] = ["thinking", "tool", "responding"];

/**
 * AI 队友头像：会呼吸、会眨眼、眼睛跟随鼠标的优雅光泽小球（Claude Design 交接稿）。
 * - 莫兰迪低饱和 oklch 配色，每个 agent 一个专属色相（按 id 派生，数量不限）；
 * - 玻璃高光 + 体积内阴影；浮动仅在大尺寸开启，列表里只呼吸/眨眼，避免抖动；
 * - 忙碌（thinking/tool/responding）时呼吸更快；尊重 prefers-reduced-motion。
 */
export function AgentAvatar({
  agent,
  size = 32,
  state,
  title,
}: {
  agent?: Agent;
  size?: number;
  state?: AgentStatus["state"];
  title?: string;
}) {
  const id = agent?.id ?? "agent";
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    return registerOrb(ref.current);
  }, []);

  const h = memberHue(id);
  const rng = seeded(id);
  const fdur = (5 + rng() * 1.6).toFixed(2); // 浮动/呼吸周期
  const bdur = (4.6 + rng() * 1.8).toFixed(2); // 眨眼周期
  const delay = `-${(rng() * 3).toFixed(2)}s`; // 错峰，避免整屏同步
  const active = state ? ACTIVE_STATES.includes(state) : false;
  const float = size >= 56; // 大图才浮动，列表里只呼吸眨眼

  const s = size / 120; // 设计稿基于 120px，阴影/模糊按比例缩放
  const px = (v: number) => `${(v * s).toFixed(2)}px`;
  const eyeHi = { position: "absolute" as const, top: "14%", left: "24%", width: "36%", height: "30%", borderRadius: "50%", background: `oklch(0.98 0.012 ${h})` };

  return (
    <div
      ref={ref}
      data-orb
      data-active={active ? "1" : undefined}
      className={`orb-wrap relative shrink-0 ${float ? "orb-float" : ""}`}
      style={{ width: size, height: size, "--fdur": `${fdur}s`, "--bdur": `${bdur}s`, "--d": delay } as React.CSSProperties}
      title={title ?? agent?.name}
    >
      {/* 球体：径向渐变 + 体积内阴影，会呼吸 */}
      <div
        className="orb-body absolute inset-0"
        style={{
          borderRadius: "50%",
          background: `radial-gradient(circle at 34% 28%, oklch(0.92 0.04 ${h}), oklch(0.81 0.075 ${h}) 54%, oklch(0.70 0.097 ${h}) 100%)`,
          boxShadow: `0 ${px(14)} ${px(30)} ${px(-12)} oklch(0.72 0.10 ${h} / 0.5), inset ${px(-7)} ${px(-9)} ${px(16)} ${px(-8)} oklch(0.63 0.10 ${h} / 0.6), inset ${px(6)} ${px(7)} ${px(14)} ${px(-6)} oklch(0.97 0.03 ${h} / 0.75)`,
          ["--fdur" as string]: `${fdur}s`,
          ["--d" as string]: delay,
        } as React.CSSProperties}
      />
      {/* 玻璃高光 */}
      <div
        className="pointer-events-none absolute"
        style={{
          top: "13%", left: "22%", width: "34%", height: "27%", borderRadius: "50%",
          background: `radial-gradient(ellipse at center, oklch(0.99 0.01 ${h} / 0.85), transparent 70%)`,
          filter: `blur(${Math.max(0.4, s).toFixed(2)}px)`,
        }}
      />
      {/* 双眼：外层跟随鼠标平移，内层眨眼 */}
      {[
        { side: "left" as const, v: "33%" },
        { side: "right" as const, v: "33%" },
      ].map((e) => (
        <div
          key={e.side}
          data-eye
          className="absolute"
          style={{ top: "43%", [e.side]: e.v, width: "12%", height: "19%", willChange: "transform", transition: "transform 0.16s ease-out" }}
        >
          <div
            className="orb-eye-lid relative h-full w-full"
            style={{ borderRadius: "50%", background: `oklch(0.33 0.045 ${h})`, transformOrigin: "center", ["--bdur" as string]: `${bdur}s`, ["--d" as string]: delay } as React.CSSProperties}
          >
            <div style={eyeHi} />
          </div>
        </div>
      ))}
      {/* 角标：露出该同事的职能 emoji，让人一眼分辨是谁（小尺寸下省略，避免拥挤） */}
      {agent?.emoji && size >= 26 && (
        <div
          className="pointer-events-none absolute flex items-center justify-center"
          style={{
            right: "-7%",
            bottom: "-7%",
            width: "48%",
            height: "48%",
            borderRadius: "50%",
            background: "var(--c-panel, #fff)",
            boxShadow: `0 ${px(2)} ${px(5)} ${px(-1)} oklch(0.5 0.05 ${h} / 0.45), 0 0 0 ${px(1.5)} oklch(0.99 0.005 ${h})`,
            fontSize: `${(size * 0.27).toFixed(1)}px`,
            lineHeight: 1,
          }}
        >
          <span>{agent.emoji}</span>
        </div>
      )}
    </div>
  );
}

export function UserAvatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-lg bg-accent font-medium text-white"
      style={{ width: size, height: size, fontSize: size * 0.45 }}
    >
      {name.slice(0, 1)}
    </div>
  );
}

export function AiBadge() {
  return (
    <span className="rounded border border-line bg-sel px-1 font-mono text-[10px] font-medium leading-4 text-ink-2">
      AI
    </span>
  );
}

import { useId } from "react";
import type { Agent } from "../types";
import type { AgentStatus } from "../types";

/** 成员专属色（Hive 设计：每位成员一个专属色相，同明度同彩度） */
export function memberHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export function memberColor(id: string, alpha = 1): string {
  return `hsl(${memberHue(id)} 52% 52% / ${alpha})`;
}

/** 由 id 派生的确定性伪随机序列——同一精灵的外形稳定，不同精灵各有性格 */
function seeded(id: string): () => number {
  let s = 0;
  for (let i = 0; i < id.length; i++) s = (s * 31 + id.charCodeAt(i)) >>> 0;
  s = (s ^ 0x9e3779b9) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 毛球轮廓：交替的外尖点/内谷点构成毛茸茸的星形剪影 */
function fuzzPath(rng: () => number, spikes: number, ro: number, ri: number): string {
  const cx = 50;
  const cy = 50;
  const pts: string[] = [];
  for (let i = 0; i < spikes; i++) {
    const a = (i / spikes) * Math.PI * 2 - Math.PI / 2;
    const rOuter = ro + (rng() - 0.5) * 5; // 尖端长度抖动
    pts.push(`${(cx + Math.cos(a) * rOuter).toFixed(1)},${(cy + Math.sin(a) * rOuter).toFixed(1)}`);
    const am = ((i + 0.5) / spikes) * Math.PI * 2 - Math.PI / 2;
    const rInner = ri + (rng() - 0.5) * 3;
    pts.push(`${(cx + Math.cos(am) * rInner).toFixed(1)},${(cy + Math.sin(am) * rInner).toFixed(1)}`);
  }
  return `M${pts.join("L")}Z`;
}

const ACTIVE_STATES: AgentStatus["state"][] = ["thinking", "tool", "responding"];

/**
 * 毛球精灵头像：SVG 绘制的毛茸茸身体 + 会眨眼的眼睛，按 id 确定性变化外形（毛发/眼神/嘴型）。
 * - 平时轻轻呼吸 + 偶尔眨眼；忙碌（state ∈ thinking/tool/responding）时更活跃地晃动。
 * - 颜色沿用 memberColor 的专属色相；尊重 prefers-reduced-motion（CSS 里关掉动画）。
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
  const uid = useId().replace(/:/g, "");
  const hue = memberHue(id);
  const rng = seeded(id);

  const spikes = 22 + Math.floor(rng() * 7); // 22–28 簇毛
  const path = fuzzPath(rng, spikes, 46, 33);
  const eyeType = Math.floor(rng() * 3); // 0 圆 / 1 困 / 2 萌大
  const mouthType = Math.floor(rng() * 3); // 0 微笑 / 1 点 / 2 小 o
  const lean = (rng() - 0.5) * 6; // 眼神/嘴的轻微偏移，增加个性

  const eyeY = 54;
  const eyeDX = 11;
  const eyeRX = eyeType === 2 ? 8 : 7;
  const eyeRY = eyeType === 1 ? 3.4 : eyeType === 2 ? 9 : 7.5;
  const pupil = eyeType === 2 ? 4 : 3.4;

  const active = state ? ACTIVE_STATES.includes(state) : false;
  const delay = `-${((hue / 360) * 4).toFixed(2)}s`; // 错峰，避免整屏同步呼吸

  const skin = `hsl(${hue} 55% 55%)`;
  const skinLight = `hsl(${hue} 62% 73%)`;
  const skinDeep = `hsl(${hue} 50% 47%)`;
  const cheek = `hsl(${(hue + 12) % 360} 70% 66%)`;
  const ink = `hsl(${hue} 45% 22%)`;

  return (
    <div
      className="fuzz-wrap relative shrink-0"
      style={{ width: size, height: size }}
      title={title ?? agent?.name}
      data-active={active ? "1" : undefined}
    >
      <svg viewBox="0 0 100 100" width={size} height={size} style={{ display: "block", overflow: "visible" }}>
        <defs>
          <radialGradient id={`fb-${uid}`} cx="38%" cy="30%" r="72%">
            <stop offset="0%" stopColor={skinLight} />
            <stop offset="62%" stopColor={skin} />
            <stop offset="100%" stopColor={skinDeep} />
          </radialGradient>
        </defs>
        <g
          className="fuzz-body"
          style={{ animationDelay: delay, transformBox: "fill-box", transformOrigin: "center" } as React.CSSProperties}
        >
          {/* 毛发剪影 */}
          <path d={path} fill={skinDeep} />
          {/* 身体 */}
          <circle cx="50" cy="50" r="33" fill={`url(#fb-${uid})`} />
          {/* 腮红 */}
          <ellipse cx={50 - eyeDX - 4} cy={eyeY + 8} rx="5" ry="3.2" fill={cheek} opacity="0.5" />
          <ellipse cx={50 + eyeDX + 4} cy={eyeY + 8} rx="5" ry="3.2" fill={cheek} opacity="0.5" />
          {/* 眼睛（独立分组以便眨眼动画） */}
          <g
            className="fuzz-eyes"
            style={{ animationDelay: delay, transformBox: "fill-box", transformOrigin: "center" } as React.CSSProperties}
          >
            <ellipse cx={50 - eyeDX} cy={eyeY} rx={eyeRX} ry={eyeRY} fill="#fffdf8" />
            <ellipse cx={50 + eyeDX} cy={eyeY} rx={eyeRX} ry={eyeRY} fill="#fffdf8" />
            <circle cx={50 - eyeDX + lean} cy={eyeY + (eyeType === 1 ? 0 : 1)} r={pupil} fill={ink} />
            <circle cx={50 + eyeDX + lean} cy={eyeY + (eyeType === 1 ? 0 : 1)} r={pupil} fill={ink} />
            <circle cx={50 - eyeDX + lean + 1.4} cy={eyeY - 1.4} r="1.2" fill="#fff" />
            <circle cx={50 + eyeDX + lean + 1.4} cy={eyeY - 1.4} r="1.2" fill="#fff" />
          </g>
          {/* 嘴 */}
          {mouthType === 0 && (
            <path d={`M${50 - 4 + lean} 67 Q${50 + lean} 71 ${50 + 4 + lean} 67`} stroke={ink} strokeWidth="1.6" fill="none" strokeLinecap="round" />
          )}
          {mouthType === 1 && <circle cx={50 + lean} cy="68" r="1.5" fill={ink} />}
          {mouthType === 2 && <ellipse cx={50 + lean} cy="68" rx="2.4" ry="3" fill={ink} opacity="0.85" />}
        </g>
      </svg>
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

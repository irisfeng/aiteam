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

/** 平滑圆胖身体：少量控制点 + Catmull-Rom 转贝塞尔，轮廓柔和起伏（不再是尖刺星形） */
function blobPath(rng: () => number, n: number, baseR: number, amp: number): string {
  const cx = 50;
  const cy = 50;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const r = baseR + (rng() - 0.5) * 2 * amp;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d + "Z";
}

/** 绒毛：一圈短而软、带轻微弧度（飘逸感）的发丝，合并成单条 path；配合圆头描边+模糊显得毛茸茸 */
function furHairs(rng: () => number, count: number, rIn: number, rOut: number, spread: number): string {
  const cx = 50;
  const cy = 50;
  let d = "";
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 - Math.PI / 2 + (rng() - 0.5) * 0.12;
    const len = rOut + (rng() - 0.5) * spread;
    const x1 = cx + Math.cos(a) * rIn;
    const y1 = cy + Math.sin(a) * rIn;
    const x2 = cx + Math.cos(a) * len;
    const y2 = cy + Math.sin(a) * len;
    const flick = (rng() - 0.5) * 5; // 沿切向的轻微弯曲，让发梢飘起来
    const tx = -Math.sin(a);
    const ty = Math.cos(a);
    const mx = (x1 + x2) / 2 + tx * flick;
    const my = (y1 + y2) / 2 + ty * flick;
    d += `M${x1.toFixed(1)},${y1.toFixed(1)}Q${mx.toFixed(1)},${my.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
  }
  return d;
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

  // 平滑圆胖身体 + 两层柔软绒毛（外层长而淡的光晕、内层短而密的绒面）
  const body = blobPath(rng, 11, 33, 2.6);
  const furBack = furHairs(rng, 60, 29, 44, 4); // 长绒：halo
  const furFront = furHairs(rng, 46, 30, 39, 3); // 短绒：密度
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
          <filter id={`soft-${uid}`} x="-25%" y="-25%" width="150%" height="150%">
            <feGaussianBlur stdDeviation="0.65" />
          </filter>
        </defs>
        <g
          className="fuzz-body"
          style={{ animationDelay: delay, transformBox: "fill-box", transformOrigin: "center" } as React.CSSProperties}
        >
          {/* 柔软绒毛：两层短弧发丝，圆头描边 + 轻模糊，毛茸茸而非尖刺 */}
          <g filter={`url(#soft-${uid})`} fill="none" strokeLinecap="round">
            <path d={furBack} stroke={`hsl(${hue} 56% 64%)`} strokeWidth="2.6" opacity="0.55" />
            <path d={furFront} stroke={skin} strokeWidth="2.3" opacity="0.7" />
          </g>
          {/* 身体（柔和起伏的圆胖剪影） */}
          <path d={body} fill={`url(#fb-${uid})`} />
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

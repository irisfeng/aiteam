import type { Agent } from "../types";

/** 成员专属色（Hive 设计：每位成员一个专属色相，同明度同彩度） */
export function memberHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export function memberColor(id: string, alpha = 1): string {
  return `hsl(${memberHue(id)} 52% 52% / ${alpha})`;
}

export function AgentAvatar({ agent, size = 32 }: { agent?: Agent; size?: number }) {
  const id = agent?.id ?? "agent";
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-lg"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.55,
        background: memberColor(id, 0.14),
        boxShadow: `inset 0 0 0 1px ${memberColor(id, 0.45)}`,
      }}
    >
      {agent?.emoji ?? "🤖"}
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

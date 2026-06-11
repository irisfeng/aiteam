import type { Agent } from "../types";

export function AgentAvatar({ agent, size = 32 }: { agent?: Agent; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-lg bg-accent-soft"
      style={{ width: size, height: size, fontSize: size * 0.55 }}
    >
      {agent?.emoji ?? "🤖"}
    </div>
  );
}

export function UserAvatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-lg bg-ink text-white font-medium"
      style={{ width: size, height: size, fontSize: size * 0.45 }}
    >
      {name.slice(0, 1)}
    </div>
  );
}

export function AiBadge() {
  return (
    <span className="rounded border border-line bg-panel px-1 text-[10px] font-medium leading-4 text-ink-2">
      AI
    </span>
  );
}

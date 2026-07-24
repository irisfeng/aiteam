import { Waypoints } from "lucide-react";

export function BrandMark({
  size = 28,
  className = "",
  title = "AiTeam",
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={`brand-mark relative inline-flex shrink-0 items-center justify-center overflow-hidden ${className}`}
      style={{ width: size, height: size }}
      title={title}
      aria-label={title}
      role="img"
    >
      <Waypoints className="brand-mark-network" strokeWidth={2.15} aria-hidden="true" />
      <span className="brand-mark-core" aria-hidden="true" />
    </span>
  );
}

export function BrandLockup({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <BrandMark size={compact ? 28 : 32} />
      <span className="min-w-0">
        <span className="block truncate text-[17px] font-semibold leading-tight">AiTeam</span>
        {!compact && <span className="block truncate text-[11px] leading-tight text-ink-3">AI colleague workspace</span>}
      </span>
    </span>
  );
}

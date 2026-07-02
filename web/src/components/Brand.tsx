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
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#111827] shadow-sm ring-1 ring-black/5 ${className}`}
      style={{ width: size, height: size }}
      title={title}
      aria-label={title}
      role="img"
    >
      <svg viewBox="0 0 64 64" className="h-[78%] w-[78%]" aria-hidden="true">
        <path d="M14 48 32 12l18 36h-8l-3.8-8.2H25.8L22 48h-8Zm15-14.8h6L32 26l-3 7.2Z" fill="#F8FAF7" />
        <path d="m40 22 5.2 5.4L55 16" fill="none" stroke="#22C55E" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M18 48h28" fill="none" stroke="#475569" strokeWidth="3" strokeLinecap="round" />
        <circle cx="18" cy="48" r="4.5" fill="#3B82F6" />
        <circle cx="46" cy="48" r="4.5" fill="#22C55E" />
      </svg>
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

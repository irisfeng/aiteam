import { useEffect, useState } from "react";

interface DailyRow {
  date: string;
  input: number;
  output: number;
}
interface RecentRow {
  ts: number;
  agent: string;
  model: string;
  snippet: string;
  input: number;
  output: number;
}

function fmtNum(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
function fmtTs(ts: number) {
  return new Date(ts).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function UsageView() {
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [recent, setRecent] = useState<RecentRow[]>([]);

  useEffect(() => {
    fetch("/api/usage")
      .then((r) => r.json())
      .then((d) => {
        setDaily(d.daily ?? []);
        setRecent(d.recent ?? []);
      })
      .catch(() => undefined);
  }, []);

  const max = Math.max(1, ...daily.map((d) => d.input + d.output));
  const total14 = daily.reduce((n, d) => n + d.input + d.output, 0);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3">
        <h1 className="text-[15px] font-semibold">用量</h1>
        <span className="text-[12px] text-ink-3">每天消耗多少、谁用的、走的哪个模型</span>
        <span className="ml-auto font-mono text-[12px] text-ink-2">
          近 14 天 <span className="font-semibold text-ink">{fmtNum(total14)}</span> tokens
        </span>
      </header>
      <div className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-3xl">
          {/* 每日消耗柱状图 */}
          <div className="rounded-xl border border-line bg-panel p-4 shadow-sm">
            <div className="mb-3 text-[13px] font-semibold">每日 token 消耗</div>
            <div className="flex h-32 items-end gap-1.5">
              {daily.map((d) => {
                const v = d.input + d.output;
                return (
                  <div key={d.date} className="group flex h-full flex-1 flex-col items-center justify-end gap-1">
                    <span className="font-mono text-[9px] text-ink-3 opacity-0 transition-opacity group-hover:opacity-100">
                      {fmtNum(v)}
                    </span>
                    <div
                      className="w-full rounded-t bg-accent transition-colors group-hover:bg-accent/80"
                      style={{ height: `${Math.max(v > 0 ? 3 : 0, (v / max) * 100)}%` }}
                      title={`${d.date}：输入 ${fmtNum(d.input)} / 输出 ${fmtNum(d.output)}`}
                    />
                    <span className="font-mono text-[9px] text-ink-3">{d.date.slice(5).replace("-", "/")}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 最近活动账本（模型归因） */}
          <div className="mt-4 rounded-xl border border-line bg-panel p-4 shadow-sm">
            <div className="mb-2 text-[13px] font-semibold">最近活动</div>
            <div className="mb-2 text-[11.5px] text-ink-3">每次消耗 token 的运行，最新在前 · 模型归因可核对分级路由是否生效</div>
            {recent.length === 0 ? (
              <div className="py-6 text-center text-[12.5px] text-ink-3">还没有用量记录</div>
            ) : (
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-ink-3">
                    <th className="py-1 pr-3 font-medium">时间</th>
                    <th className="py-1 pr-3 font-medium">执行者</th>
                    <th className="py-1 pr-3 font-medium">内容</th>
                    <th className="py-1 pr-3 font-medium">模型</th>
                    <th className="py-1 text-right font-medium">tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r, i) => (
                    <tr key={i} className="border-t border-line/60">
                      <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-[11px] text-ink-3">{fmtTs(r.ts)}</td>
                      <td className="whitespace-nowrap py-1.5 pr-3">{r.agent}</td>
                      <td className="max-w-0 truncate py-1.5 pr-3 text-ink-2" style={{ width: "40%" }} title={r.snippet}>
                        {r.snippet || "（工具运行）"}
                      </td>
                      <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-[11px] text-ink-2">{r.model}</td>
                      <td className="whitespace-nowrap py-1.5 text-right font-mono text-[11px]">
                        {fmtNum(r.input + r.output)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

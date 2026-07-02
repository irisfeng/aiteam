import { useEffect, useState } from "react";
import { useWorkspace } from "../store";
import { API_BASE } from "../api";
import { AgentAvatar } from "./Avatar";
import { BrandMark } from "./Brand";

function ThemeToggle() {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem("aiteam-theme");
    if (saved) return saved === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches; // 默认跟随系统
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("aiteam-theme", dark ? "dark" : "light");
  }, [dark]);
  return (
    <button
      onClick={() => setDark((d) => !d)}
      className="rounded px-1 text-ink-3 hover:bg-sel hover:text-ink"
      title={dark ? "切换到浅色模式" : "切换到深色模式"}
    >
      {dark ? "☀" : "☾"}
    </button>
  );
}

function SectionTitle({ children, onAdd }: { children: string; onAdd?: () => void }) {
  return (
    <div className="mt-5 mb-1 flex items-center justify-between px-3">
      <span className="text-xs font-medium text-ink-3">{children}</span>
      {onAdd && (
        <button
          onClick={onAdd}
          className="rounded px-1 text-ink-3 hover:bg-line hover:text-ink"
          title="新建"
        >
          +
        </button>
      )}
    </div>
  );
}

function Item({
  active,
  onClick,
  children,
  badge,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[13.5px] ${
        active ? "bg-accent-soft font-medium text-ink" : "text-ink-2 hover:bg-sel"
      }`}
    >
      <span className="flex-1 truncate">{children}</span>
      {badge ? (
        <span className="rounded-full bg-accent px-1.5 text-[11px] font-medium text-white">{badge}</span>
      ) : null}
    </button>
  );
}

function TodayUsage() {
  const [tokens, setTokens] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${API_BASE}/team`)
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return;
          const sum = (d.members ?? []).reduce(
            (n: number, m: any) => n + (m.tokens_today?.input ?? 0) + (m.tokens_today?.output ?? 0),
            0
          );
          setTokens(sum);
        })
        .catch(() => undefined);
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (tokens === null) return null;
  const label = tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
  return (
    <span className="font-mono text-[10.5px] text-ink-3" title="今日全团队 token 用量">
      {label} tok
    </span>
  );
}

export function Sidebar({
  onNewChannel,
  onNewAgent,
  onSettings,
  onConfigChannel,
  onOpenProfile,
}: {
  onNewChannel: () => void;
  onNewAgent: () => void;
  onSettings: () => void;
  onConfigChannel: (c: import("../types").Channel) => void;
  onOpenProfile: (a: import("../types").Agent) => void;
}) {
  const ws = useWorkspace();
  const pending = ws.approvals.filter((a) => a.status === "pending").length;
  const activeTasks = ws.tasks.filter((t) => t.status !== "done").length;
  const channels = ws.channels.filter((c) => c.kind === "channel");
  const dms = ws.channels.filter((c) => c.kind === "dm");

  return (
    <aside className="hidden h-full w-[250px] shrink-0 flex-col border-r border-line bg-panel md:flex">
      <div className="flex items-center gap-2 px-4 py-3.5">
        <BrandMark size={28} />
        <span className="font-semibold">AiTeam</span>
        {ws.mockMode && (
          <span className="ml-auto rounded-full bg-line px-2 py-0.5 text-[11px] text-ink-2" title="未配置 ANTHROPIC_API_KEY">
            Mock
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        <Item active={ws.view.kind === "workline"} onClick={() => ws.setView({ kind: "workline" })}>
          <span className="mr-1.5 font-mono text-[10.5px] text-ink-3">01</span>工作台
        </Item>
        <Item active={ws.view.kind === "inbox"} onClick={() => ws.setView({ kind: "inbox" })} badge={pending}>
          <span className="mr-1.5 font-mono text-[10.5px] text-ink-3">02</span>收件箱
        </Item>
        <Item active={ws.view.kind === "tasks"} onClick={() => ws.setView({ kind: "tasks" })} badge={activeTasks}>
          <span className="mr-1.5 font-mono text-[10.5px] text-ink-3">03</span>任务
        </Item>
        <Item active={ws.view.kind === "docs"} onClick={() => ws.setView({ kind: "docs" })}>
          <span className="mr-1.5 font-mono text-[10.5px] text-ink-3">04</span>文档
        </Item>
        <Item active={ws.view.kind === "team"} onClick={() => ws.setView({ kind: "team" })}>
          <span className="mr-1.5 font-mono text-[10.5px] text-ink-3">05</span>团队
        </Item>
        <Item active={ws.view.kind === "usage"} onClick={() => ws.setView({ kind: "usage" })}>
          <span className="mr-1.5 font-mono text-[10.5px] text-ink-3">06</span>用量
        </Item>

        <SectionTitle onAdd={onNewChannel}>频道</SectionTitle>
        {channels.map((c) => (
          <div
            key={c.id}
            className={`group flex w-full items-center gap-1 rounded-md px-3 py-1.5 text-[13.5px] ${
              ws.view.kind === "channel" && ws.view.id === c.id
                ? "bg-accent-soft font-medium text-ink"
                : "text-ink-2 hover:bg-sel"
            }`}
          >
            <button onClick={() => ws.openChannel(c.id)} className="min-w-0 flex-1 truncate text-left">
              <span className="text-ink-3"># </span>
              {c.name}
            </button>
            <button
              onClick={() => onConfigChannel(c)}
              className="rounded px-0.5 text-[11px] text-ink-3 opacity-0 hover:text-ink group-hover:opacity-100"
              title="频道设置：改名 / 增减 AI 成员 / 按场景重组"
            >
              ⚙
            </button>
            <button
              onClick={() => {
                if (window.confirm(`删除频道 #${c.name}？消息记录将一并删除（任务与文档保留）。`)) void ws.deleteChannel(c.id);
              }}
              className="rounded px-0.5 text-[11px] text-ink-3 opacity-0 hover:text-red-500 group-hover:opacity-100"
              title="删除频道"
            >
              ✕
            </button>
          </div>
        ))}

        <SectionTitle onAdd={onNewAgent}>AI 队友</SectionTitle>
        {ws.agents.map((a) => (
          <div key={a.id} className="group flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-[13.5px] text-ink-2 hover:bg-sel">
            <button onClick={() => void ws.openDm(a.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left" title={`${a.role} · 点击私信`}>
              <AgentAvatar agent={a} size={20} />
              <span className="flex-1 truncate">{a.name}</span>
            </button>
            <button
              onClick={() => onOpenProfile(a)}
              className="rounded px-1 font-mono text-[11px] text-ink-3 opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
              title="查看档案（身份/模型/记忆）"
            >
              ⓘ
            </button>
          </div>
        ))}

        {dms.length > 0 && <SectionTitle>私信</SectionTitle>}
        {dms.map((c) => {
          const agent = ws.agentById(c.dm_agent_id);
          return (
            <Item
              key={c.id}
              active={ws.view.kind === "channel" && ws.view.id === c.id}
              onClick={() => ws.openChannel(c.id)}
            >
              {agent?.emoji} {c.name}
            </Item>
          );
        })}
      </div>

      <div className="flex items-center gap-2 border-t border-line px-4 py-3 text-[13px] text-ink-2">
        <span className="h-2 w-2 rounded-full bg-green-500" />
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <span className="truncate">{ws.user.name}</span>
          {ws.user.role === "admin" && (
            <span className="shrink-0 rounded bg-accent-soft px-1 text-[10px] text-ink-3" title="管理员">admin</span>
          )}
        </span>
        <TodayUsage />
        <ThemeToggle />
        {ws.user.role === "admin" && (
          <button onClick={onSettings} className="rounded px-1 text-ink-3 hover:bg-sel hover:text-ink" title="模型供应商设置（仅管理员）">
            ⚙
          </button>
        )}
        <button
          onClick={() => void ws.logout()}
          className="rounded px-1 text-ink-3 hover:bg-sel hover:text-red-500"
          title="退出登录"
        >
          ⏻
        </button>
      </div>
    </aside>
  );
}

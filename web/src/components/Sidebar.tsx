import { useEffect, useState } from "react";
import { useWorkspace } from "../store";
import { AgentAvatar } from "./Avatar";

function ThemeToggle() {
  const [dark, setDark] = useState(() => localStorage.getItem("aiteam-theme") === "dark");
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

export function Sidebar({
  onNewChannel,
  onNewAgent,
  onSettings,
}: {
  onNewChannel: () => void;
  onNewAgent: () => void;
  onSettings: () => void;
}) {
  const ws = useWorkspace();
  const pending = ws.approvals.filter((a) => a.status === "pending").length;
  const activeTasks = ws.tasks.filter((t) => t.status !== "done").length;
  const channels = ws.channels.filter((c) => c.kind === "channel");
  const dms = ws.channels.filter((c) => c.kind === "dm");

  return (
    <aside className="flex h-full w-[250px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center gap-2 px-4 py-3.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-sm font-semibold text-white">
          A
        </div>
        <span className="font-semibold tracking-tight">AITeam</span>
        {ws.mockMode && (
          <span className="ml-auto rounded-full bg-line px-2 py-0.5 text-[11px] text-ink-2" title="未配置 ANTHROPIC_API_KEY">
            Mock
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        <Item active={ws.view.kind === "inbox"} onClick={() => ws.setView({ kind: "inbox" })} badge={pending}>
          📥 收件箱
        </Item>
        <Item active={ws.view.kind === "tasks"} onClick={() => ws.setView({ kind: "tasks" })} badge={activeTasks}>
          ✅ 任务
        </Item>
        <Item active={ws.view.kind === "docs"} onClick={() => ws.setView({ kind: "docs" })}>
          📄 文档
        </Item>
        <Item active={ws.view.kind === "team"} onClick={() => ws.setView({ kind: "team" })}>
          👥 团队
        </Item>

        <SectionTitle onAdd={onNewChannel}>频道</SectionTitle>
        {channels.map((c) => (
          <Item
            key={c.id}
            active={ws.view.kind === "channel" && ws.view.id === c.id}
            onClick={() => ws.openChannel(c.id)}
          >
            <span className="text-ink-3"># </span>
            {c.name}
          </Item>
        ))}

        <SectionTitle onAdd={onNewAgent}>AI 队友</SectionTitle>
        {ws.agents.map((a) => (
          <button
            key={a.id}
            onClick={() => void ws.openDm(a.id)}
            className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[13.5px] text-ink-2 hover:bg-sel"
            title={`${a.role} · 点击私信`}
          >
            <AgentAvatar agent={a} size={20} />
            <span className="flex-1 truncate">{a.name}</span>
          </button>
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
        <span className="flex-1">{ws.user.name}</span>
        <ThemeToggle />
        <button onClick={onSettings} className="rounded px-1 text-ink-3 hover:bg-sel hover:text-ink" title="模型供应商设置">
          ⚙
        </button>
      </div>
    </aside>
  );
}

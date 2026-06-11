import { useState } from "react";
import { useWorkspace } from "../store";
import type { Task } from "../types";
import { api } from "../api";
import { AgentAvatar } from "./Avatar";

const COLUMNS: { key: Task["status"]; label: string }[] = [
  { key: "todo", label: "待办" },
  { key: "doing", label: "进行中" },
  { key: "review", label: "待评审" },
  { key: "done", label: "完成" },
];

function TaskCard({ task }: { task: Task }) {
  const ws = useWorkspace();
  const assignee = ws.agentById(task.assignee_agent_id);
  const creator = task.created_by === "user" ? null : ws.agentById(task.created_by);
  const idx = COLUMNS.findIndex((c) => c.key === task.status);

  return (
    <div className="rounded-lg border border-line bg-white p-3 shadow-sm">
      <div className="text-[13.5px] font-medium leading-snug">{task.title}</div>
      {task.description && (
        <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-[12.5px] text-ink-2">{task.description}</div>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        {assignee ? (
          <span className="flex items-center gap-1 rounded-full bg-panel px-1.5 py-0.5 text-[11.5px] text-ink-2">
            <AgentAvatar agent={assignee} size={14} /> {assignee.name}
          </span>
        ) : (
          <span className="rounded-full bg-panel px-1.5 py-0.5 text-[11.5px] text-ink-3">未分配</span>
        )}
        {creator && (
          <span className="text-[11px] text-ink-3" title={`由 ${creator.name} 创建`}>
            {creator.emoji} 创建
          </span>
        )}
        <span className="ml-auto flex gap-0.5">
          {idx > 0 && (
            <button
              onClick={() => void ws.moveTask(task, COLUMNS[idx - 1].key)}
              className="rounded px-1 text-ink-3 hover:bg-panel hover:text-ink"
              title={`移到「${COLUMNS[idx - 1].label}」`}
            >
              ←
            </button>
          )}
          {idx < COLUMNS.length - 1 && (
            <button
              onClick={() => void ws.moveTask(task, COLUMNS[idx + 1].key)}
              className="rounded px-1 text-ink-3 hover:bg-panel hover:text-ink"
              title={`移到「${COLUMNS[idx + 1].label}」`}
            >
              →
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

export function TasksBoard() {
  const ws = useWorkspace();
  const [title, setTitle] = useState("");

  async function addTask() {
    const t = title.trim();
    if (!t) return;
    await api.createTask({ title: t });
    setTitle("");
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3">
        <h1 className="text-[15px] font-semibold">任务</h1>
        <span className="text-[12px] text-ink-3">人与 AI 共用同一块看板 — AI 同事会自己开票并推进</span>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void addTask()}
            placeholder="快速新建任务…"
            className="w-56 rounded-lg border border-line bg-white px-3 py-1.5 text-[13px] outline-none focus:border-accent/50"
          />
          <button
            onClick={() => void addTask()}
            disabled={!title.trim()}
            className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
          >
            新建
          </button>
        </div>
      </header>
      <div className="grid flex-1 grid-cols-4 gap-3 overflow-y-auto p-4">
        {COLUMNS.map((col) => {
          const tasks = ws.tasks.filter((t) => t.status === col.key);
          return (
            <div key={col.key} className="flex min-w-0 flex-col rounded-xl bg-panel p-2">
              <div className="flex items-center gap-1.5 px-2 py-1.5">
                <span className="text-[13px] font-semibold">{col.label}</span>
                <span className="text-[12px] text-ink-3">{tasks.length}</span>
              </div>
              <div className="flex flex-col gap-2 overflow-y-auto p-1">
                {tasks.map((t) => (
                  <TaskCard key={t.id} task={t} />
                ))}
                {tasks.length === 0 && <div className="px-2 py-4 text-center text-[12px] text-ink-3">空</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

import { useState } from "react";
import { useWorkspace } from "../store";
import type { Doc, Task } from "../types";
import { api } from "../api";
import { DocViewerModal } from "./DocsView";

const COLUMNS: { key: Task["status"]; label: string }[] = [
  { key: "todo", label: "待办" },
  { key: "doing", label: "进行中" },
  { key: "review", label: "待评审" },
  { key: "done", label: "完成" },
];

function TaskCard({ task, onOpenDoc }: { task: Task; onOpenDoc: (doc: Doc) => void }) {
  const ws = useWorkspace();
  const creator = task.created_by === "user" ? null : ws.agentById(task.created_by);
  const doc = ws.documents.find((d) => d.task_id === task.id);
  const idx = COLUMNS.findIndex((c) => c.key === task.status);
  const project = ws.projects.find((p) => p.id === task.project_id);
  let depCount = 0;
  try {
    depCount = (JSON.parse(task.depends_on) as string[]).length;
  } catch { /* 旧数据无该字段 */ }

  return (
    <div className="rounded-lg border border-line bg-white p-3 shadow-sm">
      {(project || depCount > 0 || task.revision_count > 0) && (
        <div className="mb-1 flex flex-wrap items-center gap-1">
          {project && (
            <span className="rounded bg-accent-soft px-1.5 py-px text-[10.5px] text-ink-2" title={project.goal}>
              🧩 {project.title}
            </span>
          )}
          {depCount > 0 && (
            <span className="rounded bg-panel px-1.5 py-px text-[10.5px] text-ink-3" title="依赖交付后自动开工">
              ⛓ 依赖 {depCount}
            </span>
          )}
          {task.revision_count > 0 && (
            <span className="rounded bg-panel px-1.5 py-px text-[10.5px] text-ink-3" title="验收未通过的返工次数">
              ↩ 返工 {task.revision_count}
            </span>
          )}
        </div>
      )}
      <div className="text-[13.5px] font-medium leading-snug">{task.title}</div>
      {task.acceptance_criteria && (
        <div className="mt-1 line-clamp-2 text-[11.5px] text-ink-3" title={task.acceptance_criteria}>
          验收：{task.acceptance_criteria}
        </div>
      )}
      {task.description && (
        <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-[12.5px] text-ink-2">{task.description}</div>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <select
          value={task.assignee_agent_id ?? ""}
          onChange={(e) => void api.updateTask(task.id, { assignee_agent_id: e.target.value || null })}
          className="max-w-[140px] rounded-full border border-line bg-panel px-1.5 py-0.5 text-[11.5px] text-ink-2 outline-none"
          title="指派给 AI 同事后会自动开工"
        >
          <option value="">未分配</option>
          {ws.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.emoji} {a.name}
            </option>
          ))}
        </select>
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
              title={`移到「${COLUMNS[idx + 1].label}」${COLUMNS[idx + 1].key === "done" ? "（关单是 human-only）" : ""}`}
            >
              →
            </button>
          )}
        </span>
      </div>
      {doc && (
        <button
          onClick={() => onOpenDoc(doc)}
          className="mt-2 flex w-full items-center gap-1.5 rounded-md bg-accent-soft px-2 py-1 text-left text-[12px] text-ink-2 hover:text-ink"
        >
          📄 <span className="truncate">交付物：{doc.title}</span>
        </button>
      )}
    </div>
  );
}

export function TasksBoard() {
  const ws = useWorkspace();
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [openDoc, setOpenDoc] = useState<Doc | null>(null);

  async function addTask() {
    const t = title.trim();
    if (!t) return;
    await api.createTask({ title: t, assignee_agent_id: assignee || null });
    setTitle("");
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3">
        <h1 className="text-[15px] font-semibold">任务</h1>
        <span className="text-[12px] text-ink-3">指派给 AI 同事即自动开工：调研 → 交付文档 → 转待评审</span>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void addTask()}
            placeholder="快速新建任务…"
            className="w-52 rounded-lg border border-line bg-white px-3 py-1.5 text-[13px] outline-none focus:border-accent/50"
          />
          <select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            className="rounded-lg border border-line bg-white px-2 py-1.5 text-[13px] text-ink-2 outline-none"
          >
            <option value="">不指派</option>
            {ws.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.emoji} {a.name}
              </option>
            ))}
          </select>
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
                  <TaskCard key={t.id} task={t} onOpenDoc={setOpenDoc} />
                ))}
                {tasks.length === 0 && <div className="px-2 py-4 text-center text-[12px] text-ink-3">空</div>}
              </div>
            </div>
          );
        })}
      </div>
      {openDoc && <DocViewerModal doc={openDoc} onClose={() => setOpenDoc(null)} />}
    </div>
  );
}

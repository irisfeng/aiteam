import {
  createProject,
  createTask,
  createTaskEvent,
  db,
  getAgent,
  getTask,
  listAgents,
  listChannels,
  listDocuments,
  listTaskEvents,
  listTasks,
  listVerdictsForTask,
  type Task,
} from "./db.js";
import { isMock, onTaskAssigned } from "./agents/engine.js";
import { classifyFinalMissionDelivery } from "./mission-quality.js";
import { ownerFromUserId, withOwner } from "./ownerScope.js";
import { seedForOwner } from "./seed.js";
import type { Mission, MissionStatus } from "./missions.js";

interface MissionExecution {
  mission_id: string;
  organization_id: string;
  owner_id: string;
  project_id: string;
  final_task_id: string;
  task_ids_json: string;
  created_at: number;
}

export interface MissionExecutionState {
  status: Exclude<MissionStatus, "queued">;
  payload: Record<string, unknown>;
}

export interface MissionArtifact {
  id: string;
  mission_id: string;
  task_id: string | null;
  kind: "report" | "slides" | "sheet" | "html";
  title: string;
  content: string;
  version: number;
  created_at: number;
  updated_at: number;
}

function executionFor(missionId: string): MissionExecution | undefined {
  return db
    .prepare(
      `SELECT mission_id, organization_id, owner_id, project_id,
              final_task_id, task_ids_json, created_at
       FROM mission_executions WHERE mission_id = ?`,
    )
    .get(missionId) as MissionExecution | undefined;
}

function pickAgent(
  agents: ReturnType<typeof listAgents>,
  patterns: RegExp[],
  fallbackIndex: number,
) {
  return (
    agents.find((agent) =>
      patterns.some((pattern) => pattern.test(`${agent.name} ${agent.role}`)),
    ) ??
    agents[fallbackIndex] ??
    agents[0]
  );
}

export function ensureMissionExecution(mission: Mission): MissionExecution {
  const existing = executionFor(mission.id);
  if (existing) return existing;

  const ownerId = ownerFromUserId(mission.requested_by);
  return withOwner(ownerId, () => {
    seedForOwner();
    const agents = listAgents();
    const channel =
      listChannels().find((candidate) => candidate.kind === "channel") ??
      listChannels()[0];
    if (!channel || agents.length === 0) {
      throw new Error("AITeam execution workspace is unavailable");
    }
    const lead = pickAgent(agents, [/产品|PM|经理|规划|product/i], 0);
    const researcher = pickAgent(
      agents,
      [/调研|分析|SEO|增长|research|analyst/i],
      3,
    );
    const analyst = pickAgent(
      agents,
      [/工程|开发|数据|分析|engineer|analyst/i],
      1,
    );
    const writer = pickAgent(
      agents,
      [/文案|内容|写作|SEO|writer|content/i],
      3,
    );
    const reviewer = pickAgent(
      agents,
      [/审核|评审|复核|review|QA|测试/i],
      2,
    );
    const specifications = [
      {
        key: "scope",
        title: `确定调研口径：${mission.title}`,
        description: `根据 Coworker Mission 明确目标、范围、比较维度与来源要求。\n\nMission brief：${mission.brief}`,
        acceptance:
          "必须明确目标、范围、比较维度、来源要求、最终报告结构和待确认边界。",
        assigneeId: lead.id,
        reviewerId: reviewer.id,
        dependencies: [] as string[],
      },
      {
        key: "research",
        title: `收集资料：${mission.title}`,
        description:
          "按已确认口径收集多来源资料，区分事实、推断与待核实内容，形成可追溯来源清单。",
        acceptance:
          "每个关键事实必须附来源；无法核实的信息必须显式标注，不得编造。",
        assigneeId: researcher.id,
        reviewerId: reviewer.id,
        dependencies: ["scope"],
      },
      {
        key: "matrix",
        title: `形成对比分析：${mission.title}`,
        description:
          "将来源清单整理为维度一致的对比分析，给出可追溯的初步判断、限制与风险。",
        acceptance:
          "比较维度一致，结论能追溯到前置来源，关键缺口与不确定性清楚。",
        assigneeId: analyst.id,
        reviewerId: reviewer.id,
        dependencies: ["research"],
      },
      {
        key: "report",
        title: `交付研究报告：${mission.title}`,
        description: `综合前置调研和对比分析，完成可供 Coworker 人工验收的正式研究报告。\n\n原始 brief：${mission.brief}`,
        acceptance:
          "报告必须包含结论摘要、证据与来源、对比分析、建议、风险边界和待人工确认事项。",
        assigneeId: writer.id,
        reviewerId: reviewer.id,
        dependencies: ["matrix"],
      },
    ];

    const initialized = db.transaction(() => {
      const project = createProject({
        channel_id: channel.id,
        lead_agent_id: lead.id,
        title: `Coworker 调研 Mission：${mission.title}`,
        goal: mission.brief,
        status: "running",
        autonomy: "auto",
      });
      const taskIdByKey = new Map<string, string>();
      const tasks = specifications.map((specification) => {
        const task = createTask({
          channel_id: channel.id,
          project_id: project.id,
          title: specification.title,
          description: specification.description,
          assignee_agent_id: specification.assigneeId,
          reviewer_agent_id: specification.reviewerId,
          created_by: `coworker-mission:${mission.id}`,
          depends_on: specification.dependencies
            .map((key) => taskIdByKey.get(key))
            .filter((id): id is string => Boolean(id)),
          acceptance_criteria: specification.acceptance,
        });
        taskIdByKey.set(specification.key, task.id);
        createTaskEvent({
          task_id: task.id,
          channel_id: task.channel_id,
          project_id: task.project_id,
          type: "created",
          summary: "Coworker Mission 创建执行任务",
          metadata: {
            mission_id: mission.id,
            organization_id: mission.organization_id,
            step: specification.key,
          },
        });
        createTaskEvent({
          task_id: task.id,
          channel_id: task.channel_id,
          project_id: task.project_id,
          agent_id: task.assignee_agent_id,
          type: "claim",
          summary: `Mission 任务由 ${getAgent(task.assignee_agent_id ?? "")?.name ?? "AI 同事"} 认领`,
          metadata: { mission_id: mission.id, step: specification.key },
        });
        return task;
      });
      const finalTask = tasks.at(-1);
      if (!finalTask) throw new Error("AITeam failed to create Mission tasks");
      const execution: MissionExecution = {
        mission_id: mission.id,
        organization_id: mission.organization_id,
        owner_id: ownerId,
        project_id: project.id,
        final_task_id: finalTask.id,
        task_ids_json: JSON.stringify(tasks.map((task) => task.id)),
        created_at: Date.now(),
      };
      db.prepare(
        `INSERT INTO mission_executions (
          mission_id, organization_id, owner_id, project_id,
          final_task_id, task_ids_json, created_at
        ) VALUES (
          @mission_id, @organization_id, @owner_id, @project_id,
          @final_task_id, @task_ids_json, @created_at
        )`,
      ).run(execution);
      return { execution, tasks };
    })();
    for (const task of initialized.tasks) onTaskAssigned(task);
    return initialized.execution;
  });
}

function executionTasks(execution: MissionExecution): Task[] {
  let taskIds: string[] = [];
  try {
    const parsed = JSON.parse(execution.task_ids_json) as unknown;
    if (Array.isArray(parsed)) taskIds = parsed.map(String);
  } catch {
    // Fall back to the project query below.
  }
  const byId = new Map(
    listTasks()
      .filter((task) => task.project_id === execution.project_id)
      .map((task) => [task.id, task]),
  );
  return taskIds
    .map((taskId) => byId.get(taskId))
    .filter((task): task is Task => Boolean(task));
}

export function inspectMissionExecution(mission: Mission): MissionExecutionState {
  const execution = ensureMissionExecution(mission);
  return withOwner(execution.owner_id, () => {
    const tasks = executionTasks(execution);
    for (const task of tasks) {
      const lastEvent = listTaskEvents(task.id).at(-1);
      if (task.status === "todo" && lastEvent?.type !== "failure") {
        // If the process exited after the transaction committed but before the
        // in-memory queue was scheduled, a read safely re-arms ready DAG work.
        onTaskAssigned(task);
      }
    }
    const finalTask = getTask(execution.final_task_id);
    const finalArtifacts = listDocuments().filter(
      (document) =>
        document.task_id === execution.final_task_id &&
        document.kind === "report",
    );
    const latestFinalVerdict = finalTask
      ? listVerdictsForTask(finalTask.id).at(-1) ?? null
      : null;
    const deliveryDecision = classifyFinalMissionDelivery({
      taskStatus: finalTask?.status ?? null,
      hasFinalArtifact: finalArtifacts.length > 0,
      latestVerdict: latestFinalVerdict?.result ?? null,
      mock: isMock(),
    });
    const payload = {
      project_id: execution.project_id,
      task_ids: tasks.map((task) => task.id),
      final_task_id: execution.final_task_id,
      artifact_ids: finalArtifacts.map((artifact) => artifact.id),
      final_artifact_id: finalArtifacts[0]?.id ?? null,
      quality_gate: deliveryDecision?.qualityGate ?? "pending",
      final_verdict_id: latestFinalVerdict?.id ?? null,
      final_verdict_reason:
        latestFinalVerdict?.result === "revise"
          ? latestFinalVerdict.reasons.slice(0, 2000)
          : null,
    };
    if (deliveryDecision?.status === "completed") {
      return { status: "completed", payload };
    }
    if (deliveryDecision?.status === "blocked") {
      return { status: "blocked", payload };
    }
    if (tasks.some((task) => task.status === "blocked")) {
      return { status: "blocked", payload };
    }
    if (
      finalTask?.status === "cancelled" ||
      (tasks.length > 0 && tasks.every((task) => task.status === "cancelled"))
    ) {
      return { status: "cancelled", payload };
    }
    const failedTask = tasks.find((task) => {
      const lastEvent = listTaskEvents(task.id).at(-1);
      return task.status === "todo" && lastEvent?.type === "failure";
    });
    if (failedTask) {
      return {
        status: "failed",
        payload: { ...payload, failed_task_id: failedTask.id },
      };
    }
    return { status: "running", payload };
  });
}

export function listMissionArtifacts(mission: Mission): MissionArtifact[] {
  const execution = ensureMissionExecution(mission);
  return withOwner(execution.owner_id, () => {
    const taskIds = new Set(executionTasks(execution).map((task) => task.id));
    return listDocuments()
      .filter(
        (document) =>
          Boolean(document.task_id && taskIds.has(document.task_id)) &&
          ["report", "slides", "sheet", "html"].includes(document.kind),
      )
      .sort((left, right) => left.created_at - right.created_at)
      .map((document) => ({
        id: document.id,
        mission_id: mission.id,
        task_id: document.task_id,
        kind: document.kind as MissionArtifact["kind"],
        title: document.title,
        content: document.content,
        version: document.version,
        created_at: document.created_at,
        updated_at: document.updated_at,
      }));
  });
}

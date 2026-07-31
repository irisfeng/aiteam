import {
  createProject,
  createTask,
  createTaskEvent,
  db,
  getAgent,
  getApproval,
  getTask,
  invalidateApprovalsForTask,
  listAgents,
  listChannels,
  listDocuments,
  listApprovals,
  listTaskEvents,
  listTasks,
  listVerdictsForTask,
  readUsage,
  updateProject,
  updateTask,
  type Task,
  type Approval,
} from "./db.js";
import { isMock, onTaskAssigned, stopTask } from "./agents/engine.js";
import { broadcast } from "./bus.js";
import { classifyFinalMissionDelivery } from "./mission-quality.js";
import {
  missionCancellationActivityMetadata,
  missionActivityMetadata,
  type MissionStageKey,
} from "./mission-activity.js";
import { summarizeMissionObservability } from "./mission-observability.js";
import { ownerFromOrganizationUser, withOwner } from "./ownerScope.js";
import { seedForOwner } from "./seed.js";
import type { Mission, MissionStatus } from "./missions.js";
import { resolveApprovalWithSideEffects } from "./approval-resolution.js";

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

export interface MissionNetworkApproval {
  id: string;
  mission_id: string;
  kind: "network";
  title: string;
  server_name: string;
  tool_name: string;
  destination: string;
  input_summary: string;
  call_fingerprint: string;
  status: "pending" | "approved" | "rejected";
  created_at: number;
  resolved_at: number | null;
}

export type ResolveMissionNetworkApprovalResult =
  | { outcome: "not_found" }
  | { outcome: "conflict"; approval: MissionNetworkApproval }
  | {
      outcome: "resolved" | "replayed";
      approval: MissionNetworkApproval;
    };

export interface CancelMissionExecutionInput {
  cancelledBy: string;
  reason: string;
}

export class MissionExecutionDomainError extends Error {
  override name = "MissionExecutionDomainError";
}

export class MissionExecutionInfrastructureError extends Error {
  override name = "MissionExecutionInfrastructureError";
}

function executionFor(
  missionId: string,
  organizationId: string,
): MissionExecution | undefined {
  return db
    .prepare(
      `SELECT mission_id, organization_id, owner_id, project_id,
              final_task_id, task_ids_json, created_at
       FROM mission_executions
       WHERE mission_id = ? AND organization_id = ?`,
    )
    .get(missionId, organizationId) as MissionExecution | undefined;
}

function publicNetworkApproval(
  mission: Mission,
  approval: Approval,
): MissionNetworkApproval | null {
  if (approval.kind !== "network") return null;
  try {
    const payload = JSON.parse(approval.payload || "{}") as {
      network_grant?: {
        v?: unknown;
        server_name?: unknown;
        server_target?: unknown;
        tool?: unknown;
        input?: unknown;
        call_fingerprint?: unknown;
      };
    };
    const grant = payload.network_grant;
    if (
      grant?.v !== 1 ||
      typeof grant.server_name !== "string" ||
      typeof grant.server_target !== "string" ||
      typeof grant.tool !== "string" ||
      typeof grant.call_fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(grant.call_fingerprint)
    ) {
      return null;
    }
    const toolName =
      grant.tool.match(/^mcp__.+?__(.+)$/)?.[1]?.slice(0, 120) ??
      "external_tool";
    return {
      id: approval.id,
      mission_id: mission.id,
      kind: "network",
      title: approval.title.slice(0, 200),
      server_name: grant.server_name.slice(0, 120),
      tool_name: toolName,
      destination: publicNetworkDestination(grant.server_target),
      input_summary: truncateUtf8(
        JSON.stringify(redactNetworkInput(grant.input)),
        1200,
      ),
      call_fingerprint: grant.call_fingerprint,
      status: approval.status,
      created_at: approval.created_at,
      resolved_at: approval.resolved_at,
    };
  } catch {
    return null;
  }
}

function publicNetworkDestination(value: string): string {
  if (value.startsWith("stdio:")) {
    return value.slice(0, 240);
  }
  try {
    const target = new URL(value);
    target.username = "";
    target.password = "";
    target.search = "";
    target.hash = "";
    return target.toString().slice(0, 240);
  } catch {
    return "unavailable";
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const suffix = "…";
  const contentBudget = maxBytes - Buffer.byteLength(suffix);
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > contentBudget) break;
    bytes += characterBytes;
    end += character.length;
  }
  return `${value.slice(0, end)}${suffix}`;
}

function redactNetworkInput(
  value: unknown,
  depth = 0,
): unknown {
  if (depth > 3) return "[nested value]";
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const redacted = redactSensitiveString(value);
    return redacted.length > 240 ? `${redacted.slice(0, 240)}…` : redacted;
  }
  if (Array.isArray(value)) {
    const visible = value
      .slice(0, 8)
      .map((child) => redactNetworkInput(child, depth + 1));
    if (value.length > visible.length) visible.push(`[${value.length - visible.length} more]`);
    return visible;
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 16);
    for (const [key, child] of entries) {
      result[key.slice(0, 80)] =
        /authorization|cookie|credential|password|secret|token|api[_-]?key/i.test(
          key,
        )
          ? "[redacted]"
          : redactNetworkInput(child, depth + 1);
    }
    return result;
  }
  return "[unsupported value]";
}

function redactSensitiveString(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|pk|rk|ghp|github_pat)[-_][A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[redacted]@")
    .replace(
      /([?&](?:access[_-]?token|api[_-]?key|key|password|secret|token)=)[^&#\s]*/gi,
      "$1[redacted]",
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|password|secret|token)\s*[:=]\s*[^\s,;&]+/gi,
      "$1=[redacted]",
    );
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
  const existing = executionFor(mission.id, mission.organization_id);
  if (existing) return existing;

  const ownerId = ownerFromOrganizationUser(
    mission.organization_id,
    mission.requested_by,
  );
  return withOwner(ownerId, () => {
    seedForOwner();
    const agents = listAgents();
    const channel =
      listChannels().find((candidate) => candidate.kind === "channel") ??
      listChannels()[0];
    if (!channel || agents.length === 0) {
      throw new MissionExecutionInfrastructureError(
        "AITeam execution workspace is unavailable",
      );
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
      const concurrentExisting = executionFor(
        mission.id,
        mission.organization_id,
      );
      if (concurrentExisting) {
        return { execution: concurrentExisting, tasks: [] as Task[] };
      }
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
      if (!finalTask) {
        throw new MissionExecutionDomainError(
          "AITeam failed to create Mission tasks",
        );
      }
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
    }).immediate();
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
  if (taskIds.length === 0) return [...byId.values()];
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
    const workflowStageKeys = [
      "scope",
      "research",
      "analysis",
      "report",
    ] as const satisfies readonly MissionStageKey[];
    const activeTaskIndex = tasks.findIndex(
      (task) => !["done", "cancelled"].includes(task.status),
    );
    const activeTask =
      activeTaskIndex >= 0 ? tasks[activeTaskIndex] : finalTask ?? tasks.at(-1);
    let activityStage: MissionStageKey =
      workflowStageKeys[
        Math.min(
          Math.max(activeTaskIndex, 0),
          workflowStageKeys.length - 1,
        )
      ] ?? "report";
    let activityAgentId = activeTask?.assignee_agent_id ?? null;
    if (
      deliveryDecision?.status === "blocked" ||
      finalTask?.status === "review" ||
      latestFinalVerdict
    ) {
      activityStage = "quality_review";
      activityAgentId = finalTask?.reviewer_agent_id ?? null;
    }
    if (deliveryDecision?.status === "completed") {
      activityStage = "delivery";
      activityAgentId = finalTask?.reviewer_agent_id ?? null;
    }
    if (
      tasks.length > 0 &&
      tasks.every((task) => task.status === "cancelled")
    ) {
      activityStage = "cancelled";
      activityAgentId = null;
    }
    const missionTaskIds = new Set(tasks.map((task) => task.id));
    const observability = summarizeMissionObservability({
      missionCreatedAt: mission.created_at,
      observedAt: Date.now(),
      usageSamples: tasks.map((task) => {
        const usage = readUsage(task.usage_json);
        return {
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead,
          cacheCreationTokens: usage.cacheCreation,
          billableTokens: usage.billable,
        };
      }),
      approvalStatuses: listApprovals()
        .filter(
          (approval) =>
            approval.kind === "network" &&
            Boolean(approval.ref_id && missionTaskIds.has(approval.ref_id)),
        )
        .map((approval) => approval.status),
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
      observability,
      activity: missionActivityMetadata(
        activityStage,
        activityAgentId ? getAgent(activityAgentId)?.name : null,
      ),
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
        payload: {
          ...payload,
          error_code: "MISSION_TASK_FAILED",
          failed_task_id: failedTask.id,
        },
      };
    }
    return { status: "running", payload };
  });
}

export function cancelMissionExecution(
  mission: Mission,
  input: CancelMissionExecutionInput,
): Record<string, unknown> {
  const execution = ensureMissionExecution(mission);
  return withOwner(execution.owner_id, () => {
    const tasks = executionTasks(execution);
    const cancelledTasks: Task[] = [];
    const reason = input.reason.trim().slice(0, 500);
    const cancelledBy = input.cancelledBy.trim().slice(0, 160);

    const project = db.transaction(() => {
      for (const task of tasks) {
        if (task.status === "done" || task.status === "cancelled") continue;
        if (task.status === "doing") stopTask(task.id);
        invalidateApprovalsForTask(task.id);
        const cancelled =
          updateTask(task.id, {
            status: "cancelled",
            blocked_approval_id: null,
          }) ?? task;
        createTaskEvent({
          task_id: cancelled.id,
          channel_id: cancelled.channel_id,
          project_id: cancelled.project_id,
          agent_id: null,
          type: "cancelled",
          summary: "Coworker 请求取消 Mission 执行",
          metadata: {
            mission_id: mission.id,
            cancelled_by: cancelledBy,
            reason,
          },
        });
        cancelledTasks.push(cancelled);
      }
      return updateProject(execution.project_id, { status: "done" });
    }).immediate();

    for (const task of cancelledTasks) {
      broadcast({ type: "task:upsert", payload: task });
    }
    if (project) broadcast({ type: "project:upsert", payload: project });

    return {
      project_id: execution.project_id,
      task_ids: tasks.map((task) => task.id),
      cancelled_task_ids: cancelledTasks.map((task) => task.id),
      cancelled_by: cancelledBy,
      reason,
      activity: missionCancellationActivityMetadata(),
    };
  });
}

export function timeoutMissionExecution(
  mission: Mission,
): Record<string, unknown> {
  const execution = ensureMissionExecution(mission);
  return withOwner(execution.owner_id, () => {
    const tasks = executionTasks(execution);
    const timedOutTasks: Task[] = [];

    const project = db.transaction(() => {
      for (const task of tasks) {
        if (task.status === "done" || task.status === "cancelled") continue;
        if (task.status === "doing") stopTask(task.id);
        invalidateApprovalsForTask(task.id);
        const timedOut =
          updateTask(task.id, {
            status: "cancelled",
            blocked_approval_id: null,
          }) ?? task;
        createTaskEvent({
          task_id: timedOut.id,
          channel_id: timedOut.channel_id,
          project_id: timedOut.project_id,
          agent_id: null,
          type: "failure",
          summary: "Mission 超过执行期限，运行时已停止剩余任务",
          metadata: {
            mission_id: mission.id,
            error_code: "MISSION_TIMEOUT",
            deadline_at: mission.deadline_at,
          },
        });
        timedOutTasks.push(timedOut);
      }
      return updateProject(execution.project_id, { status: "done" });
    }).immediate();

    for (const task of timedOutTasks) {
      broadcast({ type: "task:upsert", payload: task });
    }
    if (project) broadcast({ type: "project:upsert", payload: project });

    return {
      project_id: execution.project_id,
      task_ids: tasks.map((task) => task.id),
      timed_out_task_ids: timedOutTasks.map((task) => task.id),
      deadline_at: mission.deadline_at,
      error_code: "MISSION_TIMEOUT",
      error: "AITeam execution exceeded its configured deadline.",
      activity: missionActivityMetadata("timeout"),
    };
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

/**
 * Mission clients receive only the decision metadata needed for informed
 * consent. Exact tool input, target URL, credentials, fingerprints, task IDs,
 * and agent IDs remain inside AITeam.
 */
export function listMissionNetworkApprovals(
  mission: Mission,
): MissionNetworkApproval[] {
  const execution = ensureMissionExecution(mission);
  return withOwner(execution.owner_id, () => {
    const taskIds = new Set(executionTasks(execution).map((task) => task.id));
    return listApprovals()
      .filter(
        (approval) =>
          Boolean(approval.ref_id && taskIds.has(approval.ref_id)) &&
          approval.kind === "network",
      )
      .map((approval) => publicNetworkApproval(mission, approval))
      .filter(
        (approval): approval is MissionNetworkApproval => approval !== null,
      )
      .sort((left, right) => right.created_at - left.created_at)
      .slice(0, 50);
  });
}

export function resolveMissionNetworkApproval(
  mission: Mission,
  approvalId: string,
  input: {
    approve: boolean;
    resolvedBy: string;
    callFingerprint: string;
  },
): ResolveMissionNetworkApprovalResult {
  const execution = ensureMissionExecution(mission);
  return withOwner(execution.owner_id, () => {
    const taskIds = new Set(executionTasks(execution).map((task) => task.id));
    const before = getApproval(approvalId);
    const publicBefore = before
      ? publicNetworkApproval(mission, before)
      : null;
    if (
      !before?.ref_id ||
      !taskIds.has(before.ref_id) ||
      !publicBefore ||
      publicBefore.call_fingerprint !== input.callFingerprint
    ) {
      return { outcome: "not_found" };
    }
    const result = resolveApprovalWithSideEffects({
      id: approvalId,
      approve: input.approve,
      resolvedBy: input.resolvedBy,
    });
    if (result.outcome === "not_found") return { outcome: "not_found" };
    const approval = publicNetworkApproval(mission, result.approval);
    if (!approval) return { outcome: "not_found" };
    if (result.outcome === "conflict") {
      return { outcome: "conflict", approval };
    }
    return { outcome: result.outcome, approval };
  });
}

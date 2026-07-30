import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { db } from "./db.js";
import {
  ensureMissionExecution,
  inspectMissionExecution,
  MissionExecutionDomainError,
} from "./mission-execution.js";

export type MissionStatus =
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface Mission {
  id: string;
  organization_id: string;
  kind: "research_report";
  title: string;
  brief: string;
  requested_by: string;
  status: MissionStatus;
  created_at: number;
  updated_at: number;
}

export interface CreateMissionInput {
  organization_id: string;
  kind: "research_report";
  title: string;
  brief: string;
  requested_by: string;
}

export interface MissionEvent {
  mission_id: string;
  organization_id: string;
  sequence: number;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  created_at: number;
}

export type CreateMissionResult =
  | { outcome: "created"; mission: Mission }
  | { outcome: "replayed"; mission: Mission }
  | { outcome: "conflict"; mission: Mission };

function requestHash(input: CreateMissionInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function retryableMissionError(
  mission: Mission,
  stage: "setup" | "inspection",
  error: unknown,
): Mission {
  const message =
    error instanceof Error ? error.message.slice(0, 500) : "unknown error";
  console.warn(
    `[aiteam] Mission ${mission.id} ${stage} failed transiently; reconciliation will retry: ${message}`,
  );
  return mission;
}

export function createMission(
  input: CreateMissionInput,
  idempotencyKey: string,
): CreateMissionResult {
  const hash = requestHash(input);
  const existing = db.prepare(
    `SELECT id, organization_id, kind, title, brief, requested_by, status, created_at, updated_at, request_hash
     FROM missions WHERE organization_id = ? AND idempotency_key = ?`,
  ).get(input.organization_id, idempotencyKey) as
    | (Mission & { request_hash: string })
    | undefined;
  if (existing) {
    const { request_hash: existingHash, ...mission } = existing;
    return existingHash === hash
      ? { outcome: "replayed", mission: reconcileMission(mission) }
      : { outcome: "conflict", mission };
  }

  const createdAt = Date.now();
  const mission: Mission = {
    id: nanoid(16),
    organization_id: input.organization_id,
    kind: input.kind,
    title: input.title,
    brief: input.brief,
    requested_by: input.requested_by,
    status: "queued",
    created_at: createdAt,
    updated_at: createdAt,
  };

  db.transaction(() => {
    db.prepare(
      `INSERT INTO missions (
        id, organization_id, kind, title, brief, requested_by,
        idempotency_key, request_hash, status, created_at, updated_at
      ) VALUES (
        @id, @organization_id, @kind, @title, @brief, @requested_by,
        @idempotency_key, @request_hash, @status, @created_at, @updated_at
      )`,
    ).run({
      ...mission,
      idempotency_key: idempotencyKey,
      request_hash: hash,
    });
    db.prepare(
      `INSERT INTO mission_events (
        mission_id, organization_id, sequence, type, status, payload_json, created_at
      ) VALUES (?, ?, 1, 'mission.created', 'queued', ?, ?)`,
    ).run(
      mission.id,
      mission.organization_id,
      JSON.stringify({ kind: mission.kind, requested_by: mission.requested_by }),
      createdAt,
    );
  })();

  try {
    ensureMissionExecution(mission);
    return { outcome: "created", mission: reconcileMission(mission) };
  } catch (error) {
    if (!(error instanceof MissionExecutionDomainError)) {
      return {
        outcome: "created",
        mission: retryableMissionError(mission, "setup", error),
      };
    }
    return {
      outcome: "created",
      mission: transitionMission(mission, "failed", {
        error:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Mission execution setup failed",
      }),
    };
  }
}

function transitionMission(
  mission: Mission,
  status: MissionStatus,
  payload: Record<string, unknown>,
): Mission {
  if (mission.status === status) return mission;
  const eventType: Record<Exclude<MissionStatus, "queued">, string> = {
    running: "mission.started",
    blocked: "mission.blocked",
    completed: "mission.completed",
    failed: "mission.failed",
    cancelled: "mission.cancelled",
  };
  if (status === "queued") return mission;
  const updatedAt = Date.now();
  db.transaction(() => {
    const sequenceRow = db
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM mission_events WHERE mission_id = ?",
      )
      .get(mission.id) as { sequence: number };
    db.prepare(
      "UPDATE missions SET status = ?, updated_at = ? WHERE id = ? AND organization_id = ?",
    ).run(status, updatedAt, mission.id, mission.organization_id);
    db.prepare(
      `INSERT INTO mission_events (
        mission_id, organization_id, sequence, type, status, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      mission.id,
      mission.organization_id,
      sequenceRow.sequence + 1,
      eventType[status],
      status,
      JSON.stringify(payload),
      updatedAt,
    );
  })();
  return { ...mission, status, updated_at: updatedAt };
}

function reconcileMission(mission: Mission): Mission {
  if (
    mission.status === "completed" ||
    mission.status === "cancelled" ||
    mission.status === "failed"
  ) {
    return mission;
  }
  try {
    const execution = inspectMissionExecution(mission);
    return transitionMission(mission, execution.status, execution.payload);
  } catch (error) {
    if (!(error instanceof MissionExecutionDomainError)) {
      return retryableMissionError(mission, "inspection", error);
    }
    return transitionMission(mission, "failed", {
      error:
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Mission execution inspection failed",
    });
  }
}

export function getMission(
  organizationId: string,
  missionId: string,
): Mission | undefined {
  const mission = db.prepare(
    `SELECT id, organization_id, kind, title, brief, requested_by, status, created_at, updated_at
     FROM missions WHERE id = ? AND organization_id = ?`,
  ).get(missionId, organizationId) as Mission | undefined;
  return mission ? reconcileMission(mission) : undefined;
}

export function listMissionEvents(
  organizationId: string,
  missionId: string,
  afterSequence: number,
  limit: number,
): MissionEvent[] {
  const rows = db.prepare(
    `SELECT mission_id, organization_id, sequence, type, status, payload_json, created_at
     FROM mission_events
     WHERE organization_id = ? AND mission_id = ? AND sequence > ?
     ORDER BY sequence ASC
     LIMIT ?`,
  ).all(organizationId, missionId, afterSequence, limit) as Array<
    Omit<MissionEvent, "payload"> & { payload_json: string }
  >;
  return rows.map(({ payload_json: payloadJson, ...event }) => {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(payloadJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // Preserve replay availability if an old payload is malformed.
    }
    return { ...event, payload };
  });
}

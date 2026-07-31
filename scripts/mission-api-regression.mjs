#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = mkdtempSync(join(tmpdir(), "aiteam-mission-api-"));
const instanceId = `mission-api-${process.pid}-${Date.now()}`;
const secret = "mission-api-regression-secret-with-at-least-32-bytes";

const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const selected = typeof address === "object" && address ? address.port : 0;
    probe.close((error) => (error ? reject(error) : resolve(selected)));
  });
});

const base = `http://127.0.0.1:${port}/aiteam/api/v1`;
const child = spawn(process.execPath, [join(root, "server/dist/index.js")], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    AITEAM_DATA_DIR: dataDir,
    AITEAM_TEST_INSTANCE_ID: instanceId,
    AITEAM_SERVICE_JWT_SECRET: secret,
    AITEAM_SERVICE_JWT_KEYS: "",
    AITEAM_MISSION_EXPIRY_SWEEP_MS: "1000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += String(chunk);
});

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/aiteam/api/__test/instance`,
      );
      if (response.ok && (await response.json()).instance_id === instanceId) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`AITeam server did not start: ${stderr.slice(-1200)}`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
  console.log(`✅ ${label}`);
}

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function serviceToken(organizationId, scopes = ["mission:create", "mission:read"]) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: "HS256", typ: "JWT" });
  const payload = base64url({
    iss: "coworker",
    aud: "aiteam",
    sub: "service:coworker",
    organization_id: organizationId,
    scope: scopes,
    iat: now,
    exp: now + 300,
  });
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJson(value)))
    .digest("hex");
}

function missionExecutionOwner(missionId) {
  const database = new Database(join(dataDir, "aiteam.db"), {
    readonly: true,
  });
  try {
    return database
      .prepare("SELECT owner_id FROM mission_executions WHERE mission_id = ?")
      .get(missionId)?.owner_id;
  } finally {
    database.close();
  }
}

function expireMissionInDatabase(missionId) {
  const database = new Database(join(dataDir, "aiteam.db"));
  try {
    database
      .prepare("UPDATE missions SET deadline_at = ? WHERE id = ?")
      .run(Date.now() - 1, missionId);
  } finally {
    database.close();
  }
}

function missionStatusInDatabase(missionId) {
  const database = new Database(join(dataDir, "aiteam.db"), {
    readonly: true,
  });
  try {
    return database.prepare("SELECT status FROM missions WHERE id = ?").get(missionId)
      ?.status;
  } finally {
    database.close();
  }
}

async function waitForCondition(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

function seedMissionNetworkApproval(missionId, approvalId, inputValue) {
  const database = new Database(join(dataDir, "aiteam.db"));
  try {
    const execution = database
      .prepare(
        `SELECT owner_id, task_ids_json
         FROM mission_executions
         WHERE mission_id = ?`,
      )
      .get(missionId);
    const taskId = JSON.parse(execution.task_ids_json)[0];
    const server = {
      id: "mission-approval-network-server",
      name: "mission_approval_network",
      kind: "http",
      url: "https://secret-network-target.example/mcp",
      auth_token: "",
      command: "",
      container_image: "",
      args_json: "[]",
      env_json: "{}",
      safety: "network",
    };
    database
      .prepare(
        `INSERT OR IGNORE INTO mcp_servers (
          id, name, kind, url, auth_token, command, container_image, args_json,
          env_json, safety, enabled, created_at
        ) VALUES (
          @id, @name, @kind, @url, @auth_token, @command, @container_image, @args_json,
          @env_json, @safety, 1, @created_at
        )`,
      )
      .run({ ...server, created_at: Date.now() });
    const serverFingerprint = sha256(server);
    const tool = "mcp__mission_approval_network__search";
    const input = canonicalJson({
      ...inputValue,
      api_token: "must-never-leave-aiteam",
    });
    const grant = {
      v: 1,
      server_id: server.id,
      server_name: server.name,
      server_target: server.url,
      server_fingerprint: serverFingerprint,
      tool,
      input,
      call_fingerprint: sha256({
        server_fingerprint: serverFingerprint,
        tool,
        input,
      }),
    };
    const createdAt = Date.now();
    database
      .prepare(
        `UPDATE tasks
         SET status = 'blocked',
             assignee_agent_id = ?,
             blocked_approval_id = ?,
             updated_at = ?
         WHERE id = ? AND owner_id = ?`,
      )
      .run(
        "mission-approval-no-run-agent",
        approvalId,
        createdAt,
        taskId,
        execution.owner_id,
      );
    database
      .prepare(
        `INSERT INTO approvals (
          id, owner_id, channel_id, agent_id, title, payload, kind, ref_id,
          status, created_at, resolved_at, consumed_at
        ) VALUES (
          ?, ?, NULL, ?, ?, ?, 'network', ?, 'pending', ?, NULL, NULL
        )`,
      )
      .run(
        approvalId,
        execution.owner_id,
        "mission-approval-no-run-agent",
        "批准一次外部资料检索",
        JSON.stringify({
          details: "AITeam 需要访问外部检索服务以继续 Mission。",
          network_grant: grant,
        }),
        taskId,
        createdAt,
      );
    return { taskId, callFingerprint: grant.call_fingerprint };
  } finally {
    database.close();
  }
}

function approvalState(approvalId, taskId) {
  const database = new Database(join(dataDir, "aiteam.db"), {
    readonly: true,
  });
  try {
    return {
      approval: database
        .prepare(
          `SELECT status, resolved_at, consumed_at
           FROM approvals
           WHERE id = ?`,
        )
        .get(approvalId),
      task: database
        .prepare(
          `SELECT status, blocked_approval_id
           FROM tasks
           WHERE id = ?`,
        )
        .get(taskId),
      approvalEvents: database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM task_events
           WHERE task_id = ? AND type = 'approval'`,
        )
        .get(taskId).count,
    };
  } finally {
    database.close();
  }
}

try {
  await waitForServer();
  const missingToken = await fetch(`${base}/missions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "mission-unauthorized",
    },
    body: JSON.stringify({
      organization_id: "org-alpha",
      kind: "research_report",
      title: "Unauthorized mission",
      brief: "This request must be rejected before mission creation.",
    }),
  });
  assertEqual(missingToken.status, 401, "Mission creation requires a service JWT");
  const missingTokenBody = await missingToken.json();
  assertEqual(
    missingTokenBody.error?.code,
    "SERVICE_AUTH_REQUIRED",
    "Mission API returns its service-auth error contract",
  );

  const invalidToken = await fetch(`${base}/missions`, {
    method: "POST",
    headers: {
      Authorization: "Bearer not-a-valid-jwt",
      "Content-Type": "application/json",
      "Idempotency-Key": "mission-invalid-token",
    },
    body: JSON.stringify({
      organization_id: "org-alpha",
      kind: "research_report",
      title: "Invalid service token",
      brief: "This request must be rejected.",
      requested_by: "user-123",
    }),
  });
  assertEqual(invalidToken.status, 401, "An invalid service JWT is rejected");

  const missionHeaders = {
    Authorization: `Bearer ${serviceToken("org-alpha")}`,
    "Content-Type": "application/json",
    "Idempotency-Key": "mission-create-alpha",
  };
  const missionBody = {
    organization_id: "org-alpha",
    kind: "research_report",
    title: "Market research brief",
    brief: "Produce a sourced market research report for the organization.",
    requested_by: "user-123",
  };
  const createMission = await fetch(`${base}/missions`, {
    method: "POST",
    headers: missionHeaders,
    body: JSON.stringify(missionBody),
  });
  assertEqual(createMission.status, 201, "A valid service request creates a mission");
  const createdBody = await createMission.json();

  const secondOrganizationMission = await fetch(`${base}/missions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceToken("org-beta")}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "mission-owner-isolation-beta",
    },
    body: JSON.stringify({
      ...missionBody,
      organization_id: "org-beta",
      title: "Second organization with the same requester id",
    }),
  });
  assertEqual(
    secondOrganizationMission.status,
    201,
    "Another organization can create a Mission for the same requester id",
  );
  const secondOrganizationMissionBody = await secondOrganizationMission.json();
  assertEqual(
    missionExecutionOwner(createdBody.data.id) !==
      missionExecutionOwner(secondOrganizationMissionBody.data.id),
    true,
    "Mission execution workspaces include the organization boundary",
  );
  expireMissionInDatabase(secondOrganizationMissionBody.data.id);
  assertEqual(
    await waitForCondition(
      () =>
        missionStatusInDatabase(secondOrganizationMissionBody.data.id) ===
        "failed",
    ),
    true,
    "The runtime proactively fails an overdue Mission without another API read",
  );

  const approvalMissionResponse = await fetch(`${base}/missions`, {
    method: "POST",
    headers: {
      ...missionHeaders,
      "Idempotency-Key": "mission-approval-alpha",
    },
    body: JSON.stringify({
      ...missionBody,
      title: "Mission requiring a network approval",
    }),
  });
  assertEqual(
    approvalMissionResponse.status,
    201,
    "A Mission for network-approval regression is created",
  );
  const approvalMissionBody = await approvalMissionResponse.json();
  const approvalMissionId = approvalMissionBody.data.id;
  const approvalId = "mission-network-approval-approved";
  const seededApproval = seedMissionNetworkApproval(
    approvalMissionId,
    approvalId,
    {
      query: "private-query-that-must-not-be-returned",
      harmless: "sk-live-value-secret-1234567890",
      callback:
        "https://integration-user:integration-password@example.com/callback?token=query-secret-123456",
      z_context: Array.from({ length: 8 }, (_, index) =>
        `第${index + 1}段${"中文审批摘要".repeat(48)}`,
      ),
    },
  );

  const listApprovals = await fetch(
    `${base}/missions/${approvalMissionId}/approvals`,
    {
      headers: {
        Authorization: `Bearer ${serviceToken("org-alpha", ["mission:read"])}`,
      },
    },
  );
  assertEqual(
    listApprovals.status,
    200,
    "The owning organization can list Mission network approvals",
  );
  const listApprovalsBody = await listApprovals.json();
  assertEqual(
    listApprovalsBody.data?.[0]?.id,
    approvalId,
    "Mission approval listing returns the matching approval",
  );
  assertEqual(
    listApprovalsBody.data?.[0]?.kind,
    "network",
    "Mission approval listing exposes only the network approval kind",
  );
  assertEqual(
    listApprovalsBody.data?.[0]?.destination,
    "https://secret-network-target.example/mcp",
    "Mission approval listing identifies the sanitized network destination",
  );
  assertEqual(
    listApprovalsBody.data?.[0]?.input_summary?.includes(
      "private-query-that-must-not-be-returned",
    ),
    true,
    "Mission approval listing identifies the bounded outbound query",
  );
  assertEqual(
    listApprovalsBody.data?.[0]?.call_fingerprint,
    seededApproval.callFingerprint,
    "Mission approval listing binds the decision to the exact network call",
  );
  assertEqual(
    Buffer.byteLength(listApprovalsBody.data?.[0]?.input_summary ?? "") <= 1200,
    true,
    "Mission approval listing bounds UTF-8 input summaries to 1200 bytes",
  );
  assertEqual(
    listApprovalsBody.data?.[0]?.input_summary?.includes("\uFFFD"),
    false,
    "Mission approval listing preserves valid Unicode at the byte boundary",
  );
  const serializedApproval = JSON.stringify(listApprovalsBody);
  for (const secretValue of [
    "must-never-leave-aiteam",
    "sk-live-value-secret-1234567890",
    "integration-user",
    "integration-password",
    "query-secret-123456",
    seededApproval.taskId,
    "mission-approval-no-run-agent",
    "server_fingerprint",
  ]) {
    assertEqual(
      serializedApproval.includes(secretValue),
      false,
      `Mission approval listing redacts ${secretValue}`,
    );
  }

  const crossOrganizationApprovals = await fetch(
    `${base}/missions/${approvalMissionId}/approvals`,
    {
      headers: {
        Authorization: `Bearer ${serviceToken("org-beta", ["mission:read"])}`,
      },
    },
  );
  assertEqual(
    crossOrganizationApprovals.status,
    404,
    "Mission approvals are hidden from another organization",
  );

  const readOnlyResolve = await fetch(
    `${base}/missions/${approvalMissionId}/approvals/${approvalId}/resolve`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceToken("org-alpha", ["mission:read"])}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        decision: "approve",
        resolved_by: "user-123",
        call_fingerprint: seededApproval.callFingerprint,
      }),
    },
  );
  assertEqual(
    readOnlyResolve.status,
    403,
    "A read-only service token cannot resolve a Mission approval",
  );

  const resolveHeaders = {
    Authorization: `Bearer ${serviceToken("org-alpha", ["mission:approve"])}`,
    "Content-Type": "application/json",
  };
  const approveNetwork = await fetch(
    `${base}/missions/${approvalMissionId}/approvals/${approvalId}/resolve`,
    {
      method: "POST",
      headers: resolveHeaders,
      body: JSON.stringify({
        decision: "approve",
        resolved_by: "user-123",
        call_fingerprint: seededApproval.callFingerprint,
      }),
    },
  );
  assertEqual(
    approveNetwork.status,
    200,
    "An authorized Mission requester can approve a network action",
  );
  const approvedState = approvalState(approvalId, seededApproval.taskId);
  assertEqual(
    approvedState.approval.status,
    "approved",
    "Mission approval updates the existing AITeam approval",
  );
  assertEqual(
    approvedState.task.status,
    "todo",
    "Approving a Mission network action resumes its original task",
  );
  assertEqual(
    approvedState.task.blocked_approval_id,
    null,
    "Approving clears the task's blocking approval",
  );

  const replayApprove = await fetch(
    `${base}/missions/${approvalMissionId}/approvals/${approvalId}/resolve`,
    {
      method: "POST",
      headers: resolveHeaders,
      body: JSON.stringify({
        decision: "approve",
        resolved_by: "user-123",
        call_fingerprint: seededApproval.callFingerprint,
      }),
    },
  );
  assertEqual(
    replayApprove.status,
    200,
    "Repeating the same Mission approval decision is idempotent",
  );
  assertEqual(
    approvalState(approvalId, seededApproval.taskId).approvalEvents,
    approvedState.approvalEvents,
    "An idempotent approval replay does not duplicate task events",
  );

  const conflictingReject = await fetch(
    `${base}/missions/${approvalMissionId}/approvals/${approvalId}/resolve`,
    {
      method: "POST",
      headers: resolveHeaders,
      body: JSON.stringify({
        decision: "reject",
        resolved_by: "user-123",
        call_fingerprint: seededApproval.callFingerprint,
      }),
    },
  );
  assertEqual(
    conflictingReject.status,
    409,
    "A conflicting Mission approval decision cannot overwrite the first decision",
  );

  const rejectedApprovalId = "mission-network-approval-rejected";
  const rejectedSeed = seedMissionNetworkApproval(
    approvalMissionId,
    rejectedApprovalId,
    "another-private-query",
  );
  const rejectNetwork = await fetch(
    `${base}/missions/${approvalMissionId}/approvals/${rejectedApprovalId}/resolve`,
    {
      method: "POST",
      headers: resolveHeaders,
      body: JSON.stringify({
        decision: "reject",
        resolved_by: "user-123",
        call_fingerprint: rejectedSeed.callFingerprint,
      }),
    },
  );
  assertEqual(
    rejectNetwork.status,
    200,
    "An authorized Mission requester can reject a network action",
  );
  const rejectedState = approvalState(
    rejectedApprovalId,
    rejectedSeed.taskId,
  );
  assertEqual(
    rejectedState.approval.status,
    "rejected",
    "Mission network rejection is persisted",
  );
  assertEqual(
    rejectedState.task.status,
    "blocked",
    "Rejecting a Mission network action leaves the task blocked",
  );
  assertEqual(
    rejectedState.task.blocked_approval_id,
    rejectedApprovalId,
    "Rejected network approval remains the visible block reason",
  );
  const closeApprovalMission = await fetch(
    `${base}/missions/${approvalMissionId}/cancel`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceToken("org-alpha", [
          "mission:cancel",
        ])}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cancelled_by: "user-123",
        reason: "Network approval regression is complete.",
      }),
    },
  );
  assertEqual(
    closeApprovalMission.status,
    200,
    "The approval regression Mission releases its admission slot",
  );

  const cancellableMission = await fetch(`${base}/missions`, {
    method: "POST",
    headers: {
      ...missionHeaders,
      "Idempotency-Key": "mission-cancel-alpha",
    },
    body: JSON.stringify({
      ...missionBody,
      title: "Mission that will be cancelled",
    }),
  });
  assertEqual(
    cancellableMission.status,
    201,
    "A cancellable Mission is created",
  );
  const cancellableBody = await cancellableMission.json();
  const cancelMission = await fetch(
    `${base}/missions/${cancellableBody.data.id}/cancel`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceToken("org-alpha", [
          "mission:create",
          "mission:read",
          "mission:cancel",
        ])}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cancelled_by: "user-123",
        reason: "The requester no longer needs this report.",
      }),
    },
  );
  const cancelledBody = await cancelMission.json();
  assertEqual(
    cancelMission.status,
    200,
    "An authorized service request cancels an active Mission",
  );
  assertEqual(
    cancelledBody.data?.status,
    "cancelled",
    "Mission cancellation returns the cancelled terminal state",
  );
  const replayCancel = await fetch(
    `${base}/missions/${cancellableBody.data.id}/cancel`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceToken("org-alpha", [
          "mission:cancel",
          "mission:read",
        ])}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cancelled_by: "user-123",
        reason: "The requester no longer needs this report.",
      }),
    },
  );
  assertEqual(
    replayCancel.status,
    200,
    "Repeating the same cancellation is idempotent",
  );
  const cancelledEvents = await fetch(
    `${base}/missions/${cancellableBody.data.id}/events?after=0`,
    {
      headers: {
        Authorization: `Bearer ${serviceToken("org-alpha")}`,
      },
    },
  );
  const cancelledEventsBody = await cancelledEvents.json();
  const cancellationEvents = cancelledEventsBody.data?.filter(
    (event) => event.type === "mission.cancelled",
  );
  assertEqual(
    cancellationEvents?.length,
    1,
    "Repeated cancellation records exactly one Mission cancellation event",
  );
  assertEqual(
    cancellationEvents?.[0]?.payload?.activity?.actor?.type,
    "human",
    "Mission cancellation identifies a human actor",
  );
  assertEqual(
    cancellationEvents?.[0]?.payload?.activity?.actor?.role,
    "requester",
    "Mission cancellation attributes the action to a Coworker requester",
  );
  const readOnlyCancel = await fetch(
    `${base}/missions/${cancellableBody.data.id}/cancel`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceToken("org-alpha", ["mission:read"])}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cancelled_by: "user-123",
        reason: "This token must not be allowed to cancel.",
      }),
    },
  );
  assertEqual(
    readOnlyCancel.status,
    403,
    "A read-only service token cannot cancel a Mission",
  );
  const crossOrganizationCancel = await fetch(
    `${base}/missions/${cancellableBody.data.id}/cancel`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceToken("org-beta", ["mission:cancel"])}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cancelled_by: "user-456",
        reason: "Another organization must not observe this Mission.",
      }),
    },
  );
  assertEqual(
    crossOrganizationCancel.status,
    404,
    "Mission cancellation is hidden from another organization",
  );

  let completedMission;
  const completionDeadline = Date.now() + 15_000;
  while (Date.now() < completionDeadline) {
    const response = await fetch(
      `${base}/missions/${createdBody.data.id}`,
      {
        headers: {
          Authorization: `Bearer ${serviceToken("org-alpha")}`,
        },
      },
    );
    if (response.ok) {
      const body = await response.json();
      if (body.data?.status === "completed") {
        completedMission = body.data;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assertEqual(
    completedMission?.status,
    "completed",
    "A research Mission reaches completed through the real task engine",
  );
  const completedCancel = await fetch(
    `${base}/missions/${createdBody.data.id}/cancel`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceToken("org-alpha", ["mission:cancel"])}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cancelled_by: "user-123",
        reason: "Completed delivery must remain immutable.",
      }),
    },
  );
  assertEqual(
    completedCancel.status,
    409,
    "A completed Mission cannot be relabelled as cancelled",
  );
  const completedCancelBody = await completedCancel.json();
  assertEqual(
    completedCancelBody.error?.code,
    "MISSION_TERMINAL",
    "Terminal cancellation returns a stable machine error code",
  );
  const missionArtifacts = await fetch(
    `${base}/missions/${createdBody.data.id}/artifacts`,
    {
      headers: {
        Authorization: `Bearer ${serviceToken("org-alpha")}`,
      },
    },
  );
  assertEqual(
    missionArtifacts.status,
    200,
    "The owning organization can retrieve Mission artifacts",
  );
  const artifactsBody = await missionArtifacts.json();
  assertEqual(
    artifactsBody.data?.length > 0,
    true,
    "A completed research Mission exposes at least one artifact",
  );
  assertEqual(
    artifactsBody.data?.at(-1)?.kind,
    "report",
    "The final Mission artifact is a report",
  );
  const crossOrganizationArtifacts = await fetch(
    `${base}/missions/${createdBody.data.id}/artifacts`,
    {
      headers: {
        Authorization: `Bearer ${serviceToken("org-beta")}`,
      },
    },
  );
  assertEqual(
    crossOrganizationArtifacts.status,
    404,
    "Mission artifacts are hidden from other organizations",
  );

  const replayMission = await fetch(`${base}/missions`, {
    method: "POST",
    headers: missionHeaders,
    body: JSON.stringify(missionBody),
  });
  assertEqual(replayMission.status, 200, "An identical idempotent replay reuses the mission");
  const replayedBody = await replayMission.json();
  assertEqual(
    replayedBody.data?.id,
    createdBody.data?.id,
    "An idempotent replay returns the original mission",
  );

  const conflictingReplay = await fetch(`${base}/missions`, {
    method: "POST",
    headers: missionHeaders,
    body: JSON.stringify({
      ...missionBody,
      title: "A different report using the same request key",
    }),
  });
  assertEqual(
    conflictingReplay.status,
    409,
    "Reusing an idempotency key for another request is rejected",
  );

  const crossOrganizationCreate = await fetch(`${base}/missions`, {
    method: "POST",
    headers: {
      ...missionHeaders,
      Authorization: `Bearer ${serviceToken("org-beta")}`,
      "Idempotency-Key": "mission-cross-organization",
    },
    body: JSON.stringify(missionBody),
  });
  assertEqual(
    crossOrganizationCreate.status,
    403,
    "A service token cannot create a mission for another organization",
  );

  const readOnlyCreate = await fetch(`${base}/missions`, {
    method: "POST",
    headers: {
      ...missionHeaders,
      Authorization: `Bearer ${serviceToken("org-alpha", ["mission:read"])}`,
      "Idempotency-Key": "mission-read-only",
    },
    body: JSON.stringify(missionBody),
  });
  assertEqual(
    readOnlyCreate.status,
    403,
    "A read-only service token cannot create a mission",
  );

  const getMission = await fetch(`${base}/missions/${createdBody.data.id}`, {
    headers: {
      Authorization: `Bearer ${serviceToken("org-alpha")}`,
    },
  });
  assertEqual(getMission.status, 200, "The owning organization can retrieve its mission");

  const crossOrganizationRead = await fetch(
    `${base}/missions/${createdBody.data.id}`,
    {
      headers: {
        Authorization: `Bearer ${serviceToken("org-beta")}`,
      },
    },
  );
  assertEqual(
    crossOrganizationRead.status,
    404,
    "A mission is hidden from other organizations",
  );

  const missionEvents = await fetch(
    `${base}/missions/${createdBody.data.id}/events?after=0`,
    {
      headers: {
        Authorization: `Bearer ${serviceToken("org-alpha")}`,
      },
    },
  );
  assertEqual(missionEvents.status, 200, "Mission events can be replayed incrementally");
  const eventsBody = await missionEvents.json();
  assertEqual(eventsBody.data?.[0]?.sequence, 1, "The creation event starts at sequence one");
  assertEqual(
    typeof eventsBody.data?.[0]?.event_id === "string" &&
      eventsBody.data[0].event_id.length > 0,
    true,
    "Mission events expose a stable event id",
  );
  assertEqual(
    eventsBody.data?.[0]?.correlation_id,
    createdBody.data.id,
    "Mission events correlate to the Mission",
  );
  assertEqual(
    eventsBody.data?.[0]?.causation_id,
    null,
    "The creation event has no parent event",
  );
  assertEqual(
    eventsBody.data?.[0]?.type,
    "mission.created",
    "Mission creation is recorded as the first event",
  );
  assertEqual(
    JSON.stringify(eventsBody.data?.[0]?.payload?.activity),
    JSON.stringify({
      stage: { key: "intake", label: "任务受理" },
      actor: {
        type: "human",
        role: "requester",
        label: "Coworker 任务发起人",
      },
    }),
    "Mission creation publishes explicit requester and intake metadata",
  );
  const completedEvent = eventsBody.data?.find(
    (event) => event.type === "mission.completed",
  );
  assertEqual(
    completedEvent?.status,
    "completed",
    "Mission completion is recorded in the replayable event stream",
  );
  assertEqual(
    completedEvent?.payload?.final_artifact_id,
    artifactsBody.data?.find(
      (artifact) =>
        artifact.kind === "report" &&
        artifact.task_id === completedEvent?.payload?.final_task_id,
    )?.id,
    "The completion event points to the final report artifact",
  );
  assertEqual(
    completedEvent?.payload?.quality_gate,
    "mock_skipped",
    "Mock completion is not presented as a passed quality review",
  );
  assertEqual(
    Number.isSafeInteger(completedEvent?.payload?.observability?.latency_ms) &&
      completedEvent.payload.observability.latency_ms >= 0,
    true,
    "Mission completion publishes a bounded execution latency",
  );
  assertEqual(
    completedEvent?.payload?.observability?.usage?.billable_tokens,
    0,
    "Mock Mission completion publishes its zero billable-token cost",
  );
  assertEqual(
    completedEvent?.payload?.observability?.cost?.unit,
    "billable_tokens",
    "Mission completion uses the native billable-token cost unit",
  );
  assertEqual(
    completedEvent?.payload?.observability?.cost?.amount,
    completedEvent?.payload?.observability?.usage?.billable_tokens,
    "Mission cost amount is bound to the persisted usage total",
  );
  assertEqual(
    completedEvent?.payload?.observability?.cost?.currency_status,
    "unavailable",
    "Mission completion does not invent an unprovable currency estimate",
  );
  assertEqual(
    completedEvent?.payload?.observability?.network_approval_decisions,
    0,
    "Mission completion publishes its human network-approval interventions",
  );
  assertEqual(
    completedEvent?.payload?.activity?.stage?.key,
    "delivery",
    "Mission completion publishes the delivery stage",
  );
  assertEqual(
    completedEvent?.payload?.activity?.actor?.role,
    "reviewer",
    "Mission completion identifies the reviewer role",
  );
  assertEqual(
    completedEvent?.payload?.activity?.actor?.type,
    "agent",
    "Mission completion identifies an agent actor",
  );
  assertEqual(
    typeof completedEvent?.payload?.activity?.actor?.label === "string" &&
      completedEvent.payload.activity.actor.label.length > 0,
    true,
    "Mission completion publishes a bounded public actor label",
  );
  assertEqual(
    Object.hasOwn(completedEvent?.payload?.activity?.actor ?? {}, "id"),
    false,
    "Mission activity metadata does not expose an internal agent id",
  );
  const completedEventIndex = eventsBody.data?.findIndex(
    (event) => event.event_id === completedEvent?.event_id,
  );
  assertEqual(
    typeof completedEvent?.event_id === "string" &&
      completedEvent.event_id.length > 0,
    true,
    "The completion event has a stable event id",
  );
  assertEqual(
    completedEvent?.correlation_id,
    createdBody.data.id,
    "The completion event retains the Mission correlation id",
  );
  assertEqual(
    completedEvent?.causation_id,
    eventsBody.data?.[completedEventIndex - 1]?.event_id,
    "Each transition event references the event that caused it",
  );
  const replayedEvents = await fetch(
    `${base}/missions/${createdBody.data.id}/events?after=0`,
    {
      headers: {
        Authorization: `Bearer ${serviceToken("org-alpha")}`,
      },
    },
  );
  const replayedEventsBody = await replayedEvents.json();
  assertEqual(
    JSON.stringify(replayedEventsBody.data?.map((event) => event.event_id)),
    JSON.stringify(eventsBody.data?.map((event) => event.event_id)),
    "Mission event ids remain stable across replay",
  );

  const noNewEvents = await fetch(
    `${base}/missions/${createdBody.data.id}/events?after=${eventsBody.next_after}`,
    {
      headers: {
        Authorization: `Bearer ${serviceToken("org-alpha")}`,
      },
    },
  );
  const noNewEventsBody = await noNewEvents.json();
  assertEqual(
    noNewEventsBody.data?.length,
    0,
    "The event cursor excludes events that were already consumed",
  );
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    child.once("exit", resolve);
    setTimeout(resolve, 2000);
  });
  rmSync(dataDir, { recursive: true, force: true });
}

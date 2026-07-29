#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
    eventsBody.data?.[0]?.type,
    "mission.created",
    "Mission creation is recorded as the first event",
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
    artifactsBody.data?.at(-1)?.id,
    "The completion event points to the final report artifact",
  );
  assertEqual(
    completedEvent?.payload?.quality_gate,
    "mock_skipped",
    "Mock completion is not presented as a passed quality review",
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

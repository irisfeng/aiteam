#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = mkdtempSync(join(tmpdir(), "aiteam-mission-admission-"));
const instanceId = `mission-admission-${process.pid}-${Date.now()}`;
const secret = "mission-admission-regression-secret-at-least-32-bytes";

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
    AITEAM_MISSION_MAX_ACTIVE_PER_ORGANIZATION: "1",
    AITEAM_MISSION_MAX_ACTIVE_GLOBAL: "2",
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

function requestHash(input) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function insertActiveMission(input, idempotencyKey, id) {
  const now = Date.now();
  const database = new Database(join(dataDir, "aiteam.db"));
  try {
    database
      .prepare(
        `INSERT INTO missions (
          id, organization_id, kind, title, brief, requested_by,
          idempotency_key, request_hash, status, deadline_at, created_at, updated_at
        ) VALUES (
          @id, @organization_id, @kind, @title, @brief, @requested_by,
          @idempotency_key, @request_hash, 'running', @deadline_at, @created_at, @updated_at
        )`,
      )
      .run({
        ...input,
        id,
        idempotency_key: idempotencyKey,
        request_hash: requestHash(input),
        deadline_at: now + 60_000,
        created_at: now,
        updated_at: now,
      });
  } finally {
    database.close();
  }
}

function countMissionsByIdempotencyKeys(keys) {
  const database = new Database(join(dataDir, "aiteam.db"), { readonly: true });
  try {
    const placeholders = keys.map(() => "?").join(", ");
    return database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM missions
         WHERE idempotency_key IN (${placeholders})`,
      )
      .get(...keys).count;
  } finally {
    database.close();
  }
}

function releaseSeededCapacity() {
  const database = new Database(join(dataDir, "aiteam.db"));
  try {
    database
      .prepare(
        `UPDATE missions
         SET status = 'cancelled', updated_at = ?
         WHERE id IN (?, ?)`,
      )
      .run(
        Date.now(),
        "mission-admission-active-alpha",
        "mission-admission-active-beta",
      );
  } finally {
    database.close();
  }
}

function releaseAllCapacity() {
  const database = new Database(join(dataDir, "aiteam.db"));
  try {
    database
      .prepare(
        `UPDATE missions
         SET status = 'cancelled', updated_at = ?
         WHERE status IN ('queued', 'running', 'blocked')`,
      )
      .run(Date.now());
  } finally {
    database.close();
  }
}

const occupiedMission = {
  organization_id: "org-alpha",
  kind: "research_report",
  title: "Already running research",
  brief: "Keep the organization admission slot occupied.",
  requested_by: "user-alpha",
};
const globallyOccupiedMission = {
  organization_id: "org-beta",
  kind: "research_report",
  title: "Another running research Mission",
  brief: "Keep the second global admission slot occupied.",
  requested_by: "user-beta",
};
const rejectedOrganizationMission = {
  organization_id: "org-alpha",
  kind: "research_report",
  title: "A second organization Mission",
  brief: "This request must wait for an organization slot.",
  requested_by: "user-alpha",
};
const rejectedGlobalMission = {
  organization_id: "org-gamma",
  kind: "research_report",
  title: "A Mission beyond global capacity",
  brief: "This request must wait for a global slot.",
  requested_by: "user-gamma",
};

try {
  await waitForServer();
  insertActiveMission(
    occupiedMission,
    "mission-admission-occupied-alpha",
    "mission-admission-active-alpha",
  );
  insertActiveMission(
    globallyOccupiedMission,
    "mission-admission-occupied-beta",
    "mission-admission-active-beta",
  );

  const response = await fetch(`${base}/missions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceToken("org-alpha")}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "mission-admission-rejected-alpha",
    },
    body: JSON.stringify(rejectedOrganizationMission),
  });
  assertEqual(
    response.status,
    429,
    "An organization at its active Mission limit is rejected",
  );
  const body = await response.json();
  assertEqual(
    body.error?.code,
    "MISSION_CAPACITY_EXCEEDED",
    "Mission admission returns a stable capacity error code",
  );

  const globalResponse = await fetch(`${base}/missions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceToken("org-gamma")}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "mission-admission-rejected-global",
    },
    body: JSON.stringify(rejectedGlobalMission),
  });
  assertEqual(
    globalResponse.status,
    429,
    "A service at its global active Mission limit is rejected",
  );
  const globalBody = await globalResponse.json();
  assertEqual(
    globalBody.error?.code,
    "MISSION_CAPACITY_EXCEEDED",
    "Global Mission admission uses the stable capacity error code",
  );

  const replayResponse = await fetch(`${base}/missions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceToken("org-alpha")}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "mission-admission-occupied-alpha",
    },
    body: JSON.stringify(occupiedMission),
  });
  assertEqual(
    replayResponse.status,
    200,
    "An identical idempotent replay bypasses full admission limits",
  );
  const replayBody = await replayResponse.json();
  assertEqual(
    replayBody.data?.id,
    "mission-admission-active-alpha",
    "Capacity-safe replay returns the original Mission",
  );
  assertEqual(
    response.headers.get("retry-after"),
    "5",
    "Capacity rejection publishes a bounded retry hint",
  );
  assertEqual(
    countMissionsByIdempotencyKeys([
      "mission-admission-rejected-alpha",
      "mission-admission-rejected-global",
    ]),
    0,
    "Rejected admission does not persist a partial Mission",
  );

  releaseSeededCapacity();
  const admittedAfterRelease = await fetch(`${base}/missions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceToken("org-alpha")}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "mission-admission-rejected-alpha",
    },
    body: JSON.stringify(rejectedOrganizationMission),
  });
  assertEqual(
    admittedAfterRelease.status,
    201,
    "A terminal Mission releases capacity for a previously rejected request",
  );

  releaseAllCapacity();
  const concurrentBodies = [
    {
      ...rejectedOrganizationMission,
      organization_id: "org-delta",
      title: "Concurrent admission A",
      requested_by: "user-delta",
    },
    {
      ...rejectedOrganizationMission,
      organization_id: "org-delta",
      title: "Concurrent admission B",
      requested_by: "user-delta",
    },
  ];
  const concurrentResponses = await Promise.all(
    concurrentBodies.map((body, index) =>
      fetch(`${base}/missions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceToken("org-delta")}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `mission-admission-concurrent-${index}`,
        },
        body: JSON.stringify(body),
      }),
    ),
  );
  assertEqual(
    JSON.stringify(concurrentResponses.map((item) => item.status).sort()),
    JSON.stringify([201, 429]),
    "Concurrent requests cannot over-admit one organization",
  );
  assertEqual(
    countMissionsByIdempotencyKeys([
      "mission-admission-concurrent-0",
      "mission-admission-concurrent-1",
    ]),
    1,
    "Atomic admission persists exactly one concurrent Mission",
  );
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    child.once("exit", resolve);
    setTimeout(resolve, 2000);
  });
  rmSync(dataDir, { recursive: true, force: true });
}

function assertInvalidAdmissionConfiguration(environment, expectedMessage, label) {
  const invalidDataDir = mkdtempSync(
    join(tmpdir(), "aiteam-mission-admission-invalid-"),
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'await import("./server/dist/missions.js")',
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          AITEAM_DATA_DIR: invalidDataDir,
          ...environment,
        },
        encoding: "utf8",
      },
    );
    assertEqual(result.status, 1, label);
    assertEqual(
      `${result.stderr}\n${result.stdout}`.includes(expectedMessage),
      true,
      `${label} reports its configuration boundary`,
    );
  } finally {
    rmSync(invalidDataDir, { recursive: true, force: true });
  }
}

assertInvalidAdmissionConfiguration(
  { AITEAM_MISSION_MAX_ACTIVE_GLOBAL: "0" },
  "AITEAM_MISSION_MAX_ACTIVE_GLOBAL must be an integer between 1 and 64",
  "AITeam rejects an out-of-range global Mission limit",
);
assertInvalidAdmissionConfiguration(
  {
    AITEAM_MISSION_MAX_ACTIVE_PER_ORGANIZATION: "3",
    AITEAM_MISSION_MAX_ACTIVE_GLOBAL: "2",
  },
  "AITEAM_MISSION_MAX_ACTIVE_PER_ORGANIZATION cannot exceed AITEAM_MISSION_MAX_ACTIVE_GLOBAL",
  "AITeam rejects an organization Mission limit above the global limit",
);

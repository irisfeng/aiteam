#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = mkdtempSync(join(tmpdir(), "aiteam-mission-restart-"));
const secret = "mission-restart-secret-with-at-least-32-bytes";

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
  console.log(`✅ ${label}`);
}

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function serviceToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: "HS256", typ: "JWT" });
  const payload = base64url({
    iss: "coworker",
    aud: "aiteam",
    sub: "service:coworker",
    organization_id: "org-restart",
    scope: ["mission:create", "mission:read"],
    iat: now,
    exp: now + 300,
  });
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const selected = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => (error ? reject(error) : resolve(selected)));
    });
  });
}

async function startServer(label) {
  const port = await freePort();
  const instanceId = `mission-restart-${label}-${process.pid}-${Date.now()}`;
  const child = spawn(process.execPath, [join(root, "server/dist/index.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      AITEAM_DATA_DIR: dataDir,
      AITEAM_TEST_INSTANCE_ID: instanceId,
      AITEAM_SERVICE_JWT_SECRET: secret,
      AITEAM_SERVICE_JWT_KEYS: "",
      AITEAM_MISSION_TIMEOUT_MS: "1000",
      AITEAM_TEST_MOCK_DELAY_MS: "5000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/aiteam/api/__test/instance`,
      );
      if (response.ok && (await response.json()).instance_id === instanceId) {
        return { child, base: `http://127.0.0.1:${port}/aiteam/api/v1` };
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGKILL");
  throw new Error(`AITeam server did not start: ${stderr.slice(-1200)}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    child.once("exit", resolve);
    setTimeout(resolve, 2000);
  });
}

const missionBody = {
  organization_id: "org-restart",
  kind: "research_report",
  title: "Restart recovery",
  brief: "Prove Mission recovery across a service restart.",
  requested_by: "user-restart",
};
const headers = {
  Authorization: `Bearer ${serviceToken()}`,
  "Content-Type": "application/json",
  "Idempotency-Key": "mission-restart-regression",
};

let first;
let second;
try {
  first = await startServer("first");
  const created = await fetch(`${first.base}/missions`, {
    method: "POST",
    headers,
    body: JSON.stringify(missionBody),
  });
  assertEqual(created.status, 201, "A Mission is created before restart");
  const mission = (await created.json()).data;
  assertEqual(
    Number.isSafeInteger(mission.deadline_at),
    true,
    "A Mission publishes its persisted execution deadline",
  );
  const beforeResponse = await fetch(
    `${first.base}/missions/${mission.id}/events?after=0&limit=500`,
    { headers },
  );
  const before = await beforeResponse.json();
  assertEqual(beforeResponse.status, 200, "Mission events are readable before restart");
  await stopServer(first.child);
  first = null;

  while (Date.now() <= mission.deadline_at + 50) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  second = await startServer("second");
  const missionAfterRestartResponse = await fetch(
    `${second.base}/missions/${mission.id}`,
    { headers },
  );
  const missionAfterRestart = (await missionAfterRestartResponse.json()).data;
  assertEqual(
    missionAfterRestartResponse.status,
    200,
    "The overdue Mission is readable after restart",
  );
  assertEqual(
    missionAfterRestart.status,
    "failed",
    "Restart expires an overdue Mission before resuming in-flight work",
  );
  const afterResponse = await fetch(
    `${second.base}/missions/${mission.id}/events?after=0&limit=500`,
    { headers },
  );
  const after = await afterResponse.json();
  assertEqual(afterResponse.status, 200, "Mission events are readable after restart");
  assertEqual(
    JSON.stringify(
      after.data
        .slice(0, before.data.length)
        .map((event) => event.event_id),
    ),
    JSON.stringify(before.data.map((event) => event.event_id)),
    "Pre-restart Mission event identities survive recovery",
  );
  assertEqual(
    after.data.filter(
      (event) =>
        event.type === "mission.failed" &&
        event.payload?.error_code === "MISSION_TIMEOUT",
    ).length,
    1,
    "Recovery records exactly one durable Mission timeout event",
  );

  const replayed = await fetch(`${second.base}/missions`, {
    method: "POST",
    headers,
    body: JSON.stringify(missionBody),
  });
  assertEqual(replayed.status, 200, "Mission idempotency survives a service restart");
  assertEqual(
    (await replayed.json()).data.id,
    mission.id,
    "The restarted service returns the original Mission",
  );
  await stopServer(second.child);
  second = null;

  const third = await startServer("third");
  try {
    const replayAfterSecondRestart = await fetch(
      `${third.base}/missions/${mission.id}/events?after=0&limit=500`,
      { headers },
    );
    const replayAfterSecondRestartBody = await replayAfterSecondRestart.json();
    assertEqual(
      replayAfterSecondRestartBody.data.filter(
        (event) =>
          event.type === "mission.failed" &&
          event.payload?.error_code === "MISSION_TIMEOUT",
      ).length,
      1,
      "A second restart does not duplicate the timeout transition",
    );
  } finally {
    await stopServer(third.child);
  }
} finally {
  if (first) await stopServer(first.child);
  if (second) await stopServer(second.child);
  rmSync(dataDir, { recursive: true, force: true });
}

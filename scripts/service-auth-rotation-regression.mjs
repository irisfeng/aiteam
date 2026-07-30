#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = mkdtempSync(join(tmpdir(), "aiteam-service-auth-rotation-"));
const instanceId = `service-auth-rotation-${process.pid}-${Date.now()}`;
const currentKey = "current-service-auth-secret-with-at-least-32-bytes";
const previousKey = "previous-service-auth-secret-with-at-least-32-bytes";

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
    AITEAM_SERVICE_JWT_SECRET: "",
    AITEAM_SERVICE_JWT_KEYS: JSON.stringify({
      "preview-2026-07": currentKey,
      "preview-2026-06": previousKey,
    }),
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
      if (response.ok && (await response.json()).instance_id === instanceId) {
        return;
      }
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

function serviceToken({ keyId, secret }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({
    alg: "HS256",
    typ: "JWT",
    ...(keyId ? { kid: keyId } : {}),
  });
  const payload = base64url({
    iss: "coworker",
    aud: "aiteam",
    sub: "service:coworker",
    organization_id: "org-alpha",
    scope: ["mission:read"],
    iat: now,
    exp: now + 300,
  });
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function missionLookup(token) {
  return fetch(`${base}/missions/not-found`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

try {
  await waitForServer();
  assertEqual(
    (await missionLookup(
      serviceToken({ keyId: "preview-2026-07", secret: currentKey }),
    )).status,
    404,
    "The current service key is accepted during rotation",
  );
  assertEqual(
    (await missionLookup(
      serviceToken({ keyId: "preview-2026-06", secret: previousKey }),
    )).status,
    404,
    "The previous service key remains accepted during the overlap window",
  );
  assertEqual(
    (await missionLookup(
      serviceToken({ keyId: "preview-unknown", secret: currentKey }),
    )).status,
    401,
    "An unknown service key id is rejected",
  );
  assertEqual(
    (await missionLookup(serviceToken({ secret: currentKey }))).status,
    401,
    "A keyring token without a key id is rejected",
  );
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    child.once("exit", resolve);
    setTimeout(resolve, 2000);
  });
  rmSync(dataDir, { recursive: true, force: true });
}

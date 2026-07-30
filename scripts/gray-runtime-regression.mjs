#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = mkdtempSync(join(tmpdir(), "aiteam-gray-runtime-"));
const releaseSha = `gray-runtime-${process.pid}-${Date.now()}`;
let child;

function ok(label, condition, detail = "") {
  if (!condition) {
    throw new Error(`${label}${detail ? `: ${detail}` : ""}`);
  }
  console.log(`✅ ${label}`);
}

const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const selected = typeof address === "object" && address ? address.port : 0;
    probe.close((error) => (error ? reject(error) : resolve(selected)));
  });
});

const base = `http://127.0.0.1:${port}`;
let stderr = "";

async function waitForReady() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/aiteam/api/readyz`);
      if (response.ok) return await response.json();
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`AITeam gray runtime did not become ready: ${stderr.slice(-1200)}`);
}

async function stopGracefully() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.kill("SIGTERM");
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("AITeam did not stop within the graceful-shutdown gate"));
    }, 5000);
    timer.unref();
  });
  const result = await Promise.race([exited, timeout]);
  ok(
    "SIGTERM exits cleanly",
    result.code === 0 && result.signal === null,
    JSON.stringify(result),
  );
}

try {
  const mismatchedImage = spawnSync(
    process.execPath,
    [join(root, "scripts/container-entrypoint.mjs")],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "production",
        AITEAM_RELEASE_SHA: releaseSha,
        AITEAM_EXPECTED_RELEASE_SHA: "wrong-release",
      },
      encoding: "utf8",
    },
  );
  ok(
    "runtime preflight rejects an unexpected image release",
    mismatchedImage.status !== 0 &&
      mismatchedImage.stderr.includes("does not match the expected release"),
  );

  child = spawn(process.execPath, [join(root, "scripts/container-entrypoint.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      AITEAM_HOST: "127.0.0.1",
      AITEAM_DATA_DIR: dataDir,
      AITEAM_RELEASE_SHA: releaseSha,
      AITEAM_AUTH_MODE: "standalone",
      AITEAM_ALLOW_SIGNUP: "0",
      AITEAM_SESSION_SECRET:
        "gray-runtime-session-secret-with-at-least-32-bytes",
      AITEAM_CREDENTIAL_KEY: "92".repeat(32),
      AITEAM_SERVICE_JWT_SECRET:
        "gray-runtime-service-secret-with-at-least-32-bytes",
      ANTHROPIC_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const liveResponse = await fetch(`${base}/aiteam/api/healthz`).catch(
    () => null,
  );
  if (!liveResponse) {
    await waitForReady();
  }
  const live = await fetch(`${base}/aiteam/api/healthz`);
  const liveBody = await live.json();
  ok("live probe is public and healthy", live.ok && liveBody.status === "ok");
  ok("live probe exposes the release SHA", liveBody.release_sha === releaseSha);

  const readyBody = await waitForReady();
  ok("ready probe confirms SQLite", readyBody.checks?.database === "ok");
  ok("ready probe reports Mock mode", readyBody.checks?.model_mode === "mock");
  ok("ready probe exposes the release SHA", readyBody.release_sha === releaseSha);

  const healthcheck = spawnSync(
    process.execPath,
    [join(root, "scripts/container-healthcheck.mjs")],
    {
      cwd: root,
      env: {
        ...process.env,
        AITEAM_HEALTH_URL: `${base}/aiteam/api/readyz`,
        AITEAM_RELEASE_SHA: releaseSha,
      },
      encoding: "utf8",
    },
  );
  ok(
    "container healthcheck accepts the expected release",
    healthcheck.status === 0,
    healthcheck.stderr,
  );

  const wrongRelease = spawnSync(
    process.execPath,
    [join(root, "scripts/container-healthcheck.mjs")],
    {
      cwd: root,
      env: {
        ...process.env,
        AITEAM_HEALTH_URL: `${base}/aiteam/api/readyz`,
        AITEAM_RELEASE_SHA: "wrong-release",
      },
      encoding: "utf8",
    },
  );
  ok("container healthcheck rejects a release mismatch", wrongRelease.status !== 0);

  await stopGracefully();

  const emptyGrayAudit = spawnSync(
    process.execPath,
    [join(root, "scripts/gray-data-audit.mjs")],
    {
      cwd: root,
      env: {
        ...process.env,
        AITEAM_DATA_DIR: dataDir,
      },
      encoding: "utf8",
    },
  );
  const emptyGrayAuditBody = JSON.parse(emptyGrayAudit.stdout);
  ok(
    "empty gray contains only the expected system seed",
    emptyGrayAudit.status === 0 &&
      emptyGrayAuditBody.status === "ok" &&
      emptyGrayAuditBody.system_seed_counts?.skills > 0,
    emptyGrayAudit.stderr,
  );

  const database = new Database(join(dataDir, "aiteam.db"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const integrity = database.pragma("integrity_check", {
      simple: true,
    });
    ok("SQLite remains valid after shutdown", integrity === "ok");
  } finally {
    database.close();
  }
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  rmSync(dataDir, { recursive: true, force: true });
}

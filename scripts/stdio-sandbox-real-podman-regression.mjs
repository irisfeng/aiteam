#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pinnedImage =
  process.env.AITEAM_MCP_SANDBOX_TEST_IMAGE?.trim() || "";
if (!pinnedImage) {
  console.error(
    "AITEAM_MCP_SANDBOX_TEST_IMAGE is required and must name a preloaded Node image pinned by sha256 digest",
  );
  process.exit(2);
}

const fixture = mkdtempSync(join(tmpdir(), "aiteam-real-podman-sandbox-"));
const dataDir = join(fixture, "data");
const outsideMarker = join(fixture, "outside-marker.txt");
const insideName = "sandbox-result.json";

try {
  process.env.NODE_ENV = "production";
  process.env.AITEAM_DATA_DIR = dataDir;
  process.env.AITEAM_MCP_STDIO_RUNNER = "podman";
  process.env.AITEAM_MCP_STDIO_RUNNER_BIN =
    process.env.AITEAM_MCP_STDIO_RUNNER_BIN || "podman";
  process.env.AITEAM_MCP_STDIO_WORKSPACE_ROOT = join(
    dataDir,
    "mcp-workspaces",
  );
  process.env.AITEAM_MCP_STDIO_MEMORY =
    process.env.AITEAM_MCP_STDIO_MEMORY || "128m";
  process.env.AITEAM_MCP_STDIO_CPUS =
    process.env.AITEAM_MCP_STDIO_CPUS || "0.5";
  process.env.AITEAM_MCP_STDIO_PIDS =
    process.env.AITEAM_MCP_STDIO_PIDS || "32";

  const { buildStdioSandboxLaunch } = await import(
    "../server/dist/agents/stdioSandbox.js"
  );
  const probe = `
const fs = require("node:fs");
const output = { outside_blocked: false, rootfs_blocked: false, network_blocked: false };
try { fs.writeFileSync(${JSON.stringify(outsideMarker)}, "escaped"); }
catch { output.outside_blocked = true; }
try { fs.writeFileSync("/aiteam-rootfs-escape", "escaped"); }
catch { output.rootfs_blocked = true; }
fetch("https://example.com", { signal: AbortSignal.timeout(2000) })
  .then(() => { output.network_blocked = false; })
  .catch(() => { output.network_blocked = true; })
  .finally(() => fs.writeFileSync("/workspace/${insideName}", JSON.stringify(output)));
`;
  const launch = buildStdioSandboxLaunch(
    {
      id: "real-podman-escape-probe",
      container_image: pinnedImage,
      command: "node",
      args_json: JSON.stringify(["-e", probe]),
    },
    {
      ownerId: "user:real-podman-probe",
      executionId: "mission:real-podman-probe",
    },
    Object.fromEntries(
      Object.entries(process.env).filter(
        (entry) => typeof entry[1] === "string",
      ),
    ),
  );
  const result = spawnSync(launch.command, launch.args, {
    env: launch.env,
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const insidePath = join(launch.workspace, insideName);
  const evidence = existsSync(insidePath)
    ? JSON.parse(readFileSync(insidePath, "utf8"))
    : null;
  const passed =
    result.status === 0 &&
    !result.error &&
    !existsSync(outsideMarker) &&
    evidence?.outside_blocked === true &&
    evidence?.rootfs_blocked === true &&
    evidence?.network_blocked === true;
  console.log(
    JSON.stringify(
      {
        status: passed ? "pass" : "fail",
        runner_exit: result.status,
        runner_error: result.error?.message ?? null,
        stderr: String(result.stderr || "").slice(-500),
        workspace: launch.workspace,
        outside_marker_created: existsSync(outsideMarker),
        evidence,
      },
      null,
      2,
    ),
  );
  if (!passed) process.exit(1);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

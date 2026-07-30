#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const fixture = mkdtempSync(join(tmpdir(), "aiteam-stdio-sandbox-runner-"));
const dataDir = join(fixture, "data");
const runner = join(fixture, "podman");
const runnerLog = join(fixture, "runner-log.jsonl");
const probeFile = join(fixture, "probe-calls.jsonl");
const mcpFixture = fileURLToPath(
  new URL("./fixtures/network-probe-mcp.mjs", import.meta.url),
);
const serverEntry = fileURLToPath(
  new URL("../server/dist/index.js", import.meta.url),
);
const digest = "a".repeat(64);
const pinnedImage = `localhost/aiteam-mcp-fixture@sha256:${digest}`;

let failures = 0;
function check(id, name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(
    `${ok ? "✅" : "❌"} [${id}] ${name}${detail ? ` — ${detail}` : ""}`,
  );
}

function writeRunner(rootless, executeFixture = false, cgroups = "v2") {
  writeFileSync(
    runner,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "info") {
  process.stdout.write(
    args[2] && args[2].includes("CgroupsVersion")
      ? ${JSON.stringify(`${cgroups}\n`)}
      : ${JSON.stringify(rootless ? "true\n" : "false\n")}
  );
  process.exit(0);
}
if (args[0] === "image" && args[1] === "exists") {
  process.exit(args[2] === ${JSON.stringify(pinnedImage)} ? 0 : 1);
}
if (args[0] === "run" && ${executeFixture ? "true" : "false"}) {
  appendFileSync(${JSON.stringify(runnerLog)}, JSON.stringify(args) + "\\n", "utf8");
  const child = spawn(process.execPath, [${JSON.stringify(mcpFixture)}], {
    env: process.env,
    stdio: "inherit",
  });
  const forward = (signal) => {
    try { child.kill(signal); } catch {}
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
} else {
  process.exit(99);
}
`,
    "utf8",
  );
  chmodSync(runner, 0o755);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port =
        typeof address === "object" && address ? address.port : 0;
      probe.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 20 && child.exitCode === null; i += 1) {
    await delay(50);
  }
  if (child.exitCode === null) child.kill("SIGKILL");
}

try {
  writeRunner(true);
  process.env.NODE_ENV = "production";
  process.env.AITEAM_DATA_DIR = dataDir;
  process.env.AITEAM_MCP_STDIO_RUNNER = "podman";
  process.env.AITEAM_MCP_STDIO_RUNNER_BIN = runner;
  process.env.AITEAM_MCP_STDIO_WORKSPACE_ROOT = join(
    dataDir,
    "mcp-workspaces",
  );
  process.env.AITEAM_MCP_STDIO_MEMORY = "256m";
  process.env.AITEAM_MCP_STDIO_CPUS = "1";
  process.env.AITEAM_MCP_STDIO_PIDS = "64";

  const {
    assertStdioSandboxRunnerReady,
    buildStdioSandboxLaunch,
    isPinnedContainerImage,
    resetStdioSandboxRunnerProbeForTests,
    stdioSandboxRuntimeConfigured,
    withStdioSandboxFile,
  } = await import("../server/dist/agents/stdioSandbox.js");

  let preflightError = "";
  try {
    assertStdioSandboxRunnerReady();
  } catch (error) {
    preflightError = error instanceof Error ? error.message : String(error);
  }
  check(
    "STDIO-SANDBOX-1",
    "production accepts only an explicitly configured rootless Podman runner",
    stdioSandboxRuntimeConfigured() && preflightError === "",
    preflightError,
  );

  const server = {
    id: "sandbox-fixture",
    container_image: pinnedImage,
    command: "--privileged",
    args_json: JSON.stringify(["--mount", "/:/host", "attacker-payload"]),
    env_json: "{}",
  };
  const scope = { ownerId: "user:alpha", executionId: "mission:one" };
  const launch = buildStdioSandboxLaunch(server, scope, {
    HOME: "/host/home/must-not-enter-container",
    PATH: "/host/bin/must-not-enter-container",
    TMPDIR: "/host/tmp/must-not-enter-container",
    SECRET_TOKEN: "must-not-appear-in-argv",
  });
  const imageIndex = launch.args.indexOf(pinnedImage);
  const commandTail = launch.args.slice(imageIndex + 1);
  const argvText = launch.args.join(" ");
  const workspaceRoot = resolve(
    process.env.AITEAM_MCP_STDIO_WORKSPACE_ROOT,
  );
  check(
    "STDIO-SANDBOX-2",
    "runner hardens rootfs, capabilities, privilege gain, network and resources",
    launch.args.includes("--read-only") &&
      launch.args.includes("--cap-drop=all") &&
      launch.args.includes("--security-opt=no-new-privileges") &&
      launch.args.includes("--network=none") &&
      launch.args.includes("--pids-limit=64") &&
      launch.args.includes("--memory=256m") &&
      launch.args.includes("--cpus=1"),
    argvText,
  );
  check(
    "STDIO-SANDBOX-3",
    "attacker-controlled command and args remain after the immutable image",
    imageIndex > 0 &&
      JSON.stringify(commandTail) ===
        JSON.stringify([
          "--privileged",
          "--mount",
          "/:/host",
          "attacker-payload",
        ]),
    JSON.stringify(commandTail),
  );
  check(
    "STDIO-SANDBOX-4",
    "secret values travel through the runner environment and never argv",
    launch.env.SECRET_TOKEN === "must-not-appear-in-argv" &&
      launch.args.includes("SECRET_TOKEN") &&
      !argvText.includes("must-not-appear-in-argv") &&
      !launch.args.includes("HOME") &&
      !launch.args.includes("PATH") &&
      !launch.args.includes("TMPDIR"),
  );
  check(
    "STDIO-SANDBOX-5",
    "workspace is derived under the configured data root",
    resolve(launch.workspace).startsWith(`${workspaceRoot}${sep}`),
    launch.workspace,
  );

  const sameScope = buildStdioSandboxLaunch(server, scope, {});
  const otherMission = buildStdioSandboxLaunch(
    server,
    { ownerId: "user:alpha", executionId: "mission:two" },
    {},
  );
  const otherOwner = buildStdioSandboxLaunch(
    server,
    { ownerId: "user:beta", executionId: "mission:one" },
    {},
  );
  check(
    "STDIO-SANDBOX-6",
    "same Mission shares one workspace while Mission and owner boundaries differ",
    sameScope.workspace === launch.workspace &&
      otherMission.workspace !== launch.workspace &&
      otherOwner.workspace !== launch.workspace,
  );
  check(
    "STDIO-SANDBOX-7",
    "production requires an immutable OCI image digest",
    isPinnedContainerImage(pinnedImage) &&
      !isPinnedContainerImage("docker.io/library/node:22") &&
      !isPinnedContainerImage("--privileged"),
  );
  let stagedHostPath = "";
  const stagedContainerPath = await withStdioSandboxFile(
    scope,
    Buffer.from("sandbox input", "utf8"),
    ".txt",
    async (containerPath, hostPath) => {
      stagedHostPath = hostPath;
      return containerPath;
    },
  );
  check(
    "STDIO-SANDBOX-8",
    "production file inputs are staged inside the Mission workspace and removed after use",
    stagedContainerPath.startsWith("/workspace/") &&
      stagedHostPath.startsWith(`${workspaceRoot}${sep}`) &&
      !existsSync(stagedHostPath),
    `${stagedContainerPath} -> ${stagedHostPath}`,
  );

  writeRunner(false);
  resetStdioSandboxRunnerProbeForTests();
  let rootfulError = "";
  try {
    assertStdioSandboxRunnerReady();
  } catch (error) {
    rootfulError = error instanceof Error ? error.message : String(error);
  }
  check(
    "STDIO-SANDBOX-9",
    "rootful or unverifiable container runtimes fail closed",
    rootfulError.includes("rootless"),
    rootfulError,
  );

  writeRunner(true, false, "v1");
  resetStdioSandboxRunnerProbeForTests();
  let cgroupError = "";
  try {
    assertStdioSandboxRunnerReady();
  } catch (error) {
    cgroupError = error instanceof Error ? error.message : String(error);
  }
  check(
    "STDIO-SANDBOX-10",
    "rootless runner without cgroup v2 fails before resource limits can be bypassed",
    cgroupError.includes("cgroup v2"),
    cgroupError,
  );

  writeRunner(true, true);
  resetStdioSandboxRunnerProbeForTests();
  const apiDataDir = join(fixture, "api-data");
  const port = await freePort();
  const instanceId = `stdio-sandbox-api-${process.pid}-${Date.now()}`;
  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      AITEAM_HOST: "127.0.0.1",
      AITEAM_DATA_DIR: apiDataDir,
      AITEAM_MCP_STDIO_WORKSPACE_ROOT: join(
        apiDataDir,
        "mcp-workspaces",
      ),
      AITEAM_MCP_STDIO_RUNNER: "podman",
      AITEAM_MCP_STDIO_RUNNER_BIN: runner,
      AITEAM_CREDENTIAL_KEY: "22".repeat(32),
      AITEAM_SESSION_SECRET:
        "stdio-sandbox-session-secret-at-least-32-bytes",
      AITEAM_ADMIN_EMAILS: "sandbox-admin@example.com",
      AITEAM_ALLOW_SIGNUP: "1",
      AITEAM_TEST_INSTANCE_ID: instanceId,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  try {
    let ready = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && child.exitCode === null) {
      const response = await fetch(
        `http://127.0.0.1:${port}/aiteam/api/__test/instance`,
      ).catch(() => null);
      if (
        response?.ok &&
        (await response.json()).instance_id === instanceId
      ) {
        ready = true;
        break;
      }
      await delay(100);
    }
    if (!ready) {
      throw new Error(
        `sandbox API fixture did not start: ${output.trim().slice(-500)}`,
      );
    }
    const register = await fetch(
      `http://127.0.0.1:${port}/aiteam/api/auth/register`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "sandbox-admin@example.com",
          password: "stdio-sandbox-password",
          display_name: "Sandbox Admin",
        }),
      },
    );
    const cookie = register.headers.get("set-cookie")?.split(";")[0] ?? "";
    const create = async (body) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/aiteam/api/mcp-servers`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
          },
          body: JSON.stringify(body),
        },
      );
      return {
        status: response.status,
        body: await response.json().catch(() => ({})),
      };
    };
    const registryResponse = await fetch(
      `http://127.0.0.1:${port}/aiteam/api/registry`,
      { headers: { Cookie: cookie } },
    );
    const registryBody = await registryResponse.json().catch(() => ({}));
    const registryLocalStdio =
      registryBody.mcp?.filter(
        (preset) => preset.kind === "stdio" && preset.safety === "local",
      ) ?? [];
    const registryRiskyStdio =
      registryBody.mcp?.filter(
        (preset) => preset.kind === "stdio" && preset.safety !== "local",
      ) ?? [];
    check(
      "STDIO-SANDBOX-11",
      "configured production runner keeps local stdio presets prefillable while risky presets stay blocked",
      registryLocalStdio.length > 0 &&
        registryLocalStdio.every(
          (preset) => preset.runtime_available === true,
        ) &&
        registryRiskyStdio.every(
          (preset) => preset.runtime_available === false,
        ),
      `local=${JSON.stringify(registryLocalStdio.map((p) => p.runtime_blocked_code))} risky=${JSON.stringify(registryRiskyStdio.map((p) => p.runtime_blocked_code))}`,
    );

    const local = await create({
      name: "sandboxed-local",
      kind: "stdio",
      command: "fixture-mcp",
      args: ["--stdio"],
      safety: "local",
      container_image: pinnedImage,
      env: { AITEAM_NETWORK_PROBE_FILE: probeFile },
    });
    const mutable = await create({
      name: "mutable-image",
      kind: "stdio",
      command: "fixture-mcp",
      safety: "local",
      container_image: "localhost/aiteam-mcp-fixture:latest",
    });
    const network = await create({
      name: "network-stdio",
      kind: "stdio",
      command: "fixture-mcp",
      safety: "network",
      container_image: pinnedImage,
    });
    const missingImage = await create({
      name: "missing-image",
      kind: "stdio",
      command: "fixture-mcp",
      safety: "local",
      container_image: `localhost/missing@sha256:${"b".repeat(64)}`,
    });
    check(
      "STDIO-SANDBOX-12",
      "production API admits only local stdio with a pinned image",
      local.status === 200 &&
        local.body.container_image === pinnedImage &&
        local.body.runtime_available === true,
      `status=${local.status} body=${JSON.stringify(local.body).slice(0, 300)}`,
    );
    check(
      "STDIO-SANDBOX-13",
      "mutable images and network-capable stdio remain fail-closed",
      mutable.status === 409 &&
        mutable.body.code === "MCP_STDIO_IMAGE_REQUIRED" &&
        network.status === 409 &&
        network.body.code === "MCP_STDIO_PRODUCTION_SAFETY_DISABLED",
      `mutable=${mutable.status}/${mutable.body.code} network=${network.status}/${network.body.code}`,
    );
    check(
      "STDIO-SANDBOX-14",
      "production rejects a pinned image that was not preloaded",
      missingImage.status === 409 &&
        missingImage.body.code === "MCP_STDIO_IMAGE_UNAVAILABLE",
      `status=${missingImage.status} code=${missingImage.body.code}`,
    );

    const connectionTest = await fetch(
      `http://127.0.0.1:${port}/aiteam/api/mcp-servers/${local.body.id}/test`,
      {
        method: "POST",
        headers: { Cookie: cookie },
      },
    );
    const connectionBody = await connectionTest.json().catch(() => ({}));
    const taskTest = await fetch(
      `http://127.0.0.1:${port}/aiteam/api/mcp-servers/${local.body.id}/task-test`,
      {
        method: "POST",
        headers: { Cookie: cookie },
      },
    );
    const taskBody = await taskTest.json().catch(() => ({}));
    const runnerEntries = existsSync(runnerLog)
      ? readFileSync(runnerLog, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    const mountedWorkspaces = runnerEntries
      .flatMap((entry) => entry)
      .filter(
        (arg) =>
          typeof arg === "string" &&
          arg.startsWith("--volume=") &&
          arg.includes(":/workspace:"),
      )
      .map((arg) => arg.slice("--volume=".length).split(":/workspace:")[0]);
    check(
      "STDIO-SANDBOX-15",
      "real MCP handshake crosses the hardened runner boundary",
      connectionTest.status === 200 &&
        connectionBody.tools === 1 &&
        runnerEntries.length >= 1 &&
        runnerEntries.every(
          (entry) =>
            entry.includes("--network=none") &&
            entry.includes("--read-only") &&
            entry.includes(pinnedImage),
        ),
      `status=${connectionTest.status} tools=${connectionBody.tools} runs=${runnerEntries.length}`,
    );
    check(
      "STDIO-SANDBOX-16",
      "admin probe and task rehearsal receive distinct execution workspaces",
      taskTest.status === 200 &&
        taskBody.ok === true &&
        mountedWorkspaces.length >= 2 &&
        new Set(mountedWorkspaces).size >= 2,
      `status=${taskTest.status} workspaces=${JSON.stringify(mountedWorkspaces)}`,
    );
  } finally {
    await stopChild(child);
  }

  const scopeOwner = "user:mission-scope-owner";
  const scopeDatabase = new Database(join(apiDataDir, "aiteam.db"));
  try {
    scopeDatabase
      .prepare(
        `INSERT INTO mission_executions (
          mission_id, organization_id, owner_id, project_id, final_task_id,
          task_ids_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "mission-sandbox-scope",
        "org-sandbox-scope",
        scopeOwner,
        "project-sandbox-scope",
        "mission-task-final",
        JSON.stringify(["mission-task-one", "mission-task-final"]),
        Date.now(),
      );
  } finally {
    scopeDatabase.close();
  }
  process.env.AITEAM_DATA_DIR = apiDataDir;
  process.env.AITEAM_MCP_STDIO_WORKSPACE_ROOT = join(
    apiDataDir,
    "mcp-workspaces",
  );
  process.env.AITEAM_CREDENTIAL_KEY = "22".repeat(32);
  resetStdioSandboxRunnerProbeForTests();
  const [
    { enterOwner },
    { mcpExecutionIdForTask },
    { callMcpTool, mcpToolName },
  ] = await Promise.all([
    import("../server/dist/ownerScope.js"),
    import("../server/dist/db.js"),
    import("../server/dist/agents/mcp.js"),
  ]);
  enterOwner(scopeOwner);
  check(
    "STDIO-SANDBOX-17",
    "all internal tasks of one Mission resolve to the same sandbox scope",
    mcpExecutionIdForTask("mission-task-one") ===
      "mission:mission-sandbox-scope" &&
      mcpExecutionIdForTask("mission-task-final") ===
        "mission:mission-sandbox-scope",
  );
  check(
    "STDIO-SANDBOX-18",
    "non-Mission work falls back to a task-isolated sandbox scope",
    mcpExecutionIdForTask("ordinary-task") === "task:ordinary-task",
  );

  const countLines = (path) =>
    existsSync(path)
      ? readFileSync(path, "utf8").split("\n").filter(Boolean).length
      : 0;
  const toolName = mcpToolName("sandboxed-local", "search");
  const query = { query: "mission-scoped-cache" };
  const firstResult = await callMcpTool(toolName, query, {
    scope: { ownerId: scopeOwner, executionId: "mission:cache-one" },
  });
  const runsAfterFirst = countLines(runnerLog);
  const callsAfterFirst = countLines(probeFile);
  const cachedResult = await callMcpTool(toolName, query, {
    scope: { ownerId: scopeOwner, executionId: "mission:cache-one" },
  });
  const runsAfterCached = countLines(runnerLog);
  const callsAfterCached = countLines(probeFile);
  const otherMissionResult = await callMcpTool(toolName, query, {
    scope: { ownerId: scopeOwner, executionId: "mission:cache-two" },
  });
  const runsAfterOtherMission = countLines(runnerLog);
  const callsAfterOtherMission = countLines(probeFile);
  check(
    "STDIO-SANDBOX-19",
    "cache hits avoid spawning a container and cache entries never cross Mission scopes",
    firstResult.includes("mission-scoped-cache") &&
      cachedResult === firstResult &&
      otherMissionResult === firstResult &&
      runsAfterCached === runsAfterFirst &&
      callsAfterCached === callsAfterFirst &&
      runsAfterOtherMission === runsAfterFirst + 1 &&
      callsAfterOtherMission === callsAfterFirst + 1,
    `runs=${runsAfterFirst}/${runsAfterCached}/${runsAfterOtherMission} calls=${callsAfterFirst}/${callsAfterCached}/${callsAfterOtherMission}`,
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} stdio sandbox runner regression check(s) failed`);
  process.exit(1);
}

console.log("\nAll stdio sandbox runner regression checks passed.");

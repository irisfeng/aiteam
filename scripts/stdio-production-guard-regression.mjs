#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = mkdtempSync(join(tmpdir(), "aiteam-stdio-production-guard-"));
const marker = join(fixture, "spawned-outside-workspace.txt");
const injectedMarker = join(fixture, "injected-stdio-spawned.txt");
const developmentMarker = join(fixture, "development-stdio-spawned.txt");
const serverEntry = fileURLToPath(
  new URL("../server/dist/index.js", import.meta.url),
);

process.env.NODE_ENV = "production";
process.env.AITEAM_DATA_DIR = join(fixture, "data");
process.env.AITEAM_CREDENTIAL_KEY = "11".repeat(32);
process.env.AITEAM_SESSION_SECRET =
  "stdio-production-guard-session-secret-at-least-32-bytes";

let failures = 0;
function check(id, name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(
    `${ok ? "✅" : "❌"} [${id}] ${name}${detail ? ` — ${detail}` : ""}`,
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port =
        typeof address === "object" && address ? address.port : 0;
      probe.close((error) => (error ? reject(error) : resolve(port)));
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
  const [
    { STDIO_PRODUCTION_DISABLED_CODE, testMcpServer },
    { createMcpServer, setMcpServerEnabled },
  ] = await Promise.all([
    import("../server/dist/agents/mcp.js"),
    import("../server/dist/db.js"),
  ]);
  const server = {
    id: "stdio-production-escape",
    name: "stdio-production-escape",
    kind: "stdio",
    url: "",
    auth_token: "",
    command: process.execPath,
    args_json: JSON.stringify([
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "escaped")`,
    ]),
    env_json: "{}",
    safety: "exec",
    enabled: 1,
    created_at: Date.now(),
  };

  let error = "";
  try {
    await testMcpServer(server);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  check(
    "STDIO-PROD-1",
    "production blocks an unisolated stdio child before the process is spawned",
    !existsSync(marker) && error.includes("生产环境"),
    `spawned=${existsSync(marker)} error=${error.slice(0, 160)}`,
  );

  const enabledStdio = createMcpServer({
    name: "enabled-production-stdio",
    kind: "stdio",
    command: "node",
    args: ["-e", "process.exit(0)"],
    safety: "exec",
  });
  const disabledInjectedStdio = createMcpServer({
    name: "disabled-injected-stdio",
    kind: "stdio",
    command: process.execPath,
    args: [
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(injectedMarker)}, "escaped")`,
    ],
    safety: "exec",
  });
  setMcpServerEnabled(disabledInjectedStdio.id, false);
  const port = await freePort();
  const instanceId = `stdio-production-startup-${process.pid}-${Date.now()}`;
  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      PORT: String(port),
      AITEAM_HOST: "127.0.0.1",
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
  let started = false;
  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && child.exitCode === null) {
      const response = await fetch(
        `http://127.0.0.1:${port}/aiteam/api/__test/instance`,
      ).catch(() => null);
      if (
        response?.ok &&
        (await response.json()).instance_id === instanceId
      ) {
        started = true;
        break;
      }
      await delay(100);
    }
  } finally {
    await stopChild(child);
  }
  check(
    "STDIO-PROD-2",
    "production startup fails closed when an enabled stdio server exists",
    !started &&
      child.exitCode !== null &&
      child.exitCode !== 0 &&
      output.includes("MCP_STDIO_PRODUCTION_DISABLED"),
    `started=${started} exit=${child.exitCode} output=${output.trim().slice(-180)}`,
  );

  setMcpServerEnabled(enabledStdio.id, false);
  const apiPort = await freePort();
  const apiInstanceId = `stdio-production-api-${process.pid}-${Date.now()}`;
  const apiChild = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      PORT: String(apiPort),
      AITEAM_HOST: "127.0.0.1",
      AITEAM_TEST_INSTANCE_ID: apiInstanceId,
      AITEAM_ADMIN_EMAILS: "stdio-admin@example.com",
      AITEAM_ALLOW_SIGNUP: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let apiOutput = "";
  apiChild.stdout.on("data", (chunk) => {
    apiOutput += chunk.toString();
  });
  apiChild.stderr.on("data", (chunk) => {
    apiOutput += chunk.toString();
  });
  let apiReady = false;
  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && apiChild.exitCode === null) {
      const response = await fetch(
        `http://127.0.0.1:${apiPort}/aiteam/api/__test/instance`,
      ).catch(() => null);
      if (
        response?.ok &&
        (await response.json()).instance_id === apiInstanceId
      ) {
        apiReady = true;
        break;
      }
      await delay(100);
    }
    if (!apiReady) {
      throw new Error(
        `production API fixture did not start: ${apiOutput.trim().slice(-500)}`,
      );
    }
    const register = await fetch(
      `http://127.0.0.1:${apiPort}/aiteam/api/auth/register`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "stdio-admin@example.com",
          password: "stdio-guard-password",
          display_name: "Stdio Guard Admin",
        }),
      },
    );
    const cookie = register.headers.get("set-cookie")?.split(";")[0] ?? "";
    const stdioResponse = await fetch(
      `http://127.0.0.1:${apiPort}/aiteam/api/mcp-servers`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify({
          name: "blocked-stdio",
          kind: "stdio",
          command: "node",
          args: ["-e", "process.exit(0)"],
          safety: "exec",
        }),
      },
    );
    const stdioBody = await stdioResponse.json().catch(() => ({}));
    const httpResponse = await fetch(
      `http://127.0.0.1:${apiPort}/aiteam/api/mcp-servers`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify({
          name: "allowed-http",
          kind: "http",
          url: "https://mcp.invalid.example.test/mcp",
          safety: "network",
        }),
      },
    );
    const httpBody = await httpResponse.json().catch(() => ({}));
    const registryResponse = await fetch(
      `http://127.0.0.1:${apiPort}/aiteam/api/registry`,
      { headers: { Cookie: cookie } },
    );
    const registryBody = await registryResponse.json().catch(() => ({}));
    const registryStdio = registryBody.mcp?.filter(
      (preset) => preset.kind === "stdio",
    ) ?? [];
    const registryHttp = registryBody.mcp?.filter(
      (preset) => preset.kind === "http",
    ) ?? [];
    check(
      "STDIO-PROD-3",
      "production admin API rejects stdio configuration but preserves HTTP MCP",
      register.ok &&
        stdioResponse.status === 409 &&
        stdioBody.code === STDIO_PRODUCTION_DISABLED_CODE &&
        httpResponse.ok &&
        httpBody.kind === "http" &&
        registryBody.runtime?.stdio_available === false &&
        registryStdio.length > 0 &&
        registryStdio.every(
          (preset) =>
            preset.runtime_available === false &&
            preset.runtime_blocked_code ===
              STDIO_PRODUCTION_DISABLED_CODE,
        ) &&
        registryHttp.length > 0 &&
        registryHttp.every((preset) => preset.runtime_available === true),
      `register=${register.status} stdio=${stdioResponse.status}/${stdioBody.code} http=${httpResponse.status}/${httpBody.kind} registry=${registryStdio.length}/${registryHttp.length}`,
    );
    const toggleResponse = await fetch(
      `http://127.0.0.1:${apiPort}/aiteam/api/mcp-servers/${disabledInjectedStdio.id}/toggle`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify({ enabled: true }),
      },
    );
    const toggleBody = await toggleResponse.json().catch(() => ({}));
    const testResponse = await fetch(
      `http://127.0.0.1:${apiPort}/aiteam/api/mcp-servers/${disabledInjectedStdio.id}/test`,
      {
        method: "POST",
        headers: { Cookie: cookie },
      },
    );
    const testBody = await testResponse.json().catch(() => ({}));
    const taskTestResponse = await fetch(
      `http://127.0.0.1:${apiPort}/aiteam/api/mcp-servers/${disabledInjectedStdio.id}/task-test`,
      {
        method: "POST",
        headers: { Cookie: cookie },
      },
    );
    const taskTestBody = await taskTestResponse.json().catch(() => ({}));
    check(
      "STDIO-PROD-4",
      "production blocks enable, test, and task-test bypasses for a stored stdio row",
      toggleResponse.status === 409 &&
        toggleBody.code === STDIO_PRODUCTION_DISABLED_CODE &&
        testResponse.status === 409 &&
        testBody.code === STDIO_PRODUCTION_DISABLED_CODE &&
        taskTestResponse.status === 409 &&
        taskTestBody.code === STDIO_PRODUCTION_DISABLED_CODE &&
        !existsSync(injectedMarker),
      `toggle=${toggleResponse.status}/${toggleBody.code} test=${testResponse.status}/${testBody.code} taskTest=${taskTestResponse.status}/${taskTestBody.code} spawned=${existsSync(injectedMarker)}`,
    );
  } finally {
    await stopChild(apiChild);
  }

  process.env.NODE_ENV = "development";
  try {
    await testMcpServer({
      ...server,
      id: "stdio-development-control",
      name: "stdio-development-control",
      args_json: JSON.stringify([
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(developmentMarker)}, "allowed")`,
      ]),
    });
  } catch {
    // The child intentionally does not speak MCP; marker creation proves the
    // legitimate development spawn path remained available.
  } finally {
    process.env.NODE_ENV = "production";
  }
  check(
    "STDIO-DEV-1",
    "development keeps the existing stdio child-process path available",
    existsSync(developmentMarker),
    `spawned=${existsSync(developmentMarker)}`,
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

if (failures > 0) {
  process.exitCode = 1;
}

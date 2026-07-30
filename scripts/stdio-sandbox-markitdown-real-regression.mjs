#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const pinnedImage =
  process.env.AITEAM_MARKITDOWN_TEST_IMAGE?.trim() || "";
if (
  !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(
    pinnedImage,
  )
) {
  console.error(
    "AITEAM_MARKITDOWN_TEST_IMAGE is required and must be a preloaded name@sha256:digest reference",
  );
  process.exit(2);
}

const imageProbe = spawnSync(
  process.env.AITEAM_MCP_STDIO_RUNNER_BIN || "podman",
  ["image", "exists", pinnedImage],
  { stdio: "ignore", env: process.env },
);
if (imageProbe.status !== 0) {
  console.error(`preloaded image not found: ${pinnedImage}`);
  process.exit(2);
}

const fixture = mkdtempSync(
  join(tmpdir(), "aiteam-markitdown-production-"),
);
const dataDir = join(fixture, "data");
const workspaceRoot = join(dataDir, "mcp-workspaces");
const serverEntry = fileURLToPath(
  new URL("../server/dist/index.js", import.meta.url),
);
let failures = 0;

function check(id, name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(
    `${ok ? "✅" : "❌"} [${id}] ${name}${detail ? ` — ${detail}` : ""}`,
  );
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
      probe.close((error) =>
        error ? reject(error) : resolvePort(port),
      );
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  for (let index = 0; index < 40 && child.exitCode === null; index += 1) {
    await delay(50);
  }
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function docxFixture() {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>隔离文档季度报告</w:t></w:r></w:p>
    <w:p><w:r><w:t>营收 1200 万元</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`,
  );
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
}

function filesNamedInput(root) {
  if (!existsSync(root)) return [];
  const found = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) found.push(...filesNamedInput(path));
    else if (name.startsWith("input-")) found.push(path);
  }
  return found;
}

function leafWorkspaceCount(root) {
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const owner of readdirSync(root)) {
    const ownerPath = join(root, owner);
    if (!statSync(ownerPath).isDirectory()) continue;
    count += readdirSync(ownerPath).filter((execution) =>
      statSync(join(ownerPath, execution)).isDirectory(),
    ).length;
  }
  return count;
}

const port = await freePort();
const instanceId = `markitdown-real-${process.pid}-${Date.now()}`;
const child = spawn(process.execPath, [serverEntry], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    AITEAM_HOST: "127.0.0.1",
    AITEAM_DATA_DIR: dataDir,
    AITEAM_MCP_STDIO_WORKSPACE_ROOT: workspaceRoot,
    AITEAM_MCP_STDIO_RUNNER: "podman",
    AITEAM_MCP_STDIO_RUNNER_BIN:
      process.env.AITEAM_MCP_STDIO_RUNNER_BIN || "podman",
    AITEAM_MCP_STDIO_MEMORY: "256m",
    AITEAM_MCP_STDIO_CPUS: "1",
    AITEAM_MCP_STDIO_PIDS: "64",
    AITEAM_MCP_TIMEOUT_MS: "120000",
    AITEAM_CREDENTIAL_KEY: "41".repeat(32),
    AITEAM_SESSION_SECRET:
      "markitdown-real-session-secret-at-least-32-bytes",
    AITEAM_ADMIN_EMAILS: "markitdown-admin@example.com",
    AITEAM_ALLOW_SIGNUP: "1",
    AITEAM_TEST_INSTANCE_ID: instanceId,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
child.stdout.on("data", (chunk) => {
  serverOutput += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  serverOutput += chunk.toString();
});

try {
  let ready = false;
  const deadline = Date.now() + 10_000;
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
  check(
    "MARKITDOWN-REAL-1",
    "the production service starts with the rootless Podman runner",
    ready,
    serverOutput.trim().slice(-500),
  );
  if (!ready) throw new Error("production service did not become ready");

  const register = await fetch(
    `http://127.0.0.1:${port}/aiteam/api/auth/register`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "markitdown-admin@example.com",
        password: "markitdown-production-password",
        display_name: "MarkItDown Admin",
      }),
    },
  );
  const cookie = register.headers.get("set-cookie")?.split(";")[0] ?? "";
  check(
    "MARKITDOWN-REAL-2",
    "an authenticated admin session is available for the production path",
    register.ok && cookie.length > 0,
    `status=${register.status}`,
  );

  const createResponse = await fetch(
    `http://127.0.0.1:${port}/aiteam/api/mcp-servers`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({
        name: "markitdown",
        kind: "stdio",
        command: "markitdown-mcp",
        args: [],
        safety: "local",
        container_image: pinnedImage,
      }),
    },
  );
  const created = await createResponse.json().catch(() => ({}));
  check(
    "MARKITDOWN-REAL-3",
    "production admits the local MCP only with the preloaded digest image",
    createResponse.ok &&
      created.container_image === pinnedImage &&
      created.runtime_available === true,
    `status=${createResponse.status} body=${JSON.stringify(created).slice(0, 500)}`,
  );

  const connectionResponse = await fetch(
    `http://127.0.0.1:${port}/aiteam/api/mcp-servers/${created.id}/test`,
    {
      method: "POST",
      headers: { Cookie: cookie },
    },
  );
  const connection = await connectionResponse.json().catch(() => ({}));
  check(
    "MARKITDOWN-REAL-4",
    "the real Microsoft MCP handshake lists its conversion tool",
    connectionResponse.ok && connection.tools === 1,
    `status=${connectionResponse.status} body=${JSON.stringify(connection).slice(0, 500)}`,
  );

  const taskResponse = await fetch(
    `http://127.0.0.1:${port}/aiteam/api/mcp-servers/${created.id}/task-test`,
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: "{}",
    },
  );
  const task = await taskResponse.json().catch(() => ({}));
  const eventTypes = new Set(
    (task.events ?? []).map((event) => event.type),
  );
  check(
    "MARKITDOWN-REAL-5",
    "the MCP task rehearsal creates a source document and review evidence",
    taskResponse.ok &&
      task.ok === true &&
      task.task?.status === "review" &&
      task.docs?.some(
        (document) =>
          document.kind === "source" &&
          document.content.includes("AiTeam MCP 演练"),
      ) &&
      ["tool", "delivery", "verification"].every((type) =>
        eventTypes.has(type),
      ),
    `status=${taskResponse.status} task=${task.task?.status} events=${[...eventTypes].join(",")}`,
  );

  const form = new FormData();
  form.append(
    "file",
    new Blob([await docxFixture()], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
    "quarterly-report.docx",
  );
  const uploadResponse = await fetch(
    `http://127.0.0.1:${port}/aiteam/api/uploads`,
    {
      method: "POST",
      headers: { Cookie: cookie },
      body: form,
    },
  );
  const uploaded = await uploadResponse.json().catch(() => ({}));
  await delay(100);
  const stagedInputs = filesNamedInput(workspaceRoot);
  check(
    "MARKITDOWN-REAL-6",
    "a real DOCX crosses upload, Mission-scoped staging, MCP conversion and source persistence",
    uploadResponse.ok &&
      uploaded.kind === "source" &&
      uploaded.title === "quarterly-report.docx" &&
      uploaded.content?.includes("隔离文档季度报告") &&
      uploaded.content?.includes("营收 1200 万元") &&
      leafWorkspaceCount(workspaceRoot) >= 3 &&
      stagedInputs.length === 0,
    `status=${uploadResponse.status} title=${uploaded.title} workspaces=${leafWorkspaceCount(workspaceRoot)} staged=${stagedInputs.length} content=${String(uploaded.content ?? uploaded.error ?? "").slice(0, 300)}`,
  );
} finally {
  await stopChild(child);
  rmSync(fixture, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(
    `\n${failures} real MarkItDown production regression check(s) failed`,
  );
  process.exit(1);
}

console.log("\nAll real MarkItDown production regression checks passed.");

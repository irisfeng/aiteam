import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function ok(name, condition, detail = "") {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`✓ ${name}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => resolve(addr.port));
    });
  });
}

async function waitFor(fn, timeoutMs = 15000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (lastError) throw lastError;
  return null;
}

function cookieFrom(res) {
  const raw = res.headers.get("set-cookie") || "";
  const match = raw.match(/aiteam_session=[^;]+/);
  return match?.[0] || "";
}

async function json(base, cookie, path, init = {}) {
  const res = await fetch(`${base}/aiteam/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

function openSocket(base, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, "ws") + "/aiteam/ws", { headers: { Cookie: cookie } });
    const events = [];
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("WebSocket open timeout"));
    }, 5000);
    ws.on("open", () => {
      clearTimeout(timer);
      ws.on("message", (data) => {
        try { events.push(JSON.parse(String(data))); } catch {}
      });
      resolve({ ws, events });
    });
    ws.on("error", reject);
  });
}

let child;
let dataDir;

try {
  const port = await freePort();
  dataDir = await mkdtemp(join(tmpdir(), "aiteam-client-smoke-"));
  child = spawn(process.execPath, [join(root, "server/dist/index.js")], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      AITEAM_DATA_DIR: dataDir,
      AITEAM_SESSION_SECRET: "client-smoke-session-secret-32-bytes-minimum",
      AITEAM_CREDENTIAL_KEY: "81".repeat(32),
      AITEAM_AUTH_MODE: "standalone",
      AITEAM_ALLOW_SIGNUP: "1",
      AITEAM_ADMIN_EMAILS: "client-smoke@test.local",
    },
    stdio: "ignore",
  });

  const base = `http://127.0.0.1:${port}`;
  const ready = await waitFor(async () => {
    const res = await fetch(`${base}/aiteam/api/auth/me`).catch(() => null);
    return res && (res.status === 401 || res.ok);
  });
  ok("production server responds", Boolean(ready));

  const htmlRes = await fetch(`${base}/aiteam/`);
  const html = await htmlRes.text();
  ok("production client shell is served", htmlRes.ok && html.includes('id="root"') && html.includes("/aiteam/assets/"));

  const register = await fetch(`${base}/aiteam/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "client-smoke@test.local", password: "client-smoke-pw", display_name: "Client Smoke" }),
  });
  const cookie = cookieFrom(register);
  ok("standalone auth issues session cookie", register.ok && cookie.length > 0);

  const boot = await json(base, cookie, "/bootstrap");
  ok("bootstrap returns workspace data", Array.isArray(boot.agents) && Array.isArray(boot.channels) && Array.isArray(boot.tasks));

  const { ws, events } = await openSocket(base, cookie);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const scenario = await json(base, cookie, "/scenarios/helio-core/start", {
    method: "POST",
    body: JSON.stringify({ acceptance: true }),
  });
  ok("Helio-style scenario starts through API", scenario.project?.id && scenario.tasks?.length >= 3);

  const live = await waitFor(() => {
    const types = new Set(events.map((event) => event.type));
    return types.has("project:upsert") && types.has("task:upsert") && types.has("task:event");
  }, 8000);
  ok("WebSocket receives live project/task/activity updates", Boolean(live), events.map((event) => event.type).join(","));
  ws.close();
} finally {
  if (child && !child.killed) child.kill("SIGTERM");
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}

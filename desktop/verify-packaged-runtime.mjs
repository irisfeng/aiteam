import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(fileURLToPath(import.meta.url));

// 打包产物的 resources 目录随平台/架构变化；可用 AITEAM_PACKED_RESOURCES 显式指定，否则按常见产物路径探测。
function resolveAppResources() {
  if (process.env.AITEAM_PACKED_RESOURCES) return process.env.AITEAM_PACKED_RESOURCES;
  const release = join(desktopDir, "release");
  const candidates = [
    join(release, "mac-arm64", "AiTeam.app", "Contents", "Resources"),
    join(release, "mac", "AiTeam.app", "Contents", "Resources"),
    join(release, "mac-universal", "AiTeam.app", "Contents", "Resources"),
    join(release, "win-unpacked", "resources"),
    join(release, "linux-unpacked", "resources"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

const appResources = resolveAppResources();

if (!existsSync(appResources)) {
  console.error(`Missing packaged Resources: ${appResources}`);
  console.error("提示：可设置 AITEAM_PACKED_RESOURCES=<path> 指向打包产物的 resources 目录。");
  process.exit(1);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

function hit(url) {
  return new Promise((resolveHit, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      if (res.statusCode && res.statusCode < 500) resolveHit();
      else reject(new Error(`HTTP ${res.statusCode}`));
    });
    req.on("error", reject);
    req.setTimeout(1200, () => req.destroy(new Error("timeout")));
  });
}

async function waitFor(url, child, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) throw new Error("server exited before ready");
    try {
      await hit(url);
      return;
    } catch {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 300));
    }
  }
  throw new Error(`server did not become ready: ${url}`);
}

const isolatedRoot = mkdtempSync(join(tmpdir(), "aiteam-packaged-resources-"));
const resources = join(isolatedRoot, "Resources");
cpSync(appResources, resources, { recursive: true });

const serverEntry = join(resources, "server", "dist", "index.js");
const nodeModules = join(resources, "server", "node_modules");
const nodeBinary = process.platform === "win32"
  ? join(resources, "node", "node.exe")
  : join(resources, "node", "bin", "node");
const webIndex = join(resources, "web", "dist", "index.html");
for (const required of [serverEntry, nodeModules, nodeBinary, webIndex]) {
  if (!existsSync(required)) {
    console.error(`Missing packaged runtime file: ${required}`);
    process.exit(1);
  }
}

const dataDir = join(isolatedRoot, "data");
const port = await freePort();
const child = spawn(nodeBinary, [serverEntry], {
  cwd: resources,
  env: {
    ...process.env,
    AITEAM_DATA_DIR: dataDir,
    AITEAM_HOST: "127.0.0.1",
    AITEAM_SESSION_SECRET: "packaged-runtime-smoke-secret",
    PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (buf) => {
  output += buf.toString();
});
child.stderr.on("data", (buf) => {
  output += buf.toString();
});

try {
  await waitFor(`http://127.0.0.1:${port}/aiteam/`, child);
  console.log(`OK packaged runtime smoke outside repo: ${resolve(resources)}`);
} catch (error) {
  console.error(`Packaged runtime smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  if (output.trim()) console.error(output.trim());
  process.exitCode = 1;
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  rmSync(isolatedRoot, { recursive: true, force: true });
}

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = join(root, "server", "dist", "index.js");
const checks = [
  ["server build", serverEntry],
  ["web build", join(root, "web", "dist", "index.html")],
  ["electron main", join(root, "desktop", "main.cjs")],
  ["electron preload", join(root, "desktop", "preload.cjs")],
  ["electron builder config", join(root, "desktop", "electron-builder.yml")],
  ["desktop runtime preparer", join(root, "desktop", "prepare-runtime.mjs")],
  ["desktop packaged runtime verifier", join(root, "desktop", "verify-packaged-runtime.mjs")],
];

let ok = true;
for (const [label, file] of checks) {
  const present = existsSync(file);
  console.log(`${present ? "OK" : "MISSING"} ${label}: ${file}`);
  ok &&= present;
}

const main = readFileSync(join(root, "desktop", "main.cjs"), "utf8");
const preload = readFileSync(join(root, "desktop", "preload.cjs"), "utf8");
const viteEnv = readFileSync(join(root, "web", "src", "vite-env.d.ts"), "utf8");
const builder = readFileSync(join(root, "desktop", "electron-builder.yml"), "utf8");
const prepareRuntime = readFileSync(join(root, "desktop", "prepare-runtime.mjs"), "utf8");
const verifyPackagedRuntime = readFileSync(join(root, "desktop", "verify-packaged-runtime.mjs"), "utf8");
for (const needle of ["task=", "approval=", "view=inbox", "aiteam://"]) {
  const present = main.includes(needle);
  console.log(`${present ? "OK" : "MISSING"} desktop deep link support: ${needle}`);
  ok &&= present;
}

for (const needle of ["target.startsWith(\"aiteam://\")", "notification.on(\"click\"", "handleDeepLink(target)"]) {
  const present = main.includes(needle);
  console.log(`${present ? "OK" : "MISSING"} desktop notification routing: ${needle}`);
  ok &&= present;
}

for (const [label, source, needle] of [
  ["desktop node runtime resolver", main, "function resolveServerNode()"],
  ["desktop node runtime avoids forced electron node", main, "delete env.ELECTRON_RUN_AS_NODE"],
  ["desktop packaged resource root", main, "app.isPackaged ? process.resourcesPath"],
  ["desktop packaged server runtime", builder, "from: .runtime/server"],
  ["desktop packaged server dependencies", builder, "to: server/node_modules"],
  ["desktop packaged node sidecar", builder, "to: node"],
  ["desktop packaged web runtime", builder, "from: .runtime/web"],
  ["desktop runtime copies node sidecar", prepareRuntime, "copyFileSync(nodeBinary, runtimeNodeBin)"],
  ["desktop runtime installs production deps", prepareRuntime, "npm\", [\"install\", \"--omit=dev\""],
  ["desktop runtime verifies sqlite native module", prepareRuntime, "require('better-sqlite3')"],
  ["desktop package verifier isolates resources", verifyPackagedRuntime, "aiteam-packaged-resources-"],
  ["desktop package verifier uses sidecar node", verifyPackagedRuntime, "spawn(nodeBinary, [serverEntry]"],
  ["desktop package verifier requires server node_modules", verifyPackagedRuntime, "server\", \"node_modules"],
  ["desktop native file picker main", main, "ipcMain.handle(\"pick-file\""],
  ["desktop native file picker dialog", main, "dialog.showOpenDialog"],
  ["desktop native file picker preload", preload, "pickFile(mode)"],
  ["desktop native file picker web type", viteEnv, "pickFile(mode: \"source\" | \"template\")"],
]) {
  const present = source.includes(needle);
  console.log(`${present ? "OK" : "MISSING"} ${label}: ${needle}`);
  ok &&= present;
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
    req.setTimeout(1200, () => {
      req.destroy(new Error("timeout"));
    });
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

async function runtimeSmoke() {
  const dataDir = mkdtempSync(join(tmpdir(), "aiteam-desktop-smoke-"));
  const port = await freePort();
  const nodeBinary = process.env.AITEAM_NODE_BINARY || process.env.npm_node_execpath || process.execPath;
  const child = spawn(nodeBinary, [serverEntry], {
    cwd: root,
    env: {
      ...process.env,
      AITEAM_DATA_DIR: dataDir,
      AITEAM_HOST: "127.0.0.1",
      AITEAM_SESSION_SECRET: "desktop-smoke-secret",
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
    console.log(`OK desktop server runtime smoke: ${nodeBinary}`);
  } catch (error) {
    console.error(`MISSING desktop server runtime smoke: ${error instanceof Error ? error.message : String(error)}`);
    if (output.trim()) console.error(output.trim());
    ok = false;
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}

await runtimeSmoke();

if (!ok) process.exit(1);

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(desktopDir, "..");
const runtime = join(desktopDir, ".runtime");
const runtimeServer = join(runtime, "server");
const runtimeWeb = join(runtime, "web");
const runtimeNodeBin = process.platform === "win32"
  ? join(runtime, "node", "node.exe")
  : join(runtime, "node", "bin", "node");
const serverPkg = JSON.parse(readFileSync(join(root, "server", "package.json"), "utf8"));
const nodeBinary = process.env.AITEAM_NODE_BINARY || process.execPath;

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

rmSync(runtime, { recursive: true, force: true });
mkdirSync(runtimeServer, { recursive: true });
mkdirSync(runtimeWeb, { recursive: true });
mkdirSync(dirname(runtimeNodeBin), { recursive: true });

cpSync(join(root, "server", "dist"), join(runtimeServer, "dist"), { recursive: true });
cpSync(join(root, "web", "dist"), join(runtimeWeb, "dist"), { recursive: true });
copyFileSync(nodeBinary, runtimeNodeBin);
if (process.platform !== "win32") chmodSync(runtimeNodeBin, 0o755);
writeFileSync(join(runtimeServer, "package.json"), `${JSON.stringify({
  name: "aiteam-server-runtime",
  private: true,
  type: "module",
  dependencies: serverPkg.dependencies,
}, null, 2)}\n`);

run("npm", ["install", "--omit=dev", "--package-lock=false", "--no-audit", "--no-fund"], runtimeServer);
run("node", ["-e", "require('better-sqlite3'); console.log('runtime better-sqlite3 ok')"], runtimeServer);
run(runtimeNodeBin, ["--version"], runtime);

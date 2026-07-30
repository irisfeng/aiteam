import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

export interface StdioSandboxScope {
  ownerId: string;
  executionId: string;
}

export interface StdioSandboxServer {
  id: string;
  container_image: string;
  command: string;
  args_json: string;
}

export interface StdioSandboxLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  workspace: string;
}

const PINNED_IMAGE =
  /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-fA-F0-9]{64}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_CONTAINER_ENV_KEYS = new Set(["HOME", "PATH", "TMPDIR"]);
const MEMORY_LIMIT = /^[1-9][0-9]*[kKmMgGtT]?$/;
const PROBE_TTL_MS = 30_000;

let runnerProbe:
  | { key: string; checkedAt: number; error: Error | null }
  | undefined;
const imageProbes = new Map<
  string,
  { checkedAt: number; error: Error | null }
>();

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function productionDataDir(): string {
  const value = process.env.AITEAM_DATA_DIR?.trim();
  if (!value || !isAbsolute(value)) {
    throw new Error(
      "MCP_STDIO_SANDBOX_CONFIG_INVALID: AITEAM_DATA_DIR must be an absolute path",
    );
  }
  return resolve(value);
}

function workspaceRoot(): string {
  const dataDir = productionDataDir();
  const configured =
    process.env.AITEAM_MCP_STDIO_WORKSPACE_ROOT?.trim() ||
    join(dataDir, "mcp-workspaces");
  if (!isAbsolute(configured)) {
    throw new Error(
      "MCP_STDIO_SANDBOX_CONFIG_INVALID: AITEAM_MCP_STDIO_WORKSPACE_ROOT must be absolute",
    );
  }
  const root = resolve(configured);
  if (root === dataDir || !root.startsWith(`${dataDir}${sep}`)) {
    throw new Error(
      "MCP_STDIO_SANDBOX_CONFIG_INVALID: stdio workspace root must be a dedicated child of AITEAM_DATA_DIR",
    );
  }
  return root;
}

function runnerBinary(): string {
  const configured =
    process.env.AITEAM_MCP_STDIO_RUNNER_BIN?.trim() || "podman";
  if (basename(configured) !== "podman") {
    throw new Error(
      "MCP_STDIO_SANDBOX_CONFIG_INVALID: runner binary basename must be podman",
    );
  }
  return configured;
}

function boundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `MCP_STDIO_SANDBOX_CONFIG_INVALID: ${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

function boundedCpuLimit(): string {
  const raw = process.env.AITEAM_MCP_STDIO_CPUS?.trim() || "1";
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0.1 || value > 8) {
    throw new Error(
      "MCP_STDIO_SANDBOX_CONFIG_INVALID: AITEAM_MCP_STDIO_CPUS must be from 0.1 to 8",
    );
  }
  return String(value);
}

function memoryLimit(): string {
  const value = process.env.AITEAM_MCP_STDIO_MEMORY?.trim() || "256m";
  if (!MEMORY_LIMIT.test(value)) {
    throw new Error(
      "MCP_STDIO_SANDBOX_CONFIG_INVALID: AITEAM_MCP_STDIO_MEMORY must be a Podman byte value such as 256m",
    );
  }
  return value.toLowerCase();
}

export function isPinnedContainerImage(value: string): boolean {
  return PINNED_IMAGE.test(value.trim());
}

export function stdioSandboxRuntimeConfigured(): boolean {
  return (
    process.env.AITEAM_MCP_STDIO_RUNNER?.trim().toLowerCase() === "podman"
  );
}

export function resetStdioSandboxRunnerProbeForTests(): void {
  runnerProbe = undefined;
  imageProbes.clear();
}

/**
 * Production accepts only a locally invoked, rootless Podman CLI. The service
 * never talks to a Podman/Docker API socket because that API is equivalent to
 * arbitrary execution as the socket owner.
 */
export function assertStdioSandboxRunnerReady(): void {
  if (!stdioSandboxRuntimeConfigured()) {
    throw new Error(
      "MCP_STDIO_PRODUCTION_DISABLED: AITEAM_MCP_STDIO_RUNNER=podman is required",
    );
  }
  productionDataDir();
  workspaceRoot();
  memoryLimit();
  boundedCpuLimit();
  boundedInteger("AITEAM_MCP_STDIO_PIDS", 64, 8, 1024);

  const command = runnerBinary();
  const key = [
    command,
    process.env.PATH ?? "",
    process.env.HOME ?? "",
    process.env.XDG_RUNTIME_DIR ?? "",
  ].join("\0");
  if (
    runnerProbe &&
    runnerProbe.key === key &&
    Date.now() - runnerProbe.checkedAt < PROBE_TTL_MS
  ) {
    if (runnerProbe.error) throw runnerProbe.error;
    return;
  }

  const result = spawnSync(
    command,
    ["info", "--format", "{{.Host.Security.Rootless}}"],
    {
      encoding: "utf8",
      timeout: 5_000,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let error: Error | null = null;
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || "").trim();
    error = new Error(
      `MCP_STDIO_RUNNER_UNAVAILABLE: rootless Podman preflight failed${detail ? `: ${detail.slice(0, 240)}` : ""}`,
    );
  } else if (String(result.stdout).trim() !== "true") {
    error = new Error(
      "MCP_STDIO_RUNNER_UNAVAILABLE: Podman must run rootless for production stdio",
    );
  } else {
    const cgroups = spawnSync(
      command,
      ["info", "--format", "{{.Host.CgroupsVersion}}"],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (
      cgroups.error ||
      cgroups.status !== 0 ||
      String(cgroups.stdout).trim() !== "v2"
    ) {
      error = new Error(
        "MCP_STDIO_RUNNER_UNAVAILABLE: rootless Podman requires cgroup v2 so CPU, memory and PID limits are enforceable",
      );
    }
  }
  runnerProbe = { key, checkedAt: Date.now(), error };
  if (error) throw error;
}

export function assertStdioSandboxImageReady(image: string): void {
  assertStdioSandboxRunnerReady();
  if (!isPinnedContainerImage(image)) {
    throw new Error(
      "MCP_STDIO_IMAGE_REQUIRED: production stdio requires an OCI image pinned by sha256 digest",
    );
  }
  const key = `${runnerBinary()}\0${image}`;
  const cached = imageProbes.get(key);
  if (cached && Date.now() - cached.checkedAt < PROBE_TTL_MS) {
    if (cached.error) throw cached.error;
    return;
  }
  const result = spawnSync(runnerBinary(), ["image", "exists", image], {
    encoding: "utf8",
    timeout: 5_000,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const error =
    result.error || result.status !== 0
      ? new Error(
          `MCP_STDIO_IMAGE_UNAVAILABLE: pinned image is not preloaded in rootless Podman: ${image}`,
        )
      : null;
  imageProbes.set(key, { checkedAt: Date.now(), error });
  if (error) throw error;
}

export function stdioSandboxWorkspace(scope: StdioSandboxScope): string {
  if (!scope.ownerId.trim() || !scope.executionId.trim()) {
    throw new Error(
      "MCP_STDIO_CONTEXT_REQUIRED: owner and Mission/task execution scope are required",
    );
  }
  const root = workspaceRoot();
  const workspace = join(
    root,
    hash(scope.ownerId).slice(0, 20),
    hash(scope.executionId).slice(0, 20),
  );
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  chmodSync(workspace, 0o700);
  return workspace;
}

export function buildStdioSandboxLaunch(
  server: StdioSandboxServer,
  scope: StdioSandboxScope,
  childEnvironment: Record<string, string>,
  requestedContainerEnvKeys = Object.keys(childEnvironment),
): StdioSandboxLaunch {
  assertStdioSandboxImageReady(server.container_image);

  let serverArgs: string[];
  try {
    const parsed = JSON.parse(server.args_json || "[]");
    if (
      !Array.isArray(parsed) ||
      parsed.some((value) => typeof value !== "string")
    ) {
      throw new Error("not a string array");
    }
    serverArgs = parsed;
  } catch {
    throw new Error(
      "MCP_STDIO_CONFIG_INVALID: stdio args_json must be an array of strings",
    );
  }
  const envKeys = [...new Set(requestedContainerEnvKeys)]
    .filter((key) => !RESERVED_CONTAINER_ENV_KEYS.has(key))
    .sort();
  for (const key of envKeys) {
    if (!ENV_KEY.test(key)) {
      throw new Error(
        `MCP_STDIO_CONFIG_INVALID: invalid environment variable name ${key}`,
      );
    }
    if (!(key in childEnvironment)) {
      throw new Error(
        `MCP_STDIO_CONFIG_INVALID: container environment key ${key} has no runner value`,
      );
    }
  }

  const workspace = stdioSandboxWorkspace(scope);
  const containerName = [
    "aiteam-mcp",
    hash(scope.ownerId).slice(0, 8),
    hash(scope.executionId).slice(0, 8),
    hash(server.id).slice(0, 8),
    randomBytes(4).toString("hex"),
  ].join("-");
  const pids = boundedInteger("AITEAM_MCP_STDIO_PIDS", 64, 8, 1024);
  const args = [
    "run",
    "--rm",
    "--interactive",
    `--name=${containerName}`,
    "--pull=never",
    "--network=none",
    "--read-only",
    "--read-only-tmpfs=false",
    "--cap-drop=all",
    "--security-opt=no-new-privileges",
    "--ipc=private",
    "--pid=private",
    "--userns=keep-id",
    `--pids-limit=${pids}`,
    `--memory=${memoryLimit()}`,
    `--cpus=${boundedCpuLimit()}`,
    "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=67108864",
    `--volume=${workspace}:/workspace:rw,Z,nosuid,nodev,noexec`,
    "--workdir=/workspace",
    "--env",
    "HOME=/tmp",
    "--env",
    "TMPDIR=/tmp",
  ];
  for (const key of envKeys) args.push("--env", key);
  args.push(server.container_image, server.command, ...serverArgs);

  return {
    command: runnerBinary(),
    args,
    env: { ...childEnvironment },
    workspace,
  };
}

/**
 * Stages a file in the only host directory mounted into a production stdio
 * container. The callback receives both the container-visible and host paths;
 * the file is removed even when conversion fails.
 */
export async function withStdioSandboxFile<T>(
  scope: StdioSandboxScope,
  buffer: Buffer,
  extension: string,
  callback: (containerPath: string, hostPath: string) => Promise<T>,
): Promise<T> {
  const safeExtension = /^\.[a-zA-Z0-9]{1,8}$/.test(extension)
    ? extension
    : "";
  const workspace = stdioSandboxWorkspace(scope);
  const filename = `input-${randomBytes(12).toString("hex")}${safeExtension}`;
  const hostPath = join(workspace, filename);
  writeFileSync(hostPath, buffer, { mode: 0o600 });
  try {
    return await callback(`/workspace/${filename}`, hostPath);
  } finally {
    try {
      rmSync(hostPath, { force: true });
    } catch {
      // The caller receives the original conversion result/error; cleanup is best effort.
    }
  }
}

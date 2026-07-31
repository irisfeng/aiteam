#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  isAbsolute,
  relative,
  resolve,
} from "node:path";

async function main() {
const args = parseArgs(process.argv.slice(2));
const profile = requiredArg(args, "profile");
if (!["http-only", "local-stdio"].includes(profile)) {
  failWithoutEvidence(`unsupported profile: ${profile}`);
}

const serviceName = requiredArg(args, "service");
const releaseDir = resolve(requiredArg(args, "release-dir"));
const expectedCommit = requiredArg(args, "expected-commit");
const envFile = resolve(requiredArg(args, "env-file"));
const port = Number(requiredArg(args, "port"));
const healthUrl = requiredArg(args, "health-url");
const outputPath = args.output ? resolve(args.output) : null;
const requestedImage =
  profile === "local-stdio" ? requiredArg(args, "image") : null;

if (!/^[a-f0-9]{40}$/.test(expectedCommit)) {
  failWithoutEvidence("--expected-commit must be a full 40-character Git SHA");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  failWithoutEvidence("--port must be an integer between 1 and 65535");
}
const parsedHealthUrl = new URL(healthUrl);
if (
  parsedHealthUrl.protocol !== "http:" ||
  !["127.0.0.1", "::1", "[::1]", "localhost"].includes(
    parsedHealthUrl.hostname,
  ) ||
  Number(parsedHealthUrl.port || 80) !== port
) {
  failWithoutEvidence("--health-url must be loopback HTTP on --port");
}

const checks = [];
function check(id, condition, detail) {
  checks.push({
    id,
    status: condition ? "pass" : "fail",
    detail,
  });
}

const actualCommit = run("git", ["rev-parse", "HEAD"], releaseDir).trim();
const changedPaths = run("git", ["status", "--porcelain"], releaseDir)
  .split("\n")
  .filter(Boolean);
check(
  "release.commit",
  actualCommit === expectedCommit,
  actualCommit === expectedCommit ? "exact commit" : "commit mismatch",
);
check(
  "release.clean",
  changedPaths.length === 0,
  changedPaths.length === 0
    ? "worktree clean"
    : `${changedPaths.length} changed paths`,
);

const currentUid = Number(run("id", ["-u"]).trim());
const currentUser = run("id", ["-un"]).trim();
check(
  "host.non_root",
  Number.isInteger(currentUid) && currentUid > 0,
  currentUid > 0 ? `uid ${currentUid}` : "must not run as root",
);

const service = parseProperties(
  run("systemctl", [
    "show",
    serviceName,
    "--no-pager",
    "--property=LoadState,ActiveState,SubState,User,Group,NoNewPrivileges,ProtectSystem,ProtectHome,PrivateTmp,MemoryMax,TasksMax,EnvironmentFiles,ReadWritePaths",
  ]),
);
check(
  "service.loaded",
  service.LoadState === "loaded",
  `LoadState=${service.LoadState || "missing"}`,
);
check(
  "service.active",
  service.ActiveState === "active" && service.SubState === "running",
  `ActiveState=${service.ActiveState || "missing"} SubState=${service.SubState || "missing"}`,
);
check(
  "service.identity",
  Boolean(service.User) &&
    service.User === currentUser &&
    service.Group === currentUser,
  `service=${service.User || "missing"}:${service.Group || "missing"} current=${currentUser}`,
);
check(
  "service.no_new_privileges",
  service.NoNewPrivileges === "yes",
  `NoNewPrivileges=${service.NoNewPrivileges || "missing"}`,
);
check(
  "service.protect_system",
  service.ProtectSystem === "strict",
  `ProtectSystem=${service.ProtectSystem || "missing"}`,
);
check(
  "service.protect_home",
  ["yes", "read-only", "tmpfs"].includes(service.ProtectHome),
  `ProtectHome=${service.ProtectHome || "missing"}`,
);
check(
  "service.private_tmp",
  service.PrivateTmp === "yes",
  `PrivateTmp=${service.PrivateTmp || "missing"}`,
);
check(
  "service.memory_limit",
  finitePositive(service.MemoryMax),
  `MemoryMax=${service.MemoryMax || "missing"}`,
);
check(
  "service.task_limit",
  finitePositive(service.TasksMax),
  `TasksMax=${service.TasksMax || "missing"}`,
);
const environmentFileMatches = systemdPathListContains(
  service.EnvironmentFiles,
  envFile,
);
check(
  "service.environment_file",
  environmentFileMatches,
  environmentFileMatches
    ? "expected environment file"
    : "unexpected environment file",
);

const envMode = statSync(envFile).mode & 0o777;
const configuration = parseEnvironmentFile(envFile);
const runnerValue = configuration.AITEAM_MCP_STDIO_RUNNER?.trim() || "";
const configuredDataDir = configuration.AITEAM_DATA_DIR || "";
check(
  "configuration.file_mode",
  envMode === 0o600,
  `mode=${envMode.toString(8).padStart(3, "0")}`,
);
check(
  "configuration.production",
  configuration.NODE_ENV === "production",
  `NODE_ENV=${safeValue(configuration.NODE_ENV)}`,
);
check(
  "configuration.loopback",
  configuration.AITEAM_HOST === "127.0.0.1" &&
    Number(configuration.PORT) === port,
  `AITEAM_HOST=${safeValue(configuration.AITEAM_HOST)} PORT=${safeValue(configuration.PORT)}`,
);
check(
  "configuration.data_dir",
  isAbsolute(configuredDataDir),
  isAbsolute(configuredDataDir)
    ? "absolute data directory"
    : "AITEAM_DATA_DIR must be absolute",
);
check(
  "service.write_path",
  isAbsolute(configuredDataDir) &&
    String(service.ReadWritePaths || "").includes(configuredDataDir),
  isAbsolute(configuredDataDir) &&
    String(service.ReadWritePaths || "").includes(configuredDataDir)
    ? "data directory writable by unit"
    : "ReadWritePaths does not include data directory",
);
check(
  "configuration.auth_mode",
  configuration.AITEAM_AUTH_MODE === "coworker",
  `AITEAM_AUTH_MODE=${safeValue(configuration.AITEAM_AUTH_MODE)}`,
);
const secretPresence = {
  AUTH_SECRET: secretIsConfigured(configuration.AUTH_SECRET),
  AITEAM_SERVICE_JWT_SECRET: serviceJwtIsConfigured(configuration),
  AITEAM_CREDENTIAL_KEY: secretIsConfigured(
    configuration.AITEAM_CREDENTIAL_KEY,
  ),
};
check(
  "configuration.secret_presence",
  Object.values(secretPresence).every(Boolean),
  Object.entries(secretPresence)
    .map(([key, present]) => `${key}=${present ? "present" : "missing"}`)
    .join(" "),
);
let runnerEvidence = {
  configured: runnerValue !== "",
  profile: "disabled",
};
let imageEvidence = null;
if (profile === "http-only") {
  check(
    "runner.http_only",
    runnerValue === "",
    runnerValue === ""
      ? "stdio runner disabled"
      : "stdio runner must be disabled",
  );
} else {
  const runnerBin = configuration.AITEAM_MCP_STDIO_RUNNER_BIN || "podman";
  const workspaceRoot = configuration.AITEAM_MCP_STDIO_WORKSPACE_ROOT || "";
  let workspaceWithinDataDir = false;
  if (isAbsolute(configuredDataDir) && isAbsolute(workspaceRoot)) {
    try {
      const dataReal = realpathSync(configuredDataDir);
      const workspaceReal = realpathSync(workspaceRoot);
      const relativeWorkspace = relative(dataReal, workspaceReal);
      workspaceWithinDataDir =
        relativeWorkspace.length > 0 &&
        !relativeWorkspace.startsWith("..") &&
        !isAbsolute(relativeWorkspace);
    } catch {
      workspaceWithinDataDir = false;
    }
  }
  check(
    "runner.configuration",
    runnerValue === "podman" && basename(runnerBin) === "podman",
    runnerValue === "podman" && basename(runnerBin) === "podman"
      ? "podman runner selected"
      : "runner must be podman",
  );
  check(
    "runner.workspace",
    workspaceWithinDataDir,
    workspaceWithinDataDir
      ? "workspace is strictly below data directory"
      : "workspace must exist strictly below data directory",
  );
  const resourceLimitsValid =
    /^\d+(?:[kmgt]i?b?)?$/i.test(
      configuration.AITEAM_MCP_STDIO_MEMORY || "",
    ) &&
    Number(configuration.AITEAM_MCP_STDIO_CPUS) > 0 &&
    Number.isInteger(Number(configuration.AITEAM_MCP_STDIO_PIDS)) &&
    Number(configuration.AITEAM_MCP_STDIO_PIDS) > 0;
  check(
    "runner.resources",
    resourceLimitsValid,
    resourceLimitsValid
      ? "memory, CPU, and PID limits configured"
      : "invalid or missing memory, CPU, or PID limit",
  );

  const podmanInfo = JSON.parse(
    run(runnerBin, ["info", "--format", "json"]),
  );
  const podmanHost = podmanInfo.host || podmanInfo.Host || {};
  const podmanSecurity =
    podmanHost.security || podmanHost.Security || {};
  const rootless =
    podmanSecurity.rootless === true || podmanSecurity.Rootless === true;
  const cgroupsVersion = String(
    podmanHost.cgroupsVersion ||
      podmanHost.cgroupVersion ||
      podmanHost.CgroupsVersion ||
      "",
  ).toLowerCase();
  check(
    "runner.rootless",
    rootless,
    rootless ? "rootless=true" : "rootless=false",
  );
  check(
    "runner.cgroup_v2",
    cgroupsVersion === "v2",
    `cgroups=${cgroupsVersion || "missing"}`,
  );

  if (!/^.+@sha256:[a-f0-9]{64}$/.test(requestedImage)) {
    failWithoutEvidence("--image must be an immutable digest reference");
  }
  run(runnerBin, ["image", "exists", requestedImage]);
  const imageInspect = JSON.parse(
    run(runnerBin, ["image", "inspect", requestedImage]),
  )[0];
  const imageDigest = String(imageInspect.Digest || imageInspect.digest || "");
  const imageArchitecture = String(
    imageInspect.Architecture || imageInspect.architecture || "",
  );
  const imageOs = String(imageInspect.Os || imageInspect.os || "");
  const imageUser = String(
    imageInspect.Config?.User || imageInspect.config?.user || "",
  );
  const imageLabels =
    imageInspect.Config?.Labels || imageInspect.config?.labels || {};
  const requestedDigest = requestedImage.slice(
    requestedImage.lastIndexOf("@") + 1,
  );
  const hostArchitecture = normalizeArchitecture(run("uname", ["-m"]).trim());
  check(
    "image.digest",
    imageDigest === requestedDigest,
    imageDigest === requestedDigest
      ? "digest matches requested reference"
      : "image digest mismatch",
  );
  check(
    "image.platform",
    imageOs === "linux" && imageArchitecture === hostArchitecture,
    `${imageOs || "missing"}/${imageArchitecture || "missing"} expected linux/${hostArchitecture}`,
  );
  check(
    "image.non_root",
    imageUser === "65532:65532",
    `User=${imageUser || "missing"}`,
  );
  check(
    "image.source",
    imageLabels["org.opencontainers.image.source"] ===
      "https://github.com/microsoft/markitdown",
    imageLabels["org.opencontainers.image.source"]
      ? "source label recorded"
      : "source label missing",
  );
  runnerEvidence = {
    configured: runnerValue === "podman",
    profile: "local-stdio",
    binary_basename: basename(runnerBin),
    rootless,
    cgroups_version: cgroupsVersion,
    workspace_root: workspaceRoot,
    workspace_within_data_dir: workspaceWithinDataDir,
    resource_limits: {
      memory: configuration.AITEAM_MCP_STDIO_MEMORY || "",
      cpus: configuration.AITEAM_MCP_STDIO_CPUS || "",
      pids: configuration.AITEAM_MCP_STDIO_PIDS || "",
    },
  };
  imageEvidence = {
    digest_reference: requestedImage,
    digest: imageDigest,
    architecture: imageArchitecture,
    os: imageOs,
    size_bytes: Number(imageInspect.Size || imageInspect.size || 0),
    user: imageUser,
    source:
      imageLabels["org.opencontainers.image.source"] || "",
  };
}

const listeners = run("ss", ["-H", "-ltn"])
  .split("\n")
  .filter((line) => line.includes(`:${port}`));
const loopbackOnly =
  listeners.length > 0 &&
  listeners.every((line) =>
    new RegExp(`(?:127(?:\\.\\d+){3}|\\[::1\\]|::1):${port}(?:\\s|$)`).test(
      line,
    ),
  );
check(
  "endpoint.loopback_only",
  loopbackOnly,
  loopbackOnly
    ? `${listeners.length} loopback listener(s)`
    : "missing or non-loopback listener",
);

let healthStatus = null;
try {
  const response = await fetch(healthUrl, {
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  healthStatus = response.status;
  await response.body?.cancel();
} catch {
  healthStatus = null;
}
check(
  "endpoint.health",
  healthStatus === 200 || healthStatus === 401,
  healthStatus === null ? "health request failed" : `HTTP ${healthStatus}`,
);

const evidence = {
  schema_version: 1,
  captured_at: new Date().toISOString(),
  status: checks.every((entry) => entry.status === "pass") ? "pass" : "fail",
  profile,
  release: {
    expected_commit: expectedCommit,
    actual_commit: actualCommit,
    clean: changedPaths.length === 0,
    changed_path_count: changedPaths.length,
  },
  host: {
    os: run("uname", ["-s"]).trim(),
    kernel: run("uname", ["-r"]).trim(),
    architecture: run("uname", ["-m"]).trim(),
    uid: currentUid,
    user: currentUser,
  },
  service: {
    name: serviceName,
    load_state: service.LoadState || "",
    active_state: service.ActiveState || "",
    sub_state: service.SubState || "",
    user: service.User || "",
    group: service.Group || "",
    no_new_privileges: service.NoNewPrivileges || "",
    protect_system: service.ProtectSystem || "",
    protect_home: service.ProtectHome || "",
    private_tmp: service.PrivateTmp || "",
    memory_max: service.MemoryMax || "",
    tasks_max: service.TasksMax || "",
    read_write_paths: service.ReadWritePaths || "",
    environment_file_matches: environmentFileMatches,
  },
  configuration: {
    env_file: envFile,
    mode: envMode.toString(8).padStart(3, "0"),
    node_env: safeValue(configuration.NODE_ENV),
    host: safeValue(configuration.AITEAM_HOST),
    port: safeValue(configuration.PORT),
    data_dir: safeValue(configuration.AITEAM_DATA_DIR),
    auth_mode: safeValue(configuration.AITEAM_AUTH_MODE),
    secret_presence: secretPresence,
  },
  endpoint: {
    port,
    loopback_only: loopbackOnly,
    listener_count: listeners.length,
    health_url: healthUrl,
    health_status: healthStatus,
  },
  runner: runnerEvidence,
  image: imageEvidence,
  checks,
};

const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
if (outputPath) {
  writeEvidenceFile(outputPath, serialized);
}
process.stdout.write(serialized);
process.exitCode = evidence.status === "pass" ? 0 : 1;
}

await main().catch(handleFatal);

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      failWithoutEvidence(`invalid argument near ${key || "<end>"}`);
    }
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

function requiredArg(parsed, key) {
  const value = parsed[key]?.trim();
  if (!value) failWithoutEvidence(`--${key} is required`);
  return value;
}

function run(command, commandArgs, cwd = process.cwd()) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status ?? result.error?.code ?? "spawn"})`,
    );
  }
  return String(result.stdout);
}

function parseProperties(value) {
  return Object.fromEntries(
    value
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return separator === -1
          ? [line, ""]
          : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function parseEnvironmentFile(path) {
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) continue;
    const key = normalized.slice(0, separator).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    values[key] = unquote(normalized.slice(separator + 1).trim());
  }
  return values;
}

function systemdPathListContains(value, expectedPath) {
  const escaped = expectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)-?${escaped}(?=\\s|$)`).test(
    String(value || ""),
  );
}

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function secretIsConfigured(value) {
  return (
    typeof value === "string" &&
    value.length >= 32 &&
    !/FILL_ME|CHANGEME|PLACEHOLDER/i.test(value)
  );
}

function serviceJwtIsConfigured(configuration) {
  if (secretIsConfigured(configuration.AITEAM_SERVICE_JWT_SECRET)) return true;
  const serialized = configuration.AITEAM_SERVICE_JWT_KEYS;
  if (typeof serialized !== "string" || serialized.length === 0) return false;
  try {
    const keyring = JSON.parse(serialized);
    return (
      keyring !== null &&
      typeof keyring === "object" &&
      !Array.isArray(keyring) &&
      Object.keys(keyring).length > 0 &&
      Object.entries(keyring).every(
        ([keyId, secret]) =>
          /^[A-Za-z0-9._-]{1,64}$/.test(keyId) &&
          secretIsConfigured(secret),
      )
    );
  } catch {
    return false;
  }
}

function safeValue(value) {
  return typeof value === "string" ? value : "";
}

function finitePositive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function normalizeArchitecture(value) {
  if (value === "x86_64") return "amd64";
  if (value === "aarch64") return "arm64";
  return value;
}

function writeEvidenceFile(path, serialized) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error("evidence output must not be a symbolic link");
  }
  writeFileSync(path, serialized, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function handleFatal() {
  const rawArgs = looseArgs(process.argv.slice(2));
  const profile = ["http-only", "local-stdio"].includes(rawArgs.profile)
    ? rawArgs.profile
    : "unknown";
  const evidence = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    status: "fail",
    profile,
    error: {
      code: "QUALIFICATION_COLLECTION_FAILED",
      message: "A required read-only host check could not be completed.",
    },
    checks: [
      {
        id: "qualification.collection",
        status: "fail",
        detail: "required host evidence unavailable",
      },
    ],
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (rawArgs.output) {
    try {
      writeEvidenceFile(resolve(rawArgs.output), serialized);
    } catch {
      process.stderr.write(
        "Host qualification failed and the redacted evidence file could not be written.\n",
      );
      process.exitCode = 1;
      return;
    }
  }
  process.stdout.write(serialized);
  process.exitCode = 1;
}

function looseArgs(values) {
  const parsed = {};
  for (let index = 0; index + 1 < values.length; index += 2) {
    const key = values[index];
    if (key?.startsWith("--")) parsed[key.slice(2)] = values[index + 1];
  }
  return parsed;
}

function failWithoutEvidence(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

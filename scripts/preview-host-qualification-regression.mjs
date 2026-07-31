#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const fixture = mkdtempSync(join(tmpdir(), "aiteam-preview-qualification-"));
const bin = join(fixture, "bin");
const decoyBin = join(fixture, "decoy-bin");
const release = join(fixture, "release");
const dataDir = join(fixture, "data");
const envFile = join(fixture, "aiteam.env");
const output = join(fixture, "evidence.json");
const localEnvFile = join(fixture, "aiteam-local-stdio.env");
const localOutput = join(fixture, "local-stdio-evidence.json");
const invalidKeyringEnvFile = join(fixture, "aiteam-invalid-keyring.env");
const invalidKeyringOutput = join(fixture, "invalid-keyring-evidence.json");
const envDecoyOutput = join(fixture, "env-decoy-evidence.json");
const collectionFailureOutput = join(
  fixture,
  "collection-failure-evidence.json",
);
const workspaceRoot = join(dataDir, "mcp-workspaces");
const expectedCommit = "a".repeat(40);
const imageDigest = "b".repeat(64);
const imageReference = `localhost/aiteam/markitdown-mcp@sha256:${imageDigest}`;
const sessionSecret = "session-secret-must-not-leak-123456789";
const serviceSecret = "service-secret-must-not-leak-123456789";
const invalidKeyring = "not-json-but-long-enough-to-look-like-a-secret";

mkdirSync(bin);
mkdirSync(decoyBin);
mkdirSync(release);
mkdirSync(dataDir);
mkdirSync(workspaceRoot);

function fakeCommand(name, body) {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
}

fakeCommand(
  "git",
  `
if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then
  echo "${expectedCommit}"
  exit 0
fi
if [ "$1" = "status" ] && [ "$2" = "--porcelain" ]; then
  exit 0
fi
exit 64
`,
);
fakeCommand(
  "id",
  `
if [ "$1" = "-u" ]; then echo "1001"; exit 0; fi
if [ "$1" = "-un" ]; then echo "aiteam"; exit 0; fi
exit 64
`,
);
fakeCommand(
  "uname",
  `
if [ "$1" = "-s" ]; then echo "Linux"; exit 0; fi
if [ "$1" = "-r" ]; then echo "6.8.0-preview"; exit 0; fi
if [ "$1" = "-m" ]; then echo "x86_64"; exit 0; fi
exit 64
`,
);
fakeCommand(
  "systemctl",
  `
cat <<EOF
LoadState=loaded
ActiveState=active
SubState=running
User=aiteam
Group=aiteam
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
MemoryMax=1073741824
TasksMax=256
EnvironmentFiles=$FAKE_ENV_FILE (ignore_errors=no)
ReadWritePaths=${dataDir}
EOF
`,
);
fakeCommand(
  "ss",
  `
echo "LISTEN 0 511 127.0.0.1:\${FAKE_PORT} 0.0.0.0:*"
`,
);
fakeCommand(
  "podman",
  `
if [ "\${FAKE_PODMAN_FAIL:-}" = "1" ]; then
  exit 70
fi
if [ "$1" = "info" ]; then
  echo '{"host":{"security":{"rootless":true},"cgroupsVersion":"v2"}}'
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "exists" ]; then
  [ "$3" = "${imageReference}" ]
  exit $?
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  cat <<'EOF'
[{"Digest":"sha256:${imageDigest}","Architecture":"amd64","Os":"linux","Size":518135722,"Config":{"User":"65532:65532","Labels":{"org.opencontainers.image.source":"https://github.com/microsoft/markitdown"}}}]
EOF
  exit 0
fi
exit 64
`,
);

writeFileSync(
  envFile,
  [
    "NODE_ENV=production",
    "AITEAM_HOST=127.0.0.1",
    "PORT=8787",
    `AITEAM_DATA_DIR=${dataDir}`,
    "AITEAM_AUTH_MODE=coworker",
    `AUTH_SECRET=${sessionSecret}`,
    `AITEAM_SERVICE_JWT_SECRET=${serviceSecret}`,
    "AITEAM_CREDENTIAL_KEY=1".padEnd(86, "1"),
    "",
  ].join("\n"),
  "utf8",
);
chmodSync(envFile, 0o600);
writeFileSync(
  join(decoyBin, "podman"),
  "#!/bin/sh\nexit 71\n",
  "utf8",
);
chmodSync(join(decoyBin, "podman"), 0o755);
writeFileSync(
  localEnvFile,
  [
    readFileSync(envFile, "utf8").trimEnd(),
    "AITEAM_MCP_STDIO_RUNNER=podman",
    `AITEAM_MCP_STDIO_RUNNER_BIN=${join(bin, "podman")}`,
    `AITEAM_MCP_STDIO_WORKSPACE_ROOT=${workspaceRoot}`,
    "AITEAM_MCP_STDIO_MEMORY=256m",
    "AITEAM_MCP_STDIO_CPUS=1",
    "AITEAM_MCP_STDIO_PIDS=64",
    "",
  ].join("\n"),
  "utf8",
);
chmodSync(localEnvFile, 0o600);
writeFileSync(
  invalidKeyringEnvFile,
  readFileSync(envFile, "utf8")
    .replace(`AITEAM_SERVICE_JWT_SECRET=${serviceSecret}`, "")
    .replace(
      "AITEAM_CREDENTIAL_KEY=",
      `AITEAM_SERVICE_JWT_KEYS=${invalidKeyring}\nAITEAM_CREDENTIAL_KEY=`,
    ),
  "utf8",
);
chmodSync(invalidKeyringEnvFile, 0o600);
writeFileSync(output, "{}\n", "utf8");
chmodSync(output, 0o644);

const healthServer = createServer((_request, response) => {
  response.writeHead(401, { "content-type": "application/json" });
  response.end('{"error":"unauthorized"}');
});
await new Promise((resolvePromise) =>
  healthServer.listen(0, "127.0.0.1", resolvePromise),
);
const healthPort = healthServer.address().port;
process.env.FAKE_PORT = String(healthPort);
for (const path of [envFile, localEnvFile, invalidKeyringEnvFile]) {
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("PORT=8787", `PORT=${healthPort}`),
    "utf8",
  );
  chmodSync(path, 0o600);
}

try {
  const result = await runCli(
    process.execPath,
    [
      "scripts/preview-host-qualification.mjs",
      "--profile",
      "http-only",
      "--service",
      "aiteam-preview.service",
      "--release-dir",
      release,
      "--expected-commit",
      expectedCommit,
      "--env-file",
      envFile,
      "--port",
      String(healthPort),
      "--health-url",
      `http://127.0.0.1:${healthPort}/aiteam/api/auth/me`,
      "--output",
      output,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${decoyBin}:${bin}:${process.env.PATH}`,
        FAKE_ENV_FILE: envFile,
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `qualification failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }

  const evidenceText = readFileSync(output, "utf8");
  const evidence = JSON.parse(evidenceText);
  const failures = evidence.checks.filter((check) => check.status !== "pass");
  if (
    evidence.status !== "pass" ||
    evidence.profile !== "http-only" ||
    evidence.release.actual_commit !== expectedCommit ||
    evidence.release.clean !== true ||
    evidence.service.active_state !== "active" ||
    evidence.service.no_new_privileges !== "yes" ||
    evidence.endpoint.loopback_only !== true ||
    evidence.endpoint.health_status !== 401 ||
    evidence.runner.configured !== false ||
    failures.length !== 0 ||
    (statSync(output).mode & 0o777) !== 0o600 ||
    evidenceText.includes(sessionSecret) ||
    evidenceText.includes(serviceSecret)
  ) {
    throw new Error(`unexpected qualification evidence: ${evidenceText}`);
  }

  console.log(
    "✅ [PREVIEW-HOST-HTTP] fixed release + hardened systemd + loopback health + stdio disabled + secrets redacted",
  );

  const wrongHealthPortResult = await runCli(
    process.execPath,
    [
      "scripts/preview-host-qualification.mjs",
      "--profile",
      "http-only",
      "--service",
      "aiteam-preview.service",
      "--release-dir",
      release,
      "--expected-commit",
      expectedCommit,
      "--env-file",
      envFile,
      "--port",
      String(healthPort === 65535 ? healthPort - 1 : healthPort + 1),
      "--health-url",
      `http://127.0.0.1:${healthPort}/aiteam/api/auth/me`,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${decoyBin}:${bin}:${process.env.PATH}`,
        FAKE_ENV_FILE: envFile,
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  if (
    wrongHealthPortResult.status !== 2 ||
    !wrongHealthPortResult.stderr.includes(
      "--health-url must be loopback HTTP on --port",
    )
  ) {
    throw new Error(
      `mismatched health port did not fail closed: ${wrongHealthPortResult.stderr || wrongHealthPortResult.stdout}`,
    );
  }
  console.log(
    "✅ [PREVIEW-HOST-PORT] health evidence is bound to the qualified listener port",
  );

  const envDecoyResult = await runCli(
    process.execPath,
    [
      "scripts/preview-host-qualification.mjs",
      "--profile",
      "http-only",
      "--service",
      "aiteam-preview.service",
      "--release-dir",
      release,
      "--expected-commit",
      expectedCommit,
      "--env-file",
      envFile,
      "--port",
      String(healthPort),
      "--health-url",
      `http://127.0.0.1:${healthPort}/aiteam/api/auth/me`,
      "--output",
      envDecoyOutput,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${decoyBin}:${bin}:${process.env.PATH}`,
        FAKE_ENV_FILE: `${envFile}.backup`,
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  const envDecoyEvidence = JSON.parse(readFileSync(envDecoyOutput, "utf8"));
  const envFileCheck = envDecoyEvidence.checks.find(
    (check) => check.id === "service.environment_file",
  );
  if (
    envDecoyResult.status !== 1 ||
    envDecoyEvidence.status !== "fail" ||
    envFileCheck?.status !== "fail"
  ) {
    throw new Error(
      `environment file decoy did not fail closed: ${envDecoyResult.stdout || envDecoyResult.stderr}`,
    );
  }
  console.log(
    "✅ [PREVIEW-HOST-ENV] systemd EnvironmentFiles requires an exact configured path",
  );

  const localResult = await runCli(
    process.execPath,
    [
      "scripts/preview-host-qualification.mjs",
      "--profile",
      "local-stdio",
      "--service",
      "aiteam-preview.service",
      "--release-dir",
      release,
      "--expected-commit",
      expectedCommit,
      "--env-file",
      localEnvFile,
      "--port",
      String(healthPort),
      "--health-url",
      `http://127.0.0.1:${healthPort}/aiteam/api/auth/me`,
      "--image",
      imageReference,
      "--output",
      localOutput,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${decoyBin}:${bin}:${process.env.PATH}`,
        FAKE_ENV_FILE: localEnvFile,
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  if (localResult.status !== 0) {
    throw new Error(
      `local stdio qualification failed (${localResult.status}): ${localResult.stderr || localResult.stdout}`,
    );
  }
  const localEvidenceText = readFileSync(localOutput, "utf8");
  const localEvidence = JSON.parse(localEvidenceText);
  const localFailures = localEvidence.checks.filter(
    (check) => check.status !== "pass",
  );
  if (
    localEvidence.status !== "pass" ||
    localEvidence.profile !== "local-stdio" ||
    localEvidence.runner.configured !== true ||
    localEvidence.runner.rootless !== true ||
    localEvidence.runner.cgroups_version !== "v2" ||
    localEvidence.runner.workspace_within_data_dir !== true ||
    localEvidence.image.digest_reference !== imageReference ||
    localEvidence.image.architecture !== "amd64" ||
    localEvidence.image.user !== "65532:65532" ||
    localFailures.length !== 0 ||
    localEvidenceText.includes(sessionSecret) ||
    localEvidenceText.includes(serviceSecret)
  ) {
    throw new Error(
      `unexpected local stdio qualification evidence: ${localEvidenceText}`,
    );
  }
  console.log(
    "✅ [PREVIEW-HOST-STDIO] rootless+cgroup v2 + preloaded digest image + non-root target + bounded workspace",
  );

  const invalidKeyringResult = await runCli(
    process.execPath,
    [
      "scripts/preview-host-qualification.mjs",
      "--profile",
      "http-only",
      "--service",
      "aiteam-preview.service",
      "--release-dir",
      release,
      "--expected-commit",
      expectedCommit,
      "--env-file",
      invalidKeyringEnvFile,
      "--port",
      String(healthPort),
      "--health-url",
      `http://127.0.0.1:${healthPort}/aiteam/api/auth/me`,
      "--output",
      invalidKeyringOutput,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${decoyBin}:${bin}:${process.env.PATH}`,
        FAKE_ENV_FILE: invalidKeyringEnvFile,
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  const invalidKeyringEvidenceText = readFileSync(
    invalidKeyringOutput,
    "utf8",
  );
  const invalidKeyringEvidence = JSON.parse(invalidKeyringEvidenceText);
  const secretCheck = invalidKeyringEvidence.checks.find(
    (check) => check.id === "configuration.secret_presence",
  );
  if (
    invalidKeyringResult.status !== 1 ||
    invalidKeyringEvidence.status !== "fail" ||
    secretCheck?.status !== "fail" ||
    invalidKeyringEvidenceText.includes(invalidKeyring) ||
    invalidKeyringResult.stdout.includes(invalidKeyring) ||
    invalidKeyringResult.stderr.includes(invalidKeyring)
  ) {
    throw new Error(
      `malformed keyring did not fail closed: ${invalidKeyringResult.stdout || invalidKeyringResult.stderr}`,
    );
  }
  console.log(
    "✅ [PREVIEW-HOST-KEYRING] malformed rotation keyring fails closed with redacted evidence",
  );

  const collectionFailureResult = await runCli(
    process.execPath,
    [
      "scripts/preview-host-qualification.mjs",
      "--profile",
      "local-stdio",
      "--service",
      "aiteam-preview.service",
      "--release-dir",
      release,
      "--expected-commit",
      expectedCommit,
      "--env-file",
      localEnvFile,
      "--port",
      String(healthPort),
      "--health-url",
      `http://127.0.0.1:${healthPort}/aiteam/api/auth/me`,
      "--image",
      imageReference,
      "--output",
      collectionFailureOutput,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${decoyBin}:${bin}:${process.env.PATH}`,
        FAKE_ENV_FILE: localEnvFile,
        FAKE_PODMAN_FAIL: "1",
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  const collectionFailureText = readFileSync(
    collectionFailureOutput,
    "utf8",
  );
  const collectionFailureEvidence = JSON.parse(collectionFailureText);
  if (
    collectionFailureResult.status !== 1 ||
    collectionFailureEvidence.status !== "fail" ||
    collectionFailureEvidence.error?.code !==
      "QUALIFICATION_COLLECTION_FAILED" ||
    collectionFailureEvidence.checks?.[0]?.id !==
      "qualification.collection" ||
    (statSync(collectionFailureOutput).mode & 0o777) !== 0o600 ||
    collectionFailureText.includes(sessionSecret) ||
    collectionFailureText.includes(serviceSecret) ||
    collectionFailureResult.stderr.includes("at file:")
  ) {
    throw new Error(
      `collection failure did not produce stable redacted evidence: ${collectionFailureResult.stderr || collectionFailureResult.stdout}`,
    );
  }
  console.log(
    "✅ [PREVIEW-HOST-COLLECT] boundary command failure emits stable redacted 0600 evidence",
  );
} finally {
  await new Promise((resolvePromise) => healthServer.close(resolvePromise));
  rmSync(fixture, { recursive: true, force: true });
}

function runCli(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`qualification timed out after ${options.timeout}ms`));
    }, options.timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr });
    });
  });
}

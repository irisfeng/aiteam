#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const root = process.cwd();
const defaultTag =
  "localhost/aiteam/markitdown-mcp:0.0.1a4-markitdown0.1.6";
const requestedImage =
  process.env.AITEAM_MARKITDOWN_IMAGE?.trim() || defaultTag;
const outputPath = resolve(
  process.env.AITEAM_MARKITDOWN_EVIDENCE_PATH?.trim() ||
    join(root, "output", "markitdown-mcp-image-evidence.json"),
);
const sbomPath = resolve(
  process.env.AITEAM_MARKITDOWN_SBOM_PATH?.trim() ||
    join(root, "output", "markitdown-mcp-image-sbom.cdx.json"),
);
const lockPath = join(
  root,
  "containers",
  "markitdown-mcp",
  "requirements.lock",
);
const recipePaths = [
  join(root, "containers", "markitdown-mcp", "Containerfile"),
  join(root, "containers", "markitdown-mcp", "requirements.in"),
  lockPath,
];

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error || "")
      .trim()
      .slice(-2000);
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? "spawn"}): ${detail}`,
    );
  }
  return String(result.stdout);
}

function normalizedPackageName(value) {
  return value.toLowerCase().replace(/[_.-]+/g, "-");
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function repositoryOf(image) {
  if (image.includes("@")) return image.slice(0, image.indexOf("@"));
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  return colon > slash ? image.slice(0, colon) : image;
}

const inspect = JSON.parse(
  run("podman", ["image", "inspect", requestedImage]),
)[0];
const digest = String(inspect.Digest || "");
if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
  throw new Error(`image has no immutable manifest digest: ${requestedImage}`);
}
const digestReference = `${repositoryOf(requestedImage)}@${digest}`;
run("podman", ["image", "exists", digestReference]);

const runtimeProbe = JSON.parse(
  run("podman", [
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=all",
    "--security-opt=no-new-privileges",
    "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=67108864",
    digestReference,
    "python",
    "-c",
    [
      "import importlib.metadata as metadata",
      "import json",
      "import os",
      "packages = sorted(",
      "  ({'name': d.metadata.get('Name', ''), 'version': d.version} for d in metadata.distributions()),",
      "  key=lambda item: item['name'].lower(),",
      ")",
      "print(json.dumps({'uid': os.getuid(), 'packages': packages}))",
    ].join("\n"),
  ]),
);
run("podman", [
  "run",
  "--rm",
  "--pull=never",
  "--network=none",
  "--read-only",
  "--cap-drop=all",
  "--security-opt=no-new-privileges",
  "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=67108864",
  digestReference,
  "python",
  "-m",
  "pip",
  "check",
]);

const expectedPackages = readFileSync(lockPath, "utf8")
  .split("\n")
  .map((line) => line.trim().match(/^([a-zA-Z0-9_.-]+)==([^\s\\]+)/))
  .filter(Boolean)
  .map((match) => ({
    name: match[1],
    normalized: normalizedPackageName(match[1]),
    version: match[2],
  }));
const installedPackages = runtimeProbe.packages.map((entry) => ({
  name: String(entry.name),
  normalized: normalizedPackageName(String(entry.name)),
  version: String(entry.version),
}));
const installedByName = new Map(
  installedPackages.map((entry) => [entry.normalized, entry]),
);
const expectedNames = new Set(
  expectedPackages.map((entry) => entry.normalized),
);
const allowedBasePackages = new Set(["pip", "setuptools", "wheel"]);
const missing = expectedPackages.filter(
  (entry) => !installedByName.has(entry.normalized),
);
const wrongVersion = expectedPackages.filter((entry) => {
  const actual = installedByName.get(entry.normalized);
  return actual && actual.version !== entry.version;
});
const unexpected = installedPackages.filter(
  (entry) =>
    !expectedNames.has(entry.normalized) &&
    !allowedBasePackages.has(entry.normalized),
);
const labels = inspect.Config?.Labels ?? {};
const checks = {
  digest_reference_resolves: true,
  architecture_recorded: Boolean(inspect.Architecture),
  configured_non_root: inspect.Config?.User === "65532:65532",
  runtime_non_root: Number(runtimeProbe.uid) === 65532,
  source_label:
    labels["org.opencontainers.image.source"] ===
    "https://github.com/microsoft/markitdown",
  markitdown_mcp_version:
    labels["com.aiteam.markitdown-mcp.version"] === "0.0.1a4",
  markitdown_version:
    labels["com.aiteam.markitdown.version"] === "0.1.6",
  locked_packages_present:
    missing.length === 0 &&
    wrongVersion.length === 0 &&
    unexpected.length === 0,
  pip_check: true,
};

const createdAt = new Date().toISOString();
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: createdAt,
    tools: {
      components: [
        {
          type: "application",
          name: "aiteam-markitdown-image-evidence",
          version: "1",
        },
      ],
    },
    component: {
      type: "container",
      name: repositoryOf(requestedImage),
      version: digest,
      properties: [
        { name: "oci:architecture", value: String(inspect.Architecture) },
        { name: "oci:imageId", value: String(inspect.Id) },
      ],
    },
  },
  components: expectedPackages.map((entry) => ({
    type: "library",
    name: entry.name,
    version: entry.version,
    purl: `pkg:pypi/${encodeURIComponent(entry.name)}@${encodeURIComponent(entry.version)}`,
  })),
};
mkdirSync(dirname(sbomPath), { recursive: true });
writeFileSync(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");

const evidence = {
  schema_version: 1,
  generated_at: createdAt,
  requested_image: requestedImage,
  digest_reference: digestReference,
  image: {
    id: String(inspect.Id),
    digest,
    architecture: String(inspect.Architecture),
    os: String(inspect.Os),
    size_bytes: Number(inspect.Size),
    user: String(inspect.Config?.User ?? ""),
    entrypoint: inspect.Config?.Entrypoint ?? null,
    cmd: inspect.Config?.Cmd ?? null,
    labels,
  },
  recipe: Object.fromEntries(
    recipePaths.map((path) => [
      basename(path),
      { path, sha256: sha256(path) },
    ]),
  ),
  packages: {
    expected: expectedPackages.length,
    installed: installedPackages.length,
    missing,
    wrong_version: wrongVersion.map((entry) => ({
      expected: entry,
      actual: installedByName.get(entry.normalized),
    })),
    unexpected,
  },
  checks,
  sbom: {
    format: "CycloneDX",
    spec_version: "1.6",
    path: sbomPath,
    sha256: sha256(sbomPath),
  },
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

if (Object.values(checks).some((value) => value !== true)) {
  console.error(JSON.stringify(evidence, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: "pass",
      digest_reference: digestReference,
      architecture: evidence.image.architecture,
      size_bytes: evidence.image.size_bytes,
      locked_packages: expectedPackages.length,
      evidence_path: outputPath,
      sbom_path: sbomPath,
    },
    null,
    2,
  ),
);

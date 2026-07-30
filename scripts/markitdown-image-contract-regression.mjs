#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const imageDir = join(root, "containers", "markitdown-mcp");
const containerfilePath = join(imageDir, "Containerfile");
const requirementsInputPath = join(imageDir, "requirements.in");
const requirementsLockPath = join(imageDir, "requirements.lock");
const buildScriptPath = join(
  root,
  "scripts",
  "build-markitdown-mcp-image.mjs",
);
const evidenceScriptPath = join(
  root,
  "scripts",
  "markitdown-image-evidence.mjs",
);
const packageJsonPath = join(root, "package.json");

let failures = 0;
function check(id, name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(
    `${ok ? "✅" : "❌"} [${id}] ${name}${detail ? ` — ${detail}` : ""}`,
  );
}

const requiredFiles = [
  containerfilePath,
  requirementsInputPath,
  requirementsLockPath,
];
check(
  "MARKITDOWN-IMAGE-1",
  "the production image recipe and dependency inputs are versioned",
  requiredFiles.every(existsSync),
  requiredFiles.filter((path) => !existsSync(path)).join(", "),
);

if (requiredFiles.every(existsSync)) {
  const containerfile = readFileSync(containerfilePath, "utf8");
  const requirementsInput = readFileSync(requirementsInputPath, "utf8");
  const requirementsLock = readFileSync(requirementsLockPath, "utf8");
  const requirementLines = requirementsLock
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[a-zA-Z0-9_.-]+==/.test(line));

  check(
    "MARKITDOWN-IMAGE-2",
    "the base image is immutable and the runtime has no mutable tag fallback",
    /^FROM docker\.io\/library\/python@sha256:[a-f0-9]{64}$/m.test(
      containerfile,
    ),
  );
  check(
    "MARKITDOWN-IMAGE-3",
    "the Microsoft MCP and converter releases are explicitly selected",
    /^markitdown-mcp==0\.0\.1a4$/m.test(requirementsInput) &&
      /^markitdown==0\.1\.6$/m.test(requirementsInput),
  );
  check(
    "MARKITDOWN-IMAGE-4",
    "every resolved Python dependency is exact and hash-verified",
    requirementLines.length >= 20 &&
      !requirementsLock.includes(" @ ") &&
      !requirementsLock.includes(">=") &&
      !requirementsLock.includes("~=") &&
      requirementLines.every((line) => line.includes("==")) &&
      (requirementsLock.match(/--hash=sha256:/g)?.length ?? 0) >=
        requirementLines.length &&
      containerfile.includes("--require-hashes") &&
      containerfile.includes("--no-deps"),
    `locked=${requirementLines.length} hashes=${requirementsLock.match(/--hash=sha256:/g)?.length ?? 0}`,
  );
  check(
    "MARKITDOWN-IMAGE-5",
    "the runtime is non-root and leaves process selection to the sandbox runner",
    /^USER 65532:65532$/m.test(containerfile) &&
      !/^ENTRYPOINT\b/m.test(containerfile) &&
      !/^CMD\b/m.test(containerfile),
  );
  check(
    "MARKITDOWN-IMAGE-6",
    "the image declares source and exact component versions for audit",
    containerfile.includes(
      'org.opencontainers.image.source="https://github.com/microsoft/markitdown"',
    ) &&
      containerfile.includes('com.aiteam.markitdown-mcp.version="0.0.1a4"') &&
      containerfile.includes('com.aiteam.markitdown.version="0.1.6"'),
  );
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
check(
  "MARKITDOWN-IMAGE-7",
  "operators have versioned lock, build and evidence commands",
  existsSync(buildScriptPath) &&
    existsSync(evidenceScriptPath) &&
    typeof packageJson.scripts?.["mcp:image:markitdown:lock"] === "string" &&
    typeof packageJson.scripts?.["mcp:image:markitdown:build"] === "string" &&
    typeof packageJson.scripts?.["mcp:image:markitdown:evidence"] === "string",
);

if (failures > 0) {
  console.error(`\n${failures} MarkItDown image contract check(s) failed`);
  process.exit(1);
}

console.log("\nAll MarkItDown image contract checks passed.");

#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const root = process.cwd();
const imageTag =
  process.env.AITEAM_MARKITDOWN_IMAGE?.trim() ||
  "localhost/aiteam/markitdown-mcp:0.0.1a4-markitdown0.1.6";

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    console.error(
      `${command} ${args.join(" ")} failed (${result.status ?? "spawn"})`,
    );
    process.exit(result.status ?? 1);
  }
}

run(process.execPath, ["scripts/markitdown-image-contract-regression.mjs"]);
run("podman", [
  "build",
  "--pull=never",
  "--tag",
  imageTag,
  "--file",
  "containers/markitdown-mcp/Containerfile",
  "containers/markitdown-mcp",
]);
run(
  process.execPath,
  ["scripts/markitdown-image-evidence.mjs"],
  { AITEAM_MARKITDOWN_IMAGE: imageTag },
);

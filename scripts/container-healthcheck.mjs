#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const url =
  process.env.AITEAM_HEALTH_URL ||
  "http://127.0.0.1:8787/aiteam/api/readyz";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseFile = join(root, "RELEASE_SHA");
const expectedRelease = existsSync(releaseFile)
  ? readFileSync(releaseFile, "utf8").trim()
  : process.env.AITEAM_RELEASE_SHA?.trim();

try {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(2500),
  });
  const body = await response.json();
  if (!response.ok || body?.status !== "ready") {
    throw new Error(`ready probe returned HTTP ${response.status}`);
  }
  if (
    expectedRelease &&
    expectedRelease !== "unknown" &&
    body?.release_sha !== expectedRelease
  ) {
    throw new Error("ready probe release SHA does not match the image");
  }
} catch (error) {
  console.error(
    `[aiteam-healthcheck] ${error instanceof Error ? error.message : "probe failed"}`,
  );
  process.exit(1);
}

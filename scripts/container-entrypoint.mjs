#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function bakedReleaseSha() {
  const releaseFile = join(root, "RELEASE_SHA");
  return existsSync(releaseFile)
    ? readFileSync(releaseFile, "utf8").trim()
    : process.env.AITEAM_RELEASE_SHA?.trim();
}

function byteLength(name) {
  return Buffer.byteLength(process.env[name]?.trim() || "");
}

function requireSecret(name, minimumBytes = 32) {
  if (byteLength(name) < minimumBytes) {
    throw new Error(`${name} must contain at least ${minimumBytes} bytes`);
  }
}

function validateRuntime() {
  if (process.env.NODE_ENV !== "production") return;

  const releaseSha = bakedReleaseSha();
  if (!releaseSha || releaseSha === "unknown") {
    throw new Error("AITEAM_RELEASE_SHA must identify the immutable release");
  }
  const expectedRelease = process.env.AITEAM_EXPECTED_RELEASE_SHA?.trim();
  if (expectedRelease && expectedRelease !== releaseSha) {
    throw new Error("the image release SHA does not match the expected release");
  }
  process.env.AITEAM_RELEASE_SHA = releaseSha;

  const authMode = process.env.AITEAM_AUTH_MODE?.trim() || "standalone";
  if (!["standalone", "coworker"].includes(authMode)) {
    throw new Error("AITEAM_AUTH_MODE must be standalone or coworker");
  }

  requireSecret("AITEAM_SESSION_SECRET");

  const dataDir = process.env.AITEAM_DATA_DIR || "/data";
  if (
    byteLength("AITEAM_CREDENTIAL_KEY") === 0 &&
    !existsSync(join(dataDir, "credential.key"))
  ) {
    throw new Error(
      "AITEAM_CREDENTIAL_KEY or an existing data-dir credential.key is required",
    );
  }

  if (authMode === "coworker") {
    requireSecret("AUTH_SECRET");
    requireSecret("AITEAM_SERVICE_JWT_SECRET");
    const coworkerUrl = process.env.COWORKER_INTERNAL_URL?.trim();
    if (!coworkerUrl) {
      throw new Error("COWORKER_INTERNAL_URL is required in coworker mode");
    }
    const parsed = new URL(coworkerUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("COWORKER_INTERNAL_URL must use http or https");
    }
  }
}

try {
  validateRuntime();
  console.log("[aiteam] runtime preflight passed");
  await import("../server/dist/index.js");
} catch (error) {
  console.error(
    `[aiteam] runtime preflight failed: ${
      error instanceof Error ? error.message : "unknown error"
    }`,
  );
  process.exit(1);
}

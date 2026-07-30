#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const openapi = readFileSync(
  join(root, "docs", "openapi-mission-v1.yaml"),
  "utf8",
);
const implementations = [
  readFileSync(join(root, "server", "src", "mission-routes.ts"), "utf8"),
  readFileSync(join(root, "server", "src", "service-auth.ts"), "utf8"),
].join("\n");

function assertIncludes(value, expected, label) {
  if (!value.includes(expected)) {
    throw new Error(`${label}: missing ${expected}`);
  }
  console.log(`✅ ${label}`);
}

assertIncludes(openapi, "version: 0.4.0", "OpenAPI publishes Mission API 0.4.0");

const errorCodes = [
  ...new Set(
    [...implementations.matchAll(/code:\s*"([A-Z0-9_]+)"/g)].map(
      (match) => match[1],
    ),
  ),
].sort();
for (const code of errorCodes) {
  assertIncludes(
    openapi,
    `- ${code}`,
    `OpenAPI enumerates implementation error ${code}`,
  );
}

assertIncludes(
  openapi,
  "enum: [queued, running, blocked, completed, failed, cancelled]",
  "OpenAPI publishes the implementation Mission state machine",
);

for (const field of [
  "event_id",
  "correlation_id",
  "causation_id",
  "mission_id",
  "organization_id",
  "sequence",
  "type",
  "status",
  "payload",
  "created_at",
]) {
  assertIncludes(
    openapi,
    `- ${field}`,
    `OpenAPI requires Mission event field ${field}`,
  );
}

for (const field of ["activity", "stage", "actor", "role", "label"]) {
  assertIncludes(
    openapi,
    field,
    `OpenAPI publishes Mission activity metadata field ${field}`,
  );
}

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

function schemaBlock(name, nextName) {
  const start = openapi.indexOf(`    ${name}:`);
  const end = openapi.indexOf(`    ${nextName}:`, start + 1);
  if (start < 0 || end < 0) {
    throw new Error(`OpenAPI schema block missing: ${name}`);
  }
  return openapi.slice(start, end);
}

assertIncludes(openapi, "version: 0.9.1", "OpenAPI publishes Mission API 0.9.1");
assertIncludes(
  openapi,
  "/missions/{missionId}/approvals:",
  "OpenAPI publishes sanitized Mission approval reads",
);
assertIncludes(
  openapi,
  "/missions/{missionId}/approvals/{approvalId}/resolve:",
  "OpenAPI publishes Mission approval decisions",
);
assertIncludes(
  openapi,
  "mission:approve",
  "OpenAPI publishes the least-privilege approval scope",
);

const approvalRequestSchema = schemaBlock(
  "ResolveMissionNetworkApprovalRequest",
  "Mission",
);
assertIncludes(
  approvalRequestSchema,
  "- call_fingerprint",
  "OpenAPI requires the approval call fingerprint",
);
assertIncludes(
  approvalRequestSchema,
  "pattern: ^[a-f0-9]{64}$",
  "OpenAPI constrains the approval call fingerprint",
);

const approvalSchema = schemaBlock(
  "MissionNetworkApproval",
  "MissionNetworkApprovalEnvelope",
);
for (const field of ["destination", "input_summary", "call_fingerprint"]) {
  assertIncludes(
    approvalSchema,
    `- ${field}`,
    `OpenAPI requires Mission approval field ${field}`,
  );
}
assertIncludes(
  approvalSchema,
  "maxLength: 1200",
  "OpenAPI publishes the Mission approval summary character ceiling",
);
assertIncludes(
  approvalSchema,
  "x-maxUtf8Bytes: 1200",
  "OpenAPI publishes the Mission approval summary byte ceiling",
);

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

for (const field of [
  "observability",
  "latency_ms",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "billable_tokens",
  "currency_estimate",
  "currency_status",
  "network_approval_decisions",
  "error_code",
]) {
  assertIncludes(
    openapi,
    field,
    `OpenAPI publishes Mission observability field ${field}`,
  );
}

for (const code of [
  "MISSION_EXECUTION_FAILED",
  "MISSION_TASK_FAILED",
  "MISSION_TIMEOUT",
]) {
  assertIncludes(
    openapi,
    `- ${code}`,
    `OpenAPI publishes Mission failure reason ${code}`,
  );
}

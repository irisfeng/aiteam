#!/usr/bin/env node
import {
  summarizeMissionObservability,
} from "../server/dist/mission-observability.js";

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
  console.log(`✅ ${label}`);
}

const summary = summarizeMissionObservability({
  missionCreatedAt: 1_000,
  observedAt: 6_500,
  usageSamples: [
    {
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 300,
      cacheCreationTokens: 40,
      billableTokens: 1_280,
    },
    {
      inputTokens: 500,
      outputTokens: 100,
      cacheReadTokens: 200,
      cacheCreationTokens: 20,
      billableTokens: 645,
    },
  ],
  approvalStatuses: ["approved", "pending", "rejected"],
});

assertEqual(
  summary,
  {
    latency_ms: 5_500,
    usage: {
      input_tokens: 1_500,
      output_tokens: 300,
      cache_read_tokens: 500,
      cache_creation_tokens: 60,
      billable_tokens: 1_925,
    },
    cost: {
      unit: "billable_tokens",
      amount: 1_925,
      currency_estimate: null,
      currency_status: "unavailable",
    },
    network_approval_decisions: 2,
  },
  "Mission observability aggregates latency, billable cost, and interventions",
);

assertEqual(
  JSON.stringify(summary).includes("task-"),
  false,
  "Mission observability does not expose internal task identifiers",
);

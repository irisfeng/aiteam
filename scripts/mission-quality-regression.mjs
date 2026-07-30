#!/usr/bin/env node
import {
  classifyFinalMissionDelivery,
} from "../server/dist/mission-quality.js";

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
  console.log(`✅ ${label}`);
}

const failedReview = classifyFinalMissionDelivery({
  taskStatus: "review",
  hasFinalArtifact: true,
  latestVerdict: "revise",
  mock: false,
});
assertEqual(
  failedReview?.status,
  "blocked",
  "A final report that failed machine review does not complete the Mission",
);
assertEqual(
  failedReview?.qualityGate,
  "verification_failed",
  "The blocked Mission exposes the failed quality gate",
);

const passedReview = classifyFinalMissionDelivery({
  taskStatus: "review",
  hasFinalArtifact: true,
  latestVerdict: "pass",
  mock: false,
});
assertEqual(
  passedReview?.status,
  "completed",
  "A final report that passed machine review completes the Mission",
);
const closedPassedReview = classifyFinalMissionDelivery({
  taskStatus: "done",
  hasFinalArtifact: true,
  latestVerdict: "pass",
  mock: false,
});
assertEqual(
  closedPassedReview?.qualityGate,
  "passed",
  "Closing a machine-passed report preserves its passed quality gate",
);

const humanOverride = classifyFinalMissionDelivery({
  taskStatus: "done",
  hasFinalArtifact: true,
  latestVerdict: "revise",
  mock: false,
});
assertEqual(
  humanOverride?.status,
  "completed",
  "An explicit AITeam human close can accept a reviewed report",
);
assertEqual(
  humanOverride?.qualityGate,
  "human_override",
  "A human override remains visible in the completion payload",
);

const mockDelivery = classifyFinalMissionDelivery({
  taskStatus: "review",
  hasFinalArtifact: true,
  latestVerdict: null,
  mock: true,
});
assertEqual(
  mockDelivery?.status,
  "completed",
  "Mock delivery can still prove the integration workflow",
);
assertEqual(
  mockDelivery?.qualityGate,
  "mock_skipped",
  "Mock completion is explicitly distinguished from a passed review",
);
const closedMockDelivery = classifyFinalMissionDelivery({
  taskStatus: "done",
  hasFinalArtifact: true,
  latestVerdict: "pass",
  mock: true,
});
assertEqual(
  closedMockDelivery?.qualityGate,
  "mock_skipped",
  "Closing a Mock report does not relabel it as a verified pass",
);

const missingArtifact = classifyFinalMissionDelivery({
  taskStatus: "review",
  hasFinalArtifact: false,
  latestVerdict: "pass",
  mock: false,
});
assertEqual(
  missingArtifact,
  null,
  "A passed review without a final artifact cannot finish the Mission",
);

export type FinalMissionTaskStatus =
  | "todo"
  | "doing"
  | "review"
  | "blocked"
  | "done"
  | "cancelled";

export type FinalMissionQualityGate =
  | "passed"
  | "verification_failed"
  | "verification_missing"
  | "human_override"
  | "mock_skipped";

export interface FinalMissionDeliveryDecision {
  status: "completed" | "blocked";
  qualityGate: FinalMissionQualityGate;
}

/**
 * Mission completion is stricter than “a report exists”.
 *
 * A normal execution must have a passing final verdict. AITeam's explicit
 * human-only `done` transition is allowed to override a machine revise verdict,
 * while Mock mode remains usable for contract/UAT proof and is labelled as
 * skipped rather than passed.
 */
export function classifyFinalMissionDelivery(input: {
  taskStatus: FinalMissionTaskStatus | null;
  hasFinalArtifact: boolean;
  latestVerdict: "pass" | "revise" | null;
  mock: boolean;
}): FinalMissionDeliveryDecision | null {
  if (
    !input.hasFinalArtifact ||
    (input.taskStatus !== "review" && input.taskStatus !== "done")
  ) {
    return null;
  }
  if (input.taskStatus === "done") {
    return { status: "completed", qualityGate: "human_override" };
  }
  if (input.mock) {
    return { status: "completed", qualityGate: "mock_skipped" };
  }
  if (input.latestVerdict === "pass") {
    return { status: "completed", qualityGate: "passed" };
  }
  return {
    status: "blocked",
    qualityGate:
      input.latestVerdict === "revise"
        ? "verification_failed"
        : "verification_missing",
  };
}

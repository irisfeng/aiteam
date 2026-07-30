#!/usr/bin/env node
import {
  missionActivityMetadata,
} from "../server/dist/mission-activity.js";

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
  console.log(`✅ ${label}`);
}

assertEqual(
  missionActivityMetadata("research", "市场研究员"),
  {
    stage: {
      key: "research",
      label: "资料收集",
    },
    actor: {
      type: "agent",
      role: "researcher",
      label: "市场研究员",
    },
  },
  "Mission research metadata carries a stable stage and public agent name",
);

assertEqual(
  missionActivityMetadata("quality_review", "质量负责人"),
  {
    stage: {
      key: "quality_review",
      label: "质量复核",
    },
    actor: {
      type: "agent",
      role: "reviewer",
      label: "质量负责人",
    },
  },
  "Mission quality metadata identifies the reviewer role",
);

assertEqual(
  missionActivityMetadata("intake"),
  {
    stage: {
      key: "intake",
      label: "任务受理",
    },
    actor: {
      type: "human",
      role: "requester",
      label: "Coworker 任务发起人",
    },
  },
  "Mission intake metadata identifies the human requester without an internal id",
);

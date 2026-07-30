export type MissionStageKey =
  | "intake"
  | "scope"
  | "research"
  | "analysis"
  | "report"
  | "quality_review"
  | "delivery"
  | "cancelled";

export interface MissionActivityMetadata {
  stage: {
    key: MissionStageKey;
    label: string;
  };
  actor: {
    type: "human" | "agent" | "system";
    role:
      | "requester"
      | "mission_lead"
      | "researcher"
      | "analyst"
      | "writer"
      | "reviewer"
      | "system";
    label: string;
  };
}

const STAGES: Record<
  MissionStageKey,
  {
    label: string;
    actorType: MissionActivityMetadata["actor"]["type"];
    actorRole: MissionActivityMetadata["actor"]["role"];
    defaultActorLabel: string;
  }
> = {
  intake: {
    label: "任务受理",
    actorType: "human",
    actorRole: "requester",
    defaultActorLabel: "Coworker 任务发起人",
  },
  scope: {
    label: "口径确认",
    actorType: "agent",
    actorRole: "mission_lead",
    defaultActorLabel: "AITeam 任务负责人",
  },
  research: {
    label: "资料收集",
    actorType: "agent",
    actorRole: "researcher",
    defaultActorLabel: "AITeam 研究员",
  },
  analysis: {
    label: "对比分析",
    actorType: "agent",
    actorRole: "analyst",
    defaultActorLabel: "AITeam 分析师",
  },
  report: {
    label: "报告撰写",
    actorType: "agent",
    actorRole: "writer",
    defaultActorLabel: "AITeam 报告撰写者",
  },
  quality_review: {
    label: "质量复核",
    actorType: "agent",
    actorRole: "reviewer",
    defaultActorLabel: "AITeam 质量复核",
  },
  delivery: {
    label: "成果交付",
    actorType: "agent",
    actorRole: "reviewer",
    defaultActorLabel: "AITeam 质量复核",
  },
  cancelled: {
    label: "任务取消",
    actorType: "system",
    actorRole: "system",
    defaultActorLabel: "AITeam 系统",
  },
};

export function missionActivityMetadata(
  stageKey: MissionStageKey,
  actorName?: string | null,
): MissionActivityMetadata {
  const stage = STAGES[stageKey];
  const normalizedActorName = actorName?.replace(/\s+/g, " ").trim().slice(0, 80);
  return {
    stage: {
      key: stageKey,
      label: stage.label,
    },
    actor: {
      type: stage.actorType,
      role: stage.actorRole,
      label: normalizedActorName || stage.defaultActorLabel,
    },
  };
}

export function missionCancellationActivityMetadata(): MissionActivityMetadata {
  return {
    stage: {
      key: "cancelled",
      label: STAGES.cancelled.label,
    },
    actor: {
      type: "human",
      role: "requester",
      label: "Coworker 任务相关人",
    },
  };
}

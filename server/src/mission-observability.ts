export interface MissionUsageSample {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  billableTokens: number;
}

export interface MissionObservability {
  latency_ms: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    billable_tokens: number;
  };
  cost: {
    unit: "billable_tokens";
    amount: number;
    currency_estimate: null;
    currency_status: "unavailable";
  };
  network_approval_decisions: number;
}

export function summarizeMissionObservability(input: {
  missionCreatedAt: number;
  observedAt: number;
  usageSamples: MissionUsageSample[];
  approvalStatuses: string[];
}): MissionObservability {
  const timestamps = [input.missionCreatedAt, input.observedAt];
  if (
    timestamps.some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    ) ||
    input.observedAt < input.missionCreatedAt
  ) {
    throw new Error("Mission observability timestamps are invalid");
  }
  if (
    input.usageSamples.some((sample) =>
      Object.values(sample).some(
        (value) => !Number.isSafeInteger(value) || value < 0,
      ),
    )
  ) {
    throw new Error("Mission observability usage is invalid");
  }
  const usage = input.usageSamples.reduce(
    (total, sample) => ({
      input_tokens: total.input_tokens + sample.inputTokens,
      output_tokens: total.output_tokens + sample.outputTokens,
      cache_read_tokens:
        total.cache_read_tokens + sample.cacheReadTokens,
      cache_creation_tokens:
        total.cache_creation_tokens + sample.cacheCreationTokens,
      billable_tokens: total.billable_tokens + sample.billableTokens,
    }),
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      billable_tokens: 0,
    },
  );
  return {
    latency_ms: input.observedAt - input.missionCreatedAt,
    usage,
    cost: {
      unit: "billable_tokens",
      amount: usage.billable_tokens,
      currency_estimate: null,
      currency_status: "unavailable",
    },
    network_approval_decisions: input.approvalStatuses.filter((status) =>
      status === "approved" || status === "rejected",
    ).length,
  };
}

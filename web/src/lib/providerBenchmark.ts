import type { ProviderBenchmarkPlan, ProviderBenchmarkRunInput } from "../api";

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k`;
  return String(Math.round(value));
}

function formatCost(value: number | null, currency: string) {
  if (value === null || !Number.isFinite(value)) return "未配置模型价格，无法估算金额";
  const amount = value < 0.01 ? value.toFixed(4) : value.toFixed(2);
  return `按当前价格估算不高于约 ${currency.toUpperCase()} ${amount}`;
}

export function providerBenchmarkRunInput(
  plan: ProviderBenchmarkPlan,
  scope: { channel_id?: string | null; project_id?: string | null } = {},
): ProviderBenchmarkRunInput {
  return {
    ...scope,
    confirmation_version: plan.confirmation_version,
    confirmed_benchmark_id: plan.benchmark.id,
    confirmed_benchmark_version: plan.benchmark.version,
    confirmed_budget_billable: plan.budget_billable,
  };
}

export function providerBenchmarkConfirmation(plan: ProviderBenchmarkPlan) {
  return [
    `确认用「${plan.provider.name}」运行一次真实模型质量基准？`,
    "",
    `质量题：${plan.benchmark.title} · v${plan.benchmark.version}`,
    `输出要求：${plan.benchmark.output_contract}`,
    `生成：${plan.models.worker}`,
    `独立复核：${plan.models.reviewer}`,
    `本次计费上限：${formatTokens(plan.budget_billable)} billable tokens`,
    `其中预留复核：${formatTokens(plan.review_reserve_billable)}`,
    formatCost(plan.estimated_cost_ceiling, plan.price_currency),
    "",
    `流程：${plan.stages.join(" → ")}`,
    plan.warning,
    "",
    "选择“取消”不会调用模型，也不会创建基准任务。",
  ].join("\n");
}

export function providerBenchmarkBatchConfirmation(plans: ProviderBenchmarkPlan[]) {
  const totalBudget = plans.reduce((sum, plan) => sum + plan.budget_billable, 0);
  const currencies = new Set(plans.map((plan) => plan.price_currency.toUpperCase()));
  const allPriced = plans.every((plan) => plan.estimated_cost_ceiling !== null);
  const totalCost = allPriced && currencies.size === 1
    ? plans.reduce((sum, plan) => sum + (plan.estimated_cost_ceiling ?? 0), 0)
    : null;
  const costText = currencies.size > 1
    ? "供应商使用不同币种，请分别查看各自金额"
    : !allPriced
      ? "部分供应商未配置价格，无法估算总金额"
      : formatCost(totalCost, plans[0]?.price_currency ?? "USD");
  return [
    `配置链路验收将调用 ${plans.length} 个真实模型供应商，是否继续？`,
    "",
    `质量题：${plans[0]?.benchmark.title ?? "固定质量基准"} · v${plans[0]?.benchmark.version ?? "-"}`,
    ...plans.map((plan) =>
      `• ${plan.provider.name}：${plan.models.worker} → ${plan.models.reviewer}，上限 ${formatTokens(plan.budget_billable)}`,
    ),
    "",
    `合计计费上限：${formatTokens(totalBudget)} billable tokens`,
    costText,
    "达到各自上限会暂停；单个已发出的请求可能小幅越界。",
    "",
    "选择“取消”将跳过全部真实模型调用，但仍可继续检查 MCP 和 Skills。",
  ].join("\n");
}

type BenchmarkEvent = {
  id?: string;
  type: string;
  agent_id: string | null;
  metadata_json: string;
};

type BenchmarkDoc = { content: string };

export type ProviderBenchmarkChecks = {
  completed: boolean;
  delivered: boolean;
  tool_observed: boolean;
  verified: boolean;
  usage_tracked: boolean;
  quality_contract: boolean;
  independent_reviewer: boolean;
  verdict_recorded: boolean;
  within_budget: boolean;
  source_trace_clean: boolean;
  document_contract: boolean;
  pending_approval: boolean;
};

const TOOL_CLAIMS: Array<[string, RegExp, RegExp]> = [
  [
    "web_search",
    /(?:来源|通过|使用|调用|检索|查询)[^。！？\n]{0,40}\bweb_search\b|\bweb_search\b[^。！？\n]{0,40}(?:来源|检索|查询|调用|获得)/i,
    /(?:没有|未|不得|禁止|不曾|无需)[^。！？\n]{0,16}(?:使用|调用|检索|查询)?[^。！？\n]{0,8}\bweb_search\b/i,
  ],
  [
    "web_fetch",
    /(?:来源|通过|使用|调用|抓取|获取)[^。！？\n]{0,40}\bweb_fetch\b|\bweb_fetch\b[^。！？\n]{0,40}(?:来源|抓取|调用|获得)/i,
    /(?:没有|未|不得|禁止|不曾|无需)[^。！？\n]{0,16}(?:使用|调用|抓取|获取)?[^。！？\n]{0,8}\bweb_fetch\b/i,
  ],
  [
    "browser",
    /(?:通过|使用|调用|借助|打开)[^。！？\n]{0,32}(?:\bbrowser\b|浏览器)|(?:\bbrowser\b|浏览器)[^。！？\n]{0,32}(?:检索|浏览|查询|访问|获得)/i,
    /(?:没有|未|不得|禁止|不曾|无需)[^。！？\n]{0,16}(?:使用|调用|打开)?[^。！？\n]{0,8}(?:\bbrowser\b|浏览器)/i,
  ],
  [
    "plugin",
    /(?:通过|使用|调用|借助)[^。！？\n]{0,32}(?:\bplugin\b|插件)|(?:\bplugin\b|插件)[^。！？\n]{0,32}(?:检索|查询|访问|获得)/i,
    /(?:没有|未|不得|禁止|不曾|无需)[^。！？\n]{0,16}(?:使用|调用)?[^。！？\n]{0,8}(?:\bplugin\b|插件)/i,
  ],
  [
    "mcp",
    /(?:通过|使用|调用|借助)[^。！？\n]{0,32}\bMCP\b|\bMCP\b[^。！？\n]{0,32}(?:检索|查询|访问|获得|工具)/i,
    /(?:没有|未|不得|禁止|不曾|无需)[^。！？\n]{0,16}(?:使用|调用)?[^。！？\n]{0,8}\bMCP\b/i,
  ],
  [
    "read_document",
    /(?:通过|使用|调用|读取)[^。！？\n]{0,32}\bread_document\b|\bread_document\b[^。！？\n]{0,32}(?:读取|获得|调用)/i,
    /(?:没有|未|不得|禁止|不曾|无需)[^。！？\n]{0,16}(?:使用|调用|读取)?[^。！？\n]{0,8}\bread_document\b/i,
  ],
];

const TOOL_ALIASES: Record<string, string[]> = {
  web_search: ["web_search"],
  web_fetch: ["web_fetch"],
  browser: ["browser", "浏览器"],
  plugin: ["plugin", "插件"],
  mcp: ["mcp"],
  read_document: ["read_document"],
};

function explicitlyNegated(sentence: string, tool: string, specificPattern: RegExp) {
  if (specificPattern.test(sentence)) return true;
  const negativeClause = sentence.split(/但是|然而|不过|但|却|仍然?/)[0]?.toLowerCase() ?? "";
  if (!/(?:没有|未|不得|禁止|不曾|无需)/.test(negativeClause)) return false;
  return (TOOL_ALIASES[tool] ?? [tool]).some((alias) => negativeClause.includes(alias));
}

export function providerBenchmarkSourceTrace(
  events: BenchmarkEvent[],
  docs: BenchmarkDoc[],
  actors: { workerAgentId: string; reviewerAgentId: string },
) {
  const observed: Array<{ event_id: string | null; agent_id: string | null; tool: string }> = [];
  for (const event of events) {
    if (event.type !== "tool") continue;
    try {
      const meta = JSON.parse(event.metadata_json || "{}") as { tool?: unknown };
      if (typeof meta.tool === "string" && meta.tool) {
        observed.push({ event_id: event.id ?? null, agent_id: event.agent_id, tool: meta.tool });
      }
    } catch {
      observed.push({ event_id: event.id ?? null, agent_id: event.agent_id, tool: "<invalid-metadata>" });
    }
  }

  const isAuthorized = (entry: (typeof observed)[number]) =>
    (entry.agent_id === actors.workerAgentId && entry.tool === "write_document") ||
    (entry.agent_id === actors.reviewerAgentId && entry.tool === "submit_verdict");
  const authorized = observed.filter(isAuthorized);
  const unauthorized = observed.filter((entry) => !isAuthorized(entry));
  const authorizedTools = new Set(authorized.map((entry) => entry.tool));

  const combined = docs.map((doc) => doc.content).join("\n");
  const sentences = combined.split(/(?<=[。！？\n])/).map((sentence) => sentence.trim()).filter(Boolean);
  const unobservedClaims = TOOL_CLAIMS
    .filter(([tool, positive, negative]) =>
      !authorizedTools.has(tool) && sentences.some((sentence) => positive.test(sentence) && !explicitlyNegated(sentence, tool, negative)),
    )
    .map(([tool]) => tool);

  return {
    clean: unauthorized.length === 0 && unobservedClaims.length === 0,
    observed_tools: [...new Set(observed.map((entry) => entry.tool))],
    authorized_tools: authorized,
    unauthorized_tool_events: unauthorized,
    unobserved_claims: unobservedClaims,
  };
}

export function providerBenchmarkPassed(checks: ProviderBenchmarkChecks) {
  return checks.completed &&
    checks.delivered &&
    checks.tool_observed &&
    checks.verified &&
    checks.usage_tracked &&
    checks.quality_contract &&
    checks.independent_reviewer &&
    checks.verdict_recorded &&
    checks.within_budget &&
    checks.source_trace_clean &&
    checks.document_contract &&
    !checks.pending_approval;
}

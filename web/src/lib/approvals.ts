export interface NetworkApprovalPayload {
  details: string;
  serverId: string;
  serverName: string;
  serverTarget: string;
  tool: string;
  input: unknown;
}

export function parseNetworkApprovalPayload(payload: string): NetworkApprovalPayload | null {
  try {
    const parsed = JSON.parse(payload) as {
      details?: unknown;
      network_grant?: {
        server_id?: unknown;
        server_name?: unknown;
        server_target?: unknown;
        tool?: unknown;
        input?: unknown;
      };
    };
    const grant = parsed.network_grant;
    if (
      !grant ||
      typeof grant.server_id !== "string" ||
      typeof grant.server_name !== "string" ||
      typeof grant.server_target !== "string" ||
      typeof grant.tool !== "string"
    ) return null;
    return {
      details: typeof parsed.details === "string" ? parsed.details : "",
      serverId: grant.server_id,
      serverName: grant.server_name,
      serverTarget: grant.server_target,
      tool: grant.tool,
      input: grant.input,
    };
  } catch {
    return null;
  }
}

export function formatNetworkApprovalPayload(payload: string): string {
  const parsed = parseNetworkApprovalPayload(payload);
  if (!parsed) return payload;
  return [
    parsed.details,
    `目标：${parsed.serverName} (${parsed.serverTarget})`,
    `工具：${parsed.tool}`,
    `参数：${JSON.stringify(parsed.input, null, 2)}`,
    "范围：只允许以上工具、目标配置和完整参数执行一次；任何变化都要重新审批。",
  ].filter(Boolean).join("\n");
}

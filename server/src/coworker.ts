/**
 * 复用 Coworker 登录态时，向 Coworker 取当前用户的展示信息（displayName + 所属部门）。
 * - 仅 coworker 模式生效；standalone 直接返回 null。
 * - 同源会话 cookie 转发给 Coworker 的 GET /api/me；best-effort，失败回退（绝不让 bootstrap 挂掉）。
 * - 按 userId 缓存 60s，避免每次 bootstrap 都回源。
 * departments 现在已取回，为后续「按部门共享工作区」预留（v0.1 暂不使用）。
 */
export interface CoworkerMe {
  id: string;
  displayName: string;
  email: string;
  departments: { id: string; name: string; role: string }[];
}

const cache = new Map<string, { data: CoworkerMe; ts: number }>();
const TTL_MS = 60_000;

export async function fetchCoworkerMe(
  userId: string | undefined,
  cookieHeader: string | undefined
): Promise<CoworkerMe | null> {
  if (process.env.AITEAM_AUTH_MODE !== "coworker") return null;
  if (!userId || !cookieHeader) return null;

  const hit = cache.get(userId);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;

  const base = (process.env.COWORKER_INTERNAL_URL || "http://localhost:3000").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/me`, {
      headers: { cookie: cookieHeader },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as CoworkerMe;
    cache.set(userId, { data, ts: Date.now() });
    return data;
  } catch {
    return null; // Coworker 不可达 / 超时：回退到默认名
  }
}

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
  isSuperadmin?: boolean;
}

const cache = new Map<string, { data: CoworkerMe; ts: number }>();
const TTL_MS = 60_000;

export function coworkerMeIsAdmin(me: CoworkerMe | null): boolean {
  return Boolean(
    me?.isSuperadmin === true ||
      (Array.isArray(me?.departments) &&
        me.departments.some((department) => department.role === "admin")),
  );
}

function parseCoworkerMe(value: unknown): CoworkerMe | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  const departments = Array.isArray(record.departments)
    ? record.departments
        .filter(
          (department): department is Record<string, unknown> =>
            Boolean(department && typeof department === "object"),
        )
        .map((department) => ({
          id: typeof department.id === "string" ? department.id : "",
          name: typeof department.name === "string" ? department.name : "",
          role: typeof department.role === "string" ? department.role : "",
        }))
    : [];
  return {
    id: record.id,
    displayName:
      typeof record.displayName === "string" ? record.displayName : "",
    email: typeof record.email === "string" ? record.email : "",
    departments,
    isSuperadmin: record.isSuperadmin === true,
  };
}

export async function fetchCoworkerMe(
  userId: string | undefined,
  cookieHeader: string | undefined,
  options: { useCache?: boolean } = {},
): Promise<CoworkerMe | null> {
  if (process.env.AITEAM_AUTH_MODE !== "coworker") return null;
  if (!userId || !cookieHeader) return null;

  if (options.useCache !== false) {
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;
  }

  const base = (process.env.COWORKER_INTERNAL_URL || "http://localhost:3000").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/me`, {
      headers: { cookie: cookieHeader },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = parseCoworkerMe(await res.json());
    if (!data) return null;
    if (options.useCache !== false) {
      cache.set(userId, { data, ts: Date.now() });
    }
    return data;
  } catch {
    return null; // Coworker 不可达 / 超时：回退到默认名
  }
}

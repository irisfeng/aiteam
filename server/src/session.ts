import { SignJWT, jwtVerify } from "jose";

/**
 * AiTeam 自建会话：把 userId 签进 JWT，放 httpOnly cookie（standalone 多用户登录态）。
 * 密钥取 AITEAM_SESSION_SECRET；未设置时用一个开发回退（生产务必配置）。
 */
export const SESSION_COOKIE = "aiteam_session";
const SESSION_TTL = "30d";

function secret(): Uint8Array {
  const s = process.env.AITEAM_SESSION_SECRET;
  if (!s && process.env.NODE_ENV === "production") {
    console.warn("[aiteam] 未设置 AITEAM_SESSION_SECRET，会话密钥不安全——生产环境务必配置");
  }
  return new TextEncoder().encode(s || "aiteam-dev-secret-change-me");
}

export async function signSession(userId: string): Promise<string> {
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(secret());
}

export async function verifySession(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return typeof payload.userId === "string" ? payload.userId : null;
  } catch {
    return null;
  }
}

/** 从 Cookie 请求头里取某个 cookie 值（不引入 cookie-parser 依赖）。 */
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

import { SignJWT, jwtVerify } from "jose";

/**
 * AiTeam 自建会话：把 userId 签进 JWT，放 httpOnly cookie（standalone 多用户登录态）。
 * 密钥取 AITEAM_SESSION_SECRET；未设置时用一个开发回退（生产务必配置）。
 */
export const SESSION_COOKIE = "aiteam_session";
const SESSION_TTL = "30d";

// 生产环境必须显式配置密钥：缺省静默回退到这个公开弱密钥会让任何人伪造任意用户的 JWT。
// 故在生产下直接 fail-fast 拒启（而非 warn 后照常用弱密钥）；开发/测试仍可用回退值。
const DEV_FALLBACK_SECRET = "aiteam-dev-secret-change-me";
const SECRET_ENV = process.env.AITEAM_SESSION_SECRET;
if (!SECRET_ENV && process.env.NODE_ENV === "production") {
  console.error(
    "[aiteam] 致命：生产环境（NODE_ENV=production）未设置 AITEAM_SESSION_SECRET，拒绝以公开弱密钥启动。\n" +
      "         请生成强密钥后重启：openssl rand -base64 48"
  );
  process.exit(1);
}
const SECRET_BYTES = new TextEncoder().encode(SECRET_ENV || DEV_FALLBACK_SECRET);

function secret(): Uint8Array {
  return SECRET_BYTES;
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

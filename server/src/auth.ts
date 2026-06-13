import type { Request, Response, NextFunction } from "express";
import { getToken } from "@auth/core/jwt";

/**
 * 鉴权模式：
 * - standalone：AiTeam 原始单机用法，不校验登录，固定单用户（保证原项目可独立运行）
 * - coworker：整合进统一 Web App，复用 Coworker 的 NextAuth 登录态（本地解密会话 cookie）
 */
const AUTH_MODE = process.env.AITEAM_AUTH_MODE ?? "standalone";
const STANDALONE_USER = "user";

// NextAuth v5 会话 cookie 名（HTTPS 用 __Secure- 前缀）。同时尝试两者以兼容反代下的 http/https 落差。
const COOKIE_NAMES = ["__Secure-authjs.session-token", "authjs.session-token"];

export interface AuthedRequest extends Request {
  userId?: string;
}

/**
 * 解析当前请求对应的用户 id。
 * coworker 模式下用 @auth/core 自带的 getToken 本地解密 NextAuth 会话 cookie（与 Coworker 同一套代码，
 * 自动处理 HKDF salt、A256CBC-HS512、cookie 分块、未来 enc 切换）。失败返回 null。
 */
export async function resolveUserId(req: Pick<Request, "headers">): Promise<string | null> {
  if (AUTH_MODE !== "coworker") return STANDALONE_USER;

  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    console.warn("[aiteam] AITEAM_AUTH_MODE=coworker 但未设置 AUTH_SECRET，无法校验登录态");
    return null;
  }

  for (const cookieName of COOKIE_NAMES) {
    try {
      // getToken 接受 Express 风格的 { headers } 请求对象
      const payload = await getToken({ req: req as never, secret, cookieName, salt: cookieName });
      if (payload && typeof payload.userId === "string") return payload.userId;
    } catch {
      // 该 cookie 名解不开，尝试下一个
    }
  }
  return null;
}

/** Express 中间件：要求已登录，并把 userId 注入 req。未登录返回 401。 */
export async function requireUser(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const userId = await resolveUserId(req);
  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  req.userId = userId;
  next();
}

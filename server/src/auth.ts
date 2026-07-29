import type { Request, Response, NextFunction } from "express";
import { getToken } from "@auth/core/jwt";
import { ownerFromUserId, withOwner } from "./ownerScope.js";
import { SESSION_COOKIE, readCookie, verifySession } from "./session.js";
import { getUserById } from "./db.js";
import { coworkerMeIsAdmin, fetchCoworkerMe } from "./coworker.js";

/**
 * 鉴权模式：
 * - standalone：AiTeam 自建登录（邮箱+密码 → JWT 会话 cookie）。未登录返回 401。
 * - coworker：整合进统一 Web App，复用 Coworker 的 NextAuth 登录态（本地解密会话 cookie）
 */
const AUTH_MODE = process.env.AITEAM_AUTH_MODE ?? "standalone";

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
  if (AUTH_MODE !== "coworker") {
    // standalone：校验 AiTeam 自己签发的会话 cookie（登录后下发）。未登录 → null → 401。
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    return token ? await verifySession(token) : null;
  }

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
  // 用 owner 上下文包住整个请求处理：路由内的 db 查询自动按 owner 隔离，
  // 由请求同步触发的 Agent 运行（onMessage 等）也继承该上下文。
  withOwner(ownerFromUserId(userId), () => next());
}

/** 管理员门控（用在 requireUser 之后）：角色必须由当前鉴权模式的权威来源确认。 */
export async function requireAdmin(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (AUTH_MODE === "coworker") {
    const coworkerMe = await fetchCoworkerMe(req.userId, req.headers.cookie);
    if (!coworkerMeIsAdmin(coworkerMe)) {
      res.status(403).json({ error: "需要 Coworker 部门管理员或超级管理员权限" });
      return;
    }
  } else {
    const u = req.userId ? getUserById(req.userId) : undefined;
    if (!u || u.role !== "admin") {
      res.status(403).json({ error: "需要管理员权限（仅管理员可改组织级配置）" });
      return;
    }
  }
  next();
}

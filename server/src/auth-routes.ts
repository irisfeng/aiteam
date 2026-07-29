import { Router } from "express";
import { countUsers, createUser, getUserByEmail, getUserById } from "./db.js";
import { hashPassword, verifyPassword } from "./password.js";
import { SESSION_COOKIE, signSession } from "./session.js";
import { resolveUserId } from "./auth.js";
import { coworkerMeIsAdmin, fetchCoworkerMe } from "./coworker.js";

/** 登录/注册/登出/me —— 这些路由不经 requireUser（登出态也要能访问）。 */
export const authRoutes = Router();

const ADMIN_EMAILS = (process.env.AITEAM_ADMIN_EMAILS ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const ALLOW_SIGNUP = (process.env.AITEAM_ALLOW_SIGNUP ?? "1") !== "0"; // v0.1 默认开放，可用 env 关

const COOKIE_OPTS = { httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: 30 * 24 * 3600 * 1000 };
const publicUser = (u: { id: string; email: string; display_name: string; role: string }) =>
  ({ id: u.id, email: u.email, display_name: u.display_name, role: u.role });

authRoutes.post("/register", async (req, res) => {
  if (!ALLOW_SIGNUP) return res.status(403).json({ error: "公开注册已关闭，请联系管理员建号" });
  const email = String(req.body?.email ?? "").toLowerCase().trim();
  const password = String(req.body?.password ?? "");
  const displayName = String(req.body?.display_name ?? "").trim() || email.split("@")[0];
  if (!/.+@.+\..+/.test(email)) return res.status(400).json({ error: "邮箱格式不正确" });
  if (password.length < 6) return res.status(400).json({ error: "密码至少 6 位" });
  if (getUserByEmail(email)) return res.status(409).json({ error: "该邮箱已注册" });
  // 角色：env 白名单命中 = admin；白名单为空且是首个用户 = admin（兜底，避免无管理员）；否则 member
  const role = ADMIN_EMAILS.includes(email) || (ADMIN_EMAILS.length === 0 && countUsers() === 0) ? "admin" : "member";
  const user = createUser({ email, password_hash: hashPassword(password), display_name: displayName, role });
  res.cookie(SESSION_COOKIE, await signSession(user.id), COOKIE_OPTS);
  res.json(publicUser(user));
});

authRoutes.post("/login", async (req, res) => {
  const email = String(req.body?.email ?? "").toLowerCase().trim();
  const password = String(req.body?.password ?? "");
  const user = getUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: "邮箱或密码错误" });
  res.cookie(SESSION_COOKIE, await signSession(user.id), COOKIE_OPTS);
  res.json(publicUser(user));
});

authRoutes.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

authRoutes.get("/me", async (req, res) => {
  // 两种鉴权模式通吃：standalone 校验 aiteam_session，coworker 解 NextAuth 会话
  const userId = await resolveUserId(req);
  if (!userId) {
    // 未登录：把"是否开放注册 / 是否还没有任何用户(首个注册者将成 admin)"告诉前端，决定显示登录还是注册
    return res.status(401).json({ error: "unauthorized", allow_signup: ALLOW_SIGNUP, needs_setup: countUsers() === 0 });
  }
  const user = getUserById(userId);
  if (user) {
    res.json(publicUser(user));
    return;
  }
  const coworkerMe = await fetchCoworkerMe(userId, req.headers.cookie);
  res.json({
    id: userId,
    role: coworkerMeIsAdmin(coworkerMe) ? "admin" : "member",
  });
});

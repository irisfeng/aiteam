import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 每用户工作区隔离的核心抽象（owner = 命名空间化的归属主体）。
 *
 * v0.1：owner = `user:<userId>`（个人私有工作区）。
 * 未来按部门共享：只需让写入用 `dept:<id>`、读取用 visibleOwners() 返回多个 owner——
 * db 层查询与 engine 全链路无需改动，扩展点集中在 currentOwner()/visibleOwners() 两处。
 *
 * 用 AsyncLocalStorage 承载"当前 owner"：
 * - HTTP 请求：requireUser 中间件用 withOwner 包住整个请求处理；
 * - Agent 运行：每个运行入口（含队列边界、定时器、重启恢复）用 withOwner 重新建立上下文。
 * db 查询读取 currentOwner() 自动加 owner 过滤；fail-closed：缺上下文即抛错，绝不回退到"看全部"。
 */
const als = new AsyncLocalStorage<{ ownerId: string }>();

/** 由 userId 构造 owner 主体（命名空间化，为未来 dept: 预留）。 */
export function ownerFromUserId(userId: string): string {
  return `user:${userId}`;
}

export function withOwner<T>(ownerId: string, fn: () => T): T {
  return als.run({ ownerId }, fn);
}

/** 当前 owner；缺上下文返回 null（仅用于 broadcast 等需要 fail-safe 跳过的场景）。 */
export function currentOwnerOrNull(): string | null {
  return als.getStore()?.ownerId ?? null;
}

/** 当前 owner；缺上下文直接抛错（数据查询用，fail-closed 防止跨租户泄漏）。 */
export function currentOwner(): string {
  const ownerId = als.getStore()?.ownerId;
  if (!ownerId) throw new Error("owner context required but missing (query attempted outside withOwner scope)");
  return ownerId;
}

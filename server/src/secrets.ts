import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 凭证落库加密（AES-256-GCM）：mcp_servers.auth_token / env_json 等含密钥的字段不再明文入库，
 * 数据库文件被拷走（备份泄漏、VPS 快照）时凭证仍安全。
 *
 * 密钥来源（先到先用）：
 * - AITEAM_CREDENTIAL_KEY：32 字节，hex(64 位) 或 base64——多实例/容器部署用它统一注入；
 * - 数据目录下 credential.key：开发/测试首启自动生成（0600）；生产仅复用既有文件，不静默新建。
 *   迁移数据库时必须连同此文件一起迁移，
 *   否则存量凭证不可解（decryptSecret 会给出明确报错，不静默回退明文）。
 *
 * 密文格式 `enc1:<iv>:<tag>:<ct>`（base64url）。decrypt 对无前缀的值原样返回，
 * 兼容存量明文——启动迁移（db.ts）会把它们统一重写为密文。
 */
const ENC_PREFIX = "enc1:";
const LEGACY_V1_PREFIX = "enc:v1:";
const ENVELOPE_LIKE = /^enc(?::|[0-9]+:)/;

// 与 db.ts 同一套数据目录解析规则（不 import db，避免环依赖）
const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.AITEAM_DATA_DIR || join(__dirname, "..", "data");

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = (process.env.AITEAM_CREDENTIAL_KEY || "").trim();
  if (fromEnv) {
    const buf = /^[0-9a-fA-F]{64}$/.test(fromEnv) ? Buffer.from(fromEnv, "hex") : Buffer.from(fromEnv, "base64");
    if (buf.length !== 32) throw new Error("AITEAM_CREDENTIAL_KEY 必须是 32 字节（64 位 hex 或 base64）");
    cachedKey = buf;
    return cachedKey;
  }
  const keyPath = join(dataDir, "credential.key");
  if (existsSync(keyPath)) {
    const buf = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    if (buf.length !== 32) throw new Error(`凭证密钥文件损坏：${keyPath}（应为 32 字节 base64）`);
    cachedKey = buf;
    return cachedKey;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "生产环境缺少凭证落库密钥：请设置 AITEAM_CREDENTIAL_KEY，或恢复数据目录中原有的 credential.key。"
    );
  }
  const fresh = crypto.randomBytes(32);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(keyPath, fresh.toString("base64"), { mode: 0o600 });
  cachedKey = fresh;
  return cachedKey;
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(ENC_PREFIX) || value.startsWith(LEGACY_V1_PREFIX);
}

/** 空串与已加密值原样返回（幂等，迁移可安全重跑）。 */
export function encryptSecret(plain: string): string {
  if (!plain) return plain;
  if (plain.startsWith(ENC_PREFIX)) {
    decryptSecret(plain);
    return plain;
  }
  if (plain.startsWith(LEGACY_V1_PREFIX)) {
    throw new Error("不能把历史 enc:v1 密文当作明文再次加密；请先调用 canonicalizeSecret。");
  }
  if (ENVELOPE_LIKE.test(plain)) {
    throw new Error("检测到未知或不支持的凭证密文格式，拒绝作为明文再次加密。");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", loadKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + [iv, tag, ct].map((b) => b.toString("base64url")).join(":");
}

/** 无前缀（存量明文）原样返回；密文解不开则抛明确错误，绝不把坏密文当值用。 */
export function decryptSecret(stored: string): string {
  if (!stored) return stored;
  if (!isEncryptedSecret(stored)) {
    if (ENVELOPE_LIKE.test(stored)) {
      throw new Error("检测到未知或不支持的凭证密文格式。");
    }
    return stored;
  }
  if (stored.startsWith(LEGACY_V1_PREFIX)) {
    const material = process.env.AITEAM_SECRET_KEY || process.env.AITEAM_SESSION_SECRET;
    if (!material) {
      throw new Error(
        "历史凭证解密失败：检测到 enc:v1 数据，但未设置原 AITEAM_SECRET_KEY（或旧 AITEAM_SESSION_SECRET）。"
      );
    }
    try {
      const raw = Buffer.from(stored.slice(LEGACY_V1_PREFIX.length), "base64");
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const data = raw.subarray(28);
      const legacyKey = crypto.scryptSync(material, "aiteam-secretbox-v1", 32);
      const decipher = crypto.createDecipheriv("aes-256-gcm", legacyKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    } catch {
      throw new Error(
        "历史凭证解密失败：AITEAM_SECRET_KEY/AITEAM_SESSION_SECRET 与 enc:v1 数据不匹配，或密文已损坏。"
      );
    }
  }
  const parts = stored.slice(ENC_PREFIX.length).split(":");
  try {
    const [iv, tag, ct] = parts.map((p) => Buffer.from(p, "base64url"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", loadKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(
      "凭证解密失败：加密密钥与数据库不匹配。迁移/恢复数据库时需一并迁移数据目录下的 credential.key（或保持 AITEAM_CREDENTIAL_KEY 一致）。"
    );
  }
}

/** 把历史明文或 enc:v1 统一迁移为 canonical enc1；已有 enc1 先认证再原样保留。 */
export function canonicalizeSecret(stored: string): string {
  if (!stored) return "";
  if (stored.startsWith(ENC_PREFIX)) {
    decryptSecret(stored);
    return stored;
  }
  return encryptSecret(decryptSecret(stored));
}

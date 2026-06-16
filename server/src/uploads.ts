import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 上传文件的临时落盘目录（与 sqlite/assets 同级，跟随 AITEAM_DATA_DIR 隔离）。
 * 设计：上传只为提取文本——解析完即删原文件，**不持久化二进制**。因此：
 *  - 无孤儿文件（withTempFile 在 finally 删）；
 *  - 无"删文档要连带删文件"问题（没东西可删）；
 *  - 此目录绝不挂 express.static（来源可能含敏感内容，且本就转瞬即逝）。
 * 提取出的 Markdown 存入 documents 表（owner 隔离 + 版本化），作为 kind="source" 文档。
 */
const tmpRoot = join(process.env.AITEAM_DATA_DIR || join(__dirname, "..", "data"), "uploads-tmp");
mkdirSync(tmpRoot, { recursive: true });

/** 单文件大小上限（默认 20MB） */
export const UPLOAD_MAX_BYTES = Number(process.env.AITEAM_UPLOAD_MAX_BYTES ?? 20 * 1024 * 1024);

/** 可直接按 UTF-8 文本读取的扩展名（无需 markitdown） */
export const TEXT_EXTS = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log", ".yaml", ".yml", ".xml"]);

/** 需经 markitdown 解析的扩展名 */
export const DOC_EXTS = new Set([
  ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls", ".epub",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".html", ".htm",
]);

/** 取小写扩展名（含点）；无扩展名返回空串。仅用于类型判断，绝不参与磁盘路径拼接。 */
export function extOf(name: string): string {
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(name || "");
  return m ? "." + m[1].toLowerCase() : "";
}

/**
 * 把二进制写入临时文件供 markitdown 以 file:// 读取；回调结束（无论成败）即删。
 * 文件名用 nanoid + 扩展名，绝不使用用户原始文件名拼路径（防路径穿越）。
 */
export async function withTempFile<T>(buf: Buffer, ext: string, fn: (absPath: string) => Promise<T>): Promise<T> {
  const safeExt = /^\.[a-zA-Z0-9]{1,8}$/.test(ext) ? ext : "";
  const absPath = join(tmpRoot, nanoid(16) + safeExt);
  writeFileSync(absPath, buf);
  try {
    return await fn(absPath);
  } finally {
    try { rmSync(absPath, { force: true }); } catch { /* ignore */ }
  }
}

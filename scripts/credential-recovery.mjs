#!/usr/bin/env node
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve, join, sep } from "node:path";
import Database from "better-sqlite3";

const ENVELOPE_LIKE = /^enc(?::|[0-9]+:)/;
const FORMAT_KEYS = ["empty", "enc1", "legacy_v1", "plaintext", "unknown_envelope", "invalid"];

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {
    command,
    json: false,
    dataDir: "",
    outputDir: "",
    confirm: "",
    sourceStopped: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--confirm-source-stopped") options.sourceStopped = true;
    else if (arg === "--data-dir") options.dataDir = rest[++i] ?? "";
    else if (arg === "--output-dir") options.outputDir = rest[++i] ?? "";
    else if (arg === "--confirm") options.confirm = rest[++i] ?? "";
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

function decodeCredentialKey(material, name) {
  const value = String(material ?? "").trim();
  if (!value) throw new Error(`${name} 未设置`);
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, "hex");
  } else {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
      throw new Error(`${name} 必须是规范的 64 位 hex 或 base64`);
    }
    key = Buffer.from(value, "base64");
    if (key.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
      throw new Error(`${name} base64 格式不规范`);
    }
  }
  if (key.length !== 32) throw new Error(`${name} 必须是 32 字节（64 位 hex 或 base64）`);
  return key;
}

function decryptCanonical(stored, key) {
  const parts = stored.slice("enc1:".length).split(":");
  if (parts.length !== 3 || parts.some((part) => !part || !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error("检测到不规范的 enc1 凭证信封");
  }
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64url"));
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("检测到不规范的 enc1 凭证长度");
  }
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("enc1 凭证解密失败：源 canonical key 不匹配或密文损坏");
  }
}

function decryptLegacy(stored, material) {
  if (!material) throw new Error("检测到 enc:v1，但 AITEAM_SECRET_KEY 未设置");
  try {
    const payload = stored.slice("enc:v1:".length);
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload) ||
      payload.length % 4 !== 0
    ) {
      throw new Error("invalid legacy base64");
    }
    const raw = Buffer.from(payload, "base64");
    if (raw.toString("base64") !== payload) throw new Error("non-canonical legacy base64");
    if (raw.length <= 28) throw new Error("legacy envelope too short");
    const key = crypto.scryptSync(material, "aiteam-secretbox-v1", 32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("enc:v1 凭证解密失败：AITEAM_SECRET_KEY 不匹配或密文损坏");
  }
}

function encryptCanonical(plain, key) {
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `enc1:${[iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(":")}`;
}

function canonicalizeForCopy(stored, { sourceKey, targetKey, legacyMaterial }, emptyValues = new Set([""])) {
  if (emptyValues.has(stored)) return stored;
  const format = classify(stored, emptyValues);
  if (format === "unknown_envelope" || format === "invalid") {
    throw new Error("检测到未知或损坏的凭证格式，拒绝迁移");
  }
  const plain =
    format === "enc1"
      ? decryptCanonical(stored, sourceKey)
      : format === "legacy_v1"
        ? decryptLegacy(stored, legacyMaterial)
        : stored;
  return encryptCanonical(plain, targetKey);
}

function emptyCounts() {
  return Object.fromEntries(FORMAT_KEYS.map((key) => [key, 0]));
}

function classify(value, emptyValues = new Set([""])) {
  if (typeof value !== "string") return "invalid";
  if (emptyValues.has(value)) return "empty";
  if (value.startsWith("enc1:")) return "enc1";
  if (value.startsWith("enc:v1:")) return "legacy_v1";
  if (ENVELOPE_LIKE.test(value)) return "unknown_envelope";
  return "plaintext";
}

function countValues(values, emptyValues) {
  const counts = emptyCounts();
  for (const value of values) counts[classify(value, emptyValues)]++;
  return counts;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function assertRecoverySchema(db) {
  const required = {
    providers: ["id", "api_key"],
    mcp_servers: ["id", "auth_token", "env_json"],
    app_settings: ["key", "value"],
  };
  for (const [table, columns] of Object.entries(required)) {
    if (!tableExists(db, table)) {
      throw new Error(`数据库结构不是受支持的 AiTeam 数据库：缺少表 ${table}`);
    }
    const present = new Set(db.pragma(`table_info(${table})`).map((row) => row.name));
    for (const column of columns) {
      if (!present.has(column)) {
        throw new Error(`数据库结构不是受支持的 AiTeam 数据库：缺少列 ${table}.${column}`);
      }
    }
  }
}

function assertIntegrity(dataDir) {
  const dbPath = join(resolve(dataDir), "aiteam.db");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    const rows = db.pragma("integrity_check");
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      throw new Error("SQLite integrity_check 未通过");
    }
  } finally {
    db.close();
  }
}

function inspectDatabase(dataDir) {
  const dbPath = join(resolve(dataDir), "aiteam.db");
  if (!existsSync(dbPath)) throw new Error(`找不到数据库：${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    assertRecoverySchema(db);
    const providerValues = tableExists(db, "providers")
      ? db.prepare("SELECT api_key FROM providers").all().map((row) => row.api_key)
      : [];
    const mcpRows = tableExists(db, "mcp_servers")
      ? db.prepare("SELECT auth_token, env_json FROM mcp_servers").all()
      : [];
    let imageValue = "";
    let imageInvalid = false;
    if (tableExists(db, "app_settings")) {
      const row = db.prepare("SELECT value FROM app_settings WHERE key = 'image_provider'").get();
      if (row?.value) {
        try {
          const parsed = JSON.parse(row.value);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) imageInvalid = true;
          else if (parsed.api_key == null) imageValue = "";
          else if (typeof parsed.api_key === "string") imageValue = parsed.api_key;
          else imageInvalid = true;
        } catch {
          imageInvalid = true;
        }
      }
    }
    const imageCounts = imageInvalid ? { ...emptyCounts(), invalid: 1 } : countValues([imageValue]);
    return {
      command: "inspect",
      source_read_only: true,
      database: dbPath,
      surfaces: {
        providers: countValues(providerValues),
        mcp_auth: countValues(mcpRows.map((row) => row.auth_token)),
        mcp_env: countValues(mcpRows.map((row) => row.env_json), new Set(["", "{}"])),
        image_provider: imageCounts,
      },
    };
  } finally {
    db.close();
  }
}

async function copyDatabase(sourceDataDir, targetDataDir) {
  const sourcePath = join(resolve(sourceDataDir), "aiteam.db");
  const targetPath = join(resolve(targetDataDir), "aiteam.db");
  if (!existsSync(sourcePath)) throw new Error(`找不到数据库：${sourcePath}`);
  await mkdir(targetDataDir, { recursive: true });
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    source.pragma("query_only = ON");
    await source.backup(targetPath);
  } finally {
    source.close();
  }
}

function migrateCopy(dataDir) {
  const targetKey = decodeCredentialKey(process.env.AITEAM_CREDENTIAL_KEY, "AITEAM_CREDENTIAL_KEY");
  const sourceKey = process.env.AITEAM_SOURCE_CREDENTIAL_KEY
    ? decodeCredentialKey(process.env.AITEAM_SOURCE_CREDENTIAL_KEY, "AITEAM_SOURCE_CREDENTIAL_KEY")
    : targetKey;
  const keyset = {
    sourceKey,
    targetKey,
    legacyMaterial: String(process.env.AITEAM_SECRET_KEY ?? ""),
  };
  const dbPath = join(resolve(dataDir), "aiteam.db");
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma("journal_mode = DELETE");
    db.pragma("secure_delete = ON");
    assertRecoverySchema(db);
    db.transaction(() => {
      if (tableExists(db, "providers")) {
        const rows = db.prepare("SELECT id, api_key FROM providers").all();
        const update = db.prepare("UPDATE providers SET api_key = ? WHERE id = ?");
        for (const row of rows) {
          const next = canonicalizeForCopy(row.api_key, keyset);
          if (next !== row.api_key) update.run(next, row.id);
        }
      }
      if (tableExists(db, "mcp_servers")) {
        const rows = db.prepare("SELECT id, auth_token, env_json FROM mcp_servers").all();
        const update = db.prepare("UPDATE mcp_servers SET auth_token = ?, env_json = ? WHERE id = ?");
        for (const row of rows) {
          const authToken = canonicalizeForCopy(row.auth_token, keyset);
          const envJson = canonicalizeForCopy(row.env_json, keyset, new Set(["", "{}"]));
          if (envJson !== "{}") {
            let parsed;
            try {
              parsed = JSON.parse(decryptCanonical(envJson, targetKey));
            } catch {
              throw new Error("MCP env 解密后不是合法 JSON");
            }
            if (
              !parsed ||
              typeof parsed !== "object" ||
              Array.isArray(parsed) ||
              Object.values(parsed).some((value) => typeof value !== "string")
            ) {
              throw new Error("MCP env 必须是 string -> string 的 JSON object");
            }
          }
          if (authToken !== row.auth_token || envJson !== row.env_json) update.run(authToken, envJson, row.id);
        }
      }
      if (tableExists(db, "app_settings")) {
        const row = db.prepare("SELECT value FROM app_settings WHERE key = 'image_provider'").get();
        if (row?.value) {
          let parsed;
          try {
            parsed = JSON.parse(row.value);
          } catch {
            throw new Error("image_provider 配置 JSON 损坏，拒绝迁移");
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("image_provider 配置格式损坏，拒绝迁移");
          }
          if (parsed.api_key != null && typeof parsed.api_key !== "string") {
            throw new Error("image_provider api_key 必须是字符串或空值，拒绝迁移");
          }
          const apiKey = typeof parsed.api_key === "string" ? parsed.api_key : "";
          const next = canonicalizeForCopy(apiKey, keyset);
          if (next !== parsed.api_key) {
            db.prepare("UPDATE app_settings SET value = ? WHERE key = 'image_provider'")
              .run(JSON.stringify({ ...parsed, api_key: next }));
          }
        }
      }
    })();
    db.exec("VACUUM");
  } finally {
    db.close();
  }
  if (existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`)) {
    throw new Error("迁移副本仍残留 WAL/SHM sidecar，拒绝交付");
  }
  assertIntegrity(dataDir);
}

function assertCanonicalReport(report) {
  for (const [surface, counts] of Object.entries(report.surfaces)) {
    if (counts.legacy_v1 || counts.plaintext || counts.unknown_envelope || counts.invalid) {
      throw new Error(`${surface} 迁移后仍有非 canonical 凭证`);
    }
  }
}

async function dryRun(dataDir) {
  assertIntegrity(dataDir);
  const before = inspectDatabase(dataDir);
  const tempDir = await mkdtemp(join(tmpdir(), "aiteam-credential-dry-run-"));
  try {
    await copyDatabase(dataDir, tempDir);
    migrateCopy(tempDir);
    const after = inspectDatabase(tempDir);
    assertCanonicalReport(after);
    return {
      command: "dry-run",
      success: true,
      source_read_only: true,
      database: before.database,
      before: { surfaces: before.surfaces },
      after: { surfaces: after.surfaces },
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertOutputOutsideSource(source, output) {
  if (source === output) throw new Error("输出目录不能与源数据目录相同");
  if (output.startsWith(`${source}${sep}`)) {
    throw new Error("输出目录不能位于源数据目录内部");
  }
}

async function resolveCopyPaths(sourceDataDir, outputDataDir) {
  const source = await realpath(resolve(sourceDataDir));
  const rawOutput = resolve(outputDataDir);
  let outputParent;
  try {
    outputParent = await realpath(dirname(rawOutput));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`输出父目录必须已存在：${dirname(rawOutput)}`);
    }
    throw error;
  }
  const output = join(outputParent, basename(rawOutput));
  assertOutputOutsideSource(source, output);
  return { source, output };
}

async function assertNoSymlinks(rootPath, label) {
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} 含符号链接，拒绝生成可能逃逸目录边界的副本`);
    }
    if (!stat.isDirectory()) continue;
    for (const entry of await readdir(current)) pending.push(join(current, entry));
  }
}

async function copyAssets(source, staging) {
  const assets = join(source, "assets");
  if (!await pathExists(assets)) return;
  await assertNoSymlinks(assets, "assets");
  await cp(assets, join(staging, "assets"), { recursive: true });
}

async function publishStaging(staging, output) {
  try {
    await mkdir(output, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`输出目录已存在，拒绝覆盖：${output}`);
    throw error;
  }
  const marker = join(output, ".aiteam-recovery-incomplete");
  try {
    await writeFile(marker, "incomplete\n", { flag: "wx", mode: 0o600 });
    for (const entry of await readdir(staging)) {
      await rename(join(staging, entry), join(output, entry));
    }
    await rm(marker, { force: true });
    await rmdir(staging);
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

async function migrateCopyCommand(sourceDataDir, outputDataDir, sourceStopped) {
  if (!outputDataDir) throw new Error("migrate-copy 必须显式提供 --output-dir");
  if (!sourceStopped) {
    throw new Error("migrate-copy 会复制 assets；请先停服并提供 --confirm-source-stopped");
  }
  const { source, output } = await resolveCopyPaths(sourceDataDir, outputDataDir);
  if (await pathExists(output)) throw new Error(`输出目录已存在，拒绝覆盖：${output}`);
  assertIntegrity(source);
  const parent = dirname(output);
  const staging = await mkdtemp(join(parent, ".aiteam-credential-migrate-"));
  let published = false;
  try {
    await chmod(staging, 0o700);
    await copyDatabase(source, staging);
    await chmod(join(staging, "aiteam.db"), 0o600);
    await copyAssets(source, staging);
    migrateCopy(staging);
    const after = inspectDatabase(staging);
    assertCanonicalReport(after);
    const report = {
      command: "migrate-copy",
      success: true,
      source_read_only: true,
      source_stopped_confirmed: true,
      source_database: join(source, "aiteam.db"),
      output_database: join(output, "aiteam.db"),
      after: { surfaces: after.surfaces },
    };
    await writeFile(join(staging, "credential-migration-report.json"), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
    await publishStaging(staging, output);
    published = true;
    return report;
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
  }
}

function clearCredentials(dataDir) {
  const dbPath = join(resolve(dataDir), "aiteam.db");
  const db = new Database(dbPath, { fileMustExist: true });
  const cleared = {
    providers: 0,
    mcp_auth: 0,
    mcp_env: 0,
    image_provider: 0,
    image_provider_reset: 0,
  };
  try {
    db.pragma("journal_mode = DELETE");
    db.pragma("secure_delete = ON");
    assertRecoverySchema(db);
    db.transaction(() => {
      if (tableExists(db, "providers")) {
        const result = db.prepare("UPDATE providers SET api_key = '' WHERE api_key IS NULL OR api_key != ''").run();
        cleared.providers = result.changes;
      }
      if (tableExists(db, "mcp_servers")) {
        const auth = db.prepare(
          "UPDATE mcp_servers SET auth_token = '' WHERE auth_token IS NULL OR auth_token != ''",
        ).run();
        const env = db.prepare(
          "UPDATE mcp_servers SET env_json = '{}' WHERE env_json IS NULL OR env_json NOT IN ('', '{}')",
        ).run();
        cleared.mcp_auth = auth.changes;
        cleared.mcp_env = env.changes;
      }
      if (tableExists(db, "app_settings")) {
        const row = db.prepare("SELECT value FROM app_settings WHERE key = 'image_provider'").get();
        if (row?.value) {
          let parsed;
          try {
            parsed = JSON.parse(row.value);
          } catch {
            parsed = null;
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            db.prepare("UPDATE app_settings SET value = ? WHERE key = 'image_provider'")
              .run(JSON.stringify({ base_url: "", api_key: "", model: "" }));
            cleared.image_provider_reset = 1;
          } else if (parsed.api_key !== "") {
            db.prepare("UPDATE app_settings SET value = ? WHERE key = 'image_provider'")
              .run(JSON.stringify({ ...parsed, api_key: "" }));
            cleared.image_provider = 1;
          }
        }
      }
    })();
    db.exec("VACUUM");
  } finally {
    db.close();
  }
  if (existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`) || existsSync(`${dbPath}-journal`)) {
    throw new Error("救援副本仍残留 SQLite sidecar，拒绝交付");
  }
  assertIntegrity(dataDir);
  return cleared;
}

async function rescueCopyCommand(sourceDataDir, outputDataDir, confirmation, sourceStopped) {
  if (confirmation !== "CLEAR_ALL_CREDENTIALS") {
    throw new Error("rescue-copy 必须提供 --confirm CLEAR_ALL_CREDENTIALS");
  }
  if (!outputDataDir) throw new Error("rescue-copy 必须显式提供 --output-dir");
  if (!sourceStopped) {
    throw new Error("rescue-copy 会复制 assets；请先停服并提供 --confirm-source-stopped");
  }
  const { source, output } = await resolveCopyPaths(sourceDataDir, outputDataDir);
  if (await pathExists(output)) throw new Error(`输出目录已存在，拒绝覆盖：${output}`);
  assertIntegrity(source);
  const parent = dirname(output);
  const staging = await mkdtemp(join(parent, ".aiteam-credential-rescue-"));
  let published = false;
  try {
    await chmod(staging, 0o700);
    await copyDatabase(source, staging);
    await chmod(join(staging, "aiteam.db"), 0o600);
    await copyAssets(source, staging);
    const cleared = clearCredentials(staging);
    const after = inspectDatabase(staging);
    for (const [surface, counts] of Object.entries(after.surfaces)) {
      if (counts.enc1 || counts.legacy_v1 || counts.plaintext || counts.unknown_envelope || counts.invalid) {
        throw new Error(`${surface} 救援后仍有非空或损坏凭证`);
      }
    }
    const report = {
      command: "rescue-copy",
      success: true,
      source_read_only: true,
      source_stopped_confirmed: true,
      source_database: join(source, "aiteam.db"),
      output_database: join(output, "aiteam.db"),
      cleared,
      after: { surfaces: after.surfaces },
    };
    await writeFile(join(staging, "credential-rescue-report.json"), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
    await publishStaging(staging, output);
    published = true;
    return report;
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
  }
}

function printReport(report, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  console.log(`数据库：${report.database ?? report.source_database ?? report.output_database}`);
  console.log(`源库只读：${report.source_read_only ? "是" : "否"}`);
  const surfaces = report.surfaces ?? report.after?.surfaces;
  for (const [surface, counts] of Object.entries(surfaces ?? {})) {
    console.log(
      `${surface}: empty=${counts.empty} enc1=${counts.enc1} enc:v1=${counts.legacy_v1} ` +
      `plaintext=${counts.plaintext} unknown=${counts.unknown_envelope} invalid=${counts.invalid}`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.command) throw new Error("用法：npm run credentials:recover -- inspect --data-dir <目录> [--json]");
  if (!options.dataDir) throw new Error("必须显式提供 --data-dir；工具不会默认指向真实工作区");
  if (options.command === "inspect") {
    printReport(inspectDatabase(options.dataDir), options.json);
    return;
  }
  if (options.command === "dry-run") {
    printReport(await dryRun(options.dataDir), options.json);
    return;
  }
  if (options.command === "migrate-copy") {
    printReport(
      await migrateCopyCommand(options.dataDir, options.outputDir, options.sourceStopped),
      options.json,
    );
    return;
  }
  if (options.command === "rescue-copy") {
    printReport(
      await rescueCopyCommand(
        options.dataDir,
        options.outputDir,
        options.confirm,
        options.sourceStopped,
      ),
      options.json,
    );
    return;
  }
  throw new Error(`暂不支持命令：${options.command}`);
}

main().catch((error) => {
  console.error(`[credential-recovery] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

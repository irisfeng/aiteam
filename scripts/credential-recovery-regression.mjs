#!/usr/bin/env node
import { createHash, randomBytes, scryptSync, createCipheriv } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "scripts/credential-recovery.mjs");
const dbUrl = pathToFileURL(join(root, "server/dist/db.js")).href;
const secretsUrl = pathToFileURL(join(root, "server/dist/secrets.js")).href;
const serverEntry = join(root, "server/dist/index.js");

let failures = 0;
function check(id, name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "✅" : "❌"} [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function legacyV1Encrypt(plain, material) {
  const key = scryptSync(material, "aiteam-secretbox-v1", 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return "enc:v1:" + Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.AITEAM_CREDENTIAL_KEY;
  delete env.AITEAM_SOURCE_CREDENTIAL_KEY;
  delete env.AITEAM_SECRET_KEY;
  delete env.AITEAM_SESSION_SECRET;
  return { ...env, ...overrides };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 20 && child.exitCode === null; i++) await delay(50);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function probeProductionServer(dataDir, credentialKey) {
  const port = await freePort();
  const child = spawn(process.execPath, [serverEntry], {
    env: cleanEnv({
      NODE_ENV: "production",
      AITEAM_DATA_DIR: dataDir,
      AITEAM_CREDENTIAL_KEY: credentialKey,
      AITEAM_SESSION_SECRET: "credential-recovery-production-probe-session-secret",
      AITEAM_HOST: "127.0.0.1",
      PORT: String(port),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  try {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        return { ok: false, detail: `server exited ${child.exitCode}: ${output.trim().slice(-500)}` };
      }
      const response = await fetch(`http://127.0.0.1:${port}/aiteam/`).catch(() => null);
      if (response?.ok) {
        const html = await response.text();
        return { ok: html.includes('id="root"'), detail: `status=${response.status}` };
      }
      await delay(100);
    }
    return { ok: false, detail: `server timeout: ${output.trim().slice(-500)}` };
  } finally {
    await stopChild(child);
  }
}

{
  const dataDir = mkdtempSync(join(tmpdir(), "aiteam-credential-inspect-"));
  try {
    const dbPath = join(dataDir, "aiteam.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, api_key TEXT NOT NULL DEFAULT '');
      CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, auth_token TEXT NOT NULL DEFAULT '', env_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
    `);
    db.prepare("INSERT INTO providers (id, name, api_key) VALUES (?, ?, ?)")
      .run("provider-1", "provider-one", "provider-secret-value");
    db.prepare("INSERT INTO mcp_servers (id, auth_token, env_json) VALUES (?, ?, ?)")
      .run("mcp-1", legacyV1Encrypt("mcp-secret-value", "legacy-material"), "{}");
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('image_provider', ?)")
      .run(JSON.stringify({ base_url: "https://images.test", api_key: "enc1:AA:BB:CC", model: "image-model" }));
    db.close();

    const before = sha256(dbPath);
    const child = spawnSync(process.execPath, [cli, "inspect", "--data-dir", dataDir, "--json"], {
      encoding: "utf8",
      env: { ...process.env },
    });
    const after = sha256(dbPath);
    let report = null;
    try { report = JSON.parse(child.stdout); } catch { /* asserted below */ }
    const serialized = `${child.stdout}\n${child.stderr}`;
    check(
      "REC-INSPECT",
      "只读检查仅报告凭证格式计数，不输出秘密且不修改源数据库",
      child.status === 0 &&
        report?.surfaces?.providers?.plaintext === 1 &&
        report?.surfaces?.mcp_auth?.legacy_v1 === 1 &&
        report?.surfaces?.image_provider?.enc1 === 1 &&
        before === after &&
        !serialized.includes("provider-secret-value") &&
        !serialized.includes("mcp-secret-value"),
      `exit=${child.status} unchanged=${before === after}`,
    );
    if (child.status !== 0 && child.stderr) console.error(child.stderr.trim());
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

{
  const dataDir = mkdtempSync(join(tmpdir(), "aiteam-credential-dry-run-"));
  try {
    const canonicalKey = "71".repeat(32);
    const legacyMaterial = "legacy-material-for-recovery-dry-run";
    const providerLegacy = legacyV1Encrypt("provider-secret-value", legacyMaterial);
    const envLegacy = legacyV1Encrypt(JSON.stringify({ TOKEN: "mcp-env-secret-value" }), legacyMaterial);
    const imageLegacy = legacyV1Encrypt("image-secret-value", legacyMaterial);
    const seed = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        const db = await import(${JSON.stringify(dbUrl)});
        const provider = db.createProvider({ name: "recovery-provider", base_url: "https://provider.test", api_key: "temporary" });
        const mcp = db.createMcpServer({ name: "recovery-mcp", kind: "http", auth_token: "temporary", env: { TOKEN: "temporary" } });
        db.setImageProvider({ base_url: "https://images.test", api_key: "temporary", model: "image-model" });
        db.db.prepare("UPDATE providers SET api_key = ? WHERE id = ?").run(${JSON.stringify(providerLegacy)}, provider.id);
        db.db.prepare("UPDATE mcp_servers SET auth_token = ?, env_json = ? WHERE id = ?")
          .run("plaintext-mcp-secret-value", ${JSON.stringify(envLegacy)}, mcp.id);
        const image = JSON.parse(db.getSetting("image_provider"));
        db.setSetting("image_provider", JSON.stringify({ ...image, api_key: ${JSON.stringify(imageLegacy)} }));
        db.db.close();
      `,
    ], {
      encoding: "utf8",
      env: cleanEnv({
        NODE_ENV: "test",
        AITEAM_DATA_DIR: dataDir,
        AITEAM_CREDENTIAL_KEY: canonicalKey,
      }),
    });
    const dbPath = join(dataDir, "aiteam.db");
    const before = sha256(dbPath);
    const child = spawnSync(process.execPath, [cli, "dry-run", "--data-dir", dataDir, "--json"], {
      encoding: "utf8",
      env: cleanEnv({
        AITEAM_CREDENTIAL_KEY: canonicalKey,
        AITEAM_SECRET_KEY: legacyMaterial,
      }),
    });
    const after = sha256(dbPath);
    let report = null;
    try { report = JSON.parse(child.stdout); } catch { /* asserted below */ }
    const migrated = report?.after?.surfaces;
    const serialized = `${child.stdout}\n${child.stderr}`;
    check(
      "REC-DRY",
      "dry-run 在临时副本完成混合凭证迁移，源数据库保持字节不变",
      seed.status === 0 &&
        child.status === 0 &&
        report?.success === true &&
        migrated?.providers?.enc1 === 1 &&
        migrated?.mcp_auth?.enc1 === 1 &&
        migrated?.mcp_env?.enc1 === 1 &&
        migrated?.image_provider?.enc1 === 1 &&
        before === after &&
        !serialized.includes("provider-secret-value") &&
        !serialized.includes("mcp-env-secret-value") &&
        !serialized.includes("image-secret-value"),
      `seed=${seed.status} exit=${child.status} unchanged=${before === after}`,
    );
    if (child.status !== 0 && child.stderr) console.error(child.stderr.trim());
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

{
  const rootDir = mkdtempSync(join(tmpdir(), "aiteam-credential-migrate-copy-"));
  const dataDir = join(rootDir, "source");
  const outputDir = join(rootDir, "migrated");
  mkdirSync(dataDir);
  try {
    const canonicalKey = "72".repeat(32);
    const legacyMaterial = "legacy-material-for-recovery-copy";
    const providerLegacy = legacyV1Encrypt("copy-provider-secret-value", legacyMaterial);
    const imageLegacy = legacyV1Encrypt("copy-image-secret-value", legacyMaterial);
    const seed = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        const db = await import(${JSON.stringify(dbUrl)});
        const provider = db.createProvider({
          name: "copy-provider",
          base_url: "https://provider-copy.test",
          api_key: "temporary",
        });
        const mcp = db.createMcpServer({
          name: "copy-mcp",
          kind: "http",
          auth_token: "temporary",
          env: { TOKEN: "copy-mcp-env-secret-value" },
        });
        db.setImageProvider({
          base_url: "https://images-copy.test",
          api_key: "temporary",
          model: "copy-image-model",
        });
        db.db.prepare("UPDATE providers SET api_key = ? WHERE id = ?").run(${JSON.stringify(providerLegacy)}, provider.id);
        db.db.prepare("UPDATE mcp_servers SET auth_token = ? WHERE id = ?")
          .run("copy-mcp-auth-secret-value", mcp.id);
        const image = JSON.parse(db.getSetting("image_provider"));
        db.setSetting("image_provider", JSON.stringify({ ...image, api_key: ${JSON.stringify(imageLegacy)} }));
        db.db.close();
      `,
    ], {
      encoding: "utf8",
      env: cleanEnv({
        NODE_ENV: "test",
        AITEAM_DATA_DIR: dataDir,
        AITEAM_CREDENTIAL_KEY: canonicalKey,
      }),
    });
    mkdirSync(join(dataDir, "assets"));
    writeFileSync(join(dataDir, "assets", "proof.txt"), "asset-proof");
    const sourceDb = join(dataDir, "aiteam.db");
    const before = sha256(sourceDb);
    const child = spawnSync(process.execPath, [
      cli,
      "migrate-copy",
      "--data-dir",
      dataDir,
      "--output-dir",
      outputDir,
      "--confirm-source-stopped",
      "--json",
    ], {
      encoding: "utf8",
      env: cleanEnv({
        AITEAM_CREDENTIAL_KEY: canonicalKey,
        AITEAM_SECRET_KEY: legacyMaterial,
      }),
    });
    const after = sha256(sourceDb);
    const outputDb = join(outputDir, "aiteam.db");
    const finalBeforeVerify = existsSync(outputDb) ? sha256(outputDb) : "";
    const verifyDir = join(rootDir, "verify-migrated");
    if (existsSync(outputDir)) cpSync(outputDir, verifyDir, { recursive: true });
    const verify = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        const db = await import(${JSON.stringify(dbUrl)});
        const secrets = await import(${JSON.stringify(secretsUrl)});
        const provider = db.listProviders().find((row) => row.name === "copy-provider");
        const mcp = db.listMcpServers().find((row) => row.name === "copy-mcp");
        const image = db.getImageProvider();
        const ok =
          provider?.base_url === "https://provider-copy.test" &&
          provider?.api_key === "copy-provider-secret-value" &&
          secrets.decryptSecret(mcp?.auth_token ?? "") === "copy-mcp-auth-secret-value" &&
          JSON.parse(secrets.decryptSecret(mcp?.env_json ?? "{}")).TOKEN === "copy-mcp-env-secret-value" &&
          image.base_url === "https://images-copy.test" &&
          image.api_key === "copy-image-secret-value" &&
          image.model === "copy-image-model";
        db.db.close();
        if (!ok) process.exit(9);
      `,
    ], {
      encoding: "utf8",
      env: cleanEnv({
        NODE_ENV: "production",
        AITEAM_DATA_DIR: verifyDir,
        AITEAM_CREDENTIAL_KEY: canonicalKey,
      }),
    });
    const serverProbe = verify.status === 0
      ? await probeProductionServer(verifyDir, canonicalKey)
      : { ok: false, detail: "credential verification failed before server probe" };
    const finalAfterVerify = existsSync(outputDb) ? sha256(outputDb) : "";
    let report = null;
    try { report = JSON.parse(child.stdout); } catch { /* asserted below */ }
    const rawOutput = existsSync(outputDb) ? readFileSync(outputDb) : Buffer.alloc(0);
    const serialized = `${child.stdout}\n${child.stderr}`;
    check(
      "REC-MIGRATE",
      "migrate-copy 排他生成可启动副本，保留非秘密配置与资产并清除旧值残留",
      seed.status === 0 &&
        child.status === 0 &&
        report?.success === true &&
        verify.status === 0 &&
        serverProbe.ok &&
        finalBeforeVerify === finalAfterVerify &&
        before === after &&
        existsSync(join(outputDir, "assets", "proof.txt")) &&
        !existsSync(join(outputDir, ".aiteam-recovery-incomplete")) &&
        !existsSync(`${outputDb}-wal`) &&
        !existsSync(`${outputDb}-shm`) &&
        !rawOutput.includes(Buffer.from("copy-provider-secret-value")) &&
        !rawOutput.includes(Buffer.from("copy-mcp-auth-secret-value")) &&
        !rawOutput.includes(Buffer.from("copy-mcp-env-secret-value")) &&
        !rawOutput.includes(Buffer.from("copy-image-secret-value")) &&
        !serialized.includes("copy-provider-secret-value") &&
        !serialized.includes("copy-mcp-auth-secret-value"),
      `seed=${seed.status} exit=${child.status} verify=${verify.status} server=${serverProbe.ok} sourceUnchanged=${before === after} finalUnchanged=${finalBeforeVerify === finalAfterVerify}`,
    );
    if (child.status !== 0 && child.stderr) console.error(child.stderr.trim());
    if (verify.status !== 0 && verify.stderr) console.error(verify.stderr.trim());
    if (!serverProbe.ok) console.error(serverProbe.detail);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

{
  const rootDir = mkdtempSync(join(tmpdir(), "aiteam-credential-rescue-copy-"));
  const dataDir = join(rootDir, "source");
  const outputDir = join(rootDir, "rescued");
  mkdirSync(dataDir);
  try {
    const seedKey = "73".repeat(32);
    const unrecoverableLegacy = legacyV1Encrypt("rescue-provider-secret-value", "lost-legacy-material");
    const imageLegacy = legacyV1Encrypt("rescue-image-secret-value", "lost-image-material");
    const seed = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        const db = await import(${JSON.stringify(dbUrl)});
        const provider = db.createProvider({
          name: "rescue-provider",
          base_url: "https://provider-rescue.test",
          api_key: "temporary",
        });
        const mcp = db.createMcpServer({
          name: "rescue-mcp",
          kind: "http",
          url: "https://mcp-rescue.test",
          auth_token: "temporary",
          env: { TOKEN: "temporary" },
        });
        db.setImageProvider({
          base_url: "https://images-rescue.test",
          api_key: "temporary",
          model: "rescue-image-model",
        });
        db.db.prepare("UPDATE providers SET api_key = ? WHERE id = ?")
          .run(${JSON.stringify(unrecoverableLegacy)}, provider.id);
        db.db.prepare("UPDATE mcp_servers SET auth_token = ?, env_json = ? WHERE id = ?")
          .run("enc1:corrupt:credential:value", JSON.stringify({ TOKEN: "rescue-mcp-env-secret-value" }), mcp.id);
        const image = JSON.parse(db.getSetting("image_provider"));
        db.setSetting("image_provider", JSON.stringify({
          ...image,
          api_key: ${JSON.stringify(imageLegacy)},
          preserved_option: "keep-me",
        }));
        db.db.close();
      `,
    ], {
      encoding: "utf8",
      env: cleanEnv({
        NODE_ENV: "test",
        AITEAM_DATA_DIR: dataDir,
        AITEAM_CREDENTIAL_KEY: seedKey,
      }),
    });
    mkdirSync(join(dataDir, "assets"));
    writeFileSync(join(dataDir, "assets", "rescue-proof.txt"), "rescue-asset-proof");
    const sourceDb = join(dataDir, "aiteam.db");
    const before = sha256(sourceDb);
    const child = spawnSync(process.execPath, [
      cli,
      "rescue-copy",
      "--data-dir",
      dataDir,
      "--output-dir",
      outputDir,
      "--confirm",
      "CLEAR_ALL_CREDENTIALS",
      "--confirm-source-stopped",
      "--json",
    ], {
      encoding: "utf8",
      env: cleanEnv(),
    });
    const after = sha256(sourceDb);
    const outputDb = join(outputDir, "aiteam.db");
    const finalBeforeVerify = existsSync(outputDb) ? sha256(outputDb) : "";
    const verifyDir = join(rootDir, "verify-rescued");
    if (existsSync(outputDir)) cpSync(outputDir, verifyDir, { recursive: true });
    let rawState = null;
    if (existsSync(outputDb)) {
      const rescued = new Database(outputDb, { readonly: true });
      const provider = rescued.prepare("SELECT name, base_url, api_key FROM providers WHERE name = 'rescue-provider'").get();
      const mcp = rescued.prepare("SELECT name, url, auth_token, env_json FROM mcp_servers WHERE name = 'rescue-mcp'").get();
      const image = JSON.parse(rescued.prepare("SELECT value FROM app_settings WHERE key = 'image_provider'").get().value);
      rawState = { provider, mcp, image };
      rescued.close();
    }
    const verifyKey = "74".repeat(32);
    const verify = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        const db = await import(${JSON.stringify(dbUrl)});
        const provider = db.listProviders().find((row) => row.name === "rescue-provider");
        const mcp = db.listMcpServers().find((row) => row.name === "rescue-mcp");
        const image = db.getImageProvider();
        const ok =
          provider?.base_url === "https://provider-rescue.test" &&
          provider?.api_key === "" &&
          mcp?.url === "https://mcp-rescue.test" &&
          mcp?.auth_token === "" &&
          mcp?.env_json === "{}" &&
          image.base_url === "https://images-rescue.test" &&
          image.api_key === "" &&
          image.model === "rescue-image-model";
        db.db.close();
        if (!ok) process.exit(9);
      `,
    ], {
      encoding: "utf8",
      env: cleanEnv({
        NODE_ENV: "production",
        AITEAM_DATA_DIR: verifyDir,
        AITEAM_CREDENTIAL_KEY: verifyKey,
      }),
    });
    const serverProbe = verify.status === 0
      ? await probeProductionServer(verifyDir, verifyKey)
      : { ok: false, detail: "credential verification failed before server probe" };
    const finalAfterVerify = existsSync(outputDb) ? sha256(outputDb) : "";
    const rawOutput = existsSync(outputDb) ? readFileSync(outputDb) : Buffer.alloc(0);
    const serialized = `${child.stdout}\n${child.stderr}`;
    check(
      "REC-RESCUE",
      "rescue-copy 无旧密钥也能只清副本凭证，保留业务配置与资产并可用新 key 启动",
      seed.status === 0 &&
        child.status === 0 &&
        verify.status === 0 &&
        serverProbe.ok &&
        finalBeforeVerify === finalAfterVerify &&
        before === after &&
        rawState?.provider?.api_key === "" &&
        rawState?.provider?.base_url === "https://provider-rescue.test" &&
        rawState?.mcp?.auth_token === "" &&
        rawState?.mcp?.env_json === "{}" &&
        rawState?.image?.api_key === "" &&
        rawState?.image?.base_url === "https://images-rescue.test" &&
        rawState?.image?.model === "rescue-image-model" &&
        rawState?.image?.preserved_option === "keep-me" &&
        existsSync(join(outputDir, "assets", "rescue-proof.txt")) &&
        !existsSync(join(outputDir, ".aiteam-recovery-incomplete")) &&
        !existsSync(`${outputDb}-wal`) &&
        !existsSync(`${outputDb}-shm`) &&
        !rawOutput.includes(Buffer.from("rescue-provider-secret-value")) &&
        !rawOutput.includes(Buffer.from("rescue-mcp-env-secret-value")) &&
        !rawOutput.includes(Buffer.from("rescue-image-secret-value")) &&
        !serialized.includes("rescue-provider-secret-value"),
      `seed=${seed.status} exit=${child.status} verify=${verify.status} server=${serverProbe.ok} sourceUnchanged=${before === after} finalUnchanged=${finalBeforeVerify === finalAfterVerify}`,
    );
    if (child.status !== 0 && child.stderr) console.error(child.stderr.trim());
    if (verify.status !== 0 && verify.stderr) console.error(verify.stderr.trim());
    if (!serverProbe.ok) console.error(serverProbe.detail);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

{
  const rootDir = mkdtempSync(join(tmpdir(), "aiteam-credential-fail-closed-"));
  const dataDir = join(rootDir, "source");
  const migrateOutput = join(rootDir, "migrate-output");
  const rescueOutput = join(rootDir, "rescue-output");
  const sourceStoppedOutput = join(rootDir, "source-stopped-output");
  const existingOutput = join(rootDir, "existing-output");
  const nestedOutput = join(dataDir, "nested-output");
  mkdirSync(dataDir);
  try {
    const dbPath = join(dataDir, "aiteam.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, api_key TEXT NOT NULL DEFAULT '');
      CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, auth_token TEXT NOT NULL DEFAULT '', env_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
    `);
    db.prepare("INSERT INTO providers (id, name, api_key) VALUES (?, ?, ?)")
      .run("provider-1", "provider-one", "explicit-key-sentinel");
    db.close();
    writeFileSync(join(dataDir, "credential.key"), Buffer.alloc(32, 91).toString("base64"), { mode: 0o600 });

    const beforeMissingCanonical = sha256(dbPath);
    const missingCanonical = spawnSync(process.execPath, [cli, "dry-run", "--data-dir", dataDir, "--json"], {
      encoding: "utf8",
      env: cleanEnv({
        AITEAM_SESSION_SECRET: "must-not-be-used-as-a-recovery-key",
      }),
    });
    const afterMissingCanonical = sha256(dbPath);
    const missingCanonicalOutput = `${missingCanonical.stdout}\n${missingCanonical.stderr}`;
    check(
      "REC-EXPLICIT-KEY",
      "恢复工具不读取 credential.key，也不把 session secret 当作 canonical key",
      missingCanonical.status !== 0 &&
        beforeMissingCanonical === afterMissingCanonical &&
        missingCanonicalOutput.includes("AITEAM_CREDENTIAL_KEY 未设置") &&
        !missingCanonicalOutput.includes("explicit-key-sentinel"),
      `exit=${missingCanonical.status} unchanged=${beforeMissingCanonical === afterMissingCanonical}`,
    );

    const legacyMaterial = "legacy-material-must-be-explicit";
    const writable = new Database(dbPath);
    writable.prepare("UPDATE providers SET api_key = ? WHERE id = ?")
      .run(legacyV1Encrypt("legacy-key-sentinel", legacyMaterial), "provider-1");
    writable.close();
    const beforeMissingLegacy = sha256(dbPath);
    const missingLegacy = spawnSync(process.execPath, [
      cli,
      "migrate-copy",
      "--data-dir",
      dataDir,
      "--output-dir",
      migrateOutput,
      "--confirm-source-stopped",
      "--json",
    ], {
      encoding: "utf8",
      env: cleanEnv({
        AITEAM_CREDENTIAL_KEY: "75".repeat(32),
        AITEAM_SESSION_SECRET: legacyMaterial,
      }),
    });
    const afterMissingLegacy = sha256(dbPath);
    const missingLegacyOutput = `${missingLegacy.stdout}\n${missingLegacy.stderr}`;
    check(
      "REC-LEGACY-KEY",
      "检测到 enc:v1 时只接受显式 AITEAM_SECRET_KEY，失败不发布输出",
      missingLegacy.status !== 0 &&
        beforeMissingLegacy === afterMissingLegacy &&
        !existsSync(migrateOutput) &&
        missingLegacyOutput.includes("AITEAM_SECRET_KEY 未设置") &&
        !missingLegacyOutput.includes("legacy-key-sentinel"),
      `exit=${missingLegacy.status} unchanged=${beforeMissingLegacy === afterMissingLegacy}`,
    );

    const missingConfirm = spawnSync(process.execPath, [
      cli,
      "rescue-copy",
      "--data-dir",
      dataDir,
      "--output-dir",
      rescueOutput,
      "--json",
    ], {
      encoding: "utf8",
      env: cleanEnv(),
    });
    check(
      "REC-CONFIRM",
      "rescue-copy 未提供精确确认短语时拒绝清空且不发布输出",
      missingConfirm.status !== 0 &&
        !existsSync(rescueOutput) &&
        `${missingConfirm.stdout}\n${missingConfirm.stderr}`.includes("CLEAR_ALL_CREDENTIALS"),
      `exit=${missingConfirm.status} output=${existsSync(rescueOutput)}`,
    );

    const missingSourceStopped = spawnSync(process.execPath, [
      cli,
      "rescue-copy",
      "--data-dir",
      dataDir,
      "--output-dir",
      sourceStoppedOutput,
      "--confirm",
      "CLEAR_ALL_CREDENTIALS",
      "--json",
    ], {
      encoding: "utf8",
      env: cleanEnv(),
    });
    check(
      "REC-SOURCE-STOPPED",
      "复制 assets 前必须由操作者明确确认源服务已停止",
      missingSourceStopped.status !== 0 &&
        !existsSync(sourceStoppedOutput) &&
        `${missingSourceStopped.stdout}\n${missingSourceStopped.stderr}`.includes("--confirm-source-stopped"),
      `exit=${missingSourceStopped.status} output=${existsSync(sourceStoppedOutput)}`,
    );

    mkdirSync(existingOutput);
    const marker = join(existingOutput, "keep.txt");
    writeFileSync(marker, "do-not-clobber");
    const noClobber = spawnSync(process.execPath, [
      cli,
      "migrate-copy",
      "--data-dir",
      dataDir,
      "--output-dir",
      existingOutput,
      "--confirm-source-stopped",
      "--json",
    ], {
      encoding: "utf8",
      env: cleanEnv({
        AITEAM_CREDENTIAL_KEY: "76".repeat(32),
        AITEAM_SECRET_KEY: legacyMaterial,
      }),
    });
    check(
      "REC-NOCLOBBER",
      "输出目录已存在时拒绝覆盖并保留原内容",
      noClobber.status !== 0 &&
        readFileSync(marker, "utf8") === "do-not-clobber" &&
        `${noClobber.stdout}\n${noClobber.stderr}`.includes("拒绝覆盖"),
      `exit=${noClobber.status}`,
    );

    const nested = spawnSync(process.execPath, [
      cli,
      "migrate-copy",
      "--data-dir",
      dataDir,
      "--output-dir",
      nestedOutput,
      "--confirm-source-stopped",
      "--json",
    ], {
      encoding: "utf8",
      env: cleanEnv({
        AITEAM_CREDENTIAL_KEY: "77".repeat(32),
        AITEAM_SECRET_KEY: legacyMaterial,
      }),
    });
    check(
      "REC-BOUNDARY",
      "输出目录不得位于源数据目录内部，避免恢复过程写入源工作区",
      nested.status !== 0 &&
        !existsSync(nestedOutput) &&
        `${nested.stdout}\n${nested.stderr}`.includes("源数据目录内部"),
      `exit=${nested.status} output=${existsSync(nestedOutput)}`,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

{
  const rootDir = mkdtempSync(join(tmpdir(), "aiteam-credential-adversarial-"));
  try {
    const imageSource = join(rootDir, "image-source");
    const imageOutput = join(rootDir, "image-output");
    mkdirSync(imageSource);
    const imageDb = new Database(join(imageSource, "aiteam.db"));
    imageDb.exec(`
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, api_key TEXT NOT NULL DEFAULT '');
      CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, auth_token TEXT NOT NULL DEFAULT '', env_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
    `);
    imageDb.prepare("INSERT INTO app_settings (key, value) VALUES ('image_provider', ?)")
      .run(JSON.stringify({
        base_url: "https://images-invalid.test",
        api_key: { token: "image-object-sentinel" },
        model: "image-model",
      }));
    imageDb.close();
    const inspectImage = spawnSync(process.execPath, [
      cli,
      "inspect",
      "--data-dir",
      imageSource,
      "--json",
    ], {
      encoding: "utf8",
      env: cleanEnv(),
    });
    let imageReport = null;
    try { imageReport = JSON.parse(inspectImage.stdout); } catch { /* asserted below */ }
    const migrateImage = spawnSync(process.execPath, [
      cli,
      "migrate-copy",
      "--data-dir",
      imageSource,
      "--output-dir",
      imageOutput,
      "--confirm-source-stopped",
      "--json",
    ], {
      encoding: "utf8",
      env: cleanEnv({ AITEAM_CREDENTIAL_KEY: "78".repeat(32) }),
    });
    check(
      "REC-IMAGE-TYPE",
      "文生图 api_key 存在但非字符串时标记 invalid 并拒绝发布迁移副本",
      inspectImage.status === 0 &&
        imageReport?.surfaces?.image_provider?.invalid === 1 &&
        migrateImage.status !== 0 &&
        !existsSync(imageOutput) &&
        !`${inspectImage.stdout}\n${inspectImage.stderr}\n${migrateImage.stdout}\n${migrateImage.stderr}`
          .includes("image-object-sentinel"),
      `inspect=${inspectImage.status} invalid=${imageReport?.surfaces?.image_provider?.invalid} migrate=${migrateImage.status}`,
    );

    const wrongSource = join(rootDir, "wrong-source");
    mkdirSync(wrongSource);
    const wrongDb = new Database(join(wrongSource, "aiteam.db"));
    wrongDb.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
    wrongDb.close();
    const wrongSchema = spawnSync(process.execPath, [
      cli,
      "inspect",
      "--data-dir",
      wrongSource,
      "--json",
    ], {
      encoding: "utf8",
      env: cleanEnv(),
    });
    check(
      "REC-SCHEMA",
      "不是 AiTeam 凭证结构的数据库必须 fail-closed",
      wrongSchema.status !== 0 &&
        `${wrongSchema.stdout}\n${wrongSchema.stderr}`.includes("数据库结构"),
      `exit=${wrongSchema.status}`,
    );

    const legacySource = join(rootDir, "legacy-source");
    const legacyOutput = join(rootDir, "legacy-output");
    mkdirSync(legacySource);
    const legacyDb = new Database(join(legacySource, "aiteam.db"));
    legacyDb.exec(`
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, api_key TEXT NOT NULL DEFAULT '');
      CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, auth_token TEXT NOT NULL DEFAULT '', env_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
    `);
    const legacyMaterial = "strict-legacy-material";
    legacyDb.prepare("INSERT INTO providers (id, name, api_key) VALUES (?, ?, ?)")
      .run("provider-1", "provider-one", `${legacyV1Encrypt("legacy-tail-sentinel", legacyMaterial)}!!!`);
    legacyDb.close();
    const legacyTail = spawnSync(process.execPath, [
      cli,
      "migrate-copy",
      "--data-dir",
      legacySource,
      "--output-dir",
      legacyOutput,
      "--confirm-source-stopped",
      "--json",
    ], {
      encoding: "utf8",
      env: cleanEnv({
        AITEAM_CREDENTIAL_KEY: "79".repeat(32),
        AITEAM_SECRET_KEY: legacyMaterial,
      }),
    });
    check(
      "REC-LEGACY-FORMAT",
      "enc:v1 尾随垃圾不是规范密文，必须拒绝且不发布输出",
      legacyTail.status !== 0 &&
        !existsSync(legacyOutput) &&
        !`${legacyTail.stdout}\n${legacyTail.stderr}`.includes("legacy-tail-sentinel"),
      `exit=${legacyTail.status} output=${existsSync(legacyOutput)}`,
    );

    const symlinkSource = join(rootDir, "symlink-source");
    const symlinkAlias = join(rootDir, "symlink-alias");
    const symlinkActualOutput = join(symlinkSource, "nested-via-symlink");
    mkdirSync(symlinkSource);
    const symlinkDb = new Database(join(symlinkSource, "aiteam.db"));
    symlinkDb.exec(`
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, api_key TEXT NOT NULL DEFAULT '');
      CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, auth_token TEXT NOT NULL DEFAULT '', env_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
    `);
    symlinkDb.close();
    symlinkSync(symlinkSource, symlinkAlias, "dir");
    const symlinkBoundary = spawnSync(process.execPath, [
      cli,
      "rescue-copy",
      "--data-dir",
      symlinkSource,
      "--output-dir",
      join(symlinkAlias, "nested-via-symlink"),
      "--confirm",
      "CLEAR_ALL_CREDENTIALS",
      "--confirm-source-stopped",
      "--json",
    ], {
      encoding: "utf8",
      env: cleanEnv(),
    });
    check(
      "REC-SYMLINK",
      "输出父目录经符号链接指回源目录时仍必须拒绝",
      symlinkBoundary.status !== 0 &&
        !existsSync(symlinkActualOutput) &&
        `${symlinkBoundary.stdout}\n${symlinkBoundary.stderr}`.includes("源数据目录内部"),
      `exit=${symlinkBoundary.status} output=${existsSync(symlinkActualOutput)}`,
    );

    const assetSource = join(rootDir, "asset-source");
    const assetOutput = join(rootDir, "asset-output");
    const externalAssets = join(rootDir, "external-assets");
    mkdirSync(assetSource);
    mkdirSync(externalAssets);
    writeFileSync(join(externalAssets, "outside.txt"), "outside-asset-sentinel");
    const assetDb = new Database(join(assetSource, "aiteam.db"));
    assetDb.exec(`
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, api_key TEXT NOT NULL DEFAULT '');
      CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, auth_token TEXT NOT NULL DEFAULT '', env_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
    `);
    assetDb.close();
    symlinkSync(externalAssets, join(assetSource, "assets"), "dir");
    const assetSymlink = spawnSync(process.execPath, [
      cli,
      "migrate-copy",
      "--data-dir",
      assetSource,
      "--output-dir",
      assetOutput,
      "--confirm-source-stopped",
      "--json",
    ], {
      encoding: "utf8",
      env: cleanEnv({ AITEAM_CREDENTIAL_KEY: "7a".repeat(32) }),
    });
    check(
      "REC-ASSET-SYMLINK",
      "assets 内含符号链接时拒绝生成非独立副本",
      assetSymlink.status !== 0 &&
        !existsSync(assetOutput) &&
        `${assetSymlink.stdout}\n${assetSymlink.stderr}`.includes("assets") &&
        !`${assetSymlink.stdout}\n${assetSymlink.stderr}`.includes("outside-asset-sentinel"),
      `exit=${assetSymlink.status} output=${existsSync(assetOutput)}`,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

console.log(`\n——— 凭证恢复工具回归：${failures ? `失败 ${failures}` : "全部通过"} ———`);
process.exit(failures ? 1 : 0);

#!/usr/bin/env node
import { createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const secretsUrl = pathToFileURL(join(root, "server/dist/secrets.js")).href;
const dbUrl = pathToFileURL(join(root, "server/dist/db.js")).href;

let failures = 0;
function check(id, name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "✅" : "❌"} [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.AITEAM_CREDENTIAL_KEY;
  delete env.AITEAM_SECRET_KEY;
  delete env.AITEAM_SESSION_SECRET;
  return { ...env, ...overrides };
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

{
  const dataDir = mkdtempSync(join(tmpdir(), "aiteam-secret-v1-"));
  try {
    const material = "legacy-aiteam-secret-key-for-regression";
    const stored = legacyV1Encrypt("legacy-provider-secret", material);
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        const mod = await import(${JSON.stringify(secretsUrl)});
        const plain = mod.decryptSecret(${JSON.stringify(stored)});
        if (!mod.isEncryptedSecret(${JSON.stringify(stored)}) || plain !== "legacy-provider-secret") process.exit(9);
      `,
    ], {
      encoding: "utf8",
      env: cleanEnv({
        NODE_ENV: "production",
        AITEAM_DATA_DIR: dataDir,
        AITEAM_SECRET_KEY: material,
      }),
    });
    check(
      "SEC-V1",
      "历史 enc:v1 凭证在提供原密钥时可识别并解密",
      child.status === 0,
      `exit=${child.status}`,
    );
    if (child.status !== 0 && child.stderr) console.error(child.stderr.trim());
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

{
  const dataDir = mkdtempSync(join(tmpdir(), "aiteam-secret-prod-key-"));
  try {
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `const mod = await import(${JSON.stringify(secretsUrl)}); mod.encryptSecret("production-secret");`,
    ], {
      encoding: "utf8",
      env: cleanEnv({
        NODE_ENV: "production",
        AITEAM_DATA_DIR: dataDir,
      }),
    });
    const output = `${child.stdout || ""}\n${child.stderr || ""}`;
    check(
      "SEC-KEY",
      "生产环境缺少 canonical 凭证密钥时拒绝加密且不生成 credential.key",
      child.status !== 0 &&
        /AITEAM_CREDENTIAL_KEY|credential\.key/.test(output) &&
        !existsSync(join(dataDir, "credential.key")),
      `exit=${child.status} keyFile=${existsSync(join(dataDir, "credential.key"))}`,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

{
  const dataDir = mkdtempSync(join(tmpdir(), "aiteam-secret-prod-boot-"));
  try {
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(dbUrl)});`,
    ], {
      encoding: "utf8",
      env: cleanEnv({
        NODE_ENV: "production",
        AITEAM_DATA_DIR: dataDir,
      }),
    });
    const output = `${child.stdout || ""}\n${child.stderr || ""}`;
    check(
      "SEC-BOOT",
      "空生产库缺少 canonical 凭证密钥时启动即 fail-closed",
      child.status !== 0 &&
        /AITEAM_CREDENTIAL_KEY|credential\.key/.test(output) &&
        !existsSync(join(dataDir, "credential.key")),
      `exit=${child.status} keyFile=${existsSync(join(dataDir, "credential.key"))}`,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

{
  const dataDir = mkdtempSync(join(tmpdir(), "aiteam-secret-surfaces-"));
  try {
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        const db = await import(${JSON.stringify(dbUrl)});
        const secrets = await import(${JSON.stringify(secretsUrl)});
        const provider = db.createProvider({
          name: "encrypted-provider",
          base_url: "https://provider.test",
          api_key: "provider-secret",
        });
        const mcp = db.createMcpServer({
          name: "encrypted-mcp",
          kind: "http",
          auth_token: "mcp-secret",
          env: { TOKEN: "mcp-env-secret" },
        });
        db.setImageProvider({
          base_url: "https://images.test",
          api_key: "image-secret",
          model: "image-model",
        });

        const rawProvider = db.db.prepare("SELECT api_key FROM providers WHERE id = ?").get(provider.id);
        const rawMcp = db.db.prepare("SELECT auth_token, env_json FROM mcp_servers WHERE id = ?").get(mcp.id);
        const rawImage = JSON.parse(db.db.prepare("SELECT value FROM app_settings WHERE key = 'image_provider'").get().value);
        const readProvider = db.getProvider(provider.id);
        const readImage = db.getImageProvider();
        const ok =
          rawProvider.api_key.startsWith("enc1:") &&
          rawMcp.auth_token.startsWith("enc1:") &&
          rawMcp.env_json.startsWith("enc1:") &&
          rawImage.api_key.startsWith("enc1:") &&
          readProvider.api_key === "provider-secret" &&
          secrets.decryptSecret(rawMcp.auth_token) === "mcp-secret" &&
          JSON.parse(secrets.decryptSecret(rawMcp.env_json)).TOKEN === "mcp-env-secret" &&
          readImage.api_key === "image-secret";
        db.db.close();
        if (!ok) process.exit(9);
      `,
    ], {
      encoding: "utf8",
      env: cleanEnv({
        NODE_ENV: "test",
        AITEAM_DATA_DIR: dataDir,
        AITEAM_CREDENTIAL_KEY: "11".repeat(32),
      }),
    });
    check(
      "SEC-SURFACE",
      "Provider、MCP 与文生图凭证新写入均为 enc1 且业务读取透明",
      child.status === 0,
      `exit=${child.status}`,
    );
    if (child.status !== 0 && child.stderr) console.error(child.stderr.trim());
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

{
  const dataDir = mkdtempSync(join(tmpdir(), "aiteam-secret-mixed-"));
  try {
    const legacyMaterial = "legacy-mixed-format-key";
    const canonicalKey = "22".repeat(32);
    const legacyProvider = legacyV1Encrypt("legacy-provider-secret", legacyMaterial);
    const legacyMcp = legacyV1Encrypt("legacy-mcp-secret", legacyMaterial);
    const legacyImage = legacyV1Encrypt("legacy-image-secret", legacyMaterial);

    const seed = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        const db = await import(${JSON.stringify(dbUrl)});
        const provider = db.createProvider({ name: "legacy-provider", api_key: "temporary" });
        const stable = db.createProvider({ name: "stable-provider", api_key: "stable-secret" });
        const mcp = db.createMcpServer({
          name: "legacy-mcp",
          kind: "http",
          auth_token: "temporary",
          env: { TOKEN: "temporary" },
        });
        db.setImageProvider({ base_url: "https://images.test", api_key: "temporary", model: "image-model" });
        db.db.prepare("UPDATE providers SET api_key = ? WHERE id = ?").run(${JSON.stringify(legacyProvider)}, provider.id);
        db.db.prepare("UPDATE mcp_servers SET auth_token = ?, env_json = ? WHERE id = ?")
          .run(${JSON.stringify(legacyMcp)}, JSON.stringify({ TOKEN: "plaintext-env-secret" }), mcp.id);
        const image = JSON.parse(db.getSetting("image_provider"));
        db.setSetting("image_provider", JSON.stringify({ ...image, api_key: ${JSON.stringify(legacyImage)} }));
        const stableRaw = db.db.prepare("SELECT api_key FROM providers WHERE id = ?").get(stable.id).api_key;
        console.log(stableRaw);
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

    const verifySource = `
      const db = await import(${JSON.stringify(dbUrl)});
      const secrets = await import(${JSON.stringify(secretsUrl)});
      const rawProvider = db.db.prepare("SELECT api_key FROM providers WHERE name = 'legacy-provider'").get();
      const stable = db.db.prepare("SELECT api_key FROM providers WHERE name = 'stable-provider'").get();
      const rawMcp = db.db.prepare("SELECT auth_token, env_json FROM mcp_servers WHERE name = 'legacy-mcp'").get();
      const rawImage = JSON.parse(db.getSetting("image_provider"));
      const provider = db.listProviders().find((row) => row.name === "legacy-provider");
      const image = db.getImageProvider();
      const ok =
        rawProvider.api_key.startsWith("enc1:") &&
        stable.api_key.startsWith("enc1:") &&
        rawMcp.auth_token.startsWith("enc1:") &&
        rawMcp.env_json.startsWith("enc1:") &&
        rawImage.api_key.startsWith("enc1:") &&
        provider.api_key === "legacy-provider-secret" &&
        secrets.decryptSecret(rawMcp.auth_token) === "legacy-mcp-secret" &&
        JSON.parse(secrets.decryptSecret(rawMcp.env_json)).TOKEN === "plaintext-env-secret" &&
        image.api_key === "legacy-image-secret";
      console.log(JSON.stringify({
        provider: rawProvider.api_key,
        stable: stable.api_key,
        token: rawMcp.auth_token,
        env: rawMcp.env_json,
        image: rawImage.api_key,
      }));
      db.db.close();
      if (!ok) process.exit(9);
    `;
    const migrationEnv = cleanEnv({
      NODE_ENV: "development",
      AITEAM_DATA_DIR: dataDir,
      AITEAM_CREDENTIAL_KEY: canonicalKey,
      AITEAM_SECRET_KEY: legacyMaterial,
    });
    const migrated = spawnSync(process.execPath, ["--input-type=module", "-e", verifySource], {
      encoding: "utf8",
      env: migrationEnv,
    });
    const productionVerified = spawnSync(process.execPath, ["--input-type=module", "-e", verifySource], {
      encoding: "utf8",
      env: cleanEnv({
        NODE_ENV: "production",
        AITEAM_DATA_DIR: dataDir,
        AITEAM_CREDENTIAL_KEY: canonicalKey,
      }),
    });
    const stableCiphertext = migrated.stdout.trim() === productionVerified.stdout.trim();
    check(
      "SEC-MIX",
      "开发/测试可原子迁移混合凭证，生产仅认证迁移后的稳定 enc1",
      seed.status === 0 && migrated.status === 0 && productionVerified.status === 0 && stableCiphertext,
      `seed=${seed.status} migrate=${migrated.status} production=${productionVerified.status} stable=${stableCiphertext}`,
    );
    if (seed.status !== 0 || migrated.status !== 0 || productionVerified.status !== 0) {
      const output = `${seed.stderr || ""}\n${migrated.stderr || ""}\n${productionVerified.stderr || ""}`.trim();
      if (output) console.error(output);
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

for (const credentialCase of [
  {
    id: "SEC-PROD-PLAINTEXT",
    name: "生产启动遇到 plaintext 凭证时拒绝原地迁移",
    stored: `production-plaintext-head:${"x".repeat(5_000)}:production-plaintext-tail`,
    legacyMaterial: "",
  },
  {
    id: "SEC-PROD-LEGACY",
    name: "生产启动即使持有旧密钥也拒绝原地迁移 enc:v1",
    stored: legacyV1Encrypt("production-legacy-sentinel", "production-legacy-material"),
    legacyMaterial: "production-legacy-material",
  },
]) {
  const dataDir = mkdtempSync(join(tmpdir(), "aiteam-secret-production-copy-only-"));
  try {
    const canonicalKey = "23".repeat(32);
    const dbPath = join(dataDir, "aiteam.db");
    const seed = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        const db = await import(${JSON.stringify(dbUrl)});
        const provider = db.createProvider({
          name: ${JSON.stringify(credentialCase.id)},
          api_key: "temporary",
        });
        db.db.prepare("UPDATE providers SET api_key = ? WHERE id = ?")
          .run(${JSON.stringify(credentialCase.stored)}, provider.id);
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
    const rawBefore = new Database(dbPath, { readonly: true });
    const before = rawBefore.prepare("SELECT api_key FROM providers WHERE name = ?")
      .get(credentialCase.id).api_key;
    rawBefore.close();
    const hashBefore = sha256(dbPath);
    const production = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(dbUrl)});`,
    ], {
      encoding: "utf8",
      env: cleanEnv({
        NODE_ENV: "production",
        AITEAM_DATA_DIR: dataDir,
        AITEAM_CREDENTIAL_KEY: canonicalKey,
        ...(credentialCase.legacyMaterial ? { AITEAM_SECRET_KEY: credentialCase.legacyMaterial } : {}),
      }),
    });
    const hashAfter = sha256(dbPath);
    const rawAfter = new Database(dbPath, { readonly: true });
    const after = rawAfter.prepare("SELECT api_key FROM providers WHERE name = ?")
      .get(credentialCase.id).api_key;
    rawAfter.close();
    const output = `${production.stdout || ""}\n${production.stderr || ""}`;
    check(
      credentialCase.id,
      credentialCase.name,
      seed.status === 0 &&
        production.status !== 0 &&
        /migrate-copy/.test(output) &&
        before === credentialCase.stored &&
        after === before &&
        hashAfter === hashBefore &&
        !output.includes(credentialCase.stored),
      `seed=${seed.status} production=${production.status} unchanged=${after === before && hashAfter === hashBefore} guided=${/migrate-copy/.test(output)}`,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

{
  const dataDir = mkdtempSync(join(tmpdir(), "aiteam-secret-production-preflight-"));
  try {
    const canonicalKey = "24".repeat(32);
    const dbPath = join(dataDir, "aiteam.db");
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, api_key TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT);
    `);
    legacyDb.prepare("INSERT INTO providers (id, name, api_key) VALUES (?, ?, ?)")
      .run("legacy-provider", "legacy-provider", `preflight-head:${"y".repeat(5_000)}:preflight-tail`);
    legacyDb.close();
    const hashBefore = sha256(dbPath);
    const production = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(dbUrl)});`,
    ], {
      encoding: "utf8",
      env: cleanEnv({
        NODE_ENV: "production",
        AITEAM_DATA_DIR: dataDir,
        AITEAM_CREDENTIAL_KEY: canonicalKey,
      }),
    });
    const hashAfter = sha256(dbPath);
    const untouched = new Database(dbPath, { readonly: true });
    const taskColumns = untouched.prepare("PRAGMA table_info(tasks)").all().map((column) => column.name);
    untouched.close();
    const output = `${production.stdout || ""}\n${production.stderr || ""}`;
    check(
      "SEC-PROD-PREFLIGHT",
      "生产旧库凭证门禁早于 WAL/CREATE/ALTER，拒启时 schema 与数据库字节均不变",
      production.status !== 0 &&
        /migrate-copy/.test(output) &&
        hashAfter === hashBefore &&
        taskColumns.join(",") === "id,title" &&
        !output.includes("preflight-head") &&
        !existsSync(`${dbPath}-wal`) &&
        !existsSync(`${dbPath}-shm`),
      `production=${production.status} unchanged=${hashAfter === hashBefore} columns=${taskColumns.join(",")} sidecars=${existsSync(`${dbPath}-wal`)}/${existsSync(`${dbPath}-shm`)}`,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

{
  const seedDir = mkdtempSync(join(tmpdir(), "aiteam-secret-wal-seed-"));
  const dataDir = mkdtempSync(join(tmpdir(), "aiteam-secret-wal-preflight-"));
  try {
    const seedPath = join(seedDir, "aiteam.db");
    const dbPath = join(dataDir, "aiteam.db");
    const seed = new Database(seedPath);
    seed.pragma("journal_mode = WAL");
    seed.pragma("wal_autocheckpoint = 0");
    seed.exec("CREATE TABLE providers (id TEXT PRIMARY KEY, api_key TEXT NOT NULL DEFAULT '')");
    seed.pragma("wal_checkpoint(TRUNCATE)");
    seed.prepare("INSERT INTO providers (id, api_key) VALUES (?, ?)").run(
      "wal-provider",
      "wal-only-plaintext-secret",
    );
    copyFileSync(seedPath, dbPath);
    copyFileSync(`${seedPath}-wal`, `${dbPath}-wal`);
    seed.close();

    const beforeFiles = readdirSync(dataDir).sort();
    const dbHashBefore = sha256(dbPath);
    const walHashBefore = sha256(`${dbPath}-wal`);
    const production = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(dbUrl)});`,
    ], {
      encoding: "utf8",
      env: cleanEnv({
        NODE_ENV: "production",
        AITEAM_DATA_DIR: dataDir,
        AITEAM_CREDENTIAL_KEY: "89".repeat(32),
      }),
    });
    const afterFiles = readdirSync(dataDir).sort();
    const dbUnchanged = sha256(dbPath) === dbHashBefore;
    const walUnchanged = sha256(`${dbPath}-wal`) === walHashBefore;
    const output = `${production.stdout || ""}\n${production.stderr || ""}`;
    check(
      "SEC-PROD-WAL-PREFLIGHT",
      "生产预检读取 WAL 中的旧凭证，但不得在缺 SHM 的源目录创建伴生文件",
      production.status !== 0 &&
        /migrate-copy/.test(output) &&
        !output.includes("wal-only-plaintext-secret") &&
        dbUnchanged &&
        walUnchanged &&
        beforeFiles.join(",") === "aiteam.db,aiteam.db-wal" &&
        afterFiles.join(",") === beforeFiles.join(","),
      `production=${production.status} unchanged=${dbUnchanged}/${walUnchanged} files=${beforeFiles.join("+")}->${afterFiles.join("+")}`,
    );
  } finally {
    rmSync(seedDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

{
  const dataDir = mkdtempSync(join(tmpdir(), "aiteam-secret-format-"));
  try {
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `const mod = await import(${JSON.stringify(secretsUrl)}); mod.canonicalizeSecret("enc:v2:unknown-format");`,
    ], {
      encoding: "utf8",
      env: cleanEnv({
        NODE_ENV: "test",
        AITEAM_DATA_DIR: dataDir,
        AITEAM_CREDENTIAL_KEY: "33".repeat(32),
      }),
    });
    const output = `${child.stdout || ""}\n${child.stderr || ""}`;
    check(
      "SEC-FORMAT",
      "未知 enc 前缀必须 fail-closed，禁止作为明文二次包装",
      child.status !== 0 && /未知|不支持/.test(output),
      `exit=${child.status}`,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

{
  const dataDir = mkdtempSync(join(tmpdir(), "aiteam-secret-envelope-"));
  try {
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        const mod = await import(${JSON.stringify(secretsUrl)});
        const stored = mod.encryptSecret("authenticated-secret");
        let rejected = false;
        try { mod.canonicalizeSecret(stored + ":unauthenticated"); } catch { rejected = true; }
        if (!rejected) process.exit(9);
      `,
    ], {
      encoding: "utf8",
      env: cleanEnv({
        NODE_ENV: "test",
        AITEAM_DATA_DIR: dataDir,
        AITEAM_CREDENTIAL_KEY: "34".repeat(32),
      }),
    });
    check(
      "SEC-ENVELOPE",
      "enc1 尾随字段与非规范信封必须 fail-closed",
      child.status === 0,
      `exit=${child.status}`,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

{
  const dataDir = mkdtempSync(join(tmpdir(), "aiteam-secret-image-tamper-"));
  try {
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        const db = await import(${JSON.stringify(dbUrl)});
        db.setImageProvider({
          base_url: "https://images.test",
          api_key: "image-secret",
          model: "image-model",
        });
        const row = db.db.prepare("SELECT value FROM app_settings WHERE key = 'image_provider'").get();
        const parsed = JSON.parse(row.value);
        const last = parsed.api_key.at(-1);
        parsed.api_key = parsed.api_key.slice(0, -1) + (last === "A" ? "B" : "A");
        db.db.prepare("UPDATE app_settings SET value = ? WHERE key = 'image_provider'")
          .run(JSON.stringify(parsed));
        let rejected = false;
        try { db.getImageProvider(); } catch { rejected = true; }
        db.db.close();
        if (!rejected) process.exit(9);
      `,
    ], {
      encoding: "utf8",
      env: cleanEnv({
        NODE_ENV: "test",
        AITEAM_DATA_DIR: dataDir,
        AITEAM_CREDENTIAL_KEY: "35".repeat(32),
      }),
    });
    check(
      "SEC-IMAGE",
      "文生图密文认证失败必须向上报错，不能伪装成未配置",
      child.status === 0,
      `exit=${child.status}`,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

{
  const dataDir = mkdtempSync(join(tmpdir(), "aiteam-secret-image-schema-rollback-"));
  try {
    const canonicalKey = "36".repeat(32);
    const seed = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        const db = await import(${JSON.stringify(dbUrl)});
        const provider = db.createProvider({
          name: "image-schema-rollback-provider",
          api_key: "temporary",
        });
        db.db.prepare("UPDATE providers SET api_key = ? WHERE id = ?")
          .run("image-schema-provider-plaintext", provider.id);
        db.setSetting("image_provider", JSON.stringify({
          base_url: "https://images-schema.test",
          api_key: { token: "image-object-sentinel" },
          model: "image-schema-model",
        }));
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
    const migrate = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(dbUrl)});`,
    ], {
      encoding: "utf8",
      env: cleanEnv({
        NODE_ENV: "test",
        AITEAM_DATA_DIR: dataDir,
        AITEAM_CREDENTIAL_KEY: canonicalKey,
      }),
    });
    const raw = new Database(join(dataDir, "aiteam.db"), { readonly: true });
    const providerAfter = raw.prepare(
      "SELECT api_key FROM providers WHERE name = 'image-schema-rollback-provider'"
    ).get().api_key;
    const imageAfter = JSON.parse(
      raw.prepare("SELECT value FROM app_settings WHERE key = 'image_provider'").get().value
    );
    raw.close();
    const output = `${migrate.stdout || ""}\n${migrate.stderr || ""}`;
    check(
      "SEC-IMAGE-SCHEMA",
      "开发/测试原地迁移遇到非字符串文生图 api_key 时失败且整体回滚",
      seed.status === 0 &&
        migrate.status !== 0 &&
        /image_provider api_key 必须是字符串或空值/.test(output) &&
        providerAfter === "image-schema-provider-plaintext" &&
        imageAfter?.api_key?.token === "image-object-sentinel",
      `seed=${seed.status} migrate=${migrate.status} providerRolledBack=${providerAfter === "image-schema-provider-plaintext"}`,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

{
  const dataDir = mkdtempSync(join(tmpdir(), "aiteam-secret-rollback-"));
  try {
    const canonicalKey = "44".repeat(32);
    const badLegacy = legacyV1Encrypt("unreadable-mcp-secret", "actual-legacy-key");
    const seed = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        const db = await import(${JSON.stringify(dbUrl)});
        const provider = db.createProvider({ name: "rollback-provider", api_key: "temporary" });
        const mcp = db.createMcpServer({ name: "rollback-mcp", kind: "http", auth_token: "temporary" });
        db.db.prepare("UPDATE providers SET api_key = ? WHERE id = ?").run("plaintext-provider-secret", provider.id);
        db.db.prepare("UPDATE mcp_servers SET auth_token = ? WHERE id = ?").run(${JSON.stringify(badLegacy)}, mcp.id);
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
    const migrate = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(dbUrl)});`,
    ], {
      encoding: "utf8",
      env: cleanEnv({
        NODE_ENV: "test",
        AITEAM_DATA_DIR: dataDir,
        AITEAM_CREDENTIAL_KEY: canonicalKey,
        AITEAM_SECRET_KEY: "wrong-legacy-key",
      }),
    });
    const raw = new Database(join(dataDir, "aiteam.db"), { readonly: true });
    const providerAfter = raw.prepare("SELECT api_key FROM providers WHERE name = 'rollback-provider'").get().api_key;
    const mcpAfter = raw.prepare("SELECT auth_token FROM mcp_servers WHERE name = 'rollback-mcp'").get().auth_token;
    raw.close();
    check(
      "SEC-ROLLBACK",
      "开发/测试原地迁移中任一旧密文解密失败时整体回滚",
      seed.status === 0 &&
        migrate.status !== 0 &&
        providerAfter === "plaintext-provider-secret" &&
        mcpAfter === badLegacy,
      `seed=${seed.status} migrate=${migrate.status}`,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

{
  const dataDir = mkdtempSync(join(tmpdir(), "aiteam-secret-restore-"));
  try {
    const originalKey = "55".repeat(32);
    const wrongKey = "66".repeat(32);
    const seed = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        const db = await import(${JSON.stringify(dbUrl)});
        db.createProvider({ name: "restore-provider", api_key: "restore-secret" });
        db.db.close();
      `,
    ], {
      encoding: "utf8",
      env: cleanEnv({
        NODE_ENV: "test",
        AITEAM_DATA_DIR: dataDir,
        AITEAM_CREDENTIAL_KEY: originalKey,
      }),
    });
    const restore = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(dbUrl)});`,
    ], {
      encoding: "utf8",
      env: cleanEnv({
        NODE_ENV: "production",
        AITEAM_DATA_DIR: dataDir,
        AITEAM_CREDENTIAL_KEY: wrongKey,
      }),
    });
    const output = `${restore.stdout || ""}\n${restore.stderr || ""}`;
    check(
      "SEC-RESTORE",
      "恢复 enc1 数据时 canonical key 不匹配必须在启动阶段失败",
      seed.status === 0 && restore.status !== 0 && /凭证解密失败/.test(output),
      `seed=${seed.status} restore=${restore.status}`,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

console.log(`\n——— 凭证回归结果：${failures ? `失败 ${failures}` : "全部通过"} ———`);
process.exit(failures ? 1 : 0);

#!/usr/bin/env node
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
  console.log(`✅ ${label}`);
}

const dataDir = mkdtempSync(join(tmpdir(), "aiteam-mission-event-migration-"));
const dbPath = join(dataDir, "aiteam.db");

try {
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE mission_events (
      mission_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (mission_id, sequence)
    );
    INSERT INTO mission_events (
      mission_id, organization_id, sequence, type, status, payload_json, created_at
    ) VALUES
      ('mission-legacy', 'org-alpha', 1, 'mission.created', 'queued', '{}', 1),
      ('mission-legacy', 'org-alpha', 2, 'mission.started', 'running', '{}', 2);
  `);
  legacy.close();

  process.env.AITEAM_DATA_DIR = dataDir;
  process.env.NODE_ENV = "test";
  const { db } = await import("../server/dist/db.js");
  const rows = db
    .prepare(
      `SELECT event_id, correlation_id, causation_id, sequence
       FROM mission_events
       WHERE mission_id = ?
       ORDER BY sequence ASC`,
    )
    .all("mission-legacy");

  assertEqual(rows.length, 2, "Legacy Mission events survive the migration");
  assertEqual(
    rows[0].event_id,
    "legacy:mission-legacy:1",
    "The first legacy event receives a deterministic id",
  );
  assertEqual(
    rows[0].correlation_id,
    "mission-legacy",
    "The first legacy event receives its Mission correlation",
  );
  assertEqual(
    rows[0].causation_id,
    null,
    "The first legacy event has no cause",
  );
  assertEqual(
    rows[1].causation_id,
    rows[0].event_id,
    "Legacy transition events form a causation chain",
  );

  let duplicateRejected = false;
  try {
    db.prepare(
      `INSERT INTO mission_events (
        event_id, correlation_id, causation_id,
        mission_id, organization_id, sequence, type, status, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
    ).run(
      rows[0].event_id,
      "mission-other",
      null,
      "mission-other",
      "org-alpha",
      1,
      "mission.created",
      "queued",
      3,
    );
  } catch {
    duplicateRejected = true;
  }
  assertEqual(
    duplicateRejected,
    true,
    "The event id uniqueness constraint rejects duplicates",
  );
  db.close();
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

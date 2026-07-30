#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

const dataDir = process.env.AITEAM_DATA_DIR || "/data";
const databasePath = join(dataDir, "aiteam.db");
const expectedEmptyTables = [
  "agent_memory",
  "agents",
  "app_settings",
  "approvals",
  "channel_agents",
  "channels",
  "documents",
  "mcp_servers",
  "messages",
  "mission_events",
  "mission_executions",
  "missions",
  "projects",
  "providers",
  "routines",
  "task_events",
  "tasks",
  "users",
  "verdicts",
];

if (!existsSync(databasePath)) {
  console.error("[aiteam-gray-data] aiteam.db does not exist");
  process.exit(1);
}

const database = new Database(databasePath, {
  readonly: true,
  fileMustExist: true,
});

try {
  database.pragma("query_only = ON");
  const integrity = database.pragma("integrity_check", { simple: true });
  const journalMode = database.pragma("journal_mode", { simple: true });
  const counts = Object.fromEntries(
    expectedEmptyTables.map((table) => {
      const row = database
        .prepare(`SELECT COUNT(*) AS count FROM "${table}"`)
        .get();
      return [table, Number(row?.count ?? -1)];
    }),
  );
  const skills = Number(
    database.prepare('SELECT COUNT(*) AS count FROM "skills"').get()?.count ??
      -1,
  );
  const nonEmpty = Object.entries(counts)
    .filter(([, count]) => count !== 0)
    .map(([table]) => table);
  const ok = integrity === "ok" && journalMode === "wal" && nonEmpty.length === 0;

  console.log(
    JSON.stringify({
      status: ok ? "ok" : "failed",
      integrity,
      journal_mode: journalMode,
      system_seed_counts: { skills },
      expected_empty_counts: counts,
      non_empty_tables: nonEmpty,
    }),
  );
  if (!ok) process.exitCode = 1;
} finally {
  database.close();
}

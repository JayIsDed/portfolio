import { Database } from "bun:sqlite";

const DB_PATH = process.env.SHELF_EVENTS_DB ?? "./data/shelf-events.db";

export function openDb(): Database {
  const db = new Database(DB_PATH, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  db.run(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      vitals TEXT NOT NULL,
      flags TEXT NOT NULL,
      severity_critical INTEGER NOT NULL DEFAULT 0,
      severity_warn INTEGER NOT NULL DEFAULT 0,
      severity_info INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('flag_appeared', 'flag_cleared')),
      flag TEXT NOT NULL,
      level TEXT NOT NULL CHECK(level IN ('critical', 'warn', 'info')),
      message TEXT,
      resolution_hint TEXT,
      snapshot_id INTEGER REFERENCES snapshots(id)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_flag ON events(flag)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON snapshots(timestamp)`);

  return db;
}

export interface ShelfEvent {
  timestamp: string;
  type: "flag_appeared" | "flag_cleared";
  flag: string;
  level: string;
  message?: string;
  resolution_hint?: string;
}

export function insertSnapshot(
  db: Database,
  snap: {
    timestamp: string;
    vitals: Record<string, any>;
    flags: any[];
    severity: { critical: number; warn: number; info: number };
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO snapshots (timestamp, vitals, flags, severity_critical, severity_warn, severity_info)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      snap.timestamp,
      JSON.stringify(snap.vitals),
      JSON.stringify(snap.flags),
      snap.severity.critical,
      snap.severity.warn,
      snap.severity.info,
    );
  return Number(result.lastInsertRowid);
}

export function insertEvent(db: Database, ev: ShelfEvent, snapshotId: number): void {
  db.prepare(
    `INSERT INTO events (timestamp, type, flag, level, message, resolution_hint, snapshot_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ev.timestamp,
    ev.type,
    ev.flag,
    ev.level,
    ev.message ?? null,
    ev.resolution_hint ?? null,
    snapshotId,
  );
}

export function getLastFlagsBeforeCurrent(db: Database, currentId: number): any[] {
  const row = db
    .prepare(`SELECT flags FROM snapshots WHERE id < ? ORDER BY id DESC LIMIT 1`)
    .get(currentId) as { flags: string } | null;
  return row ? JSON.parse(row.flags) : [];
}

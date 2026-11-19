// Shelf event logger — polls HA every 5 min, writes a snapshot row + flag
// transition events into the shared SQLite DB. The portfolio web reads from
// the same DB (read-only) to power the historical timeline scrub.
//
// Entity IDs and flag logic come from ../flags.ts so there's a single source
// of truth between the writer and the reader.

import { openDb, insertSnapshot, insertEvent, getLastFlagsBeforeCurrent, type ShelfEvent } from "./db";
import { evaluateFlags, buildVitals, severityOf, type EntityStates, type Flag } from "../flags";

const HA_URL = process.env.HA_URL;
const HA_TOKEN = process.env.HA_TOKEN;
const POLL_MS = parseInt(process.env.LOGGER_POLL_INTERVAL_MS ?? "300000"); // 5 min default

if (!HA_URL || !HA_TOKEN) {
  console.error("HA_URL and HA_TOKEN are required. Set them in .env or environment.");
  process.exit(1);
}

// Authoritative entity list (verified 2026-05-17). Mirrors server.ts.
const SHELF_ENTITIES = [
  "sensor.plant_shelf_temperatures_tank_center",
  "sensor.plant_shelf_temperatures_tank_substrate",
  "sensor.plant_shelf_temperatures_shelf_ambient",
  "sensor.plant_shelf_canopy_canopy_temperature",
  "sensor.plant_shelf_canopy_canopy_humidity",
  "sensor.plant_shelf_canopy_canopy_illuminance",
  "sensor.tank_chemistry_tds_tank",
  "sensor.cal_shelf_inkbird_10g_current_consumption",
  "sensor.cal_shelf_inkbird_10g_voltage",
  "sensor.calibration_shelf_strip_tapo_p316m_1_current_consumption",
  "sensor.calibration_shelf_strip_tapo_p316m_2_current_consumption",
  "sensor.calibration_shelf_strip_tapo_p316m_3_current_consumption",
  "sensor.calibration_shelf_strip_tapo_p316m_4_current_consumption",
  "sensor.calibration_shelf_strip_tapo_p316m_5_current_consumption",
  "sensor.calibration_shelf_strip_tapo_p316m_6_current_consumption",
  "sensor.outside_temperature",
  "sensor.outside_humidity",
  "light.grow_white",
];

// A login page in front of HA would turn every entity of every poll into a
// warning, so count them per poll and log only when the count changes.
let notJsonLast = 0;
function noteNotJson(n: number): void {
  if (n === notJsonLast) return;
  notJsonLast = n;
  console.warn(`${n} of ${SHELF_ENTITIES.length} HA replies were not JSON (logged when this changes)`);
}

async function fetchEntity(id: string, tally: { notJson: number }): Promise<any> {
  try {
    const res = await fetch(`${HA_URL}/api/states/${id}`, {
      headers: { Authorization: `Bearer ${HA_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    // Awaited so a 200 that isn't JSON (a login or proxy page in front of HA)
    // rejects inside this try instead of past it.
    return await res.json();
  } catch (e) {
    if (e instanceof SyntaxError) tally.notJson++;
    return null;
  }
}

async function fetchAllEntities(): Promise<EntityStates> {
  const out: EntityStates = {};
  const tally = { notJson: 0 };
  const results = await Promise.all(SHELF_ENTITIES.map((id) => fetchEntity(id, tally)));
  noteNotJson(tally.notJson);
  for (let i = 0; i < SHELF_ENTITIES.length; i++) {
    if (results[i]) out[SHELF_ENTITIES[i]] = results[i];
  }
  return out;
}

function diffFlags(prev: Flag[], curr: Flag[]): { appeared: Flag[]; cleared: Flag[] } {
  const prevSet = new Set(prev.map((f) => f.flag));
  const currSet = new Set(curr.map((f) => f.flag));
  return {
    appeared: curr.filter((f) => !prevSet.has(f.flag)),
    cleared: prev.filter((f) => !currSet.has(f.flag)),
  };
}

function resolutionHint(f: Flag, vitals: Record<string, any>): string {
  switch (f.flag) {
    case "tank_band_breach":
      return `Tank center returned to ${vitals.tank_center?.toFixed?.(2) ?? "?"}°F`;
    case "stratification":
      return "Stratification normalized";
    case "heater_overdraw":
      return `Heater returned to ${vitals.heater_power?.toFixed?.(1) ?? "?"}W`;
    case "basement_cold_drift":
      return `Shelf ambient recovered to ${vitals.shelf_ambient?.toFixed?.(1) ?? "?"}°F`;
    case "tds_out_of_range":
      return `TDS returned to ${vitals.tds?.toFixed?.(0) ?? "?"} ppm`;
    default:
      if (f.flag.startsWith("sensor_stale:")) return `${f.flag.split(":")[1]} resumed reporting`;
      return "Condition cleared";
  }
}

async function poll(db: ReturnType<typeof openDb>): Promise<void> {
  const now = new Date().toISOString();
  const entities = await fetchAllEntities();
  if (Object.keys(entities).length === 0) {
    console.warn(`[${now}] HA unreachable, skipping`);
    return;
  }

  const flags = evaluateFlags(entities);
  const vitals = buildVitals(entities);
  const severity = severityOf(flags);

  // One transaction per poll: if an event insert fails, the snapshot rolls
  // back with it, so the next poll diffs against the same previous snapshot
  // and records the transition then instead of losing it.
  const { snapId, appeared, cleared } = db.transaction(() => {
    const snapId = insertSnapshot(db, { timestamp: now, vitals, flags, severity });
    const { appeared, cleared } = diffFlags(getLastFlagsBeforeCurrent(db, snapId), flags);
    for (const f of appeared) {
      const ev: ShelfEvent = { timestamp: now, type: "flag_appeared", flag: f.flag, level: f.level, message: f.message };
      insertEvent(db, ev, snapId);
    }
    for (const f of cleared) {
      const ev: ShelfEvent = {
        timestamp: now,
        type: "flag_cleared",
        flag: f.flag,
        level: f.level,
        resolution_hint: resolutionHint(f, vitals),
      };
      insertEvent(db, ev, snapId);
    }
    return { snapId, appeared, cleared };
  })();

  for (const f of appeared) console.log(`[${now}] APPEARED ${f.flag} (${f.level}) — ${f.message}`);
  for (const f of cleared) console.log(`[${now}] CLEARED ${f.flag} — ${resolutionHint(f, vitals)}`);

  const summary = flags.length ? flags.map((f) => f.flag).join(", ") : "clean";
  console.log(`[${now}] snap #${snapId} — ${severity.critical}c/${severity.warn}w/${severity.info}i — ${summary}`);
}

console.log("shelf-event-logger starting");
console.log(`  HA: ${HA_URL}`);
console.log(`  poll: ${POLL_MS / 1000}s`);
console.log(`  entities: ${SHELF_ENTITIES.length}`);
console.log(`  db: ${process.env.SHELF_EVENTS_DB ?? "./data/shelf-events.db"}`);
// A throw in one poll is logged and the next poll tries again; left
// unhandled, it would exit the logger.
async function pollSafely(db: ReturnType<typeof openDb>): Promise<void> {
  try {
    await poll(db);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] poll failed:`, e);
  }
}

const db = openDb();
await pollSafely(db);
setInterval(() => pollSafely(db), POLL_MS);

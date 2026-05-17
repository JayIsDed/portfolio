import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { evaluateFlags, buildVitals, severityOf, type EntityStates, type Flag } from "./flags";

const PORT = parseInt(process.env.PORT ?? "3000");
const HA_URL = process.env.HA_URL;
const HA_TOKEN = process.env.HA_TOKEN;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "30000");
const SHELF_EVENTS_DB = process.env.SHELF_EVENTS_DB ?? "./data/shelf-events.db";
const PUBLIC_DIR = join(import.meta.dir, "public");

if (!HA_URL) {
  console.error("HA_URL is required (e.g. http://homeassistant.local:8123). Set it in .env or environment.");
  process.exit(1);
}

// Live HA entity IDs (verified against /api/states on 2026-05-17).
// The shelf-event-logger uses an older mapping; this list is authoritative for the portfolio.
const SHELF_ENTITIES = [
  "sensor.plant_shelf_temperatures_tank_center",
  "sensor.plant_shelf_temperatures_tank_substrate",
  "sensor.plant_shelf_temperatures_shelf_ambient",
  "sensor.plant_shelf_canopy_canopy_temperature",
  "sensor.plant_shelf_canopy_canopy_humidity",
  "sensor.plant_shelf_canopy_canopy_illuminance",
  "sensor.tank_chemistry_tds_tank",                              // TDS (was: calibration_shelf_tds)
  "sensor.cal_shelf_inkbird_10g_current_consumption",            // Heater draw (Inkbird P316M-style plug)
  "sensor.cal_shelf_inkbird_10g_voltage",                        // Heater voltage
  "sensor.calibration_shelf_strip_tapo_p316m_1_current_consumption", // Outlet 1 — Pump
  "sensor.calibration_shelf_strip_tapo_p316m_2_current_consumption",
  "sensor.calibration_shelf_strip_tapo_p316m_3_current_consumption", // Outlet 3 — Grow light
  "sensor.calibration_shelf_strip_tapo_p316m_4_current_consumption",
  "sensor.calibration_shelf_strip_tapo_p316m_5_current_consumption",
  "sensor.calibration_shelf_strip_tapo_p316m_6_current_consumption",
  "sensor.outside_temperature",
  "sensor.outside_humidity",
  "light.grow_white",
];

interface LiveState {
  timestamp: string;
  mode: "live" | "stale";
  vitals: Record<string, number | string | boolean>;
  flags: Flag[];
  severity: { critical: number; warn: number; info: number };
}

let liveState: LiveState | null = null;
let lastPollOk = 0;

async function fetchEntity(id: string): Promise<any> {
  if (!HA_TOKEN) return null;
  try {
    const res = await fetch(`${HA_URL}/api/states/${id}`, {
      headers: { Authorization: `Bearer ${HA_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function pollHA(): Promise<void> {
  const now = new Date().toISOString();
  const entities: EntityStates = {};

  const results = await Promise.all(SHELF_ENTITIES.map((id) => fetchEntity(id)));
  for (let i = 0; i < SHELF_ENTITIES.length; i++) {
    if (results[i]) entities[SHELF_ENTITIES[i]] = results[i];
  }

  if (Object.keys(entities).length === 0) {
    if (liveState) liveState.mode = "stale";
    return;
  }

  const flags = evaluateFlags(entities);
  const vitals = buildVitals(entities);
  const severity = severityOf(flags);

  liveState = { timestamp: now, mode: "live", vitals, flags, severity };
  lastPollOk = Date.now();
}

// ─── DB (read-only) ────────────────────────────────────────────────────────────

let db: Database | null = null;
function openShelfDb(): Database | null {
  if (db) return db;
  if (!existsSync(SHELF_EVENTS_DB)) {
    console.warn(`Shelf events DB not found at ${SHELF_EVENTS_DB} — history disabled`);
    return null;
  }
  try {
    db = new Database(SHELF_EVENTS_DB, { readonly: true });
    return db;
  } catch (e) {
    console.warn(`Could not open shelf events DB: ${e}`);
    return null;
  }
}

function getSnapshotAt(ts: string): LiveState | null {
  const d = openShelfDb();
  if (!d) return null;
  const row = d
    .prepare(`SELECT timestamp, vitals, flags, severity_critical, severity_warn, severity_info
              FROM snapshots WHERE timestamp <= ? ORDER BY timestamp DESC LIMIT 1`)
    .get(ts) as any;
  if (!row) return null;
  return {
    timestamp: row.timestamp,
    mode: "live",
    vitals: JSON.parse(row.vitals),
    flags: JSON.parse(row.flags),
    severity: {
      critical: row.severity_critical,
      warn: row.severity_warn,
      info: row.severity_info,
    },
  };
}

function getEvents(from: string, to: string) {
  const d = openShelfDb();
  if (!d) return [];
  return d
    .prepare(`SELECT timestamp, type, flag, level, message, resolution_hint
              FROM events WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp`)
    .all(from, to);
}

function getRange(): { earliest: string; latest: string } | null {
  const d = openShelfDb();
  if (!d) return null;
  const row = d.prepare(`SELECT MIN(timestamp) AS earliest, MAX(timestamp) AS latest FROM snapshots`).get() as any;
  if (!row?.earliest) return null;
  return { earliest: row.earliest, latest: row.latest };
}

// For each requested vital key, find the most recent snapshot where vitals[key] > threshold.
// Used to render "last on N ago · X.X W" captions under each outlet pill.
function getLastActivations(keys: string[], threshold = 1): Record<string, { last_active_at: string; last_active_watts: number } | null> {
  const d = openShelfDb();
  const out: Record<string, { last_active_at: string; last_active_watts: number } | null> = {};
  if (!d) {
    for (const k of keys) out[k] = null;
    return out;
  }
  for (const k of keys) {
    const row = d
      .prepare(
        `SELECT timestamp, json_extract(vitals, '$.' || ?) AS v
         FROM snapshots
         WHERE json_extract(vitals, '$.' || ?) > ?
         ORDER BY timestamp DESC LIMIT 1`
      )
      .get(k, k, threshold) as any;
    out[k] = row ? { last_active_at: row.timestamp, last_active_watts: Number(row.v) } : null;
  }
  return out;
}

// ─── Static file serving ──────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
};

// Asset cache policy: HTML stays fresh, static files get a short browser cache.
// 5 min on assets keeps recruiters seeing latest changes without burning bandwidth.
function cacheFor(ext: string): string {
  if (ext === ".html" || ext === "") return "no-cache";
  if (ext === ".pdf") return "public, max-age=3600";
  return "public, max-age=300";
}

function serveStatic(pathname: string): Response | null {
  let p = decodeURIComponent(pathname);
  if (p === "/" || p === "") p = "/index.html";
  const safe = normalize(join(PUBLIC_DIR, p));
  if (!safe.startsWith(PUBLIC_DIR)) return new Response("Forbidden", { status: 403 });
  if (!existsSync(safe) || !statSync(safe).isFile()) return null;
  const ext = extname(safe).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  const file = readFileSync(safe);
  return new Response(file, { headers: { "content-type": type, "cache-control": cacheFor(ext) } });
}

// Security headers applied to every response. Inter CSS lives on rsms.me; SVG
// uses an internal <style> block so style-src needs 'unsafe-inline'. No inline
// scripts anywhere, so script-src stays strict 'self'.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://rsms.me",
  "font-src 'self' https://rsms.me",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

function withSecurity(res: Response): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!h.has(k)) h.set(k, v);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const json = (data: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init?.headers ?? {}) },
  });

const ROBOTS_TXT = `User-agent: *
Allow: /
Disallow: /api/

Sitemap: https://jason.pancake3d.com/sitemap.xml
`;

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://jason.pancake3d.com/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>https://jason.pancake3d.com/resume.pdf</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>
</urlset>
`;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const res = await route(url, path);
    return withSecurity(res);
  },
});

async function route(url: URL, path: string): Promise<Response> {
  // ── /api/health — severity only, for ambient color (cache-friendly, public) ──
  if (path === "/api/health") {
    const fresh = Date.now() - lastPollOk < POLL_INTERVAL_MS * 3;
    if (!liveState || !fresh) {
      return json({ critical: 0, warn: 0, info: 0, mode: "unknown", timestamp: new Date().toISOString() });
    }
    return json({
      critical: liveState.severity.critical,
      warn: liveState.severity.warn,
      info: liveState.severity.info,
      mode: liveState.mode,
      timestamp: liveState.timestamp,
    });
  }

  // ── /api/shelf/state — full live vitals + flags ──
  if (path === "/api/shelf/state") {
    if (!liveState) return json({ error: "not_ready" }, { status: 503 });
    return json(liveState);
  }

  // ── /api/shelf/history?ts=ISO — historical reconstruction ──
  if (path === "/api/shelf/history") {
    const ts = url.searchParams.get("ts");
    if (!ts) return json({ error: "missing ts" }, { status: 400 });
    const snap = getSnapshotAt(ts);
    if (!snap) return json({ error: "no_snapshot" }, { status: 404 });
    return json({ ...snap, mode: "replay" });
  }

  // ── /api/shelf/events?from=&to= — flag transitions for timeline markers ──
  if (path === "/api/shelf/events") {
    const from = url.searchParams.get("from") ?? new Date(Date.now() - 30 * 86400000).toISOString();
    const to = url.searchParams.get("to") ?? new Date().toISOString();
    return json({ events: getEvents(from, to) });
  }

  // ── /api/shelf/range — earliest+latest snapshot timestamps (timeline bounds) ──
  if (path === "/api/shelf/range") {
    const r = getRange();
    if (!r) return json({ earliest: null, latest: null });
    return json(r);
  }

  // ── /api/shelf/last-activations — last "on" sample for each load (for dim caption row) ──
  if (path === "/api/shelf/last-activations") {
    const keys = ["outlet_1_pump", "outlet_3_led", "heater_power"];
    return json(getLastActivations(keys));
  }

  // ── /robots.txt + /sitemap.xml ──
  if (path === "/robots.txt") {
    return new Response(ROBOTS_TXT, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" },
    });
  }
  if (path === "/sitemap.xml") {
    return new Response(SITEMAP_XML, {
      headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=86400" },
    });
  }

  // ── /healthz — for Docker healthcheck ──
  if (path === "/healthz") {
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  }

  // ── Static files ──
  const file = serveStatic(path);
  if (file) return file;

  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

console.log(`portfolio server running at http://localhost:${server.port}`);
console.log(`  HA: ${HA_URL}`);
console.log(`  shelf events DB: ${SHELF_EVENTS_DB} (${existsSync(SHELF_EVENTS_DB) ? "found" : "missing"})`);
console.log(`  poll interval: ${POLL_INTERVAL_MS / 1000}s`);

if (HA_TOKEN) {
  pollHA();
  setInterval(pollHA, POLL_INTERVAL_MS);
} else {
  console.warn("HA_TOKEN missing — live state disabled");
}

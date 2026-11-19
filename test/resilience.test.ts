// Runs the real server and logger as child processes against a fake Home
// Assistant, so a crash shows up as a process that exited. No network beyond
// localhost, no dependencies beyond Bun. Run with `bun test`.
import { afterAll, afterEach, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TMP = mkdtempSync(join(tmpdir(), "portfolio-test-"));
const NOW = new Date().toISOString();

// Fake HA. "json" answers like HA; "html" answers 200 with a page, the way a
// login or proxy page in front of HA would; "one-html" answers that page for
// the first entity it is asked about and JSON for the rest.
let haMode: "json" | "html" | "one-html" = "json";
let badPath = "";
const hits = new Map<string, number>();
const ha = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (haMode === "html" || (haMode === "one-html" && path === (badPath ||= path))) {
      return new Response("<html>sign in</html>", { headers: { "content-type": "text/html" } });
    }
    const id = path.split("/").pop();
    return Response.json({ entity_id: id, state: "77.0", attributes: {}, last_changed: NOW, last_updated: NOW });
  },
});
// Each poll asks for every entity once, so the least-asked path counts polls,
// and equal counts everywhere means no poll is half answered.
const polls = () => (hits.size ? Math.min(...hits.values()) : 0);
const between = () => hits.size > 0 && polls() === Math.max(...hits.values());

const procs: Subprocess[] = [];
afterEach(async () => {
  for (const p of procs.splice(0)) {
    p.kill();
    await p.exited;
  }
  hits.clear();
  haMode = "json";
  badPath = "";
});
afterAll(() => {
  ha.stop(true);
  rmSync(TMP, { recursive: true, force: true });
});

async function until(cond: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond()) && Date.now() < end) await Bun.sleep(25);
}

let runs = 0;
function spawn(script: string, env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, "run", script], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: TMP,
      NODE_ENV: "production",
      // Set explicitly: these win over anything a local .env would load.
      HA_URL: ha.url.origin,
      HA_TOKEN: "test-token",
      SHELF_EVENTS_DB: join(TMP, `${script.replace(/\W/g, "_")}-${++runs}.db`),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push(proc);
  const log = { text: "" };
  for (const s of [proc.stdout, proc.stderr]) {
    (async () => {
      for await (const chunk of s) log.text += new TextDecoder().decode(chunk);
    })();
  }
  return { proc, log };
}

async function startServer(env: Record<string, string>) {
  const { proc, log } = spawn("server.ts", { PORT: "0", POLL_INTERVAL_MS: "100", ...env });
  await until(() => /localhost:\d+/.test(log.text) || proc.exitCode !== null);
  const base = `http://127.0.0.1:${log.text.match(/localhost:(\d+)/)?.[1]}`;
  return { proc, log, base };
}

test("server stays up on a 200 non-JSON HA reply and keeps its last good reading", async () => {
  const { proc, log, base } = await startServer({});
  await until(async () => (await fetch(`${base}/api/shelf/state`).catch(() => null))?.status === 200);
  const good = await (await fetch(`${base}/api/shelf/state`)).json();

  // Switch between polls, in the same tick as the check, so no poll mixes
  // good and bad replies.
  let from = 0;
  await until(() => {
    if (!between()) return false;
    haMode = "html";
    from = polls();
    return true;
  });
  await until(() => polls() >= from + 2 || proc.exitCode !== null);

  expect(proc.exitCode).toBeNull();
  const res = await fetch(`${base}/api/shelf/state`);
  expect(res.status).toBe(200);
  const now = await res.json();
  expect(now.mode).toBe("stale");
  expect(now.vitals).toEqual(good.vitals);
  // Two or more polls of nothing but non-JSON: one warning, not one per entity.
  expect(log.text.match(/HA replies were not JSON/g)).toHaveLength(1);
}, 15000);

test("logger stays up on a 200 non-JSON HA reply and writes once HA recovers", async () => {
  haMode = "html";
  const { proc, log } = spawn("logger/logger.ts", { LOGGER_POLL_INTERVAL_MS: "100" });
  await until(() => polls() >= 2 || proc.exitCode !== null);
  expect(proc.exitCode).toBeNull();

  haMode = "json";
  await until(() => log.text.includes("snap #1") || proc.exitCode !== null);
  expect(proc.exitCode).toBeNull();
  expect(log.text).toContain("snap #1");
}, 15000);

test("logger skips one non-JSON entity and still writes each poll's snapshot", async () => {
  haMode = "one-html";
  const { proc, log } = spawn("logger/logger.ts", { LOGGER_POLL_INTERVAL_MS: "100" });
  await until(() => /snap #3|poll failed/.test(log.text) || proc.exitCode !== null);

  expect(proc.exitCode).toBeNull();
  expect(log.text).not.toContain("poll failed");
  expect(log.text).toContain("snap #3");
  // Three polls with the same one bad entity: one warning line.
  expect(log.text.match(/HA replies were not JSON/g)).toHaveLength(1);
  expect(log.text).toMatch(/\b1 of \d+ HA replies were not JSON/);
}, 15000);

test("logger writes a poll's snapshot and its events together or not at all", async () => {
  // HTML first: the logger opens the DB and creates its tables, but writes nothing.
  haMode = "html";
  const dbPath = join(TMP, "logger-tx.db");
  const { proc, log } = spawn("logger/logger.ts", { LOGGER_POLL_INTERVAL_MS: "100", SHELF_EVENTS_DB: dbPath });
  await until(() => polls() >= 1 || proc.exitCode !== null);
  const db = new Database(dbPath);
  db.run("PRAGMA busy_timeout = 5000");
  db.run("CREATE TRIGGER fail_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'events insert failed'); END");

  // Every fake reading is 77, which puts TDS out of range, so the first
  // snapshot raises a flag and its event insert fails.
  haMode = "json";
  await until(() => log.text.includes("poll failed") || proc.exitCode !== null);
  db.run("DROP TRIGGER fail_events");
  await until(() => log.text.includes("snap #") || proc.exitCode !== null);

  expect(proc.exitCode).toBeNull();
  expect(log.text).toContain("poll failed");
  expect(log.text).toContain("snap #");
  // Kept separately, the failed poll's snapshot would stay, the next poll
  // would diff against it, and the flag_appeared marker would never land.
  const { n } = db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'flag_appeared'").get() as { n: number };
  db.close();
  expect(n).toBeGreaterThan(0);
}, 15000);

// Every response should carry the same five headers as a plain /healthz.
function expectSecurityHeaders(ok: Headers, got: Headers) {
  for (const h of [
    "content-security-policy",
    "strict-transport-security",
    "x-content-type-options",
    "referrer-policy",
    "permissions-policy",
  ]) {
    expect(ok.get(h)).toBeTruthy();
    expect(got.get(h)).toBe(ok.get(h));
  }
}

// fetch() won't send a malformed Host header, so write the request by hand.
async function rawGet(base: string, head: string): Promise<{ status: number; headers: Headers }> {
  const { hostname, port } = new URL(base);
  const text = await new Promise<string>((resolve, reject) => {
    let out = "";
    const sock = connect(Number(port), hostname, () => sock.write(`${head}\r\n\r\n`));
    sock.on("data", (d) => (out += d));
    sock.on("close", () => resolve(out));
    sock.on("error", reject);
  });
  const [status = "", ...lines] = text.split("\r\n\r\n")[0].split("\r\n");
  const headers = new Headers();
  for (const line of lines) {
    const i = line.indexOf(":");
    headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return { status: Number(status.split(" ")[1]), headers };
}

test("malformed %-escape gets a 400 with the same security headers as any response", async () => {
  const { base } = await startServer({});
  const ok = await fetch(`${base}/healthz`);
  const bad = await fetch(`${base}/%E0%A4%A`);

  expect(bad.status).toBe(400);
  expectSecurityHeaders(ok.headers, bad.headers);
}, 15000);

test("a malformed or missing Host header gets a 400 with the security headers", async () => {
  const { proc, base } = await startServer({});
  const ok = await fetch(`${base}/healthz`);
  for (const head of ["GET / HTTP/1.1\r\nHost: a b\r\nConnection: close", "GET / HTTP/1.0"]) {
    const bad = await rawGet(base, head);
    expect(bad.status).toBe(400);
    expectSecurityHeaders(ok.headers, bad.headers);
  }
  expect(proc.exitCode).toBeNull();
}, 15000);

test("a throw inside a route gets a 500 with the security headers, and the server stays up", async () => {
  // An empty file opens as a valid SQLite DB with no tables, so the history
  // query throws inside route().
  const empty = join(TMP, "empty.db");
  writeFileSync(empty, "");
  const { proc, base } = await startServer({ SHELF_EVENTS_DB: empty });
  const ok = await fetch(`${base}/healthz`);
  const bad = await fetch(`${base}/api/shelf/history?ts=2026-01-01T00:00:00Z`);

  expect(bad.status).toBe(500);
  expect(await bad.text()).toBe("Internal error");
  expectSecurityHeaders(ok.headers, bad.headers);
  expect((await fetch(`${base}/healthz`)).status).toBe(200);
  expect(proc.exitCode).toBeNull();
}, 15000);

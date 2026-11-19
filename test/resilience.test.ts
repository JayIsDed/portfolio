// Runs the real server and logger as child processes against a fake Home
// Assistant, so a crash shows up as a process that exited. No network beyond
// localhost, no dependencies beyond Bun. Run with `bun test`.
import { afterAll, afterEach, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
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
  const { proc, base } = await startServer({});
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
}, 15000);

test("malformed %-escape gets a 400 with the same security headers as any response", async () => {
  const { base } = await startServer({});
  const ok = await fetch(`${base}/healthz`);
  const bad = await fetch(`${base}/%E0%A4%A`);

  expect(bad.status).toBe(400);
  for (const h of [
    "content-security-policy",
    "strict-transport-security",
    "x-content-type-options",
    "referrer-policy",
    "permissions-policy",
  ]) {
    expect(ok.headers.get(h)).toBeTruthy();
    expect(bad.headers.get(h)).toBe(ok.headers.get(h));
  }
}, 15000);

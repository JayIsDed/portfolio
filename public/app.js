// ────────────────────────────────────────────────────────────────────
// Ambient health theme — drives :root[data-health] from /api/health.
// In replay mode, scada.js takes over via shelf:replay-* events and the
// live poll is paused so the page color tracks the historical snapshot.
// ────────────────────────────────────────────────────────────────────

const POLL_MS = 60_000;

const ambientPill = document.getElementById("ambientPill");
const ambientLabel = ambientPill?.querySelector(".ambient-label");
const footLabel = document.getElementById("footLiveLabel");

// Pure: severity object → "healthy" | "warn" | "critical"
function severityState(severity) {
  if ((severity?.critical ?? 0) > 0) return "critical";
  if ((severity?.warn ?? 0) > 0) return "warn";
  return "healthy";
}

function applyHealth(severity, mode) {
  const html = document.documentElement;
  const state = severityState(severity);

  html.dataset.health = state;
  if (ambientPill) ambientPill.dataset.state = state;

  const sevLabel =
    state === "critical" ? `${severity.critical} critical`
    : state === "warn"   ? `${severity.warn} warn`
    : "healthy";

  // Connection state overrides severity in the pill text — if data is stale
  // or unreachable, the severity count can't be trusted.
  const pillText =
    mode === "stale"   ? "stale"
    : mode === "unknown" ? "offline"
    : sevLabel;

  const total = severity.critical + severity.warn;
  const pillTitle =
    mode === "stale"   ? "Data stale — last good poll was over 90 s ago"
    : mode === "unknown" ? "HA unreachable — page color is frozen"
    : state === "healthy" ? "All flags clear · click to see live diagram"
    : `${sevLabel} flag${total === 1 ? "" : "s"} firing — click for details`;

  if (ambientLabel) ambientLabel.textContent = pillText;
  if (ambientPill) ambientPill.title = pillTitle;
  if (footLabel) footLabel.textContent = `shelf · ${sevLabel}`;
}

let livePollHandle = null;
let inReplay = false;

async function pollHealth() {
  if (inReplay) return; // replay snapshot owns the page color; don't fight it
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    applyHealth(
      { critical: data.critical ?? 0, warn: data.warn ?? 0, info: data.info ?? 0 },
      data.mode ?? "unknown"
    );
  } catch (_) {
    // unreachable — stay healthy/teal, indicate offline in footer
    applyHealth({ critical: 0, warn: 0, info: 0 }, "unknown");
  }
}

function startLivePolling() {
  inReplay = false;
  pollHealth();
  if (livePollHandle) clearInterval(livePollHandle);
  livePollHandle = setInterval(pollHealth, POLL_MS);
}

function stopLivePolling() {
  inReplay = true;
  if (livePollHandle) { clearInterval(livePollHandle); livePollHandle = null; }
}

// ── Replay mode coordination ──────────────────────────────────────────
// scada.js fires these events when the user scrubs the timeline or
// clicks a marker. We drive :root[data-health] + the nav pill so the
// page-color shift mirrors the snapshot's severity, not the live one.

const fmtReplayTime = (iso) => {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

document.addEventListener("shelf:replay-enter", () => {
  stopLivePolling();
  if (ambientPill) {
    ambientPill.classList.add("is-replay");
    if (ambientLabel) ambientLabel.textContent = "replay…";
    ambientPill.title = "Replay mode — scrubbing historical state. Click LIVE on the timeline to return to real-time.";
  }
});

document.addEventListener("shelf:replay-snapshot", (e) => {
  const { timestamp, severity, level, headlineFlag } = e.detail ?? {};
  if (!timestamp) return;

  // Apply severity directly so the page color matches the historical state.
  const html = document.documentElement;
  html.dataset.health = level ?? severityState(severity);
  if (ambientPill) ambientPill.dataset.state = html.dataset.health;

  const when = fmtReplayTime(timestamp);
  const flagPart = headlineFlag ? ` — ${headlineFlag}` : "";
  if (ambientLabel) ambientLabel.textContent = `replay · ${when}${flagPart}`;
  if (ambientPill) ambientPill.title = `Replay: ${when}${flagPart}. Click LIVE on the timeline to return to real-time.`;

  const sevLabel =
    html.dataset.health === "critical" ? `${severity?.critical ?? 0} critical`
    : html.dataset.health === "warn"   ? `${severity?.warn ?? 0} warn`
    : "healthy";
  if (footLabel) footLabel.textContent = `shelf · replay · ${sevLabel}`;
});

document.addEventListener("shelf:replay-exit", () => {
  if (ambientPill) ambientPill.classList.remove("is-replay");
  startLivePolling();
});

startLivePolling();

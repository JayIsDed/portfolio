// ────────────────────────────────────────────────────────────────────
// Ambient health theme — drives :root[data-health] from /api/health
// Polls every 60s. Falls back to "healthy" if unreachable.
// ────────────────────────────────────────────────────────────────────

const POLL_MS = 60_000;

const ambientPill = document.getElementById("ambientPill");
const ambientLabel = ambientPill?.querySelector(".ambient-label");
const footLabel = document.getElementById("footLiveLabel");

function applyHealth(severity, mode) {
  const html = document.documentElement;
  let state = "healthy";
  if (severity.critical > 0) state = "critical";
  else if (severity.warn > 0) state = "warn";

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

async function pollHealth() {
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

pollHealth();
setInterval(pollHealth, POLL_MS);

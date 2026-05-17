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

  const label =
    state === "critical"
      ? `${severity.critical} critical`
      : state === "warn"
        ? `${severity.warn} warn`
        : "healthy";
  const modeText = mode === "stale" ? "stale" : mode === "unknown" ? "offline" : "live";

  if (ambientLabel) ambientLabel.textContent = modeText;
  if (footLabel) footLabel.textContent = `shelf · ${label}`;
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

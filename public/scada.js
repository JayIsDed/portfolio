// ────────────────────────────────────────────────────────────────────
// SCADA / HMI for Calibration Shelf
//
// Architecture (envelope 720×680, viewBox 1200×820):
//   y=20–95    Header readouts (Ambient / L0 Master / Damping)
//   y=115–211  I/O Panel — power strip, 3 outlet pills (96px tall, captions inside)
//   y=231–351  Canopy Zone (grow light bar centered, shortened to clear wire corridors)
//   y=381–666  Main Tank (sensor junction strip + viz on left + readouts on right)
//
// Wiring rules (envelope-local coords):
//   - Outlets centered at x=120 (Pump), x=360 (Light), x=600 (Heater)
//   - Pump + Heater drop down in CLEAR corridors that don't cross the grow light bar
//     (light bar is now x=200..520, leaving x<200 and x>520 clear)
//   - Pump T-bar at y=360, Heater bend at y=370 — staggered so they don't overlap
//   - Light is dead-simple drop from outlet to bar (it IS over the bar)
//
// Sensor wires terminate at a junction strip at the top of the tank with
// small ports, and a "→ ESP32" indicator on the right showing data flow.
// Last-activation captions on each pill come from /api/shelf/last-activations.
// ────────────────────────────────────────────────────────────────────

const REFRESH_MS = 15_000;
const LAST_ACT_REFRESH_MS = 60_000;

const SVG = `
<svg viewBox="0 0 1200 820" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Calibration shelf process diagram">
  <defs>
    <linearGradient id="g-surface" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(255,255,255,0.04)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0.01)"/>
    </linearGradient>

    <radialGradient id="g-heater-glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="rgba(255,135,40,0.9)"/>
      <stop offset="50%" stop-color="rgba(255,135,40,0.3)"/>
      <stop offset="100%" stop-color="rgba(255,135,40,0)"/>
    </radialGradient>

    <radialGradient id="g-light-glow" cx="0.5" cy="0.2" r="0.6">
      <stop offset="0%" stop-color="rgba(255,235,180,0.7)"/>
      <stop offset="60%" stop-color="rgba(255,235,180,0.15)"/>
      <stop offset="100%" stop-color="rgba(255,235,180,0)"/>
    </radialGradient>

    <pattern id="p-water" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
      <path d="M0 10 Q5 6 10 10 T20 10" stroke="rgba(120,200,255,0.12)" stroke-width="1" fill="none"/>
    </pattern>

    <filter id="f-glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="6" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>

    <style>
      .lbl { fill: #768285; font: 500 10px "Inter", sans-serif; letter-spacing: 0.16em; text-transform: uppercase; }
      .lbl-tight { fill: #b6c2c5; font: 400 11px "Inter", sans-serif; }
      .v { fill: #e8eef0; font: 500 15px "JetBrains Mono", "SF Mono", Menlo, monospace; font-variant-numeric: tabular-nums; }
      .v-lg { font-size: 22px; }
      .v-warn { fill: #ffbe55; }
      .v-crit { fill: #ff5f6d; }
      .v-unit { fill: #768285; font: 400 10px "Inter", sans-serif; }
      .v-state { fill: #b6c2c5; font: 500 10px "JetBrains Mono", monospace; letter-spacing: 0.06em; text-transform: uppercase; }
      .frame { fill: url(#g-surface); stroke: rgba(255,255,255,0.10); stroke-width: 1; rx: 8; }
      .pipe-line { stroke: rgba(255,255,255,0.18); stroke-width: 1.5; fill: none; }
      .pipe-flow { stroke: var(--accent, #00d4b3); stroke-width: 1.5; fill: none; stroke-dasharray: 6 8; animation: flow 1.6s linear infinite; }
      @keyframes flow { to { stroke-dashoffset: -28; } }
      .badge-on { fill: rgba(0,212,179,0.18); stroke: var(--accent, #00d4b3); stroke-width: 1; }
      .badge-off { fill: rgba(255,255,255,0.04); stroke: rgba(255,255,255,0.18); stroke-width: 1; }
      .heater-glow-rect { transition: opacity 1.2s ease-out; }
      .light-glow-rect { transition: opacity 1.2s ease-out, fill 1.2s ease-out; }

      /* Routes — wires from outlet terminals to devices.
         Two-layer paths: a dim base always visible + an active flow that lights up. */
      .route-base, .route-flow {
        fill: none;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .route-base { stroke: rgba(255,255,255,0.10); stroke-width: 2.2; }
      .route-flow {
        stroke-width: 2.2;
        stroke-dasharray: 5 11;
        opacity: 0;
        transition: opacity 0.6s ease, stroke 0.6s ease;
      }
      .route.is-on .route-flow {
        opacity: 1;
        animation: routeFlow 1.4s linear infinite;
      }
      .route-pump .route-flow, .route-light .route-flow { stroke: var(--accent, #00d4b3); }
      .route.is-on.route-pump .route-flow,
      .route.is-on.route-light .route-flow {
        filter: drop-shadow(0 0 4px var(--accent-glow, #00d4b340));
      }
      .route-heater .route-flow { stroke: rgba(255,135,40,0.95); }
      .route.is-on.route-heater .route-flow {
        filter: drop-shadow(0 0 6px rgba(255,135,40,0.7));
      }
      @keyframes routeFlow { to { stroke-dashoffset: -32; } }

      /* Tank visualization styles */
      .glass        { fill: rgba(120,200,255,0.03); stroke: rgba(120,200,255,0.30); stroke-width: 1.4; }
      .water-fill   { fill: url(#p-water); }
      .water-surface{ stroke: rgba(120,200,255,0.45); stroke-width: 1.2; }
      .substrate    { fill: rgba(140,110,80,0.10); }
      .grain        { fill: rgba(180,150,110,0.45); }

      .heater-body { fill: rgba(255,255,255,0.06); stroke: rgba(255,255,255,0.30); stroke-width: 1.2; transition: fill 0.8s ease, stroke 0.8s ease, filter 0.8s ease; }
      .heater-coil { stroke: rgba(255,180,90,0.45); stroke-width: 0.8; fill: none; }

      .sponge-body { fill: rgba(120,200,255,0.06); stroke: rgba(120,200,255,0.32); stroke-width: 1; }
      .sponge-pore { fill: rgba(120,200,255,0.20); }
      .diffuser    { fill: rgba(120,200,255,0.16); stroke: rgba(120,200,255,0.55); stroke-width: 1; transition: fill 0.6s ease, stroke 0.6s ease; }

      .probe-body  { fill: rgba(255,255,255,0.08); stroke: rgba(255,255,255,0.40); stroke-width: 1.2; }
      .probe-tip-c { fill: rgba(0,212,179,0.95); }
      .probe-tip-g { fill: rgba(180,210,150,0.85); }
      .probe-wire  { stroke: rgba(255,255,255,0.22); stroke-width: 1; fill: none; }

      .bubble { fill: rgba(120,200,255,0.55); }

      .terminal { fill: rgba(255,255,255,0.42); stroke: rgba(255,255,255,0.15); stroke-width: 0.5; }
      .route.is-on .terminal { fill: var(--accent, #00d4b3); }
      .route.is-on.route-heater .terminal { fill: rgba(255,135,40,0.95); }
    </style>
  </defs>

  <!-- ── Top band: External Weather ─────────────────────────────────── -->
  <!-- Columns at x=16/245/474 fill the 720-wide frame instead of clustering on the left. -->
  <g transform="translate(40,30)">
    <rect class="frame" x="0" y="0" width="720" height="90" rx="8"/>
    <text class="lbl" x="16" y="22">External · Weather</text>
    <g transform="translate(16, 40)">
      <text class="lbl-tight" y="0">Outside</text>
      <text class="v" y="26" data-vital="outside_temp" data-fmt="temp">— °F</text>
    </g>
    <g transform="translate(245, 40)">
      <text class="lbl-tight" y="0">Humidity</text>
      <text class="v" y="26" data-vital="outside_humidity" data-fmt="pct">— %</text>
    </g>
    <g transform="translate(474, 40)">
      <text class="lbl-tight" y="0">Δ to shelf</text>
      <text class="v" y="26" data-vital="thermal_delta" data-fmt="delta">— °F</text>
      <text class="v-unit" y="42">basement damping</text>
    </g>
  </g>

  <!-- ── Top band right: System time ─────────────────────────────────── -->
  <g transform="translate(780,30)">
    <rect class="frame" x="0" y="0" width="380" height="90" rx="8"/>
    <text class="lbl" x="16" y="22">System</text>
    <text class="v v-lg" x="16" y="58" id="scadaTopTs">— — —</text>
    <text class="v-unit" x="16" y="76">live · 30s poll · 30 d replay window</text>
    <!-- Pulse dot mirrored across the panel: 16 left margin → 16 right margin (cx = 380-16). -->
    <circle cx="364" cy="22" r="4" fill="var(--accent, #00d4b3)" filter="url(#f-glow)">
      <animate attributeName="opacity" values="1;0.4;1" dur="2.4s" repeatCount="indefinite"/>
    </circle>
  </g>

  <!-- ─────────────────────────────────────────────────────────────────
       ENVELOPE — full-width container, sections stacked top to bottom.
       ───────────────────────────────────────────────────────────────── -->
  <g transform="translate(40,140)">
    <rect class="frame" x="0" y="0" width="720" height="680" rx="14" stroke-dasharray="4 4"/>
    <text class="lbl" x="16" y="22">Layer 0 · Basement Envelope</text>

    <!-- Header columns spread evenly across the 720-wide envelope (x=16/245/474). -->
    <g transform="translate(16, 44)">
      <text class="lbl-tight" y="0">Ambient</text>
      <text class="v" y="26" data-vital="shelf_ambient" data-fmt="temp">— °F</text>
    </g>
    <g transform="translate(245, 44)">
      <text class="lbl-tight" y="0">L0 Master</text>
      <text class="v" y="26" data-vital="l0_power" data-fmt="watts">— W</text>
    </g>
    <g transform="translate(474, 44)">
      <text class="lbl-tight" y="0">Damping</text>
      <text class="v" y="26">11 : 1</text>
      <text class="v-unit" y="42">passive thermal mass</text>
    </g>

    <!-- ── I/O Panel — Tapo P316M Power Strip ─────────────────────────
         Outlet terminals (envelope coords, bottom-center of each pill):
           Pump:   (120, 211) → drops to T-bar at y=360 in the clear x<200 corridor
           Light:  (360, 211) → drops to top of grow light bar (over the bar)
           Heater: (600, 211) → drops to bus at y=370 in the clear x>520 corridor,
                                bends left to heater body in tank
         Symmetric layout inside the 700-wide panel: 10px L/R margins, 40px between pills.
    -->
    <g transform="translate(10, 115)">
      <rect class="frame" x="0" y="0" width="700" height="96" rx="10"/>
      <text class="lbl" x="14" y="20">I/O Panel · Tapo P316M Power Strip</text>

      <!-- Pill 1: Pump  (center at power-strip x=110 → envelope x=120) -->
      <g transform="translate(10, 28)">
        <rect class="badge-off" x="0" y="0" width="200" height="64" rx="6" id="outlet1Pill"/>
        <text class="lbl-tight" x="12" y="20">Outlet 1 — Pump</text>
        <text class="v" x="12" y="40" data-vital="outlet_1_pump" data-fmt="watts">— W</text>
        <text class="v-state" x="188" y="40" text-anchor="end" id="outlet1State">—</text>
        <text class="v-unit" x="12" y="56" id="outlet1Last">last —</text>
      </g>

      <!-- Pill 3: Grow Light  (center at power-strip x=350 → envelope x=360) -->
      <g transform="translate(250, 28)">
        <rect class="badge-off" x="0" y="0" width="200" height="64" rx="6" id="outlet3Pill"/>
        <text class="lbl-tight" x="12" y="20">Outlet 3 — Grow Light</text>
        <text class="v" x="12" y="40" data-vital="outlet_3_led" data-fmt="watts">— W</text>
        <text class="v-state" x="188" y="40" text-anchor="end" id="outlet3State">—</text>
        <text class="v-unit" x="12" y="56" id="outlet3Last">last —</text>
      </g>

      <!-- Pill H: Heater · Inkbird  (center at power-strip x=590 → envelope x=600) -->
      <g transform="translate(490, 28)">
        <rect class="badge-off" x="0" y="0" width="200" height="64" rx="6" id="heaterPill"/>
        <text class="lbl-tight" x="12" y="20">Heater · Inkbird PID</text>
        <text class="v" x="12" y="40" data-vital="heater_power" data-fmt="watts">— W</text>
        <text class="v-state" x="188" y="40" text-anchor="end" id="heaterState">—</text>
        <text class="v-unit" x="12" y="56" id="heaterLast">last —</text>
      </g>
    </g>

    <!-- ── Canopy Zone ────────────────────────────────────────────── -->
    <!-- Light bar shortened to canopy-local x=190..510 (envelope x=200..520)
         so the Pump (x=120) and Heater (x=600) wire drops have clear corridors. -->
    <g transform="translate(10, 231)">
      <rect class="frame" x="0" y="0" width="700" height="120" rx="10"/>
      <text class="lbl" x="14" y="20">Canopy Zone</text>

      <!-- Grow light bar (centered, width 320) -->
      <g transform="translate(190, 40)">
        <rect class="light-glow-rect" x="-32" y="-6" width="384" height="80" rx="14"
              fill="url(#g-light-glow)" opacity="0" id="growLightGlow"/>
        <rect class="badge-off" x="0" y="0" width="320" height="14" rx="3" id="growLightBar"/>
        <text class="lbl" x="0" y="36" id="growLightLabel">Grow Light · — %</text>
      </g>

      <g transform="translate(14, 88)">
        <text class="lbl-tight" y="0">Canopy °F</text>
        <text class="v" y="22" data-vital="canopy_temp" data-fmt="temp">— °F</text>
      </g>
      <g transform="translate(220, 88)">
        <text class="lbl-tight" y="0">Humidity</text>
        <text class="v" y="22" data-vital="canopy_humidity" data-fmt="pct">— %</text>
      </g>
      <g transform="translate(440, 88)">
        <text class="lbl-tight" y="0">Illuminance</text>
        <text class="v" y="22" data-vital="canopy_illuminance" data-fmt="lux">— lx</text>
      </g>
    </g>

    <!-- ── Main Tank ─────────────────────────────────────────────────
         Tank g at envelope (10, 381), w=700, h=285.
         Sensor junction strip at tank-local y=27–33 (just below the section label).
         Viz at tank-local (20, 42) → envelope (30, 423), w=420, h=240.
         Readouts at tank-local (470, 56) → envelope (480, 437).
    -->
    <g transform="translate(10, 381)">
      <rect class="frame" x="0" y="0" width="700" height="285" rx="10"/>
      <text class="lbl" x="14" y="20">Main Tank · 77 °F setpoint</text>

      <!-- ── Sensor junction strip ─────────────────────────────────
           Each sensor wire terminates at a port (filled circle) here.
           "→ ESP32" indicator on the right shows where the data goes. -->
      <g transform="translate(20, 28)">
        <rect x="0" y="0" width="420" height="8" rx="3"
              fill="rgba(255,255,255,0.04)" stroke="rgba(0,212,179,0.30)" stroke-width="0.8"/>
        <!-- ports aligned to TDS x=70, center x=210, substrate x=340 (viz-local) -->
        <circle cx="70"  cy="4" r="2.6" fill="rgba(0,212,179,0.75)" stroke="rgba(0,212,179,0.95)" stroke-width="0.8"/>
        <circle cx="210" cy="4" r="2.6" fill="rgba(0,212,179,0.75)" stroke="rgba(0,212,179,0.95)" stroke-width="0.8"/>
        <circle cx="340" cy="4" r="2.6" fill="rgba(0,212,179,0.75)" stroke="rgba(0,212,179,0.95)" stroke-width="0.8"/>
        <text class="v-unit" x="436" y="6" fill="rgba(0,212,179,0.85)" text-anchor="start">→ ESP32</text>
      </g>

      <g transform="translate(20, 42)">
        <!-- Glass body -->
        <rect class="glass" x="0" y="0" width="420" height="240" rx="4"/>

        <!-- Water column (above substrate) -->
        <rect class="water-fill" x="2" y="18" width="416" height="180"/>
        <line class="water-surface" x1="2" y1="18" x2="418" y2="18"/>

        <!-- Substrate (gravel) -->
        <rect class="substrate" x="2" y="198" width="416" height="40"/>
        <circle class="grain" cx="20"  cy="216" r="2.4"/>
        <circle class="grain" cx="44"  cy="220" r="1.8"/>
        <circle class="grain" cx="70"  cy="212" r="2.6"/>
        <circle class="grain" cx="96"  cy="222" r="2"/>
        <circle class="grain" cx="124" cy="216" r="2.2"/>
        <circle class="grain" cx="152" cy="220" r="1.8"/>
        <circle class="grain" cx="180" cy="214" r="2.4"/>
        <circle class="grain" cx="208" cy="218" r="2"/>
        <circle class="grain" cx="234" cy="222" r="2.4"/>
        <circle class="grain" cx="260" cy="216" r="1.8"/>
        <circle class="grain" cx="288" cy="220" r="2.2"/>
        <circle class="grain" cx="316" cy="214" r="2.6"/>
        <circle class="grain" cx="356" cy="220" r="2"/>
        <circle class="grain" cx="384" cy="216" r="2.4"/>
        <circle class="grain" cx="406" cy="220" r="1.8"/>

        <!-- ── Sponge filter LEFT (corner, bottom-left of water column) ── -->
        <g transform="translate(20, 130)">
          <rect class="sponge-body" x="0" y="0" width="28" height="70" rx="3"/>
          <circle class="sponge-pore" cx="6"  cy="12" r="1.6"/>
          <circle class="sponge-pore" cx="20" cy="20" r="1.4"/>
          <circle class="sponge-pore" cx="10" cy="34" r="1.6"/>
          <circle class="sponge-pore" cx="22" cy="48" r="1.4"/>
          <circle class="sponge-pore" cx="6"  cy="58" r="1.6"/>
          <!-- diffuser puck on top -->
          <rect class="diffuser" x="-2" y="-8" width="32" height="8" rx="2" id="diffuserL"/>
          <!-- bubbles rising from diffuser through water -->
          <g transform="translate(14, -8)">
            <circle class="bubble" r="2"   cy="0"><animate attributeName="cy" values="0;-110" dur="3.2s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.9;0" dur="3.2s" repeatCount="indefinite"/></circle>
            <circle class="bubble" r="1.6" cy="0"><animate attributeName="cy" values="0;-110" dur="3.2s" begin="1.0s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.7;0" dur="3.2s" begin="1.0s" repeatCount="indefinite"/></circle>
            <circle class="bubble" r="2"   cy="0"><animate attributeName="cy" values="0;-110" dur="3.2s" begin="2.0s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.85;0" dur="3.2s" begin="2.0s" repeatCount="indefinite"/></circle>
          </g>
        </g>

        <!-- ── Sponge filter RIGHT (corner, bottom-right) ─────────── -->
        <g transform="translate(372, 130)">
          <rect class="sponge-body" x="0" y="0" width="28" height="70" rx="3"/>
          <circle class="sponge-pore" cx="6"  cy="12" r="1.4"/>
          <circle class="sponge-pore" cx="20" cy="20" r="1.6"/>
          <circle class="sponge-pore" cx="10" cy="34" r="1.4"/>
          <circle class="sponge-pore" cx="22" cy="48" r="1.6"/>
          <circle class="sponge-pore" cx="6"  cy="58" r="1.4"/>
          <rect class="diffuser" x="-2" y="-8" width="32" height="8" rx="2" id="diffuserR"/>
          <g transform="translate(14, -8)">
            <circle class="bubble" r="2"   cy="0"><animate attributeName="cy" values="0;-110" dur="3.2s" begin="0.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.9;0" dur="3.2s" begin="0.4s" repeatCount="indefinite"/></circle>
            <circle class="bubble" r="1.6" cy="0"><animate attributeName="cy" values="0;-110" dur="3.2s" begin="1.6s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.7;0" dur="3.2s" begin="1.6s" repeatCount="indefinite"/></circle>
            <circle class="bubble" r="2"   cy="0"><animate attributeName="cy" values="0;-110" dur="3.2s" begin="2.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.85;0" dur="3.2s" begin="2.4s" repeatCount="indefinite"/></circle>
          </g>
        </g>

        <!-- ── HEATER (long horizontal cylinder, mid-water, true center) ── -->
        <!-- Cord enters tank at viz-local x=294 (envelope x=324, route ends there).
             Body span: x=146→284 in viz-local. -->
        <g transform="translate(140, 130)">
          <rect class="heater-glow-rect" x="-30" y="-26" width="200" height="62" rx="32"
                fill="url(#g-heater-glow)" opacity="0" id="heaterGlow"/>
          <!-- left end-cap -->
          <rect class="heater-body" x="0" y="0" width="12" height="14" rx="3"/>
          <!-- body cylinder -->
          <rect class="heater-body" x="12" y="-2" width="128" height="18" rx="9"/>
          <!-- right end-cap (cord exits here) -->
          <rect class="heater-body" x="140" y="0" width="14" height="14" rx="3"/>
          <!-- coil hint -->
          <path class="heater-coil"
                d="M 18 7 q 6 -8 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0 t 12 0"/>
        </g>

        <!-- ── TDS probe (wires extend up to junction strip at viz-local y=-10) ── -->
        <g transform="translate(70, 18)">
          <line class="probe-wire" x1="0" y1="-28" x2="0" y2="20"/>
          <rect class="probe-body" x="-5" y="20" width="10" height="28" rx="3"/>
          <circle class="probe-tip-g" cx="0" cy="50" r="2.6"/>
          <text class="v-unit" x="-12" y="62" text-anchor="end">TDS</text>
        </g>

        <!-- ── Center thermocouple (true horizontal center, mid-water above heater) ── -->
        <g transform="translate(210, 18)">
          <line class="probe-wire" x1="0" y1="-28" x2="0" y2="92"/>
          <circle class="probe-body" cx="0" cy="96" r="5"/>
          <circle class="probe-tip-c" cx="0" cy="96" r="1.8"/>
          <text class="v-unit" x="8" y="98">center</text>
        </g>

        <!-- ── Substrate thermocouple (right of heater, in gravel) ── -->
        <g transform="translate(340, 18)">
          <line class="probe-wire" x1="0" y1="-28" x2="0" y2="200"/>
          <circle class="probe-body" cx="0" cy="204" r="5"/>
          <circle class="probe-tip-c" cx="0" cy="204" r="1.8"/>
          <text class="v-unit" x="-8" y="206" text-anchor="end">substrate</text>
        </g>
      </g>

      <!-- ── Tank readouts column ─────────────────────────────────────
           Spacing: Center °F gets a 60px slot (big v-lg value + sublabel);
           Substrate / Stratification / TDS each get 56px slots for even rhythm. -->
      <g transform="translate(470, 56)">
        <text class="lbl-tight" y="0">Center °F</text>
        <text class="v v-lg" y="28" data-vital="tank_center" data-fmt="temp" id="tankCenterV">— °F</text>
        <text class="v-unit" y="44">setpoint 77.0</text>
      </g>
      <g transform="translate(470, 116)">
        <text class="lbl-tight" y="0">Substrate °F</text>
        <text class="v" y="24" data-vital="tank_substrate" data-fmt="temp">— °F</text>
      </g>
      <g transform="translate(470, 172)">
        <text class="lbl-tight" y="0">Stratification</text>
        <text class="v" y="24" data-vital="tank_strat" data-fmt="delta">— °F</text>
        <text class="v-unit" y="40">center vs substrate</text>
      </g>
      <g transform="translate(470, 228)">
        <text class="lbl-tight" y="0">TDS</text>
        <text class="v" y="24" data-vital="tds" data-fmt="ppm">— ppm</text>
        <text class="v-unit" y="40">200–400 in-band</text>
      </g>
    </g>

    <!-- ─── WIRING OVERLAY ────────────────────────────────────────────
         All envelope-local. Power strip pills end at y=211 (terminal lead).

         Outlet terminals (bottom-center of each pill):
           Pump:   (120, 211)  → x<200 corridor (clear of light bar at x=200..520)
           Light:  (360, 211)  → over the light bar, drops straight to bar top
           Heater: (600, 211)  → x>520 corridor (clear of light bar)

         Bus levels (staggered to avoid overlap):
           Pump T-bar at y=360
           Heater bend at y=370

         Tank device endpoints (tank g now at y=381, viz at tank-local (20,42)):
           Heater right-end-cap top: (10+20+140+147, 381+42+130) = (317, 553)
           Diffuser L top-center:    (10+20+20+14,   381+42+130-8) = (64, 545)
           Diffuser R top-center:    (10+20+372+14,  381+42+130-8) = (416, 545)
           Grow light bar top-center: canopy g (10,231) + bar at (190,40) w=320
                                      → (10+190+160, 231+40) = (360, 271)
    ─────────────────────────────────────────────────────────────────── -->

    <!-- Pump: outlet drops, T-splits at y=360, both arms plug into diffusers -->
    <g class="route route-pump" id="routePump">
      <path class="route-base" d="M 120 211 V 360 H 64 V 545 M 120 360 H 416 V 545"/>
      <path class="route-flow" d="M 120 211 V 360 H 64 V 545 M 120 360 H 416 V 545"/>
      <circle class="terminal" cx="120" cy="211" r="3"/>
    </g>

    <!-- Light: dead-simple vertical drop into the top of the grow light bar -->
    <g class="route route-light" id="routeLight">
      <path class="route-base" d="M 360 211 V 271"/>
      <path class="route-flow" d="M 360 211 V 271"/>
      <circle class="terminal" cx="360" cy="211" r="3"/>
    </g>

    <!-- Heater: outlet drops, bends left at y=370 (below pump T-bar), plugs into heater body -->
    <g class="route route-heater" id="routeHeater">
      <path class="route-base" d="M 600 211 V 370 H 317 V 553"/>
      <path class="route-flow" d="M 600 211 V 370 H 317 V 553"/>
      <circle class="terminal" cx="600" cy="211" r="3"/>
    </g>
  </g>

  <!-- ─────────────────────────────────────────────────────────────────
       RIGHT COLUMN — Data Pipeline + Control Loops + L0 Sum + Camera
       ───────────────────────────────────────────────────────────────── -->
  <g transform="translate(800, 140)">
    <rect class="frame" x="0" y="0" width="360" height="660" rx="14"/>
    <text class="lbl" x="16" y="22">Data Pipeline</text>

    <!-- Pipeline rail (drawn first; circles overlay) -->
    <line class="pipe-line" x1="240" y1="50" x2="240" y2="362" />
    <path class="pipe-flow" d="M 240 50 V 362" />

    <g transform="translate(20, 32)" id="pipeline">
      ${pipelineNode(0,   "ESP32 sensors",    "MQTTS / 8883")}
      ${pipelineNode(66,  "Mosquitto broker", "LXC 112")}
      ${pipelineNode(132, "Telegraf",         "MQTT consumer")}
      ${pipelineNode(198, "InfluxDB",         "homeassistant bucket")}
      ${pipelineNode(264, "shelf_pulse API",  "this server")}
      ${pipelineNode(330, "Portfolio render", "you are here")}
    </g>

    <!-- Control loops -->
    <g transform="translate(16, 410)">
      <text class="lbl" y="0">Control Loops</text>
      <g transform="translate(0, 14)">
        <rect class="frame" x="0" y="0" width="328" height="40" rx="6"/>
        <text class="lbl-tight" x="12" y="16">Thermal · Inkbird (L1)</text>
        <text class="v" x="12" y="34" data-vital="tank_center" data-fmt="temp">— °F</text>
        <text class="v-state" x="316" y="34" text-anchor="end" data-vital="heater_calling" data-fmt="calling">idle</text>
      </g>
      <g transform="translate(0, 62)">
        <rect class="frame" x="0" y="0" width="328" height="40" rx="6"/>
        <text class="lbl-tight" x="12" y="16">Lighting · HA schedule</text>
        <text class="v" x="12" y="34" data-vital="grow_light_brightness" data-fmt="pct">— %</text>
      </g>
      <g transform="translate(0, 110)">
        <rect class="frame" x="0" y="0" width="328" height="40" rx="6"/>
        <text class="lbl-tight" x="12" y="16">Passive · Layer 0 mass</text>
        <text class="v" x="12" y="34" data-vital="thermal_delta" data-fmt="delta">— °F</text>
      </g>
    </g>

    <!-- L0 Sum + Camera footer -->
    <g transform="translate(16, 568)">
      <rect class="frame" x="0" y="0" width="158" height="76" rx="6"/>
      <text class="lbl" x="12" y="20">L0 Sum</text>
      <text class="v v-lg" x="12" y="50" data-vital="l0_power" data-fmt="watts">— W</text>
      <text class="v-unit" x="12" y="66">shelf strip total</text>
    </g>
    <g transform="translate(186, 568)">
      <rect class="frame" x="0" y="0" width="158" height="76" rx="6"/>
      <text class="lbl" x="12" y="20">Camera</text>
      <text class="lbl-tight" x="12" y="38">Reolink PTZ</text>
      <text class="v-unit" x="12" y="56">pan / tilt / day-night</text>
      <circle cx="142" cy="20" r="4" fill="var(--accent, #00d4b3)" opacity="0.75"/>
    </g>
  </g>
</svg>
`;

function pipelineNode(y, name, sub) {
  // Rail is at absolute x=240; helper g is translated by 20 so local x=220 hits the rail.
  return `
    <g transform="translate(0, ${y})">
      <text class="lbl-tight" x="208" y="14" text-anchor="end">${name}</text>
      <text class="v-unit"  x="208" y="30" text-anchor="end">${sub}</text>
      <circle cx="220" cy="16" r="8" fill="#0a0e0f" stroke="var(--accent, #00d4b3)" stroke-width="1.5"/>
      <circle cx="220" cy="16" r="3" fill="var(--accent, #00d4b3)" opacity="0.85"/>
    </g>
  `;
}

// ── Mount SVG ─────────────────────────────────────────────────────────
const canvas = document.getElementById("scadaCanvas");
if (canvas) canvas.innerHTML = SVG;

// ── Formatters ────────────────────────────────────────────────────────

function fmt(value, type) {
  if (value === null || value === undefined || (typeof value === "number" && isNaN(value))) {
    return "—";
  }
  switch (type) {
    case "temp":   return `${Number(value).toFixed(1)} °F`;
    case "pct":    return `${Math.round(Number(value))} %`;
    case "watts":  return `${Number(value).toFixed(1)} W`;
    case "ppm":    return `${Math.round(Number(value))} ppm`;
    case "lux":    return `${Math.round(Number(value))} lx`;
    case "delta":  return `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)} °F`;
    case "calling": return value ? "calling" : "idle";
    default:       return String(value);
  }
}

function relTime(iso) {
  if (!iso) return "—";
  const diffSec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return `${Math.round(diffSec)}s ago`;
  const m = diffSec / 60;
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(h < 10 ? 1 : 0)}h ago`;
  const d = h / 24;
  return `${d.toFixed(d < 10 ? 1 : 0)}d ago`;
}

// ── Live state binding ───────────────────────────────────────────────

function renderState(snap) {
  const v = snap.vitals ?? {};

  const tankCenter = Number(v.tank_center);
  const tankSub = Number(v.tank_substrate);
  const strat = !isNaN(tankCenter) && !isNaN(tankSub) ? Math.abs(tankCenter - tankSub) : NaN;
  const outsideTemp = Number(v.outside_temp);
  const shelfAmbient = Number(v.shelf_ambient);
  const thermalDelta = !isNaN(outsideTemp) && !isNaN(shelfAmbient) ? (shelfAmbient - outsideTemp) : NaN;

  const enriched = { ...v, tank_strat: strat, thermal_delta: thermalDelta };

  document.querySelectorAll("[data-vital]").forEach((el) => {
    const key = el.getAttribute("data-vital");
    const fmtKey = el.getAttribute("data-fmt") ?? "";
    const value = enriched[key];
    el.textContent = fmt(value, fmtKey);

    el.classList.remove("v-warn", "v-crit");
    if (key === "tank_center" && !isNaN(Number(value))) {
      const dev = Math.abs(Number(value) - 77.0);
      if (dev > 1.0) el.classList.add("v-crit");
      else if (dev > 0.5) el.classList.add("v-warn");
    }
    if (key === "shelf_ambient" && !isNaN(Number(value)) && Number(value) < 58) {
      el.classList.add("v-warn");
    }
    if (key === "tds" && !isNaN(Number(value)) && (Number(value) < 200 || Number(value) > 400)) {
      el.classList.add("v-warn");
    }
  });

  // Heater glow proportional to heater_power
  const heaterPower = Number(v.heater_power);
  const heaterGlow = document.getElementById("heaterGlow");
  if (heaterGlow) {
    if (!isNaN(heaterPower) && heaterPower > 5) {
      const intensity = Math.min(1, heaterPower / 105);
      heaterGlow.setAttribute("opacity", String(0.3 + intensity * 0.65));
    } else {
      heaterGlow.setAttribute("opacity", "0");
    }
  }

  // Grow light brightness → glow + bar accent
  const brightness = Number(v.grow_light_brightness);
  const lightGlow = document.getElementById("growLightGlow");
  const lightLabel = document.getElementById("growLightLabel");
  const lightBar = document.getElementById("growLightBar");
  if (lightGlow && lightLabel && lightBar) {
    if (!isNaN(brightness)) {
      const op = Math.max(0, Math.min(1, brightness / 100));
      lightGlow.setAttribute("opacity", String(op * 0.85));
      lightLabel.textContent = `Grow Light · ${Math.round(brightness)} %`;
      lightBar.setAttribute("class", op > 0.05 ? "badge-on" : "badge-off");
    } else {
      lightGlow.setAttribute("opacity", "0");
      lightLabel.textContent = "Grow Light · —";
    }
  }

  // Outlet status pills
  const setPill = (pillId, stateId, watts) => {
    const pill = document.getElementById(pillId);
    const state = document.getElementById(stateId);
    if (!pill || !state) return;
    const isOn = !isNaN(Number(watts)) && Number(watts) > 1;
    pill.setAttribute("class", isOn ? "badge-on" : "badge-off");
    state.textContent = isOn ? "ON" : isNaN(Number(watts)) ? "—" : "OFF";
    state.setAttribute("fill", isOn ? "var(--accent, #00d4b3)" : "rgba(180,200,200,0.4)");
  };
  setPill("outlet1Pill", "outlet1State", v.outlet_1_pump);
  setPill("outlet3Pill", "outlet3State", v.outlet_3_led);
  setPill("heaterPill", "heaterState", v.heater_power);

  // ── Route active states ─────────────────────────────────────────────
  const heaterActive =
    v.heater_calling === true ||
    (!isNaN(Number(v.heater_power)) && Number(v.heater_power) > 5);
  document.getElementById("routeHeater")?.classList.toggle("is-on", !!heaterActive);

  const pumpActive = !isNaN(Number(v.outlet_1_pump)) && Number(v.outlet_1_pump) > 1;
  document.getElementById("routePump")?.classList.toggle("is-on", !!pumpActive);

  const lightActive =
    (!isNaN(brightness) && brightness > 0) ||
    (!isNaN(Number(v.outlet_3_led)) && Number(v.outlet_3_led) > 1);
  document.getElementById("routeLight")?.classList.toggle("is-on", !!lightActive);

  // Timestamps
  const ts = snap.timestamp ? new Date(snap.timestamp) : new Date();
  const tsStr = ts.toLocaleString("en-US", { dateStyle: "short", timeStyle: "medium" });
  const topTs = document.getElementById("scadaTopTs");
  const scadaTs = document.getElementById("scadaTs");
  if (topTs) topTs.textContent = tsStr;
  if (scadaTs) scadaTs.textContent = `${snap.mode === "replay" ? "replay" : "live"} · ${tsStr}`;

  // Top mini-vitals strip
  document.querySelectorAll(".mini-value").forEach((el) => {
    const key = el.getAttribute("data-vital");
    const f = key === "tank_center" || key === "shelf_ambient" ? "temp" : "watts";
    el.textContent = fmt(enriched[key], f);
  });
}

// ── Last-activation captions (dim row under each outlet's watts) ─────

let lastActivations = null;

async function pollLastActivations() {
  try {
    const data = await fetch("/api/shelf/last-activations", { cache: "no-store" }).then((r) => r.json());
    lastActivations = data;
    renderLastActivations();
  } catch (_) { /* keep previous frame */ }
}

function renderLastActivations() {
  if (!lastActivations) return;
  const updates = [
    { id: "outlet1Last", key: "outlet_1_pump" },
    { id: "outlet3Last", key: "outlet_3_led" },
    { id: "heaterLast", key: "heater_power" },
  ];
  for (const { id, key } of updates) {
    const el = document.getElementById(id);
    if (!el) continue;
    const info = lastActivations[key];
    if (!info?.last_active_at) {
      el.textContent = "last —";
    } else {
      el.textContent = `last ${info.last_active_watts.toFixed(1)} W · ${relTime(info.last_active_at)}`;
    }
  }
}

pollLastActivations();
setInterval(pollLastActivations, LAST_ACT_REFRESH_MS);
// Re-render every 30s so the "Nm ago" string stays fresh without a fetch
setInterval(renderLastActivations, 30_000);

// ── Mode (LIVE / REPLAY) state ────────────────────────────────────────

const state = {
  mode: "live",
  events: [],
  range: null,
  playing: false,
  playTimer: null,
  speedSecPerSec: 21600,
};

const tlInput = document.getElementById("trackInput");
const tlReadout = document.getElementById("tlReadout");
const tlLive = document.getElementById("tlLive");
const tlPlay = document.getElementById("tlPlay");
const tlSpeed = document.getElementById("tlSpeed");
const modeBadge = document.querySelector(".mode-badge");
const markersHost = document.getElementById("trackMarkers");

function setMode(m) {
  state.mode = m;
  if (modeBadge) {
    modeBadge.textContent = m === "replay" ? "REPLAY" : "LIVE";
    modeBadge.classList.toggle("mode-replay", m === "replay");
  }
  if (tlLive) tlLive.classList.toggle("is-active", m === "live");
}

function tsFromSliderValue(v) {
  if (!state.range) return new Date().toISOString();
  const e = new Date(state.range.earliest).getTime();
  const l = new Date(state.range.latest).getTime();
  const frac = Number(v) / 1000;
  return new Date(e + (l - e) * frac).toISOString();
}

function sliderValueFromTs(iso) {
  if (!state.range) return 1000;
  const e = new Date(state.range.earliest).getTime();
  const l = new Date(state.range.latest).getTime();
  if (l <= e) return 1000;
  const t = new Date(iso).getTime();
  return Math.round(((t - e) / (l - e)) * 1000);
}

async function loadRangeAndEvents() {
  try {
    const [rangeR, eventsR] = await Promise.all([
      fetch("/api/shelf/range").then((r) => r.json()),
      fetch("/api/shelf/events").then((r) => r.json()),
    ]);
    state.range = rangeR;
    state.events = eventsR.events ?? [];
    renderMarkers();
    const ts = document.getElementById("trackStart");
    if (ts && rangeR.earliest) {
      const d = new Date(rangeR.earliest);
      ts.textContent = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
  } catch (e) {
    console.warn("[scada] range/events load failed", e);
  }
}

function renderMarkers() {
  if (!markersHost || !state.range) return;
  markersHost.innerHTML = "";
  const e = new Date(state.range.earliest).getTime();
  const l = new Date(state.range.latest).getTime();
  if (l <= e) return;
  for (const ev of state.events) {
    const t = new Date(ev.timestamp).getTime();
    const pct = ((t - e) / (l - e)) * 100;
    if (pct < 0 || pct > 100) continue;
    const m = document.createElement("div");
    m.className = "tl-marker";
    m.dataset.level = ev.level;
    m.dataset.type = ev.type;
    m.style.left = `${pct}%`;
    const label = ev.type === "flag_appeared" ? "appeared" : "cleared";
    const detail = ev.message ?? ev.resolution_hint ?? "";
    m.title = `${new Date(ev.timestamp).toLocaleString()} — ${ev.flag} ${label}${detail ? `\n${detail}` : ""}`;
    m.addEventListener("click", () => {
      if (tlInput) tlInput.value = String(Math.round(pct * 10));
      handleScrub(true);
    });
    markersHost.appendChild(m);
  }
}

// ── LIVE polling ──────────────────────────────────────────────────────

let livePollTimer = null;
async function pollLive() {
  if (state.mode !== "live") return;
  try {
    const data = await fetch("/api/shelf/state", { cache: "no-store" }).then((r) => r.json());
    if (data?.timestamp) {
      renderState(data);
      if (tlInput && state.range) tlInput.value = "1000";
      if (tlReadout) tlReadout.textContent = "LIVE";
    }
  } catch (_) { /* leave previous frame */ }
}

function startLive() {
  setMode("live");
  if (state.playing) stopPlayback();
  pollLive();
  if (livePollTimer) clearInterval(livePollTimer);
  livePollTimer = setInterval(pollLive, REFRESH_MS);
}

// ── REPLAY scrub ─────────────────────────────────────────────────────

let scrubDebounce = null;
async function handleScrub(force = false) {
  if (!tlInput) return;
  const ts = tsFromSliderValue(tlInput.value);
  if (tlReadout) tlReadout.textContent = new Date(ts).toLocaleString();

  if (Number(tlInput.value) >= 995 && !force) {
    if (state.mode !== "live") startLive();
    return;
  }

  setMode("replay");
  if (livePollTimer) { clearInterval(livePollTimer); livePollTimer = null; }

  clearTimeout(scrubDebounce);
  scrubDebounce = setTimeout(async () => {
    try {
      const data = await fetch(`/api/shelf/history?ts=${encodeURIComponent(ts)}`).then((r) => r.json());
      if (data?.timestamp) renderState(data);
    } catch (_) { /* keep prev */ }
  }, 80);
}

if (tlInput) tlInput.addEventListener("input", () => handleScrub());

if (tlLive) tlLive.addEventListener("click", () => {
  if (tlInput) tlInput.value = "1000";
  startLive();
});

// ── Playback ──────────────────────────────────────────────────────────

function stopPlayback() {
  state.playing = false;
  if (state.playTimer) { clearInterval(state.playTimer); state.playTimer = null; }
  if (tlPlay) tlPlay.textContent = "▶";
}

function startPlayback() {
  if (!state.range || !tlInput) return;
  state.playing = true;
  if (tlPlay) tlPlay.textContent = "❚❚";
  if (livePollTimer) { clearInterval(livePollTimer); livePollTimer = null; }
  setMode("replay");

  const stepMs = 250;
  const advanceSec = state.speedSecPerSec * (stepMs / 1000);
  state.playTimer = setInterval(() => {
    const cur = tsFromSliderValue(tlInput.value);
    const next = new Date(new Date(cur).getTime() + advanceSec * 1000).toISOString();
    const nextVal = sliderValueFromTs(next);
    if (nextVal >= 1000) {
      tlInput.value = "1000";
      stopPlayback();
      startLive();
      return;
    }
    tlInput.value = String(nextVal);
    handleScrub(true);
  }, stepMs);
}

if (tlPlay) tlPlay.addEventListener("click", () => {
  if (state.playing) stopPlayback();
  else startPlayback();
});

if (tlSpeed) tlSpeed.addEventListener("change", () => {
  state.speedSecPerSec = parseInt(tlSpeed.value);
  if (state.playing) { stopPlayback(); startPlayback(); }
});

// ── Keyboard nav ──────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  if (!tlInput) return;
  const target = e.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const step = e.shiftKey ? 50 : 8;
    const dir = e.key === "ArrowLeft" ? -1 : 1;
    tlInput.value = String(Math.max(0, Math.min(1000, Number(tlInput.value) + step * dir)));
    handleScrub();
    e.preventDefault();
  }
});

// ── Boot ──────────────────────────────────────────────────────────────

loadRangeAndEvents();
startLive();

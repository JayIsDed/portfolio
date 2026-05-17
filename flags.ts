// Flag evaluation — mirrors shelf-event-logger/flags.ts so portfolio is self-contained.

export interface Flag {
  flag: string;
  level: "critical" | "warn" | "info";
  message: string;
  since?: string;
}

export interface EntityStates {
  [entityId: string]: {
    state: string;
    attributes: Record<string, any>;
    last_changed: string;
    last_updated: string;
  };
}

const TANK_TARGET = 77.0;
const TANK_BAND = 1.0;
const TDS_LOW = 200;
const TDS_HIGH = 400;
const HEATER_MAX = 150;
const STRAT_MAX = 1.0;
const AMBIENT_LOW = 58;
const STALE_MINUTES = 30;

const num = (s: string | undefined) => (s === undefined ? NaN : parseFloat(s));
const minutesSince = (iso: string) => (Date.now() - new Date(iso).getTime()) / 60000;

export function evaluateFlags(e: EntityStates): Flag[] {
  const flags: Flag[] = [];
  const tankCenter = e["sensor.plant_shelf_temperatures_tank_center"];
  const tankSubstrate = e["sensor.plant_shelf_temperatures_tank_substrate"];
  // Authoritative live entity IDs (verified 2026-05-17). Old `sensor.calibration_shelf_*`
  // names existed in an earlier mapping; using them silently broke flag evaluation.
  const tds = e["sensor.tank_chemistry_tds_tank"];
  const heaterPower = e["sensor.cal_shelf_inkbird_10g_current_consumption"];
  const shelfAmbient = e["sensor.plant_shelf_temperatures_shelf_ambient"];
  const canopyIlluminance = e["sensor.plant_shelf_canopy_canopy_illuminance"];
  const canopyTemp = e["sensor.plant_shelf_canopy_canopy_temperature"];

  if (tankCenter) {
    const v = num(tankCenter.state);
    if (!isNaN(v) && Math.abs(v - TANK_TARGET) > TANK_BAND) {
      flags.push({
        flag: "tank_band_breach",
        level: "critical",
        message: `tank_center ${v.toFixed(2)}°F is ${Math.abs(v - TANK_TARGET).toFixed(2)}° from ${TANK_TARGET}°F`,
      });
    }
  }

  if (tankCenter && tankSubstrate) {
    const delta = Math.abs(num(tankCenter.state) - num(tankSubstrate.state));
    if (!isNaN(delta) && delta > STRAT_MAX) {
      flags.push({
        flag: "stratification",
        level: "warn",
        message: `Stratification ${delta.toFixed(2)}°F exceeds ${STRAT_MAX}°F`,
      });
    }
  }

  if (tds) {
    const v = num(tds.state);
    if (!isNaN(v) && (v < TDS_LOW || v > TDS_HIGH)) {
      flags.push({
        flag: "tds_out_of_range",
        level: "warn",
        message: `TDS ${v.toFixed(0)} ppm outside ${TDS_LOW}-${TDS_HIGH}`,
      });
    }
  }

  if (heaterPower) {
    const v = num(heaterPower.state);
    if (!isNaN(v) && v > HEATER_MAX) {
      flags.push({
        flag: "heater_overdraw",
        level: "critical",
        message: `Heater drawing ${v.toFixed(1)}W exceeds ${HEATER_MAX}W`,
      });
    }
  }

  if (shelfAmbient) {
    const v = num(shelfAmbient.state);
    if (!isNaN(v) && v < AMBIENT_LOW) {
      flags.push({
        flag: "basement_cold_drift",
        level: "warn",
        message: `Shelf ambient ${v.toFixed(1)}°F below ${AMBIENT_LOW}°F`,
      });
    }
  }

  const staleChecks = [
    { entity: canopyIlluminance, name: "canopy_illuminance" },
    { entity: canopyTemp, name: "canopy_temperature" },
    { entity: tankCenter, name: "tank_center" },
    { entity: tankSubstrate, name: "tank_substrate" },
    { entity: tds, name: "tds" },
  ];

  for (const { entity, name } of staleChecks) {
    if (entity && minutesSince(entity.last_updated) > STALE_MINUTES) {
      flags.push({
        flag: `sensor_stale:${name}`,
        level: "warn",
        message: `${name} has not updated in ${Math.round(minutesSince(entity.last_updated))} min`,
        since: entity.last_updated,
      });
    }
  }

  return flags;
}

export function buildVitals(e: EntityStates): Record<string, number | string | boolean> {
  const n = (id: string) => parseFloat(e[id]?.state ?? "NaN");
  const heaterPower = n("sensor.cal_shelf_inkbird_10g_current_consumption");
  const growLight = e["light.grow_white"];
  const growBrightness = growLight?.state === "on" ? (growLight.attributes?.brightness ?? 0) / 255 * 100 : 0;

  // L0 power = sum of all 6 strip outlets + heater (Inkbird) — total wall draw at the shelf
  const outlets = [1, 2, 3, 4, 5, 6].map((i) =>
    n(`sensor.calibration_shelf_strip_tapo_p316m_${i}_current_consumption`)
  );
  const outletSum = outlets.reduce((a, b) => a + (isNaN(b) ? 0 : b), 0);
  const l0Power = outletSum + (isNaN(heaterPower) ? 0 : heaterPower);

  return {
    tank_center: n("sensor.plant_shelf_temperatures_tank_center"),
    tank_substrate: n("sensor.plant_shelf_temperatures_tank_substrate"),
    shelf_ambient: n("sensor.plant_shelf_temperatures_shelf_ambient"),
    canopy_temp: n("sensor.plant_shelf_canopy_canopy_temperature"),
    canopy_humidity: n("sensor.plant_shelf_canopy_canopy_humidity"),
    canopy_illuminance: n("sensor.plant_shelf_canopy_canopy_illuminance"),
    tds: n("sensor.tank_chemistry_tds_tank"),
    heater_power: heaterPower,
    heater_calling: !isNaN(heaterPower) && heaterPower > 5,
    heater_voltage: n("sensor.cal_shelf_inkbird_10g_voltage"),
    l0_power: l0Power,
    outlet_1_pump: outlets[0],
    outlet_3_led: outlets[2],
    outside_temp: n("sensor.outside_temperature"),
    outside_humidity: n("sensor.outside_humidity"),
    grow_light_brightness: Math.round(growBrightness),
  };
}

export function severityOf(flags: Flag[]): { critical: number; warn: number; info: number } {
  return {
    critical: flags.filter((f) => f.level === "critical").length,
    warn: flags.filter((f) => f.level === "warn").length,
    info: flags.filter((f) => f.level === "info").length,
  };
}

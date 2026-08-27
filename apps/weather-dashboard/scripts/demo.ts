/**
 * Demo harness: runs the real server and the real fusion engine against
 * synthetic model output, so the dashboard can be developed, screenshotted and
 * reviewed without touching a live API or burning free-tier quota.
 *
 *   node --experimental-strip-types scripts/demo.ts
 */

import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import type { WeatherSource } from "../src/sources/index.ts";
import type {
  Condition,
  Coordinates,
  HourPoint,
  SourceDescriptor,
} from "../src/types.ts";

const HOUR_MS = 3_600_000;

/** Deterministic pseudo-random in [0, 1) so runs are reproducible. */
const noise = (seed: number): number => {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

const DEMO_SOURCES: Array<{
  descriptor: SourceDescriptor;
  /** Systematic offset, to make the sources genuinely disagree. */
  bias: number;
  wetness: number;
}> = [
  {
    descriptor: { id: "om-ukmo", label: "Met Office UKV / Global (via Open-Meteo)", attribution: "Met Office via Open-Meteo", family: "ukmo", resolutionKm: 2, maxLeadHours: 168 },
    bias: 0.2,
    wetness: 1.3,
  },
  {
    descriptor: { id: "met-office-datahub", label: "Met Office (DataHub Site Specific)", attribution: "Met Office Weather DataHub", family: "ukmo", resolutionKm: 2, maxLeadHours: 168 },
    bias: 0.35,
    wetness: 1.25,
  },
  {
    descriptor: { id: "om-ecmwf", label: "ECMWF IFS 0.25°", attribution: "ECMWF via Open-Meteo", family: "ecmwf", resolutionKm: 25, maxLeadHours: 168 },
    bias: -0.4,
    wetness: 0.7,
  },
  {
    descriptor: { id: "met-norway", label: "MET Norway / Yr", attribution: "MET Norway (CC BY 4.0)", family: "ecmwf", resolutionKm: 9, maxLeadHours: 168 },
    bias: -0.3,
    wetness: 0.75,
  },
  {
    descriptor: { id: "om-icon", label: "DWD ICON", attribution: "Deutscher Wetterdienst via Open-Meteo", family: "icon", resolutionKm: 7, maxLeadHours: 168 },
    bias: 0.1,
    wetness: 1.0,
  },
  {
    descriptor: { id: "om-gfs", label: "NOAA GFS", attribution: "NOAA via Open-Meteo", family: "gfs", resolutionKm: 13, maxLeadHours: 168 },
    bias: 1.1,
    wetness: 0.5,
  },
  {
    descriptor: { id: "om-gem", label: "Environment Canada GEM", attribution: "Environment Canada via Open-Meteo", family: "gem", resolutionKm: 15, maxLeadHours: 168 },
    bias: -0.8,
    wetness: 1.1,
  },
  {
    descriptor: { id: "accuweather", label: "AccuWeather", attribution: "AccuWeather", family: "proprietary", resolutionKm: 11, maxLeadHours: 12 },
    bias: 0.5,
    wetness: 0.9,
  },
  {
    descriptor: { id: "apple-weatherkit", label: "Apple Weather (WeatherKit)", attribution: "Apple Weather", family: "proprietary", resolutionKm: 10, maxLeadHours: 168 },
    bias: -0.15,
    wetness: 0.95,
  },
];

const conditionFor = (cloud: number, precip: number): Condition => {
  if (precip >= 1.5) return "heavy-rain";
  if (precip >= 0.4) return "rain";
  if (precip >= 0.1) return "drizzle";
  if (cloud >= 75) return "cloudy";
  if (cloud >= 30) return "partly-cloudy";
  return "clear";
};

const buildSeries = (
  seedOffset: number,
  bias: number,
  wetness: number,
): HourPoint[] => {
  const start = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  const hours: HourPoint[] = [];

  for (let index = 0; index < 168; index += 1) {
    const time = new Date(start + index * HOUR_MS);
    const hourOfDay = time.getUTCHours();
    // Diurnal cycle, a slow synoptic trend, and per-source spread that grows
    // with lead time exactly as real model disagreement does.
    const diurnal = -Math.cos(((hourOfDay - 3) / 24) * 2 * Math.PI) * 4.5;
    const synoptic = Math.sin(index / 38) * 3;
    const spread = (noise(index + seedOffset) - 0.5) * (1 + index / 40);
    const tempC = 15.5 + diurnal + synoptic + bias + spread;

    const frontal = Math.max(0, Math.sin(index / 17 - 1.2));
    const showerNoise = noise(index * 3.1 + seedOffset);
    const precipMm =
      frontal > 0.55 ? Number((frontal * showerNoise * 2.4 * wetness).toFixed(2)) : 0;

    const cloudPct = Math.min(
      100,
      Math.max(5, 35 + frontal * 70 + (noise(index + seedOffset * 2) - 0.5) * 30),
    );
    const windKph = 12 + frontal * 22 + (noise(index * 1.7 + seedOffset) - 0.5) * 8;

    hours.push({
      time: time.toISOString(),
      tempC: Number(tempC.toFixed(1)),
      apparentC: Number((tempC - 1.6 - windKph / 22).toFixed(1)),
      precipMm,
      windKph: Number(windKph.toFixed(1)),
      gustKph: Number((windKph * 1.7).toFixed(1)),
      windDirDeg: Number(((215 + Math.sin(index / 24) * 45 + bias * 12) % 360).toFixed(0)),
      humidityPct: Number(Math.min(99, 62 + frontal * 28).toFixed(0)),
      cloudPct: Number(cloudPct.toFixed(0)),
      pressureHpa: Number((1012 - frontal * 14 + bias).toFixed(1)),
      uvIndex:
        hourOfDay >= 8 && hourOfDay <= 18
          ? Number((Math.max(0, 4.5 - Math.abs(13 - hourOfDay)) * (1 - cloudPct / 160)).toFixed(1))
          : 0,
      visibilityKm: Number(Math.max(2, 24 - frontal * 18).toFixed(1)),
      condition: conditionFor(cloudPct, precipMm),
    });
  }

  // Two sources publish a probability of precipitation; the rest do not, which
  // exercises the ensemble-vote path in the fusion engine.
  return hours;
};

const buildDemoSources = (): WeatherSource[] =>
  DEMO_SOURCES.map((entry, index) => ({
    descriptor: entry.descriptor,
    fetch: async (_coords: Coordinates): Promise<
      Awaited<ReturnType<WeatherSource["fetch"]>>
    > => {
      const hours = buildSeries(index * 97, entry.bias, entry.wetness);
      const publishesProbability =
        index < 2 || entry.descriptor.family === "proprietary";
      const withProbability =
        publishesProbability
          ? hours.map((hour) => ({
              ...hour,
              precipProbPct: Math.min(
                95,
                Math.round((hour.precipMm ?? 0) > 0 ? 45 + (hour.precipMm ?? 0) * 22 : 8),
              ),
            }))
          : hours;
      return {
        source: entry.descriptor,
        hours: withProbability,
        fetchedAt: new Date().toISOString(),
        latencyMs: 40 + index * 11,
      };
    },
  }));

const config = loadConfig();
console.log("demo mode: synthetic model data, no upstream calls");
startServer(config, { sources: buildDemoSources() });

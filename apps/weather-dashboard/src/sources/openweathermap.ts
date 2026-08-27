import { buildUrl, fetchJson, UpstreamError } from "../http.ts";
import { asArray, isRecord, numberAt, path } from "../parse.ts";
import { openWeatherIdToCondition } from "../conditions.ts";
import { msToKph, metresToKm, round } from "../units.ts";
import type {
  Coordinates,
  HourPoint,
  SourceDescriptor,
  SourceForecast,
} from "../types.ts";

/**
 * OpenWeatherMap One Call 3.0. A commercial blend rather than a raw model, so
 * it sits in the "blend" correlation family alongside WeatherAPI: useful as a
 * sanity check, not as an independent vote.
 */

const ENDPOINT = "https://api.openweathermap.org/data/3.0/onecall";

export const OPENWEATHERMAP_DESCRIPTOR: SourceDescriptor = {
  id: "openweathermap",
  label: "OpenWeatherMap",
  attribution: "OpenWeatherMap",
  family: "blend",
  resolutionKm: 11,
  requiresEnv: "OPENWEATHERMAP_API_KEY",
  maxLeadHours: 48,
};

const parseHourly = (entries: unknown[]): HourPoint[] => {
  const hours: HourPoint[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const epoch = numberAt(entry, "dt");
    if (epoch === undefined) continue;

    const point: HourPoint = { time: new Date(epoch * 1000).toISOString() };

    const temp = numberAt(entry, "temp");
    if (temp !== undefined) point.tempC = temp;

    const feels = numberAt(entry, "feels_like");
    if (feels !== undefined) point.apparentC = feels;

    const pressure = numberAt(entry, "pressure");
    if (pressure !== undefined) point.pressureHpa = pressure;

    const humidity = numberAt(entry, "humidity");
    if (humidity !== undefined) point.humidityPct = humidity;

    const clouds = numberAt(entry, "clouds");
    if (clouds !== undefined) point.cloudPct = clouds;

    const uv = numberAt(entry, "uvi");
    if (uv !== undefined) point.uvIndex = uv;

    const visibility = numberAt(entry, "visibility");
    if (visibility !== undefined) {
      point.visibilityKm = round(metresToKm(visibility), 2);
    }

    // With units=metric, wind is m/s.
    const wind = numberAt(entry, "wind_speed");
    if (wind !== undefined) point.windKph = round(msToKph(wind), 1);

    const gust = numberAt(entry, "wind_gust");
    if (gust !== undefined) point.gustKph = round(msToKph(gust), 1);

    const windDir = numberAt(entry, "wind_deg");
    if (windDir !== undefined) point.windDirDeg = windDir;

    // `pop` is a 0-1 fraction.
    const pop = numberAt(entry, "pop");
    if (pop !== undefined) point.precipProbPct = round(pop * 100, 0);

    const rain = numberAt(path(entry, "rain"), "1h") ?? 0;
    const snow = numberAt(path(entry, "snow"), "1h") ?? 0;
    if (isRecord(entry["rain"]) || isRecord(entry["snow"])) {
      point.precipMm = round(rain + snow, 2);
    } else {
      point.precipMm = 0;
    }

    const id = numberAt(asArray(entry["weather"])[0], "id");
    if (id !== undefined) point.condition = openWeatherIdToCondition(id);

    hours.push(point);
  }
  return hours;
};

export const createOpenWeatherMapSource = (options: { apiKey: string }) => ({
  descriptor: OPENWEATHERMAP_DESCRIPTOR,
  fetch: async (
    coords: Coordinates,
    signal?: AbortSignal,
  ): Promise<SourceForecast> => {
    const startedAt = Date.now();
    const url = buildUrl(ENDPOINT, {
      lat: round(coords.latitude, 4),
      lon: round(coords.longitude, 4),
      appid: options.apiKey,
      units: "metric",
      exclude: "minutely,daily,alerts,current",
    });
    const json = await fetchJson<unknown>(url, { signal });
    const hours = parseHourly(asArray(path(json, "hourly")));
    if (hours.length === 0) {
      throw new UpstreamError("no usable hourly entries", ENDPOINT);
    }
    return {
      source: OPENWEATHERMAP_DESCRIPTOR,
      hours,
      fetchedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
    };
  },
});

export const __testing = { parseHourly };

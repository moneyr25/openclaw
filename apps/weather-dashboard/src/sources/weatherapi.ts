import { buildUrl, fetchJson, UpstreamError } from "../http.ts";
import { asArray, isRecord, numberAt, path, stringAt } from "../parse.ts";
import { weatherApiCodeToCondition } from "../conditions.ts";
import { round } from "../units.ts";
import type {
  Coordinates,
  HourPoint,
  SourceDescriptor,
  SourceForecast,
} from "../types.ts";

/**
 * WeatherAPI.com. Like OpenWeatherMap this is a commercial blend, so it shares
 * the "blend" family. Free tier caps the forecast at 3 days.
 */

const ENDPOINT = "https://api.weatherapi.com/v1/forecast.json";

export const WEATHERAPI_DESCRIPTOR: SourceDescriptor = {
  id: "weatherapi",
  label: "WeatherAPI.com",
  attribution: "WeatherAPI.com",
  family: "blend",
  resolutionKm: 12,
  requiresEnv: "WEATHERAPI_KEY",
  maxLeadHours: 72,
};

const parseForecastDays = (days: unknown[]): HourPoint[] => {
  const hours: HourPoint[] = [];
  for (const day of days) {
    for (const entry of asArray(path(day, "hour"))) {
      if (!isRecord(entry)) continue;
      const epoch = numberAt(entry, "time_epoch");
      const isoish = stringAt(entry, "time");
      const time =
        epoch !== undefined
          ? new Date(epoch * 1000).toISOString()
          : isoish
            ? new Date(isoish.replace(" ", "T")).toISOString()
            : undefined;
      if (!time || time === "Invalid Date") continue;

      const point: HourPoint = { time };

      const temp = numberAt(entry, "temp_c");
      if (temp !== undefined) point.tempC = temp;

      const feels = numberAt(entry, "feelslike_c");
      if (feels !== undefined) point.apparentC = feels;

      const precip = numberAt(entry, "precip_mm");
      if (precip !== undefined) point.precipMm = precip;

      const rainChance = numberAt(entry, "chance_of_rain");
      const snowChance = numberAt(entry, "chance_of_snow");
      const chance = Math.max(rainChance ?? 0, snowChance ?? 0);
      if (rainChance !== undefined || snowChance !== undefined) {
        point.precipProbPct = chance;
      }

      const wind = numberAt(entry, "wind_kph");
      if (wind !== undefined) point.windKph = wind;

      const gust = numberAt(entry, "gust_kph");
      if (gust !== undefined) point.gustKph = gust;

      const windDir = numberAt(entry, "wind_degree");
      if (windDir !== undefined) point.windDirDeg = windDir;

      const humidity = numberAt(entry, "humidity");
      if (humidity !== undefined) point.humidityPct = humidity;

      const cloud = numberAt(entry, "cloud");
      if (cloud !== undefined) point.cloudPct = cloud;

      const pressure = numberAt(entry, "pressure_mb");
      if (pressure !== undefined) point.pressureHpa = pressure;

      const uv = numberAt(entry, "uv");
      if (uv !== undefined) point.uvIndex = uv;

      const visibility = numberAt(entry, "vis_km");
      if (visibility !== undefined) point.visibilityKm = visibility;

      const code = numberAt(path(entry, "condition"), "code");
      if (code !== undefined) point.condition = weatherApiCodeToCondition(code);

      hours.push(point);
    }
  }
  return hours;
};

export const createWeatherApiSource = (options: { apiKey: string }) => ({
  descriptor: WEATHERAPI_DESCRIPTOR,
  fetch: async (
    coords: Coordinates,
    signal?: AbortSignal,
  ): Promise<SourceForecast> => {
    const startedAt = Date.now();
    const url = buildUrl(ENDPOINT, {
      key: options.apiKey,
      q: `${round(coords.latitude, 4)},${round(coords.longitude, 4)}`,
      days: 3,
      aqi: "no",
      alerts: "no",
    });
    const json = await fetchJson<unknown>(url, { signal });
    const hours = parseForecastDays(asArray(path(json, "forecast.forecastday")));
    if (hours.length === 0) {
      throw new UpstreamError("no usable hourly entries", ENDPOINT);
    }
    return {
      source: WEATHERAPI_DESCRIPTOR,
      hours,
      fetchedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
    };
  },
});

export const __testing = { parseForecastDays };

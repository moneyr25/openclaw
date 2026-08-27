import { buildUrl, fetchJson, UpstreamError } from "../http.ts";
import { asArray, isRecord, numberAt, path, stringAt } from "../parse.ts";
import { accuWeatherIconToCondition } from "../conditions.ts";
import { round } from "../units.ts";
import type {
  Condition,
  Coordinates,
  HourPoint,
  SourceDescriptor,
  SourceForecast,
} from "../types.ts";

/**
 * AccuWeather.
 *
 * A genuine forecast system rather than a thin wrapper: its own bias
 * correction, statistical post-processing and human forecaster intervention on
 * top of the raw models. That earns it the `proprietary` family alongside
 * Apple, weighted well above the pass-through commercial APIs but still below
 * the raw models it is derived from.
 *
 * Two calls are needed — coordinates resolve to a location key, then the key
 * resolves to a forecast. The free tier allows only 50 calls a day, so the
 * location key (which never changes for a coordinate) is cached in process and
 * the pair costs one call per refresh after the first.
 */

const BASE_URL = "https://dataservice.accuweather.com";

export const ACCUWEATHER_DESCRIPTOR: SourceDescriptor = {
  id: "accuweather",
  label: "AccuWeather",
  attribution: "AccuWeather",
  family: "proprietary",
  resolutionKm: 11,
  requiresEnv: "ACCUWEATHER_API_KEY",
  // The free tier returns 12 hours; paid tiers extend to 120.
  maxLeadHours: 12,
};

type AccuWeatherOptions = {
  apiKey: string;
  /** One of AccuWeather's hourly tiers: 1hour, 12hour, 24hour, 72hour, 120hour. */
  hourlyRange: string;
  userAgent: string;
};

/** Location keys are stable per coordinate, so they are worth keeping. */
const locationKeys = new Map<string, string>();

const locationCacheKey = (coords: Coordinates): string =>
  `${round(coords.latitude, 3)},${round(coords.longitude, 3)}`;

const resolveLocationKey = async (
  coords: Coordinates,
  options: AccuWeatherOptions,
  signal?: AbortSignal,
): Promise<string> => {
  const cacheKey = locationCacheKey(coords);
  const cached = locationKeys.get(cacheKey);
  if (cached) return cached;

  const url = buildUrl(`${BASE_URL}/locations/v1/cities/geoposition/search`, {
    apikey: options.apiKey,
    q: `${round(coords.latitude, 4)},${round(coords.longitude, 4)}`,
  });
  const json = await fetchJson<unknown>(url, {
    signal,
    headers: { "user-agent": options.userAgent },
  });

  const key = stringAt(json, "Key");
  if (!key) {
    throw new UpstreamError(
      "geoposition search returned no location Key",
      BASE_URL,
    );
  }
  locationKeys.set(cacheKey, key);
  return key;
};

/**
 * AccuWeather has no distinct heavy-rain icon, so a downpour and a shower share
 * one code. The forecast rainfall rate recovers the distinction.
 */
const withIntensity = (
  condition: Condition,
  liquidMm: number | undefined,
): Condition => {
  if (condition !== "rain" || liquidMm === undefined) return condition;
  if (liquidMm >= 2) return "heavy-rain";
  if (liquidMm > 0 && liquidMm < 0.3) return "drizzle";
  return condition;
};

const parseHourly = (entries: unknown[]): HourPoint[] => {
  const hours: HourPoint[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;

    const epoch = numberAt(entry, "EpochDateTime");
    const iso = stringAt(entry, "DateTime");
    const time =
      epoch !== undefined
        ? new Date(epoch * 1000).toISOString()
        : iso
          ? new Date(iso).toISOString()
          : undefined;
    if (!time || time === "Invalid Date") continue;

    const point: HourPoint = { time };

    // With metric=true these are already Celsius, km/h, mm and km.
    const temp = numberAt(path(entry, "Temperature"), "Value");
    if (temp !== undefined) point.tempC = temp;

    const feels = numberAt(path(entry, "RealFeelTemperature"), "Value");
    if (feels !== undefined) point.apparentC = feels;

    const wind = numberAt(path(entry, "Wind.Speed"), "Value");
    if (wind !== undefined) point.windKph = wind;

    const gust = numberAt(path(entry, "WindGust.Speed"), "Value");
    if (gust !== undefined) point.gustKph = gust;

    const windDir = numberAt(path(entry, "Wind.Direction"), "Degrees");
    if (windDir !== undefined) point.windDirDeg = windDir;

    const humidity = numberAt(entry, "RelativeHumidity");
    if (humidity !== undefined) point.humidityPct = humidity;

    const cloud = numberAt(entry, "CloudCover");
    if (cloud !== undefined) point.cloudPct = cloud;

    const uv = numberAt(entry, "UVIndex");
    if (uv !== undefined) point.uvIndex = uv;

    const visibility = numberAt(path(entry, "Visibility"), "Value");
    if (visibility !== undefined) point.visibilityKm = visibility;

    const probability = numberAt(entry, "PrecipitationProbability");
    if (probability !== undefined) point.precipProbPct = probability;

    const liquid = numberAt(path(entry, "TotalLiquid"), "Value");
    if (liquid !== undefined) point.precipMm = liquid;

    const icon = numberAt(entry, "WeatherIcon");
    if (icon !== undefined) {
      point.condition = withIntensity(accuWeatherIconToCondition(icon), liquid);
    }

    hours.push(point);
  }
  return hours;
};

export const createAccuWeatherSource = (options: AccuWeatherOptions) => ({
  descriptor: {
    ...ACCUWEATHER_DESCRIPTOR,
    // Keep the declared range honest when an operator has a paid tier.
    maxLeadHours: Number.parseInt(options.hourlyRange, 10) || 12,
  },
  fetch: async (
    coords: Coordinates,
    signal?: AbortSignal,
  ): Promise<SourceForecast> => {
    const startedAt = Date.now();
    const locationKey = await resolveLocationKey(coords, options, signal);

    const url = buildUrl(
      `${BASE_URL}/forecasts/v1/hourly/${options.hourlyRange}/${locationKey}`,
      { apikey: options.apiKey, metric: true, details: true },
    );
    const json = await fetchJson<unknown>(url, {
      signal,
      headers: { "user-agent": options.userAgent },
    });

    const hours = parseHourly(asArray(json));
    if (hours.length === 0) {
      throw new UpstreamError("no usable hourly entries", BASE_URL);
    }

    return {
      source: {
        ...ACCUWEATHER_DESCRIPTOR,
        maxLeadHours: Number.parseInt(options.hourlyRange, 10) || 12,
      },
      hours,
      fetchedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
    };
  },
});

export const __testing = {
  parseHourly,
  withIntensity,
  clearLocationCache: () => locationKeys.clear(),
};

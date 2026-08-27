import { buildUrl, fetchJson, UpstreamError } from "../http.ts";
import { asArray, isRecord, numberAt, path, stringAt } from "../parse.ts";
import { metOfficeCodeToCondition } from "../conditions.ts";
import { msToKph, paToHpa, metresToKm, round } from "../units.ts";
import type {
  Coordinates,
  HourPoint,
  SourceDescriptor,
  SourceForecast,
} from "../types.ts";

/**
 * Met Office Weather DataHub, Site Specific.
 *
 * This is the authoritative UK source: the same UKV/Global Spot output that
 * drives the Met Office's own app, on the exact grid point nearest the caller.
 * It needs a (free) API key, so the dashboard treats it as optional and simply
 * runs with one fewer source when the key is absent.
 *
 * Responses are GeoJSON FeatureCollections; the forecast lives at
 * `features[0].properties.timeSeries[]`.
 */

export const MET_OFFICE_DESCRIPTOR: SourceDescriptor = {
  id: "met-office-datahub",
  label: "Met Office (DataHub Site Specific)",
  attribution: "Met Office Weather DataHub",
  family: "ukmo",
  resolutionKm: 2,
  requiresEnv: "MET_OFFICE_API_KEY",
  maxLeadHours: 168,
};

type MetOfficeOptions = {
  apiKey: string;
  baseUrl: string;
  userAgent: string;
};

const parseTimeSeries = (entries: unknown[]): HourPoint[] => {
  const hours: HourPoint[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const time = stringAt(entry, "time");
    if (!time) continue;
    const date = new Date(time);
    if (Number.isNaN(date.getTime())) continue;

    const point: HourPoint = { time: date.toISOString() };

    const temp = numberAt(entry, "screenTemperature");
    if (temp !== undefined) point.tempC = temp;

    const feels = numberAt(entry, "feelsLikeTemperature");
    if (feels !== undefined) point.apparentC = feels;

    // Hourly gives an instantaneous rate; three-hourly gives an accumulation.
    const totalPrecip = numberAt(entry, "totalPrecipAmount");
    const precipRate = numberAt(entry, "precipitationRate");
    if (totalPrecip !== undefined) point.precipMm = totalPrecip;
    else if (precipRate !== undefined) point.precipMm = precipRate;

    const precipProb =
      numberAt(entry, "probOfPrecipitation") ??
      numberAt(entry, "probOfRain");
    if (precipProb !== undefined) point.precipProbPct = precipProb;

    const wind = numberAt(entry, "windSpeed10m");
    if (wind !== undefined) point.windKph = round(msToKph(wind), 1);

    const gust =
      numberAt(entry, "windGustSpeed10m") ?? numberAt(entry, "max10mWindGust");
    if (gust !== undefined) point.gustKph = round(msToKph(gust), 1);

    const windDir = numberAt(entry, "windDirectionFrom10m");
    if (windDir !== undefined) point.windDirDeg = windDir;

    const humidity = numberAt(entry, "screenRelativeHumidity");
    if (humidity !== undefined) point.humidityPct = humidity;

    const pressurePa = numberAt(entry, "mslp");
    if (pressurePa !== undefined) point.pressureHpa = round(paToHpa(pressurePa), 1);

    const uv = numberAt(entry, "uvIndex") ?? numberAt(entry, "maxUvIndex");
    if (uv !== undefined) point.uvIndex = uv;

    const visibilityM = numberAt(entry, "visibility");
    if (visibilityM !== undefined) {
      point.visibilityKm = round(metresToKm(visibilityM), 2);
    }

    const code = numberAt(entry, "significantWeatherCode");
    if (code !== undefined) point.condition = metOfficeCodeToCondition(code);

    hours.push(point);
  }
  return hours;
};

const readFeature = (json: unknown): { entries: unknown[]; name?: string } => {
  const feature = asArray(path(json, "features"))[0];
  const entries = asArray(path(feature, "properties.timeSeries"));
  const name = stringAt(path(feature, "properties.location"), "name");
  return name === undefined ? { entries } : { entries, name };
};

const fetchSlice = async (
  slice: "hourly" | "three-hourly",
  coords: Coordinates,
  options: MetOfficeOptions,
  signal?: AbortSignal,
): Promise<{ entries: unknown[]; name?: string }> => {
  const url = buildUrl(`${options.baseUrl}/${slice}`, {
    latitude: round(coords.latitude, 4),
    longitude: round(coords.longitude, 4),
    excludeParameterMetadata: true,
    includeLocationName: true,
  });
  const json = await fetchJson<unknown>(url, {
    signal,
    headers: {
      // DataHub authenticates with a bare `apikey` header, not a bearer token.
      apikey: options.apiKey,
      "user-agent": options.userAgent,
    },
  });
  return readFeature(json);
};

export const createMetOfficeSource = (options: MetOfficeOptions) => ({
  descriptor: MET_OFFICE_DESCRIPTOR,
  fetch: async (
    coords: Coordinates,
    signal?: AbortSignal,
  ): Promise<SourceForecast> => {
    const startedAt = Date.now();

    // Hourly covers ~48h at full resolution; three-hourly extends to 7 days.
    // Fetching both and preferring hourly gives one seamless series.
    const [hourly, threeHourly] = await Promise.allSettled([
      fetchSlice("hourly", coords, options, signal),
      fetchSlice("three-hourly", coords, options, signal),
    ]);

    if (hourly.status === "rejected" && threeHourly.status === "rejected") {
      throw hourly.reason instanceof Error
        ? hourly.reason
        : new UpstreamError(String(hourly.reason), options.baseUrl);
    }

    const byTime = new Map<string, HourPoint>();
    if (threeHourly.status === "fulfilled") {
      for (const point of parseTimeSeries(threeHourly.value.entries)) {
        byTime.set(point.time, point);
      }
    }
    if (hourly.status === "fulfilled") {
      for (const point of parseTimeSeries(hourly.value.entries)) {
        byTime.set(point.time, point);
      }
    }

    const hours = [...byTime.values()].sort((a, b) =>
      a.time.localeCompare(b.time),
    );
    if (hours.length === 0) {
      throw new UpstreamError(
        "DataHub returned no usable timeSeries entries",
        options.baseUrl,
      );
    }

    return {
      source: MET_OFFICE_DESCRIPTOR,
      hours,
      fetchedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
    };
  },
});

export const __testing = { parseTimeSeries, readFeature };

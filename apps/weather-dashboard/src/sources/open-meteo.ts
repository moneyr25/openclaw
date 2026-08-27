import { buildUrl, fetchJson, UpstreamError } from "../http.ts";
import { pickSeries, toUtcHour, asArray, asString } from "../parse.ts";
import { wmoCodeToCondition } from "../conditions.ts";
import { round } from "../units.ts";
import type {
  Coordinates,
  HourPoint,
  SourceDescriptor,
  SourceForecast,
} from "../types.ts";

const ENDPOINT = "https://api.open-meteo.com/v1/forecast";

/**
 * Variables every model in our set produces. If Open-Meteo rejects a request
 * these are the ones we keep.
 */
const CORE_VARIABLES = [
  "temperature_2m",
  "apparent_temperature",
  "precipitation",
  "weather_code",
  "wind_speed_10m",
  "wind_direction_10m",
  "relative_humidity_2m",
  "cloud_cover",
  "surface_pressure",
] as const;

/**
 * Variables that only some models carry. Requesting one a model does not have
 * fails the whole request with HTTP 400, so on that error we retry with the
 * core set only rather than losing the source entirely.
 */
const OPTIONAL_VARIABLES = [
  "precipitation_probability",
  "wind_gusts_10m",
  "uv_index",
  "visibility",
] as const;

type OpenMeteoResponse = {
  hourly?: Record<string, unknown>;
  error?: boolean;
  reason?: string;
  [key: string]: unknown;
};

const requestModel = async (
  coords: Coordinates,
  modelId: string,
  variables: readonly string[],
  forecastDays: number,
  signal?: AbortSignal,
): Promise<OpenMeteoResponse> =>
  fetchJson<OpenMeteoResponse>(
    buildUrl(ENDPOINT, {
      latitude: round(coords.latitude, 4),
      longitude: round(coords.longitude, 4),
      hourly: variables.join(","),
      models: modelId,
      timezone: "UTC",
      forecast_days: forecastDays,
      wind_speed_unit: "kmh",
      precipitation_unit: "mm",
      temperature_unit: "celsius",
      cell_selection: "nearest",
    }),
    { signal, timeoutMs: 15_000 },
  );

const parseHours = (hourly: Record<string, unknown>): HourPoint[] => {
  const times = asArray(hourly["time"]);
  if (times.length === 0) return [];

  const series = {
    tempC: pickSeries(hourly, "temperature_2m"),
    apparentC: pickSeries(hourly, "apparent_temperature"),
    precipMm: pickSeries(hourly, "precipitation"),
    precipProbPct: pickSeries(hourly, "precipitation_probability"),
    windKph: pickSeries(hourly, "wind_speed_10m"),
    gustKph: pickSeries(hourly, "wind_gusts_10m"),
    windDirDeg: pickSeries(hourly, "wind_direction_10m"),
    humidityPct: pickSeries(hourly, "relative_humidity_2m"),
    cloudPct: pickSeries(hourly, "cloud_cover"),
    pressureHpa: pickSeries(hourly, "surface_pressure"),
    uvIndex: pickSeries(hourly, "uv_index"),
  };
  const visibility = pickSeries(hourly, "visibility");
  const weatherCode = pickSeries(hourly, "weather_code");

  const hours: HourPoint[] = [];
  for (let index = 0; index < times.length; index += 1) {
    const raw = times[index];
    const time = toUtcHour(
      typeof raw === "number" ? raw : (asString(raw) ?? ""),
    );
    if (!time) continue;

    const point: HourPoint = { time };
    for (const [key, values] of Object.entries(series)) {
      const value = values?.[index];
      if (typeof value === "number" && Number.isFinite(value)) {
        point[key as keyof typeof series] = value;
      }
    }
    // Open-Meteo reports visibility in metres.
    const visibilityM = visibility?.[index];
    if (typeof visibilityM === "number" && Number.isFinite(visibilityM)) {
      point.visibilityKm = round(visibilityM / 1000, 2);
    }
    const code = weatherCode?.[index];
    if (typeof code === "number" && Number.isFinite(code)) {
      point.condition = wmoCodeToCondition(code);
    }
    hours.push(point);
  }
  return hours;
};

/**
 * Build a source backed by one specific Open-Meteo model.
 *
 * One request per model (rather than one request with `models=a,b,c`) keeps the
 * response field names unsuffixed, lets a single model fail without taking the
 * others down, and lets each model use its own forecast length.
 */
export const createOpenMeteoSource = (
  descriptor: SourceDescriptor,
  modelId: string,
): {
  descriptor: SourceDescriptor;
  fetch: (coords: Coordinates, signal?: AbortSignal) => Promise<SourceForecast>;
} => ({
  descriptor,
  fetch: async (coords, signal) => {
    const startedAt = Date.now();
    const forecastDays = Math.min(
      7,
      Math.max(1, Math.ceil(descriptor.maxLeadHours / 24)),
    );
    const full = [...CORE_VARIABLES, ...OPTIONAL_VARIABLES];

    let json: OpenMeteoResponse;
    try {
      json = await requestModel(coords, modelId, full, forecastDays, signal);
    } catch (error) {
      // A 400 here almost always means one optional variable is unavailable for
      // this model. Retry with the core set before giving up on the source.
      if (error instanceof UpstreamError && error.status === 400) {
        json = await requestModel(
          coords,
          modelId,
          CORE_VARIABLES,
          forecastDays,
          signal,
        );
      } else {
        throw error;
      }
    }

    if (json.error) {
      throw new UpstreamError(
        `open-meteo rejected the request: ${json.reason ?? "unknown reason"}`,
        ENDPOINT,
      );
    }
    if (!json.hourly) {
      throw new UpstreamError("response had no `hourly` block", ENDPOINT);
    }

    const hours = parseHours(json.hourly);
    if (hours.length === 0) {
      throw new UpstreamError("response had no usable hours", ENDPOINT);
    }

    return {
      source: descriptor,
      hours,
      fetchedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
    };
  },
});

/** Exported for tests. */
export const __testing = { parseHours };

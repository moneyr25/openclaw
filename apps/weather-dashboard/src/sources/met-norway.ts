import { buildUrl, fetchJson, UpstreamError } from "../http.ts";
import { asArray, isRecord, numberAt, path, stringAt } from "../parse.ts";
import { metNorwaySymbolToCondition } from "../conditions.ts";
import { msToKph, round } from "../units.ts";
import type {
  Coordinates,
  HourPoint,
  SourceDescriptor,
  SourceForecast,
} from "../types.ts";

/**
 * MET Norway Locationforecast 2.0 (the engine behind Yr).
 *
 * Free and keyless, but their terms require a real contact address in the
 * User-Agent and coordinates truncated to 4 decimals; requests without a
 * contact are answered with 403.
 * https://api.met.no/doc/TermsOfService
 *
 * Over the UK this is ECMWF-based, so it shares a correlation family with the
 * ECMWF source and the two are deliberately not counted as independent.
 */

const ENDPOINT = "https://api.met.no/weatherapi/locationforecast/2.0/compact";

export const MET_NORWAY_DESCRIPTOR: SourceDescriptor = {
  id: "met-norway",
  label: "MET Norway / Yr",
  attribution: "MET Norway (CC BY 4.0)",
  family: "ecmwf",
  resolutionKm: 9,
  maxLeadHours: 168,
};

/**
 * The series is hourly for roughly the first three days and six-hourly after
 * that. We keep the six-hourly entries: the aggregator aligns on whatever hours
 * a source actually provides, so a sparse tail still contributes.
 */
const parseTimeseries = (entries: unknown[]): HourPoint[] => {
  const hours: HourPoint[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const time = stringAt(entry, "time");
    if (!time) continue;
    const date = new Date(time);
    if (Number.isNaN(date.getTime())) continue;

    const details = path(entry, "data.instant.details");
    const point: HourPoint = { time: date.toISOString() };

    const temp = numberAt(details, "air_temperature");
    if (temp !== undefined) point.tempC = temp;

    const humidity = numberAt(details, "relative_humidity");
    if (humidity !== undefined) point.humidityPct = humidity;

    const cloud = numberAt(details, "cloud_area_fraction");
    if (cloud !== undefined) point.cloudPct = cloud;

    const pressure = numberAt(details, "air_pressure_at_sea_level");
    if (pressure !== undefined) point.pressureHpa = pressure;

    const wind = numberAt(details, "wind_speed");
    if (wind !== undefined) point.windKph = round(msToKph(wind), 1);

    const gust = numberAt(details, "wind_speed_of_gust");
    if (gust !== undefined) point.gustKph = round(msToKph(gust), 1);

    const windDir = numberAt(details, "wind_from_direction");
    if (windDir !== undefined) point.windDirDeg = windDir;

    const uv = numberAt(details, "ultraviolet_index_clear_sky");
    if (uv !== undefined) point.uvIndex = uv;

    // Prefer the 1-hour block; fall back to the 6-hour one for the long tail,
    // spreading its accumulation evenly so units stay "mm in this hour".
    const oneHour = path(entry, "data.next_1_hours");
    const sixHour = path(entry, "data.next_6_hours");

    const oneHourPrecip = numberAt(path(oneHour, "details"), "precipitation_amount");
    if (oneHourPrecip !== undefined) {
      point.precipMm = oneHourPrecip;
    } else {
      const sixHourPrecip = numberAt(
        path(sixHour, "details"),
        "precipitation_amount",
      );
      if (sixHourPrecip !== undefined) point.precipMm = round(sixHourPrecip / 6, 2);
    }

    const prob =
      numberAt(path(oneHour, "details"), "probability_of_precipitation") ??
      numberAt(path(sixHour, "details"), "probability_of_precipitation");
    if (prob !== undefined) point.precipProbPct = prob;

    const symbol =
      stringAt(path(oneHour, "summary"), "symbol_code") ??
      stringAt(path(sixHour, "summary"), "symbol_code");
    if (symbol) point.condition = metNorwaySymbolToCondition(symbol);

    hours.push(point);
  }
  return hours;
};

export const createMetNorwaySource = (options: { userAgent: string }) => ({
  descriptor: MET_NORWAY_DESCRIPTOR,
  fetch: async (
    coords: Coordinates,
    signal?: AbortSignal,
  ): Promise<SourceForecast> => {
    const startedAt = Date.now();
    const url = buildUrl(ENDPOINT, {
      // Their terms ask for no more than 4 decimals of coordinate precision.
      lat: round(coords.latitude, 4),
      lon: round(coords.longitude, 4),
    });
    const json = await fetchJson<unknown>(url, {
      signal,
      headers: { "user-agent": options.userAgent },
    });

    const hours = parseTimeseries(asArray(path(json, "properties.timeseries")));
    if (hours.length === 0) {
      throw new UpstreamError("no usable timeseries entries", ENDPOINT);
    }

    const updated = stringAt(path(json, "properties.meta"), "updated_at");
    return {
      source: MET_NORWAY_DESCRIPTOR,
      hours,
      fetchedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      ...(updated ? { modelRun: updated } : {}),
    };
  },
});

export const __testing = { parseTimeseries };

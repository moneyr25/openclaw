import { createSign } from "node:crypto";
import { buildUrl, fetchJson, UpstreamError } from "../http.ts";
import { asArray, isRecord, numberAt, path, stringAt } from "../parse.ts";
import { appleConditionToCondition } from "../conditions.ts";
import { metresToKm, round } from "../units.ts";
import type {
  Coordinates,
  HourPoint,
  SourceDescriptor,
  SourceForecast,
} from "../types.ts";

/**
 * Apple WeatherKit — the forecast behind the Weather app on iPhone.
 *
 * Descended from Dark Sky and blended with Apple's own post-processing, so it
 * belongs in the `proprietary` family with AccuWeather rather than with the
 * pass-through commercial APIs.
 *
 * Authentication is a JWT signed with an ES256 key from an Apple Developer
 * account, which means four pieces of configuration rather than one API key.
 * Everything needed is in the Developer portal under Certificates, Identifiers
 * and Profiles; see the README.
 */

const ENDPOINT = "https://weatherkit.apple.com/api/v1/weather";

export const APPLE_WEATHERKIT_DESCRIPTOR: SourceDescriptor = {
  id: "apple-weatherkit",
  label: "Apple Weather (WeatherKit)",
  attribution: "Apple Weather",
  family: "proprietary",
  resolutionKm: 10,
  requiresEnv: "APPLE_WEATHERKIT_PRIVATE_KEY",
  maxLeadHours: 168,
};

export type AppleWeatherKitOptions = {
  teamId: string;
  serviceId: string;
  keyId: string;
  /** Contents of the .p8 file, PEM encoded. */
  privateKey: string;
  userAgent: string;
};

const base64url = (input: Buffer | string): string =>
  (typeof input === "string" ? Buffer.from(input) : input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

/** Tokens are valid for an hour; refresh well before that. */
const TOKEN_LIFETIME_SECONDS = 3600;
const TOKEN_REFRESH_MARGIN_SECONDS = 300;

let cachedToken: { token: string; expiresAt: number } | undefined;

/**
 * Build the WeatherKit bearer token.
 *
 * Two details are easy to get wrong and both fail as an opaque 401:
 *  - the JWT header carries an extra `id` claim of `TEAM_ID.SERVICE_ID`, which
 *    is not part of the JWT spec but is what WeatherKit matches against;
 *  - ES256 signatures must be JOSE's raw r||s pair, not the DER encoding
 *    Node produces by default, hence `dsaEncoding: "ieee-p1363"`.
 */
export const createWeatherKitToken = (
  options: AppleWeatherKitOptions,
  nowSeconds = Math.floor(Date.now() / 1000),
): string => {
  const header = {
    alg: "ES256",
    typ: "JWT",
    kid: options.keyId,
    id: `${options.teamId}.${options.serviceId}`,
  };
  const payload = {
    iss: options.teamId,
    sub: options.serviceId,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_LIFETIME_SECONDS,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;

  const signature = createSign("SHA256")
    .update(signingInput)
    .sign({ key: options.privateKey, dsaEncoding: "ieee-p1363" });

  return `${signingInput}.${base64url(signature)}`;
};

const tokenFor = (options: AppleWeatherKitOptions): string => {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_SECONDS > now) {
    return cachedToken.token;
  }
  const token = createWeatherKitToken(options, now);
  cachedToken = { token, expiresAt: now + TOKEN_LIFETIME_SECONDS };
  return token;
};

const parseHours = (entries: unknown[]): HourPoint[] => {
  const hours: HourPoint[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const start = stringAt(entry, "forecastStart");
    if (!start) continue;
    const date = new Date(start);
    if (Number.isNaN(date.getTime())) continue;

    const point: HourPoint = { time: date.toISOString() };

    // WeatherKit is metric throughout: Celsius, km/h, millibars, millimetres,
    // metres for visibility, and 0-1 fractions for the percentages.
    const temp = numberAt(entry, "temperature");
    if (temp !== undefined) point.tempC = temp;

    const feels = numberAt(entry, "temperatureApparent");
    if (feels !== undefined) point.apparentC = feels;

    const precip = numberAt(entry, "precipitationAmount");
    if (precip !== undefined) point.precipMm = precip;

    const chance = numberAt(entry, "precipitationChance");
    if (chance !== undefined) point.precipProbPct = round(chance * 100, 0);

    const wind = numberAt(entry, "windSpeed");
    if (wind !== undefined) point.windKph = wind;

    const gust = numberAt(entry, "windGust");
    if (gust !== undefined) point.gustKph = gust;

    const windDir = numberAt(entry, "windDirection");
    if (windDir !== undefined) point.windDirDeg = windDir;

    const humidity = numberAt(entry, "humidity");
    if (humidity !== undefined) point.humidityPct = round(humidity * 100, 0);

    const cloud = numberAt(entry, "cloudCover");
    if (cloud !== undefined) point.cloudPct = round(cloud * 100, 0);

    const pressure = numberAt(entry, "pressure");
    if (pressure !== undefined) point.pressureHpa = pressure;

    const uv = numberAt(entry, "uvIndex");
    if (uv !== undefined) point.uvIndex = uv;

    const visibility = numberAt(entry, "visibility");
    if (visibility !== undefined) {
      point.visibilityKm = round(metresToKm(visibility), 2);
    }

    const code = stringAt(entry, "conditionCode");
    if (code) point.condition = appleConditionToCondition(code);

    hours.push(point);
  }
  return hours;
};

export const createAppleWeatherKitSource = (options: AppleWeatherKitOptions) => ({
  descriptor: APPLE_WEATHERKIT_DESCRIPTOR,
  fetch: async (
    coords: Coordinates,
    signal?: AbortSignal,
  ): Promise<SourceForecast> => {
    const startedAt = Date.now();
    const url = buildUrl(
      `${ENDPOINT}/en/${round(coords.latitude, 4)}/${round(coords.longitude, 4)}`,
      {
        dataSets: "forecastHourly",
        timezone: "GMT",
      },
    );

    const json = await fetchJson<unknown>(url, {
      signal,
      headers: {
        authorization: `Bearer ${tokenFor(options)}`,
        "user-agent": options.userAgent,
      },
    });

    const hours = parseHours(asArray(path(json, "forecastHourly.hours")));
    if (hours.length === 0) {
      throw new UpstreamError(
        "no usable hours in forecastHourly",
        ENDPOINT,
      );
    }

    const metadata = stringAt(
      path(json, "forecastHourly.metadata"),
      "readTime",
    );

    return {
      source: APPLE_WEATHERKIT_DESCRIPTOR,
      hours,
      fetchedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      ...(metadata ? { modelRun: metadata } : {}),
    };
  },
});

export const __testing = {
  parseHours,
  base64url,
  resetTokenCache: () => {
    cachedToken = undefined;
  },
};

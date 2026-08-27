import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Absolute path to the app root (the directory holding package.json). */
export const APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Load `.env` from the app root if present. Real env always wins. */
export const loadEnvFile = (): void => {
  const envPath = path.join(APP_ROOT, ".env");
  if (!existsSync(envPath)) return;
  process.loadEnvFile(envPath);
};

const readNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
};

const readKey = (name: string): string | undefined => {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
};

export type AppleWeatherKitCredentials = {
  teamId: string;
  serviceId: string;
  keyId: string;
  privateKey: string;
};

export type AppConfig = {
  host: string;
  port: number;
  forecastCacheTtlMs: number;
  geocodeCacheTtlMs: number;
  warningsCacheTtlMs: number;
  metOfficeApiKey?: string;
  openWeatherMapApiKey?: string;
  weatherApiKey?: string;
  accuWeatherApiKey?: string;
  /** AccuWeather hourly tier: 1hour, 12hour, 24hour, 72hour or 120hour. */
  accuWeatherHourlyRange: string;
  appleWeatherKit?: AppleWeatherKitCredentials;
  /** Contact string for the MET Norway User-Agent, required by their terms. */
  metNorwayContact: string;
  metOfficeWarningsUrl: string;
  /** Overridable so a Met Office API version bump does not need a code change. */
  metOfficeBaseUrl: string;
  userAgent: string;
};

/**
 * AccuWeather's free tier only serves the 12-hour endpoint. Asking for a tier
 * the key cannot reach returns 401, which reads like a bad key, so the value is
 * validated here rather than at the first request.
 */
const ACCUWEATHER_RANGES = new Set([
  "1hour",
  "12hour",
  "24hour",
  "72hour",
  "120hour",
]);

const readAccuWeatherRange = (): string => {
  const raw = readKey("ACCUWEATHER_HOURLY_RANGE") ?? "12hour";
  if (!ACCUWEATHER_RANGES.has(raw)) {
    throw new Error(
      `ACCUWEATHER_HOURLY_RANGE must be one of ${[...ACCUWEATHER_RANGES].join(", ")}, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
};

/**
 * WeatherKit needs a whole credential set, not one key. Accepting the .p8
 * either inline (with escaped newlines, as most secret stores hand it back) or
 * as a path keeps it usable in both a local .env and a deployment.
 */
const readAppleWeatherKit = (): AppleWeatherKitCredentials | undefined => {
  const teamId = readKey("APPLE_WEATHERKIT_TEAM_ID");
  const serviceId = readKey("APPLE_WEATHERKIT_SERVICE_ID");
  const keyId = readKey("APPLE_WEATHERKIT_KEY_ID");
  const inlineKey = readKey("APPLE_WEATHERKIT_PRIVATE_KEY");
  const keyPath = readKey("APPLE_WEATHERKIT_PRIVATE_KEY_PATH");

  if (!teamId && !serviceId && !keyId && !inlineKey && !keyPath) {
    return undefined;
  }

  const missing = [
    ["APPLE_WEATHERKIT_TEAM_ID", teamId],
    ["APPLE_WEATHERKIT_SERVICE_ID", serviceId],
    ["APPLE_WEATHERKIT_KEY_ID", keyId],
  ].filter(([, value]) => !value);

  if (missing.length > 0 || (!inlineKey && !keyPath)) {
    const names = missing.map(([name]) => name);
    if (!inlineKey && !keyPath) {
      names.push("APPLE_WEATHERKIT_PRIVATE_KEY or APPLE_WEATHERKIT_PRIVATE_KEY_PATH");
    }
    // Half-configured credentials are a mistake worth naming loudly, unlike a
    // source that is simply switched off.
    throw new Error(
      `Apple WeatherKit is partly configured; missing ${names.join(", ")}`,
    );
  }

  const privateKey = keyPath
    ? readFileSync(path.resolve(APP_ROOT, keyPath), "utf8")
    : // Secret stores commonly flatten PEM newlines to the two-character
      // escape; restore them so node:crypto can read the key.
      inlineKey!.replaceAll("\\n", "\n");

  if (!privateKey.includes("BEGIN PRIVATE KEY")) {
    throw new Error(
      "Apple WeatherKit private key does not look like a PEM .p8 file",
    );
  }

  return { teamId: teamId!, serviceId: serviceId!, keyId: keyId!, privateKey };
};

export const loadConfig = (): AppConfig => {
  loadEnvFile();
  const contact = readKey("MET_NORWAY_CONTACT") ?? "";
  const appleWeatherKit = readAppleWeatherKit();
  return {
    host: readKey("HOST") ?? "127.0.0.1",
    port: readNumber("PORT", 8787),
    forecastCacheTtlMs: readNumber("FORECAST_CACHE_TTL", 600) * 1000,
    geocodeCacheTtlMs: readNumber("GEOCODE_CACHE_TTL", 86_400) * 1000,
    warningsCacheTtlMs: readNumber("WARNINGS_CACHE_TTL", 300) * 1000,
    metOfficeApiKey: readKey("MET_OFFICE_API_KEY"),
    openWeatherMapApiKey: readKey("OPENWEATHERMAP_API_KEY"),
    weatherApiKey: readKey("WEATHERAPI_KEY"),
    accuWeatherApiKey: readKey("ACCUWEATHER_API_KEY"),
    accuWeatherHourlyRange: readAccuWeatherRange(),
    ...(appleWeatherKit ? { appleWeatherKit } : {}),
    metNorwayContact: contact,
    metOfficeWarningsUrl:
      readKey("MET_OFFICE_WARNINGS_URL") ??
      "https://www.metoffice.gov.uk/public/data/PWSCache/WarningsRSS/Region/UK",
    metOfficeBaseUrl:
      readKey("MET_OFFICE_BASE_URL") ??
      "https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point",
    userAgent: contact
      ? `openclaw-weather-dashboard/0.1 (${contact})`
      : "openclaw-weather-dashboard/0.1 (+https://github.com/openclaw/openclaw)",
  };
};

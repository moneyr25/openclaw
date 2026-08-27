import { existsSync } from "node:fs";
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

export type AppConfig = {
  host: string;
  port: number;
  forecastCacheTtlMs: number;
  geocodeCacheTtlMs: number;
  warningsCacheTtlMs: number;
  metOfficeApiKey?: string;
  openWeatherMapApiKey?: string;
  weatherApiKey?: string;
  /** Contact string for the MET Norway User-Agent, required by their terms. */
  metNorwayContact: string;
  metOfficeWarningsUrl: string;
  /** Overridable so a Met Office API version bump does not need a code change. */
  metOfficeBaseUrl: string;
  userAgent: string;
};

export const loadConfig = (): AppConfig => {
  loadEnvFile();
  const contact = readKey("MET_NORWAY_CONTACT") ?? "";
  return {
    host: readKey("HOST") ?? "127.0.0.1",
    port: readNumber("PORT", 8787),
    forecastCacheTtlMs: readNumber("FORECAST_CACHE_TTL", 600) * 1000,
    geocodeCacheTtlMs: readNumber("GEOCODE_CACHE_TTL", 86_400) * 1000,
    warningsCacheTtlMs: readNumber("WARNINGS_CACHE_TTL", 300) * 1000,
    metOfficeApiKey: readKey("MET_OFFICE_API_KEY"),
    openWeatherMapApiKey: readKey("OPENWEATHERMAP_API_KEY"),
    weatherApiKey: readKey("WEATHERAPI_KEY"),
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

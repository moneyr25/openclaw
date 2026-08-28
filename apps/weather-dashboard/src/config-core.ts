/**
 * Configuration, with no runtime-specific imports.
 *
 * Node reads these from `process.env` plus a `.env` file; Cloudflare Workers
 * reads them from the bindings object. Both end up here, so the two
 * deployments cannot drift on what a setting means or how it is validated.
 */

export type EnvSource = Record<string, string | undefined>;

export type AppleWeatherKitCredentials = {
  teamId: string;
  serviceId: string;
  keyId: string;
  /** PEM-encoded contents of the .p8 file. */
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
  /** Overridable so a Met Office API version bump needs no code change. */
  metOfficeBaseUrl: string;
  userAgent: string;
};

export type BuildConfigOptions = {
  /**
   * Reads a private key from disk. Node supplies this; Workers has no file
   * system, so `APPLE_WEATHERKIT_PRIVATE_KEY_PATH` is rejected there with an
   * error that says to use the inline key instead.
   */
  readPrivateKeyFile?: (path: string) => string;
};

const readKey = (env: EnvSource, name: string): string | undefined => {
  const raw = env[name]?.trim();
  return raw ? raw : undefined;
};

const readNumber = (env: EnvSource, name: string, fallback: number): number => {
  const raw = readKey(env, name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
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

const readAccuWeatherRange = (env: EnvSource): string => {
  const raw = readKey(env, "ACCUWEATHER_HOURLY_RANGE") ?? "12hour";
  if (!ACCUWEATHER_RANGES.has(raw)) {
    throw new Error(
      `ACCUWEATHER_HOURLY_RANGE must be one of ${[...ACCUWEATHER_RANGES].join(
        ", ",
      )}, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
};

/**
 * WeatherKit needs a whole credential set, not one key. Accepting the .p8
 * either inline (with escaped newlines, as most secret stores hand it back) or
 * as a path keeps it usable in a local .env and in a deployment alike.
 */
const readAppleWeatherKit = (
  env: EnvSource,
  options: BuildConfigOptions,
): AppleWeatherKitCredentials | undefined => {
  const teamId = readKey(env, "APPLE_WEATHERKIT_TEAM_ID");
  const serviceId = readKey(env, "APPLE_WEATHERKIT_SERVICE_ID");
  const keyId = readKey(env, "APPLE_WEATHERKIT_KEY_ID");
  const inlineKey = readKey(env, "APPLE_WEATHERKIT_PRIVATE_KEY");
  const keyPath = readKey(env, "APPLE_WEATHERKIT_PRIVATE_KEY_PATH");

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
      names.push(
        "APPLE_WEATHERKIT_PRIVATE_KEY or APPLE_WEATHERKIT_PRIVATE_KEY_PATH",
      );
    }
    // Half-configured credentials are a mistake worth naming loudly, unlike a
    // source that is simply switched off.
    throw new Error(
      `Apple WeatherKit is partly configured; missing ${names.join(", ")}`,
    );
  }

  let privateKey: string;
  if (inlineKey) {
    // Secret stores commonly flatten PEM newlines to the two-character escape;
    // restore them so the key can be parsed.
    privateKey = inlineKey.replaceAll("\\n", "\n");
  } else if (options.readPrivateKeyFile) {
    privateKey = options.readPrivateKeyFile(keyPath!);
  } else {
    throw new Error(
      "APPLE_WEATHERKIT_PRIVATE_KEY_PATH needs a file system; set " +
        "APPLE_WEATHERKIT_PRIVATE_KEY with the key contents instead",
    );
  }

  if (!privateKey.includes("BEGIN PRIVATE KEY")) {
    throw new Error(
      "Apple WeatherKit private key does not look like a PEM .p8 file",
    );
  }

  return { teamId: teamId!, serviceId: serviceId!, keyId: keyId!, privateKey };
};

export const buildConfig = (
  env: EnvSource,
  options: BuildConfigOptions = {},
): AppConfig => {
  const contact = readKey(env, "MET_NORWAY_CONTACT") ?? "";
  const appleWeatherKit = readAppleWeatherKit(env, options);

  return {
    host: readKey(env, "HOST") ?? "127.0.0.1",
    port: readNumber(env, "PORT", 8787),
    forecastCacheTtlMs: readNumber(env, "FORECAST_CACHE_TTL", 600) * 1000,
    geocodeCacheTtlMs: readNumber(env, "GEOCODE_CACHE_TTL", 86_400) * 1000,
    warningsCacheTtlMs: readNumber(env, "WARNINGS_CACHE_TTL", 300) * 1000,
    metOfficeApiKey: readKey(env, "MET_OFFICE_API_KEY"),
    openWeatherMapApiKey: readKey(env, "OPENWEATHERMAP_API_KEY"),
    weatherApiKey: readKey(env, "WEATHERAPI_KEY"),
    accuWeatherApiKey: readKey(env, "ACCUWEATHER_API_KEY"),
    accuWeatherHourlyRange: readAccuWeatherRange(env),
    ...(appleWeatherKit ? { appleWeatherKit } : {}),
    metNorwayContact: contact,
    metOfficeWarningsUrl:
      readKey(env, "MET_OFFICE_WARNINGS_URL") ??
      "https://www.metoffice.gov.uk/public/data/PWSCache/WarningsRSS/Region/UK",
    metOfficeBaseUrl:
      readKey(env, "MET_OFFICE_BASE_URL") ??
      "https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point",
    userAgent: contact
      ? `openclaw-weather-dashboard/0.1 (${contact})`
      : "openclaw-weather-dashboard/0.1 (+https://github.com/openclaw/openclaw)",
  };
};

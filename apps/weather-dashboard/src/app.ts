import { TtlCache } from "./cache.ts";
import { aggregate } from "./aggregate.ts";
import {
  buildSources,
  fetchAllSources,
  skippedSources,
  type WeatherSource,
} from "./sources/index.ts";
import { fetchMetOfficeWarnings } from "./sources/warnings.ts";
import { reverseGeocode, searchPlaces } from "./geocode.ts";
import { FAMILY_SKILL } from "./skill.ts";
import type { AppConfig } from "./config-core.ts";
import type { AggregateResult, ResolvedLocation, Warning } from "./types.ts";

/**
 * The whole application as a Web-standard `Request -> Response` handler.
 *
 * Cloudflare Workers speaks this natively; the Node server is a thin bridge
 * over it. Keeping one implementation means the deployed dashboard and the
 * local one cannot drift, and the same tests cover both.
 */

export type AssetResolver = (request: Request) => Promise<Response | undefined>;

export type AppOptions = {
  /** Injectable so the demo harness and tests can run without upstreams. */
  sources?: WeatherSource[];
  /** Static file serving. Node reads from disk; Workers uses its asset binding. */
  assets?: AssetResolver;
};

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

/**
 * Coordinates are validated rather than trusted: they are the only untrusted
 * input that reaches an outbound URL.
 */
const parseCoordinate = (
  raw: string | null,
  min: number,
  max: number,
): number | undefined => {
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return undefined;
  return value;
};

/**
 * Coordinates are rounded for the cache key so that standing still — but with
 * GPS jitter of a few metres — is a cache hit rather than a fresh fan-out.
 * Three decimal places is about 110 m.
 */
const cacheKey = (latitude: number, longitude: number): string =>
  `${latitude.toFixed(3)},${longitude.toFixed(3)}`;

export const createApp = (config: AppConfig, options: AppOptions = {}) => {
  const sources = options.sources ?? buildSources(config);
  const activeIds = sources.map((source) => source.descriptor.id);

  const forecastCache = new TtlCache<AggregateResult>({
    ttlMs: config.forecastCacheTtlMs,
  });
  const warningsCache = new TtlCache<Warning[]>({
    ttlMs: config.warningsCacheTtlMs,
  });
  const geocodeCache = new TtlCache<unknown>({ ttlMs: config.geocodeCacheTtlMs });

  const loadWarnings = async (): Promise<Warning[]> => {
    try {
      const { value } = await warningsCache.resolve("uk", () =>
        fetchMetOfficeWarnings({
          url: config.metOfficeWarningsUrl,
          userAgent: config.userAgent,
        }),
      );
      return value;
    } catch {
      // Warnings are a bonus strip, never a reason to fail the forecast.
      return [];
    }
  };

  const buildForecast = async (
    location: ResolvedLocation,
  ): Promise<AggregateResult> => {
    const [{ forecasts, failures }, warnings] = await Promise.all([
      fetchAllSources(sources, location),
      loadWarnings(),
    ]);

    if (forecasts.length === 0) {
      const detail = failures.map((f) => `${f.label}: ${f.reason}`).join("; ");
      throw new Error(
        `every weather source failed${detail ? ` (${detail})` : ""}`,
      );
    }

    return aggregate({
      location,
      forecasts,
      failures: [...failures, ...skippedSources(config, activeIds)],
      warnings,
    });
  };

  const handleForecast = async (url: URL): Promise<Response> => {
    const latitude = parseCoordinate(url.searchParams.get("lat"), -90, 90);
    const longitude = parseCoordinate(url.searchParams.get("lon"), -180, 180);
    if (latitude === undefined || longitude === undefined) {
      return json(
        { error: "lat and lon are required and must be valid coordinates" },
        400,
      );
    }

    const timezone = url.searchParams.get("tz")?.slice(0, 64) ?? undefined;
    const label = url.searchParams.get("label")?.slice(0, 120) ?? undefined;
    const accuracy = parseCoordinate(url.searchParams.get("accuracy"), 0, 1e6);
    const originRaw = url.searchParams.get("origin");
    const origin: ResolvedLocation["origin"] =
      originRaw === "gps" || originRaw === "search" || originRaw === "manual"
        ? originRaw
        : "default";

    const key = `${cacheKey(latitude, longitude)}|${timezone ?? ""}`;
    try {
      const { value, stale } = await forecastCache.resolve(key, async () => {
        // Only look up a name when the caller has not supplied one.
        const resolvedLabel =
          label ??
          (await reverseGeocode(
            { latitude, longitude },
            { userAgent: config.userAgent },
          ));
        const location: ResolvedLocation = {
          latitude,
          longitude,
          origin,
          ...(resolvedLabel ? { label: resolvedLabel } : {}),
          ...(timezone ? { timezone } : {}),
          ...(accuracy !== undefined ? { accuracyMetres: accuracy } : {}),
        };
        return buildForecast(location);
      });

      return json({ ...value, stale }, 200, { "cache-control": "no-store" });
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        502,
      );
    }
  };

  const handleGeocode = async (url: URL): Promise<Response> => {
    const query = url.searchParams.get("q")?.trim().slice(0, 80) ?? "";
    if (query.length < 2) {
      return json({ error: "q must be at least 2 characters" }, 400);
    }
    try {
      const { value } = await geocodeCache.resolve(
        `q:${query.toLowerCase()}`,
        () => searchPlaces(query, { userAgent: config.userAgent }),
      );
      return json({ results: value });
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        502,
      );
    }
  };

  const handle = async (request: Request): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "method not allowed" }, 405);
    }

    const url = new URL(request.url);

    switch (url.pathname) {
      case "/api/health":
        return json({
          ok: true,
          sources: activeIds,
          unconfigured: skippedSources(config, activeIds).map(
            (failure) => failure.sourceId,
          ),
          cachedForecasts: forecastCache.size,
        });
      case "/api/weights":
        // Exposed so the weighting is inspectable rather than a black box.
        return json({ familySkill: FAMILY_SKILL });
      case "/api/forecast":
        return handleForecast(url);
      case "/api/geocode":
        return handleGeocode(url);
      default:
        break;
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "unknown endpoint" }, 404);
    }

    const asset = await options.assets?.(request);
    if (asset) return asset;

    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  };

  return {
    fetch: async (request: Request): Promise<Response> => {
      try {
        return await handle(request);
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : "internal error" },
          500,
        );
      }
    },
    sources,
  };
};

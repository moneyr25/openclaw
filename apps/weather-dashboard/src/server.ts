import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { APP_ROOT, loadConfig, type AppConfig } from "./config.ts";
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
import type { AggregateResult, ResolvedLocation, Warning } from "./types.ts";

const PUBLIC_DIR = path.join(APP_ROOT, "public");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const sendJson = (
  response: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
};

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

/** Coordinates are rounded for the cache key so that standing still — but with
 * GPS jitter of a few metres — is a cache hit rather than a fresh fan-out.
 * 3 decimal places is about 110 m. */
const cacheKey = (latitude: number, longitude: number): string =>
  `${latitude.toFixed(3)},${longitude.toFixed(3)}`;

const serveStatic = async (
  urlPath: string,
  response: http.ServerResponse,
): Promise<boolean> => {
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/u, "");
  const resolved = path.resolve(PUBLIC_DIR, relative);
  // Refuse anything that escapes the public directory.
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    return false;
  }

  try {
    const stats = await stat(resolved);
    if (!stats.isFile()) return false;
    const body = await readFile(resolved);
    const type = CONTENT_TYPES[path.extname(resolved)] ?? "application/octet-stream";
    response.writeHead(200, {
      "content-type": type,
      "content-length": body.byteLength,
      // The dashboard is served from disk and changes only on deploy.
      "cache-control": "no-cache",
    });
    response.end(body);
    return true;
  } catch {
    return false;
  }
};

export type AppOptions = {
  /** Injectable so the demo harness and tests can run without upstreams. */
  sources?: WeatherSource[];
};

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

  const handleForecast = async (
    url: URL,
    response: http.ServerResponse,
  ): Promise<void> => {
    const latitude = parseCoordinate(url.searchParams.get("lat"), -90, 90);
    const longitude = parseCoordinate(url.searchParams.get("lon"), -180, 180);
    if (latitude === undefined || longitude === undefined) {
      sendJson(response, 400, {
        error: "lat and lon are required and must be valid coordinates",
      });
      return;
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

      sendJson(
        response,
        200,
        { ...value, stale },
        { "cache-control": "no-store" },
      );
    } catch (error) {
      sendJson(response, 502, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleGeocode = async (
    url: URL,
    response: http.ServerResponse,
  ): Promise<void> => {
    const query = url.searchParams.get("q")?.trim().slice(0, 80) ?? "";
    if (query.length < 2) {
      sendJson(response, 400, { error: "q must be at least 2 characters" });
      return;
    }
    try {
      const { value } = await geocodeCache.resolve(`q:${query.toLowerCase()}`, () =>
        searchPlaces(query, { userAgent: config.userAgent }),
      );
      sendJson(response, 200, { results: value });
    } catch (error) {
      sendJson(response, 502, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handler = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "method not allowed" });
      return;
    }

    switch (url.pathname) {
      case "/api/health":
        sendJson(response, 200, {
          ok: true,
          sources: sources.map((source) => source.descriptor.id),
          unconfigured: skippedSources(config, activeIds).map((failure) => failure.sourceId),
          cachedForecasts: forecastCache.size,
        });
        return;
      case "/api/weights":
        // Exposed so the weighting is inspectable rather than a black box.
        sendJson(response, 200, { familySkill: FAMILY_SKILL });
        return;
      case "/api/forecast":
        await handleForecast(url, response);
        return;
      case "/api/geocode":
        await handleGeocode(url, response);
        return;
      default:
        break;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "unknown endpoint" });
      return;
    }

    if (await serveStatic(url.pathname, response)) return;

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  };

  return {
    handler: (request: http.IncomingMessage, response: http.ServerResponse) => {
      handler(request, response).catch((error: unknown) => {
        if (response.headersSent) {
          response.end();
          return;
        }
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : "internal error",
        });
      });
    },
    sources,
  };
};

export const startServer = (config = loadConfig(), options: AppOptions = {}) => {
  const app = createApp(config, options);
  const server = http.createServer(app.handler);

  server.listen(config.port, config.host, () => {
    const configured = app.sources.length;
    const missing = skippedSources(config, app.sources.map((s) => s.descriptor.id)).length;
    console.log(
      `weather dashboard on http://${config.host}:${config.port} ` +
        `(${configured} sources active${missing > 0 ? `, ${missing} unconfigured` : ""})`,
    );
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    // Do not hang forever on a keep-alive connection.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return server;
};

// Only auto-start when run directly, so tests can import `createApp`.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}

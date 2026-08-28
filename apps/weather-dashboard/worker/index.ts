import { buildConfig, type EnvSource } from "../src/config-core.ts";
import { createApp } from "../src/app.ts";
import type { AppConfig } from "../src/config-core.ts";

/**
 * Cloudflare Workers entry point.
 *
 * All the behaviour lives in `src/app.ts`, which is already a Web-standard
 * `Request -> Response` handler — exactly what the Workers runtime wants — so
 * this file only supplies configuration, the static asset binding, and an
 * isolate-lifetime cache of the built app.
 *
 * Nothing here (or anywhere it imports) may touch a `node:` module. Node-only
 * code lives in `src/server.ts` and `src/config.ts`, which the Worker never
 * imports; `npm run check:worker` enforces that.
 */

type Env = EnvSource & {
  /** Static Assets binding, declared in wrangler.toml. */
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
};

/**
 * Workers reuses an isolate across requests, so building the source list and
 * the caches once per isolate is worth doing — a warm isolate answers a repeat
 * request without touching a single upstream. Isolates are still evicted freely,
 * which is why the app degrades gracefully rather than assuming a warm cache.
 */
let cached: { app: ReturnType<typeof createApp>; config: AppConfig } | undefined;

const appFor = (env: Env): ReturnType<typeof createApp> => {
  if (cached) return cached.app;

  const config = buildConfig(env);
  const app = createApp(config, {
    assets: async (request) => {
      if (!env.ASSETS) return undefined;
      const response = await env.ASSETS.fetch(request);
      // The binding answers 404 for anything it does not hold; let the app
      // produce its own not-found rather than passing that through.
      return response.status === 404 ? undefined : response;
    },
  });

  cached = { app, config };
  return app;
};

/** The isolate-lifetime cache defeats per-test isolation; tests reset it. */
export const __testing = {
  resetAppCache: (): void => {
    cached = undefined;
  },
};

export default {
  fetch: async (request: Request, env: Env): Promise<Response> => {
    try {
      return await appFor(env).fetch(request);
    } catch (error) {
      // A configuration error throws on the first request of a cold isolate.
      // Returning it beats a bare 1101, which says nothing useful.
      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : "worker failed to start",
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  },
};

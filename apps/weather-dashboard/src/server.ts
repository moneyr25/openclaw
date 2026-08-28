import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { APP_ROOT, loadConfig, type AppConfig } from "./config.ts";
import {
  createApp as createCoreApp,
  type AppOptions,
  type AssetResolver,
} from "./app.ts";
import { skippedSources } from "./sources/index.ts";

/**
 * Node host for the shared handler in `app.ts`.
 *
 * All the routing lives there so this file is only a bridge: node:http in,
 * Web-standard Request out, Response back. Cloudflare Workers skips the bridge
 * and calls the same handler directly.
 */

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

/** Serve `public/` from disk, refusing anything that escapes it. */
export const diskAssets: AssetResolver = async (request) => {
  const { pathname } = new URL(request.url);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/u, "");

  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return undefined;
  }

  const resolved = path.resolve(PUBLIC_DIR, decoded);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    return undefined;
  }

  try {
    const stats = await stat(resolved);
    if (!stats.isFile()) return undefined;
    const body = await readFile(resolved);
    return new Response(body, {
      headers: {
        "content-type":
          CONTENT_TYPES[path.extname(resolved)] ?? "application/octet-stream",
        // Served from disk and changed only on deploy.
        "cache-control": "no-cache",
      },
    });
  } catch {
    return undefined;
  }
};

/** node:http request -> Web Request. GET/HEAD only, so there is no body. */
const toWebRequest = (request: http.IncomingMessage): Request => {
  const host = request.headers.host ?? "localhost";
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  return new Request(new URL(request.url ?? "/", `http://${host}`), {
    method: request.method ?? "GET",
    headers,
  });
};

const writeWebResponse = async (
  response: Response,
  target: http.ServerResponse,
): Promise<void> => {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of response.headers) headers[name] = value;
  target.writeHead(response.status, headers);

  if (!response.body) {
    target.end();
    return;
  }
  // Stream rather than buffer, so a large asset does not sit in memory twice.
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
      .on("error", reject)
      .on("end", resolve)
      .pipe(target);
  });
};

export const createNodeApp = (config: AppConfig, options: AppOptions = {}) => {
  const app = createCoreApp(config, { assets: diskAssets, ...options });

  const handler = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): void => {
    app
      .fetch(toWebRequest(request))
      .then((webResponse) => writeWebResponse(webResponse, response))
      .catch((error: unknown) => {
        if (response.headersSent) {
          response.end();
          return;
        }
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : "internal error",
          }),
        );
      });
  };

  return { handler, sources: app.sources };
};

/** Named `createApp` for callers that just want "the app, on Node". */
export { createNodeApp as createApp };

export const startServer = (config = loadConfig(), options: AppOptions = {}) => {
  const app = createNodeApp(config, options);
  const server = http.createServer(app.handler);

  server.listen(config.port, config.host, () => {
    const missing = skippedSources(
      config,
      app.sources.map((source) => source.descriptor.id),
    ).length;
    console.log(
      `weather dashboard on http://${config.host}:${config.port} ` +
        `(${app.sources.length} sources active${
          missing > 0 ? `, ${missing} unconfigured` : ""
        })`,
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

// Only auto-start when run directly, so tests can import the app.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}

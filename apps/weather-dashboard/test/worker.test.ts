import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import worker, { __testing } from "../worker/index.ts";

/**
 * The Workers entry point, exercised under Node.
 *
 * Both runtimes share `src/app.ts`, so this is not re-testing the routing — it
 * checks the things only the Worker does: reading configuration from bindings
 * rather than process.env, delegating static files to the ASSETS binding, and
 * turning a configuration error into a readable response instead of a bare
 * runtime failure.
 */

const ASSET_BODY = "<!doctype html><title>Weather consensus</title>";

const stubAssets = {
  fetch: async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === "/" || pathname === "/index.html") {
      return new Response(ASSET_BODY, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    // Cloudflare's binding answers 404 for anything it does not hold.
    return new Response("Not Found", { status: 404 });
  },
};

const env = (extra: Record<string, string> = {}) => ({
  MET_NORWAY_CONTACT: "test@example.com",
  ASSETS: stubAssets,
  ...extra,
});

const call = (pathAndQuery: string, init?: RequestInit, bindings = env()) =>
  worker.fetch(new Request(`https://weather.example${pathAndQuery}`, init), bindings);

describe("cloudflare worker", () => {
  beforeEach(() => {
    __testing.resetAppCache();
  });

  test("reads configuration from bindings, not process.env", async () => {
    const response = await call(
      "/api/health",
      undefined,
      env({ ACCUWEATHER_API_KEY: "from-a-binding" }),
    );
    const body = (await response.json()) as {
      ok: boolean;
      sources: string[];
      unconfigured: string[];
    };

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    // The key came from the bindings object, so the source must be live.
    assert.ok(body.sources.includes("accuweather"));
    assert.ok(!body.unconfigured.includes("accuweather"));
  });

  test("keyless bindings still bring up the model backbone", async () => {
    const response = await call("/api/health");
    const body = (await response.json()) as { sources: string[] };
    assert.ok(body.sources.includes("om-ukmo"));
    assert.ok(body.sources.includes("met-norway"));
  });

  test("serves the dashboard through the ASSETS binding", async () => {
    const response = await call("/");
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Weather consensus/u);
  });

  test("turns an ASSETS 404 into the app's own not-found", async () => {
    const response = await call("/does-not-exist.css");
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type") ?? "", /text\/plain/u);
  });

  test("exposes the weighting priors", async () => {
    const response = await call("/api/weights");
    const body = (await response.json()) as {
      familySkill: Record<string, { correlation: number }>;
    };
    assert.equal(response.status, 200);
    assert.equal(body.familySkill["proprietary"]?.correlation, 0.6);
  });

  test("validates coordinates before reaching any upstream", async () => {
    const response = await call("/api/forecast?lat=91&lon=0");
    assert.equal(response.status, 400);
  });

  test("rejects non-GET methods", async () => {
    const response = await call("/api/health", { method: "POST" });
    assert.equal(response.status, 405);
  });

  test("returns unknown api routes as json", async () => {
    const response = await call("/api/nope");
    assert.equal(response.status, 404);
    assert.match(
      response.headers.get("content-type") ?? "",
      /application\/json/u,
    );
  });

  test("reports a configuration mistake instead of failing opaquely", async () => {
    // Half-configured WeatherKit throws while the config is built, which on a
    // cold isolate happens inside the first request.
    const response = await call(
      "/api/health",
      undefined,
      env({ APPLE_WEATHERKIT_TEAM_ID: "T1" }),
    );
    assert.equal(response.status, 500);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /partly configured/u);
  });

  test("runs without an ASSETS binding at all", async () => {
    const response = await worker.fetch(
      new Request("https://weather.example/api/health"),
      { MET_NORWAY_CONTACT: "test@example.com" },
    );
    assert.equal(response.status, 200);
  });
});

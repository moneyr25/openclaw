import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { createApp } from "../src/server.ts";
import type { AppConfig } from "../src/config.ts";
import type { WeatherSource } from "../src/sources/index.ts";
import type { Coordinates, SourceDescriptor } from "../src/types.ts";

const CONFIG: AppConfig = {
  host: "127.0.0.1",
  port: 0,
  forecastCacheTtlMs: 60_000,
  geocodeCacheTtlMs: 60_000,
  warningsCacheTtlMs: 60_000,
  metNorwayContact: "test@example.com",
  metOfficeWarningsUrl: "http://127.0.0.1:1/warnings",
  metOfficeBaseUrl: "http://127.0.0.1:1/sitespecific",
  userAgent: "weather-dashboard-test/0.1",
};

const descriptor = (id: string, family: SourceDescriptor["family"]): SourceDescriptor => ({
  id,
  label: id,
  attribution: "test",
  family,
  resolutionKm: 10,
  maxLeadHours: 48,
});

const stubSource = (
  id: string,
  family: SourceDescriptor["family"],
  baseTemp: number,
): WeatherSource => ({
  descriptor: descriptor(id, family),
  fetch: async (_coords: Coordinates) => {
    const start = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    return {
      source: descriptor(id, family),
      hours: Array.from({ length: 24 }, (_, index) => ({
        time: new Date(start + index * 3_600_000).toISOString(),
        tempC: baseTemp + index * 0.1,
        precipMm: 0,
        condition: "cloudy" as const,
      })),
      fetchedAt: new Date().toISOString(),
      latencyMs: 1,
    };
  },
});

const failingSource = (id: string): WeatherSource => ({
  descriptor: descriptor(id, "gem"),
  fetch: async () => {
    throw new Error("upstream exploded");
  },
});

let server: http.Server;
let base: string;

before(async () => {
  const app = createApp(CONFIG, {
    sources: [
      stubSource("alpha", "ukmo", 15),
      stubSource("beta", "ecmwf", 16),
      failingSource("gamma"),
    ],
  });
  server = http.createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("http api", () => {
  test("reports health with the active source list", async () => {
    const response = await fetch(`${base}/api/health`);
    const body = (await response.json()) as { ok: boolean; sources: string[] };
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.sources, ["alpha", "beta", "gamma"]);
  });

  test("builds a forecast and keeps going when one source fails", async () => {
    const response = await fetch(
      `${base}/api/forecast?lat=51.5074&lon=-0.1278&tz=Europe/London&label=Test&origin=gps`,
    );
    assert.equal(response.status, 200);

    const body = (await response.json()) as {
      hours: unknown[];
      days: unknown[];
      sources: unknown[];
      failures: Array<{ sourceId: string; reason: string; skipped: boolean }>;
      location: { label: string };
    };

    assert.ok(body.hours.length > 0);
    assert.ok(body.days.length > 0);
    assert.equal(body.sources.length, 2);
    assert.equal(body.location.label, "Test");

    const broken = body.failures.find((failure) => failure.sourceId === "gamma");
    assert.ok(broken, "the failing source should be reported, not hidden");
    assert.match(broken.reason, /upstream exploded/u);
    assert.equal(broken.skipped, false);
  });

  test("rejects coordinates that are out of range", async () => {
    for (const query of ["lat=91&lon=0", "lat=0&lon=181", "lat=abc&lon=0", ""]) {
      const response = await fetch(`${base}/api/forecast?${query}`);
      assert.equal(response.status, 400, `expected 400 for "${query}"`);
    }
  });

  test("rejects a short geocode query", async () => {
    const response = await fetch(`${base}/api/geocode?q=a`);
    assert.equal(response.status, 400);
  });

  test("serves the dashboard itself", async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/u);
    assert.match(await response.text(), /Weather consensus/u);
  });

  test("refuses to serve files outside the public directory", async () => {
    for (const target of [
      "/../package.json",
      "/../../package.json",
      "/..%2fpackage.json",
      "/%2e%2e/package.json",
    ]) {
      const response = await fetch(`${base}${target}`, { redirect: "manual" });
      assert.ok(
        response.status === 404 || response.status === 400,
        `${target} returned ${response.status}`,
      );
      const body = await response.text();
      assert.doesNotMatch(body, /"name":\s*"@openclaw\/weather-dashboard"/u);
    }
  });

  test("returns 404 json for an unknown api route", async () => {
    const response = await fetch(`${base}/api/nope`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/u);
  });

  test("rejects non-GET methods", async () => {
    const response = await fetch(`${base}/api/health`, { method: "POST" });
    assert.equal(response.status, 405);
  });

  test("serves a repeat request from cache", async () => {
    const url = `${base}/api/forecast?lat=52.2&lon=0.12&tz=Europe/London&label=Cambridge`;
    const first = (await (await fetch(url)).json()) as { generatedAt: string };
    const second = (await (await fetch(url)).json()) as { generatedAt: string };
    // A cache hit returns the identical payload rather than refetching.
    assert.equal(first.generatedAt, second.generatedAt);
  });
});

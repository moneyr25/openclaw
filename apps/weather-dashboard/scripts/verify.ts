/**
 * Live contract check.
 *
 * Every adapter in this app was written against published API documentation.
 * This script is how you confirm the documentation matches reality from a
 * machine that can actually reach these hosts: it calls each source for real,
 * reports which variables came back, and names the exact mismatch when one
 * does not. Run it after any upstream model upgrade, and whenever a source
 * starts looking wrong on the dashboard.
 *
 *   pnpm --dir apps/weather-dashboard verify [lat] [lon]
 */

import { loadConfig } from "../src/config.ts";
import { buildSources, skippedSources } from "../src/sources/index.ts";
import { fetchMetOfficeWarnings } from "../src/sources/warnings.ts";
import { reverseGeocode, searchPlaces } from "../src/geocode.ts";
import { NUMERIC_VARIABLES, type Coordinates } from "../src/types.ts";

const config = loadConfig();

const latitude = Number(process.argv[2] ?? 51.5074);
const longitude = Number(process.argv[3] ?? -0.1278);
if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
  console.error("usage: verify.ts [latitude] [longitude]");
  process.exit(2);
}
const coords: Coordinates = { latitude, longitude };

let failures = 0;

console.log(
  `Checking every source against ${latitude.toFixed(4)}, ${longitude.toFixed(4)}\n`,
);

const sources = buildSources(config);

for (const source of sources) {
  const { id, label, family, maxLeadHours } = source.descriptor;
  try {
    const started = Date.now();
    const forecast = await source.fetch(coords);
    const elapsed = Date.now() - started;

    const present = NUMERIC_VARIABLES.filter((variable) =>
      forecast.hours.some((hour) => hour[variable] !== undefined),
    );
    const missing = NUMERIC_VARIABLES.filter(
      (variable) => !present.includes(variable),
    );
    const withCondition = forecast.hours.filter((hour) => hour.condition).length;

    const first = forecast.hours[0];
    const last = forecast.hours.at(-1);
    const spanHours =
      first && last
        ? Math.round((Date.parse(last.time) - Date.parse(first.time)) / 3_600_000)
        : 0;

    console.log(`PASS  ${label}  (${id}, family ${family})`);
    console.log(
      `        ${forecast.hours.length} hours spanning ${spanHours} h ` +
        `(declared max ${maxLeadHours} h), ${elapsed} ms`,
    );
    console.log(`        parsed:  ${present.join(", ") || "nothing"}`);
    if (missing.length > 0) {
      console.log(`        absent:  ${missing.join(", ")}`);
    }
    console.log(
      `        conditions on ${withCondition}/${forecast.hours.length} hours; ` +
        `first hour ${first?.time ?? "?"} at ${first?.tempC ?? "?"} C`,
    );

    // A source that parses but yields nothing usable is a silent failure, and
    // silent failures are exactly what this script exists to surface.
    if (present.length === 0) {
      console.log("        ERROR: no numeric variables parsed - the response shape has changed");
      failures += 1;
    } else if (!present.includes("tempC")) {
      console.log("        ERROR: no temperature parsed");
      failures += 1;
    }
    if (spanHours > maxLeadHours) {
      console.log("        NOTE:  returns more hours than declared; raise maxLeadHours");
    }
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${label}  (${id})`);
    console.log(
      `        ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  console.log();
}

for (const skipped of skippedSources(
  config,
  sources.map((source) => source.descriptor.id),
)) {
  console.log(`SKIP  ${skipped.label}: ${skipped.reason}`);
}
console.log();

// Warnings are scraped from an RSS feed, the surface most likely to move
// without notice.
try {
  const warnings = await fetchMetOfficeWarnings({
    url: config.metOfficeWarningsUrl,
    userAgent: config.userAgent,
  });
  console.log(
    `PASS  Met Office warnings feed reachable - ${warnings.length} in force`,
  );
  for (const warning of warnings.slice(0, 3)) {
    console.log(`        ${warning.level}: ${warning.title}`);
  }
} catch (error) {
  // Not fatal: the dashboard hides the warnings strip when this is unavailable.
  console.log(
    `WARN  Met Office warnings feed unavailable: ` +
      `${error instanceof Error ? error.message : String(error)}`,
  );
  console.log("        set MET_OFFICE_WARNINGS_URL if the feed has moved");
}
console.log();

try {
  const places = await searchPlaces("Shoreditch", { userAgent: config.userAgent });
  console.log(
    `PASS  Place search returned ${places.length} results ` +
      `(first: ${places[0]?.label ?? "none"})`,
  );
} catch (error) {
  failures += 1;
  console.log(
    `FAIL  Place search failed: ` +
      `${error instanceof Error ? error.message : String(error)}`,
  );
}

const name = await reverseGeocode(coords, { userAgent: config.userAgent });
console.log(
  name
    ? `PASS  Reverse geocode: ${name}`
    : "WARN  Reverse geocode returned nothing; the dashboard will show coordinates",
);

console.log();
if (failures === 0) {
  console.log("All source contracts hold.");
  process.exit(0);
}
console.log(`${failures} source check(s) failed.`);
process.exit(1);

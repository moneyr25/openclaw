import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { __testing as openMeteo } from "../src/sources/open-meteo.ts";
import { __testing as metOffice } from "../src/sources/met-office.ts";
import { __testing as metNorway } from "../src/sources/met-norway.ts";
import { __testing as openWeather } from "../src/sources/openweathermap.ts";
import { __testing as weatherApi } from "../src/sources/weatherapi.ts";
import { __testing as accuWeather } from "../src/sources/accuweather.ts";
import {
  __testing as appleWeatherKit,
  createWeatherKitToken,
} from "../src/sources/apple-weatherkit.ts";
import { parseWarningsFeed } from "../src/sources/warnings.ts";
import { asArray, path as at } from "../src/parse.ts";
import { generateKeyPairSync, createVerify } from "node:crypto";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));

describe("open-meteo", () => {
  const hours = openMeteo.parseHours(
    (fixture("open-meteo") as { hourly: Record<string, unknown> }).hourly,
  );

  test("normalises times to UTC hours", () => {
    assert.equal(hours[0]?.time, "2026-08-27T09:00:00.000Z");
    assert.equal(hours.length, 3);
  });

  test("resolves a model-suffixed variable name", () => {
    // The fixture carries `temperature_2m_ukmo_seamless`, which is the shape
    // Open-Meteo uses when more than one model is requested.
    assert.equal(hours[0]?.tempC, 16.4);
    assert.equal(hours[1]?.tempC, 17.1);
  });

  test("drops nulls rather than reading them as zero", () => {
    assert.equal(hours[2]?.tempC, undefined);
    assert.equal(hours[2]?.precipMm, 1.4);
  });

  test("converts visibility from metres to km", () => {
    assert.equal(hours[0]?.visibilityKm, 24);
    assert.equal(hours[2]?.visibilityKm, 4);
  });

  test("maps WMO codes to the shared taxonomy", () => {
    assert.equal(hours[0]?.condition, "partly-cloudy");
    assert.equal(hours[1]?.condition, "rain");
    assert.equal(hours[2]?.condition, "thunder");
  });
});

describe("met office datahub", () => {
  const parsed = metOffice.readFeature(fixture("met-office"));
  const hours = metOffice.parseTimeSeries(parsed.entries);

  test("reads the location name out of the feature", () => {
    assert.equal(parsed.name, "London");
  });

  test("converts wind from m/s to km/h", () => {
    // 4.12 m/s * 3.6 = 14.832 -> 14.8
    assert.equal(hours[0]?.windKph, 14.8);
    assert.equal(hours[0]?.gustKph, 27.7);
  });

  test("converts mean sea level pressure from Pa to hPa", () => {
    assert.equal(hours[0]?.pressureHpa, 1011.2);
  });

  test("converts visibility from metres to km", () => {
    assert.equal(hours[0]?.visibilityKm, 22);
  });

  test("maps significant weather codes", () => {
    assert.equal(hours[0]?.condition, "partly-cloudy");
    assert.equal(hours[1]?.condition, "heavy-rain");
  });

  test("carries the probability of precipitation through", () => {
    assert.equal(hours[1]?.precipProbPct, 55);
  });
});

describe("met norway", () => {
  const hours = metNorway.parseTimeseries(
    asArray(at(fixture("met-norway"), "properties.timeseries")),
  );

  test("reads instant details", () => {
    assert.equal(hours[0]?.tempC, 16.1);
    assert.equal(hours[0]?.humidityPct, 66.4);
    assert.equal(hours[0]?.cloudPct, 30.5);
    assert.equal(hours[0]?.pressureHpa, 1011.5);
  });

  test("converts wind from m/s to km/h", () => {
    assert.equal(hours[0]?.windKph, 14.4);
  });

  test("spreads a six-hour accumulation over its hours", () => {
    // The long tail is six-hourly; 6.0 mm over 6 h is 1 mm in this hour.
    assert.equal(hours[1]?.precipMm, 1);
  });

  test("maps symbol codes, ignoring the day/night suffix", () => {
    assert.equal(hours[0]?.condition, "partly-cloudy");
    assert.equal(hours[1]?.condition, "thunder");
  });
});

describe("openweathermap", () => {
  const hours = openWeather.parseHourly(
    asArray(at(fixture("openweathermap"), "hourly")),
  );

  test("converts pop from a fraction to a percentage", () => {
    assert.equal(hours[0]?.precipProbPct, 6);
    assert.equal(hours[1]?.precipProbPct, 52);
  });

  test("converts wind from m/s to km/h", () => {
    assert.equal(hours[0]?.windKph, 14.8);
  });

  test("reads the 1h rain accumulation", () => {
    assert.equal(hours[0]?.precipMm, 0);
    assert.equal(hours[1]?.precipMm, 0.83);
  });

  test("maps condition ids", () => {
    assert.equal(hours[0]?.condition, "partly-cloudy");
    assert.equal(hours[1]?.condition, "heavy-rain");
  });
});

describe("weatherapi", () => {
  const hours = weatherApi.parseForecastDays(
    asArray(at(fixture("weatherapi"), "forecast.forecastday")),
  );

  test("reads already-metric values without converting", () => {
    assert.equal(hours[0]?.windKph, 14.8);
    assert.equal(hours[0]?.tempC, 16.5);
    assert.equal(hours[1]?.precipMm, 0.9);
  });

  test("takes the higher of rain and snow chance", () => {
    assert.equal(hours[1]?.precipProbPct, 58);
  });

  test("maps condition codes", () => {
    assert.equal(hours[0]?.condition, "partly-cloudy");
    assert.equal(hours[1]?.condition, "heavy-rain");
  });
});

describe("met office warnings feed", () => {
  const feed = `<?xml version="1.0"?><rss><channel>
    <item>
      <title>Amber warning of thunderstorms affecting London &amp; South East England</title>
      <description><![CDATA[<p>Slow moving storms <b>may</b> cause flooding.</p>]]></description>
      <link>https://www.metoffice.gov.uk/weather/warnings/1</link>
      <pubDate>Wed, 27 Aug 2026 05:00:00 GMT</pubDate>
      <guid>warning-1</guid>
    </item>
    <item><title>There are currently no severe weather warnings in force</title></item>
  </channel></rss>`;

  const warnings = parseWarningsFeed(feed);

  test("skips the no-warnings placeholder item", () => {
    assert.equal(warnings.length, 1);
  });

  test("decodes entities and strips CDATA markup", () => {
    assert.equal(
      warnings[0]?.title,
      "Amber warning of thunderstorms affecting London & South East England",
    );
    assert.equal(warnings[0]?.summary, "Slow moving storms may cause flooding.");
  });

  test("reads the warning level from the title", () => {
    assert.equal(warnings[0]?.level, "amber");
  });

  test("returns nothing for an empty feed rather than throwing", () => {
    assert.deepEqual(parseWarningsFeed("<rss><channel/></rss>"), []);
  });
});

describe("accuweather", () => {
  const hours = accuWeather.parseHourly(fixture("accuweather") as unknown[]);

  test("reads metric values without converting", () => {
    assert.equal(hours[0]?.tempC, 16.6);
    assert.equal(hours[0]?.windKph, 14.8);
    assert.equal(hours[0]?.gustKph, 27.8);
    assert.equal(hours[0]?.visibilityKm, 22.5);
  });

  test("reads nested Wind.Direction.Degrees", () => {
    assert.equal(hours[0]?.windDirDeg, 233);
    assert.equal(hours[1]?.windDirDeg, 248);
  });

  test("reads TotalLiquid as the hourly accumulation", () => {
    assert.equal(hours[0]?.precipMm, 0);
    assert.equal(hours[1]?.precipMm, 3.4);
  });

  test("upgrades rain to heavy rain from the rainfall rate", () => {
    // AccuWeather has no heavy-rain icon: 18 is plain "Rain" either way, so the
    // 3.4 mm is what separates a downpour from a shower.
    assert.equal(hours[1]?.condition, "heavy-rain");
  });

  test("downgrades a trace of rain to drizzle", () => {
    assert.equal(hours[2]?.condition, "drizzle");
  });

  test("tolerates hours missing the optional detail fields", () => {
    assert.equal(hours[2]?.tempC, 17.4);
    assert.equal(hours[2]?.windKph, undefined);
    assert.equal(hours[2]?.uvIndex, undefined);
  });

  test("maps icons that need no intensity adjustment", () => {
    assert.equal(hours[0]?.condition, "partly-cloudy");
  });
});

describe("apple weatherkit", () => {
  const hours = appleWeatherKit.parseHours(
    asArray(at(fixture("apple-weatherkit"), "forecastHourly.hours")),
  );

  test("converts 0-1 fractions to percentages", () => {
    assert.equal(hours[0]?.humidityPct, 65);
    assert.equal(hours[0]?.cloudPct, 42);
    assert.equal(hours[0]?.precipProbPct, 5);
    assert.equal(hours[1]?.precipProbPct, 75);
  });

  test("reads metric wind and pressure as given", () => {
    assert.equal(hours[0]?.windKph, 14.6);
    assert.equal(hours[0]?.gustKph, 27.1);
    assert.equal(hours[0]?.pressureHpa, 1011.4);
  });

  test("converts visibility from metres to km", () => {
    assert.equal(hours[0]?.visibilityKm, 23);
    assert.equal(hours[1]?.visibilityKm, 6.5);
  });

  test("maps condition codes", () => {
    assert.equal(hours[0]?.condition, "partly-cloudy");
    assert.equal(hours[1]?.condition, "heavy-rain");
  });

  test("uses forecastStart as the hour timestamp", () => {
    assert.equal(hours[0]?.time, "2026-08-27T09:00:00.000Z");
  });
});

describe("apple weatherkit authentication", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

  // Signed via WebCrypto so the same path runs under Node and on Workers.
  const token = await createWeatherKitToken(
    {
      teamId: "ABCDE12345",
      serviceId: "com.example.weather",
      keyId: "KEY1234567",
      privateKey: pem,
      userAgent: "test",
    },
    1_787_734_800,
  );

  const [headerPart, payloadPart, signaturePart] = token.split(".");
  const decode = (part: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;

  test("carries the id claim WeatherKit matches on", () => {
    // Not part of the JWT spec, and its absence fails as an opaque 401.
    assert.equal(decode(headerPart!)["id"], "ABCDE12345.com.example.weather");
    assert.equal(decode(headerPart!)["kid"], "KEY1234567");
    assert.equal(decode(headerPart!)["alg"], "ES256");
  });

  test("issues and subjects the token correctly", () => {
    const payload = decode(payloadPart!);
    assert.equal(payload["iss"], "ABCDE12345");
    assert.equal(payload["sub"], "com.example.weather");
    assert.equal(payload["iat"], 1_787_734_800);
    assert.ok((payload["exp"] as number) > (payload["iat"] as number));
  });

  test("signs in JOSE r||s form, not DER", () => {
    const signature = Buffer.from(signaturePart!, "base64url");
    // DER-encoded ECDSA is variable length and starts 0x30; JOSE requires
    // exactly 64 bytes for P-256.
    assert.equal(signature.length, 64);
    assert.ok(
      createVerify("SHA256")
        .update(`${headerPart}.${payloadPart}`)
        .verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, signature),
    );
  });

  test("is url-safe with no padding", () => {
    assert.doesNotMatch(token, /[+/=]/u);
  });
});

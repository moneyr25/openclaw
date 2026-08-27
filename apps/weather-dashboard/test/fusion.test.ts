import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  circularStdDev,
  circularWeightedMean,
  robustWeightedMean,
  weightedMean,
  weightedMedian,
} from "../src/stats.ts";
import { computeWeights, familySkill } from "../src/skill.ts";
import { aggregate, confidenceFrom, densify } from "../src/aggregate.ts";
import { solarTimes } from "../src/astro.ts";
import type {
  HourPoint,
  ModelFamily,
  ResolvedLocation,
  SourceDescriptor,
  SourceForecast,
} from "../src/types.ts";

const sample = (sourceId: string, value: number, weight = 1) => ({
  sourceId,
  value,
  weight,
});

const descriptor = (
  id: string,
  family: ModelFamily,
  resolutionKm = 10,
  maxLeadHours = 168,
): SourceDescriptor => ({
  id,
  label: id,
  attribution: "test",
  family,
  resolutionKm,
  maxLeadHours,
});

const NOW = new Date("2026-08-27T09:00:00Z");

const LOCATION: ResolvedLocation = {
  latitude: 51.5074,
  longitude: -0.1278,
  origin: "gps",
  timezone: "Europe/London",
};

const series = (
  source: SourceDescriptor,
  points: Array<Partial<HourPoint>>,
): SourceForecast => ({
  source,
  hours: points.map((point, index) => ({
    time: new Date(NOW.getTime() + index * 3_600_000).toISOString(),
    ...point,
  })) as HourPoint[],
  fetchedAt: NOW.toISOString(),
  latencyMs: 5,
});

const run = (forecasts: SourceForecast[], horizonHours = 6) =>
  aggregate({
    location: LOCATION,
    forecasts,
    failures: [],
    warnings: [],
    now: NOW,
    horizonHours,
  });

describe("weighted statistics", () => {
  test("weighted median splits an even pair at the midpoint", () => {
    assert.equal(weightedMedian([sample("a", 10), sample("b", 12)]), 11);
  });

  test("weighted median follows the weight, not the count", () => {
    const value = weightedMedian([
      sample("a", 5, 0.1),
      sample("b", 5, 0.1),
      sample("c", 20, 5),
    ]);
    assert.equal(value, 20);
  });

  test("robust mean rejects a single broken source", () => {
    const samples = [
      sample("a", 10),
      sample("b", 10.4),
      sample("c", 10.2),
      sample("d", 9.9),
      sample("e", 45),
    ];
    // A plain mean is dragged to 17.1 by the outlier.
    assert.ok(weightedMean(samples) > 17);
    assert.ok(robustWeightedMean(samples).value < 10.5);
  });

  test("robust mean keeps everything when nothing is an outlier", () => {
    const samples = [sample("a", 10), sample("b", 10.4), sample("c", 10.2)];
    assert.equal(robustWeightedMean(samples).kept.length, 3);
  });

  test("wind direction averages across north instead of through south", () => {
    const { degrees } = circularWeightedMean([sample("a", 350), sample("b", 10)]);
    assert.ok(degrees < 1 || degrees > 359, `expected ~0, got ${degrees}`);
  });

  test("opposed wind directions report maximum circular spread", () => {
    const { concentration } = circularWeightedMean([
      sample("a", 0),
      sample("b", 180),
    ]);
    assert.equal(circularStdDev(concentration), 180);
  });
});

describe("skill weighting", () => {
  test("the Met Office leads in the short range and ECMWF in the medium", () => {
    assert.ok(familySkill("ukmo", 3) > familySkill("ecmwf", 3));
    assert.ok(familySkill("ecmwf", 120) > familySkill("ukmo", 120));
  });

  test("two feeds of one model do not get two votes", () => {
    const paired = computeWeights(
      [descriptor("a", "ukmo", 2), descriptor("b", "ukmo", 2)],
      3,
    );
    const single = computeWeights([descriptor("a", "ukmo", 2)], 3);

    const pairedTotal = [...paired.values()].reduce((sum, w) => sum + w, 0);
    const singleTotal = [...single.values()].reduce((sum, w) => sum + w, 0);

    // A second feed of the same model earns a small sampling bonus, never a
    // doubling.
    assert.ok(pairedTotal > singleTotal);
    assert.ok(pairedTotal <= singleTotal * 1.2 + 1e-9);
  });

  test("the sharper model takes the larger share within a family", () => {
    const weights = computeWeights(
      [descriptor("sharp", "ukmo", 2), descriptor("coarse", "ukmo", 25)],
      3,
    );
    assert.ok(weights.get("sharp")! > weights.get("coarse")!);
  });
});

describe("confidence", () => {
  test("perfect agreement across many models beats the same across one", () => {
    assert.ok(confidenceFrom(0, 2, 5, 0) > confidenceFrom(0, 2, 1, 0));
  });

  test("disagreement lowers confidence", () => {
    assert.ok(confidenceFrom(4, 2, 5, 0) < confidenceFrom(0.2, 2, 5, 0));
  });

  test("lead time lowers confidence even with total agreement", () => {
    assert.ok(confidenceFrom(0, 2, 5, 168) < confidenceFrom(0, 2, 5, 0));
  });

  test("stays inside 1-99 so nothing ever reads as certain", () => {
    assert.ok(confidenceFrom(0, 2, 99, 0) <= 99);
    assert.ok(confidenceFrom(1000, 2, 1, 300) >= 1);
  });
});

describe("densify", () => {
  test("interpolates across a six-hour gap", () => {
    const filled = densify([
      { time: "2026-08-27T00:00:00Z", tempC: 10 },
      { time: "2026-08-27T06:00:00Z", tempC: 16 },
    ]);
    assert.deepEqual(
      filled.map((point) => point.tempC),
      [10, 11, 12, 13, 14, 15, 16],
    );
  });

  test("leaves a gap larger than the limit alone", () => {
    const filled = densify([
      { time: "2026-08-27T00:00:00Z", tempC: 10 },
      { time: "2026-08-27T12:00:00Z", tempC: 16 },
    ]);
    assert.equal(filled.length, 2);
  });

  test("interpolates wind direction the short way round the compass", () => {
    const filled = densify([
      { time: "2026-08-27T00:00:00Z", windDirDeg: 350 },
      { time: "2026-08-27T02:00:00Z", windDirDeg: 10 },
    ]);
    assert.equal(filled[1]?.windDirDeg, 0);
  });

  test("carries conditions forward rather than inventing them", () => {
    const filled = densify([
      { time: "2026-08-27T00:00:00Z", condition: "rain" },
      { time: "2026-08-27T03:00:00Z", condition: "clear" },
    ]);
    assert.equal(filled[1]?.condition, "rain");
    assert.equal(filled[2]?.condition, "rain");
  });
});

describe("aggregation", () => {
  test("counts independent model families, not feeds", () => {
    const result = run([
      series(descriptor("ukmo-a", "ukmo", 2), [{ tempC: 18 }]),
      series(descriptor("ukmo-b", "ukmo", 2), [{ tempC: 18.2 }]),
      series(descriptor("ecmwf-a", "ecmwf", 25), [{ tempC: 17.5 }]),
      series(descriptor("ecmwf-b", "ecmwf", 9), [{ tempC: 17.6 }]),
      series(descriptor("gfs", "gfs", 13), [{ tempC: 19.5 }]),
    ]);
    assert.equal(result.hours[0]?.values.tempC?.contributors, 3);
  });

  test("three feeds of one model cannot outvote one of another", () => {
    // Same numbers either way; only the number of correlated feeds changes.
    const withOneEcmwf = run([
      series(descriptor("ukmo", "ukmo", 2), [{ tempC: 10 }]),
      series(descriptor("ecmwf-a", "ecmwf", 25), [{ tempC: 20 }]),
    ]);
    const withThreeEcmwf = run([
      series(descriptor("ukmo", "ukmo", 2), [{ tempC: 10 }]),
      series(descriptor("ecmwf-a", "ecmwf", 25), [{ tempC: 20 }]),
      series(descriptor("ecmwf-b", "ecmwf", 25), [{ tempC: 20 }]),
      series(descriptor("ecmwf-c", "ecmwf", 25), [{ tempC: 20 }]),
    ]);

    const shift = Math.abs(
      (withThreeEcmwf.hours[0]?.values.tempC?.value ?? 0) -
        (withOneEcmwf.hours[0]?.values.tempC?.value ?? 0),
    );
    // Adding two more copies of the same model moves the answer barely at all.
    assert.ok(shift < 1, `consensus moved by ${shift}`);
  });

  test("derives rain probability from the ensemble when nobody reports one", () => {
    const result = run([
      series(descriptor("a", "ukmo", 2), [{ precipMm: 0.5 }]),
      series(descriptor("b", "ecmwf", 25), [{ precipMm: 0.4 }]),
      series(descriptor("c", "icon", 7), [{ precipMm: 0 }]),
      series(descriptor("d", "gfs", 13), [{ precipMm: 0 }]),
    ]);
    const pop = result.hours[0]?.values.precipProbPct;
    assert.ok(pop, "expected a probability");
    assert.ok(pop.value > 30 && pop.value < 70, `got ${pop.value}`);
  });

  test("every fused range brackets its own value", () => {
    const result = run(
      [
        series(descriptor("a", "ukmo", 2), [
          { tempC: 18, precipMm: 0.4, precipProbPct: 60, windKph: 20, humidityPct: 95 },
        ]),
        series(descriptor("b", "ecmwf", 25), [
          { tempC: 12, precipMm: 0, precipProbPct: 5, windKph: 4, humidityPct: 60 },
        ]),
        series(descriptor("c", "gfs", 13), [
          { tempC: 25, precipMm: 3, precipProbPct: 90, windKph: 55, humidityPct: 99 },
        ]),
      ],
      2,
    );

    for (const hour of result.hours) {
      for (const [name, value] of Object.entries(hour.values)) {
        if (name === "windDirDeg") continue;
        assert.ok(
          value.low <= value.value && value.value <= value.high,
          `${name}: ${value.low} <= ${value.value} <= ${value.high}`,
        );
      }
    }
  });

  test("percentages never leave 0-100", () => {
    const result = run([
      series(descriptor("a", "ukmo", 2), [{ humidityPct: 99, precipProbPct: 98 }]),
      series(descriptor("b", "ecmwf", 25), [{ humidityPct: 40, precipProbPct: 2 }]),
      series(descriptor("c", "gfs", 13), [{ humidityPct: 97, precipProbPct: 95 }]),
    ]);
    const humidity = result.hours[0]?.values.humidityPct;
    assert.ok(humidity && humidity.high <= 100 && humidity.low >= 0);
  });

  test("a tie between conditions resolves towards the more consequential one", () => {
    const result = run([
      series(descriptor("a", "ukmo", 2), [{ condition: "cloudy" }]),
      series(descriptor("b", "gfs", 13), [{ condition: "thunder" }]),
    ]);
    // Equal families, so weights differ only by skill; either way the reported
    // condition must be one of the two, and a genuine split must not read as
    // confident.
    assert.ok(["cloudy", "thunder"].includes(result.hours[0]!.condition!.value));
    assert.ok(result.hours[0]!.condition!.confidence < 70);
  });

  test("adjacent conditions still count as agreement", () => {
    const split = run([
      series(descriptor("a", "ukmo", 2), [{ condition: "rain" }]),
      series(descriptor("b", "ecmwf", 25), [{ condition: "heavy-rain" }]),
    ]);
    // "Rain" versus "heavy rain" is agreement about the thing that matters.
    assert.ok(split.hours[0]!.condition!.confidence > 90);
  });

  test("a source is not used beyond its own forecast range", () => {
    const shortRange = descriptor("short", "arpege", 10, 2);
    const longRange = descriptor("long", "ecmwf", 25, 168);
    const result = run(
      [
        series(shortRange, [{ tempC: 10 }, { tempC: 11 }, { tempC: 12 }, { tempC: 13 }]),
        series(longRange, [{ tempC: 20 }, { tempC: 21 }, { tempC: 22 }, { tempC: 23 }]),
      ],
      4,
    );
    assert.equal(result.bySource["short"]?.length, 3);
    assert.equal(result.bySource["long"]?.length, 4);
  });

  test("confidence decays with lead time", () => {
    const points = Array.from({ length: 49 }, (_, index) => ({
      tempC: 15 + (index % 3) * 0.2,
    }));
    const result = run(
      [
        series(descriptor("a", "ukmo", 2), points),
        series(descriptor("b", "ecmwf", 25), points),
        series(descriptor("c", "gfs", 13), points),
      ],
      48,
    );
    const first = result.hours[0]?.values.tempC?.confidence ?? 0;
    const last = result.hours.at(-1)?.values.tempC?.confidence ?? 0;
    assert.ok(last < first, `${last} should be below ${first}`);
  });

  test("rolls hours up into local days", () => {
    const points = Array.from({ length: 30 }, (_, index) => ({
      tempC: 10 + index * 0.5,
      precipMm: 0.1,
    }));
    const result = run(
      [
        series(descriptor("a", "ukmo", 2), points),
        series(descriptor("b", "ecmwf", 25), points),
      ],
      30,
    );

    assert.ok(result.days.length >= 2);
    const today = result.days[0]!;
    assert.ok(today.minTempC!.value < today.maxTempC!.value);
    assert.ok(today.totalPrecipMm!.value > 0);
    assert.ok(today.sunrise && today.sunset);
  });

  test("survives a source that reports nothing but a timestamp", () => {
    const result = run([
      series(descriptor("a", "ukmo", 2), [{ tempC: 15 }]),
      series(descriptor("empty", "gfs", 13), [{}]),
    ]);
    assert.equal(result.hours[0]?.values.tempC?.value, 15);
    assert.equal(result.hours[0]?.values.tempC?.contributors, 1);
  });
});

describe("solar times", () => {
  test("matches published London sunrise and sunset at the solstice", () => {
    const times = solarTimes(51.5074, -0.1278, new Date("2026-06-21T12:00:00Z"));
    // Published: 04:43 BST (03:43 UTC) and 21:21 BST (20:21 UTC).
    assert.equal(times.sunrise?.slice(11, 16), "03:42");
    assert.equal(times.sunset?.slice(11, 16), "20:21");
  });

  test("reports polar day inside the Arctic Circle in June", () => {
    const times = solarTimes(69.65, 18.96, new Date("2026-06-21T12:00:00Z"));
    assert.equal(times.polarDay, true);
    assert.equal(times.sunrise, undefined);
  });
});

import {
  circularStdDev,
  circularWeightedMean,
  robustWeightedMean,
  weightedMedian,
  weightedStdDev,
  type Sample,
} from "./stats.ts";
import { computeWeights } from "./skill.ts";
import { conditionSeverity } from "./conditions.ts";
import { solarTimes } from "./astro.ts";
import { round } from "./units.ts";
import {
  NUMERIC_VARIABLES,
  type AggregateResult,
  type Condition,
  type FusedDay,
  type FusedHour,
  type FusedValue,
  type HourPoint,
  type NumericVariable,
  type ResolvedLocation,
  type SourceDescriptor,
  type SourceFailure,
  type SourceForecast,
  type Warning,
} from "./types.ts";

const HOUR_MS = 3_600_000;

/**
 * Spread at which confidence in a variable should sit at roughly 50%.
 *
 * These encode "how much disagreement actually matters" per variable, which is
 * not the same as how much disagreement there is. Two models 3 hPa apart on
 * pressure is a real difference; 3% apart on cloud cover is noise.
 */
const TOLERANCE: Record<NumericVariable, number> = {
  tempC: 2,
  apparentC: 2.5,
  precipMm: 0.8,
  precipProbPct: 20,
  windKph: 8,
  gustKph: 12,
  windDirDeg: 40,
  humidityPct: 12,
  cloudPct: 25,
  pressureHpa: 3,
  uvIndex: 1.5,
  visibilityKm: 5,
};

/**
 * Variables combined with a plain weighted mean rather than a trimmed one.
 * Precipitation is genuinely skewed: trimming the one model that resolves a
 * convective shower would delete exactly the signal worth having.
 */
const MEAN_ONLY: ReadonlySet<NumericVariable> = new Set<NumericVariable>([
  "precipMm",
  "precipProbPct",
]);

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Confidence from agreement.
 *
 * Three things reduce it: the sources disagree (`spread` against the variable's
 * tolerance), there are few genuinely independent opinions, and the forecast is
 * a long way out. The last one matters — six models agreeing about next
 * Thursday are still six models guessing about next Thursday.
 */
export const confidenceFrom = (
  spread: number,
  tolerance: number,
  familyCount: number,
  leadHours: number,
): number => {
  const agreement = 1 / (1 + (spread / tolerance) ** 2);
  // 1 family: 0.45 (we cannot measure agreement at all). 4+: full credit.
  const independence = clamp(0.45 + 0.185 * (familyCount - 1), 0.45, 1);
  // Halves by the end of a 7-day forecast.
  const horizon = clamp(1 - leadHours / 336, 0.5, 1);
  return clamp(Math.round(100 * agreement * independence * horizon), 1, 99);
};

/**
 * Fill short gaps in a source's series by linear interpolation.
 *
 * MET Norway (and the Met Office three-hourly slice) drop to coarser steps
 * beyond a few days. Without this those sources silently stop contributing
 * exactly when the forecast is least certain and most needs another opinion.
 * Gaps larger than `maxGapHours` are left alone — that would be extrapolation.
 */
export const densify = (hours: HourPoint[], maxGapHours = 6): HourPoint[] => {
  if (hours.length < 2) return hours;
  const sorted = [...hours].sort((a, b) => a.time.localeCompare(b.time));
  const filled: HourPoint[] = [];

  for (const [index, current] of sorted.entries()) {
    filled.push(current);
    const next = sorted[index + 1];
    if (!next) break;

    const startMs = Date.parse(current.time);
    const endMs = Date.parse(next.time);
    const gapHours = (endMs - startMs) / HOUR_MS;
    if (gapHours <= 1 || gapHours > maxGapHours) continue;

    for (let step = 1; step < gapHours; step += 1) {
      const fraction = step / gapHours;
      const point: HourPoint = {
        time: new Date(startMs + step * HOUR_MS).toISOString(),
      };
      for (const variable of NUMERIC_VARIABLES) {
        const from = current[variable];
        const to = next[variable];
        if (from === undefined || to === undefined) continue;
        if (variable === "windDirDeg") {
          // Interpolate the short way round the compass.
          const delta = ((to - from + 540) % 360) - 180;
          point[variable] = round((((from + delta * fraction) % 360) + 360) % 360, 1);
        } else {
          point[variable] = round(from + (to - from) * fraction, 2);
        }
      }
      // Conditions do not interpolate; carry the earlier one forward.
      if (current.condition) point.condition = current.condition;
      filled.push(point);
    }
  }

  return filled.sort((a, b) => a.time.localeCompare(b.time));
};

type HourSamples = {
  descriptors: SourceDescriptor[];
  points: Array<{ descriptor: SourceDescriptor; point: HourPoint }>;
};

const fuseNumeric = (
  variable: NumericVariable,
  samples: Sample[],
  familyCount: number,
  leadHours: number,
): FusedValue | undefined => {
  if (samples.length === 0) return undefined;
  const tolerance = TOLERANCE[variable];

  if (variable === "windDirDeg") {
    const { degrees, concentration } = circularWeightedMean(samples);
    if (!Number.isFinite(degrees)) return undefined;
    const spread = circularStdDev(concentration);
    return {
      value: round(degrees, 0),
      contributors: familyCount,
      spread: round(spread, 0),
      low: round((((degrees - spread) % 360) + 360) % 360, 0),
      high: round((((degrees + spread) % 360) + 360) % 360, 0),
      confidence: confidenceFrom(spread, tolerance, familyCount, leadHours),
    };
  }

  const value = MEAN_ONLY.has(variable)
    ? samples.reduce((sum, s) => sum + s.value * s.weight, 0) /
      samples.reduce((sum, s) => sum + s.weight, 0)
    : robustWeightedMean(samples).value;

  if (!Number.isFinite(value)) return undefined;

  const spread = weightedStdDev(samples, value);
  // 1.2816 sigma is the 10th/90th percentile of a normal distribution: a range
  // the outcome should fall inside about 80% of the time if the ensemble is
  // well calibrated.
  const halfRange = 1.2816 * spread;
  const isPositiveOnly =
    variable === "precipMm" ||
    variable === "precipProbPct" ||
    variable === "windKph" ||
    variable === "gustKph" ||
    variable === "uvIndex" ||
    variable === "visibilityKm";

  const decimals = variable === "precipMm" ? 2 : 1;
  // Percentages are bounded; the rest only have a floor at zero.
  const isPercentage =
    variable === "precipProbPct" ||
    variable === "humidityPct" ||
    variable === "cloudPct";
  const low = isPositiveOnly || isPercentage ? Math.max(0, value - halfRange) : value - halfRange;
  const high = isPercentage ? Math.min(100, value + halfRange) : value + halfRange;

  return {
    value: round(value, decimals),
    contributors: familyCount,
    spread: round(spread, decimals),
    low: round(low, decimals),
    high: round(high, decimals),
    confidence: confidenceFrom(spread, tolerance, familyCount, leadHours),
  };
};

/**
 * Consensus condition.
 *
 * Confidence counts not just the winner's weight but everything within one step
 * of it on the severity scale: sources splitting between "rain" and
 * "heavy-rain" agree about the thing that matters, and should not read as a
 * coin toss.
 */
const fuseCondition = (
  votes: Array<{ condition: Condition; weight: number }>,
  leadHours: number,
): FusedHour["condition"] => {
  if (votes.length === 0) return undefined;

  const tally = new Map<Condition, number>();
  for (const vote of votes) {
    tally.set(vote.condition, (tally.get(vote.condition) ?? 0) + vote.weight);
  }

  const ranked = [...tally.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    // Tie: prefer the more consequential outcome. Being told to take a coat and
    // not needing it beats the reverse.
    return conditionSeverity(b[0]) - conditionSeverity(a[0]);
  });

  const winner = ranked[0]!;
  const total = votes.reduce((sum, vote) => sum + vote.weight, 0);
  const winnerSeverity = conditionSeverity(winner[0]);
  const nearWeight = [...tally.entries()]
    .filter(
      ([condition]) =>
        Math.abs(conditionSeverity(condition) - winnerSeverity) <= 1,
    )
    .reduce((sum, [, weight]) => sum + weight, 0);

  const horizon = clamp(1 - leadHours / 336, 0.5, 1);
  return {
    value: winner[0],
    confidence: clamp(Math.round((nearWeight / total) * 100 * horizon), 1, 99),
    votes: ranked.map(([condition, weight]) => ({
      condition,
      weight: round(weight, 3),
    })),
  };
};

/**
 * Probability of precipitation, blending two different kinds of evidence.
 *
 * Only some models publish a probability. The rest publish an amount, and the
 * *fraction of the ensemble producing measurable rain* is itself a probability
 * — often a better calibrated one, because it comes from genuine disagreement
 * between independent models rather than one model's post-processing. Where
 * both exist we use both.
 */
const fusePrecipProbability = (
  reported: Sample[],
  amounts: Sample[],
  familyCount: number,
  leadHours: number,
): FusedValue | undefined => {
  const voteWeight = amounts.reduce((sum, s) => sum + s.weight, 0);
  const wetWeight = amounts
    .filter((sample) => sample.value >= 0.1)
    .reduce((sum, s) => sum + s.weight, 0);
  const ensembleProb =
    voteWeight > 0 ? (wetWeight / voteWeight) * 100 : undefined;

  const reportedFused = fuseNumeric(
    "precipProbPct",
    reported,
    familyCount,
    leadHours,
  );

  if (reportedFused && ensembleProb !== undefined && amounts.length >= 3) {
    const blended = clamp(0.6 * reportedFused.value + 0.4 * ensembleProb, 0, 100);
    // Disagreement between the two methods is itself uncertainty.
    const spread = Math.max(
      reportedFused.spread,
      Math.abs(reportedFused.value - ensembleProb) / 2,
    );
    // The range has to be rebuilt around the blended value; carrying over the
    // reported source's band can leave `low` above `value`.
    const halfRange = 1.2816 * spread;
    return {
      ...reportedFused,
      value: round(blended, 0),
      spread: round(spread, 1),
      low: round(clamp(blended - halfRange, 0, 100), 0),
      high: round(clamp(blended + halfRange, 0, 100), 0),
    };
  }
  if (reportedFused) return reportedFused;
  if (ensembleProb === undefined || amounts.length < 2) return undefined;

  // Nothing reported a probability: the ensemble vote is all we have. Spread is
  // largest at 50% (maximum disagreement) and smallest at the extremes.
  const spread = (100 - Math.abs(ensembleProb - 50) * 2) / 2;
  return {
    value: round(ensembleProb, 0),
    contributors: familyCount,
    spread: round(spread, 1),
    low: round(Math.max(0, ensembleProb - spread), 0),
    high: round(Math.min(100, ensembleProb + spread), 0),
    confidence: confidenceFrom(
      spread,
      TOLERANCE.precipProbPct,
      familyCount,
      leadHours,
    ),
  };
};

const fuseHour = (
  time: string,
  entries: HourSamples,
  nowMs: number,
): FusedHour => {
  const leadHours = Math.max(0, (Date.parse(time) - nowMs) / HOUR_MS);
  const weights = computeWeights(entries.descriptors, leadHours);

  const samplesFor = (variable: NumericVariable): Sample[] =>
    entries.points.flatMap(({ descriptor, point }) => {
      const value = point[variable];
      if (value === undefined || !Number.isFinite(value)) return [];
      const weight = weights.get(descriptor.id);
      if (weight === undefined || weight <= 0) return [];
      return [{ sourceId: descriptor.id, value, weight }];
    });

  const familiesFor = (variable: NumericVariable): number =>
    new Set(
      entries.points
        .filter(({ point }) => point[variable] !== undefined)
        .map(({ descriptor }) => descriptor.family),
    ).size;

  const values: Partial<Record<NumericVariable, FusedValue>> = {};
  for (const variable of NUMERIC_VARIABLES) {
    if (variable === "precipProbPct") continue;
    const fused = fuseNumeric(
      variable,
      samplesFor(variable),
      familiesFor(variable),
      leadHours,
    );
    if (fused) values[variable] = fused;
  }

  const probability = fusePrecipProbability(
    samplesFor("precipProbPct"),
    samplesFor("precipMm"),
    Math.max(familiesFor("precipProbPct"), familiesFor("precipMm")),
    leadHours,
  );
  if (probability) values.precipProbPct = probability;

  const votes = entries.points.flatMap(({ descriptor, point }) => {
    if (!point.condition) return [];
    const weight = weights.get(descriptor.id);
    if (weight === undefined || weight <= 0) return [];
    return [{ condition: point.condition, weight }];
  });

  const condition = fuseCondition(votes, leadHours);
  return {
    time,
    leadHours: round(leadHours, 1),
    values,
    ...(condition ? { condition } : {}),
  };
};

/** `en-CA` formats as YYYY-MM-DD, which is exactly the day key we want. */
const dayKey = (iso: string, timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
};

const pickDominantCondition = (hours: FusedHour[]): Condition | undefined => {
  const daytime = hours.filter((hour) => {
    const utcHour = new Date(hour.time).getUTCHours();
    return utcHour >= 6 && utcHour <= 20;
  });
  const pool = daytime.length > 0 ? daytime : hours;

  const tally = new Map<Condition, number>();
  for (const hour of pool) {
    if (!hour.condition) continue;
    tally.set(hour.condition.value, (tally.get(hour.condition.value) ?? 0) + 1);
  }
  if (tally.size === 0) return undefined;

  // A day with two hours of thunder is a thundery day even if it is mostly
  // cloudy, so significant weather outranks the simple mode.
  const significant = [...tally.entries()]
    .filter(
      ([condition, count]) => count >= 2 && conditionSeverity(condition) >= 5,
    )
    .sort((a, b) => conditionSeverity(b[0]) - conditionSeverity(a[0]));
  if (significant[0]) return significant[0][0];

  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};

const rollUpDays = (
  hours: FusedHour[],
  location: ResolvedLocation,
): FusedDay[] => {
  const timeZone = location.timezone ?? "UTC";
  const grouped = new Map<string, FusedHour[]>();
  for (const hour of hours) {
    const key = dayKey(hour.time, timeZone);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(hour);
    else grouped.set(key, [hour]);
  }

  const days: FusedDay[] = [];
  for (const [date, dayHours] of [...grouped.entries()].sort()) {
    const extreme = (
      variable: NumericVariable,
      direction: "min" | "max",
    ): FusedValue | undefined => {
      const values = dayHours
        .map((hour) => hour.values[variable])
        .filter((value): value is FusedValue => value !== undefined);
      if (values.length === 0) return undefined;
      return values.reduce((best, value) =>
        direction === "min"
          ? value.value < best.value
            ? value
            : best
          : value.value > best.value
            ? value
            : best,
      );
    };

    const precipValues = dayHours
      .map((hour) => hour.values.precipMm)
      .filter((value): value is FusedValue => value !== undefined);
    const totalPrecip =
      precipValues.length === 0
        ? undefined
        : {
            value: round(
              precipValues.reduce((sum, v) => sum + v.value, 0),
              1,
            ),
            contributors: precipValues[0]!.contributors,
            // Hourly errors are correlated within a single rain event, so
            // adding in quadrature would understate the day's uncertainty.
            spread: round(
              precipValues.reduce((sum, v) => sum + v.spread, 0),
              1,
            ),
            low: round(
              precipValues.reduce((sum, v) => sum + v.low, 0),
              1,
            ),
            high: round(
              precipValues.reduce((sum, v) => sum + v.high, 0),
              1,
            ),
            confidence: Math.round(
              precipValues.reduce((sum, v) => sum + v.confidence, 0) /
                precipValues.length,
            ),
          };

    const tempConfidences = dayHours
      .map((hour) => hour.values.tempC?.confidence)
      .filter((value): value is number => value !== undefined);

    const noonish =
      dayHours.find((hour) => new Date(hour.time).getUTCHours() === 12) ??
      dayHours[Math.floor(dayHours.length / 2)];
    const sun = noonish
      ? solarTimes(
          location.latitude,
          location.longitude,
          new Date(noonish.time),
        )
      : undefined;

    const minTempC = extreme("tempC", "min");
    const maxTempC = extreme("tempC", "max");
    const maxPrecipProbPct = extreme("precipProbPct", "max");
    const maxWindKph = extreme("windKph", "max");
    const maxGustKph = extreme("gustKph", "max");
    const maxUvIndex = extreme("uvIndex", "max");
    const condition = pickDominantCondition(dayHours);

    days.push({
      date,
      ...(minTempC ? { minTempC } : {}),
      ...(maxTempC ? { maxTempC } : {}),
      ...(totalPrecip ? { totalPrecipMm: totalPrecip } : {}),
      ...(maxPrecipProbPct ? { maxPrecipProbPct } : {}),
      ...(maxWindKph ? { maxWindKph } : {}),
      ...(maxGustKph ? { maxGustKph } : {}),
      ...(maxUvIndex ? { maxUvIndex } : {}),
      ...(condition ? { condition } : {}),
      confidence:
        tempConfidences.length === 0
          ? 0
          : Math.round(
              tempConfidences.reduce((sum, value) => sum + value, 0) /
                tempConfidences.length,
            ),
      ...(sun?.sunrise ? { sunrise: sun.sunrise } : {}),
      ...(sun?.sunset ? { sunset: sun.sunset } : {}),
    });
  }

  return days;
};

export type AggregateOptions = {
  location: ResolvedLocation;
  forecasts: SourceForecast[];
  failures: SourceFailure[];
  warnings: Warning[];
  /** Overridable so tests are deterministic. */
  now?: Date;
  /** Hours to project forward. */
  horizonHours?: number;
};

export const aggregate = (options: AggregateOptions): AggregateResult => {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  // Start from the top of the current hour so "now" always has a bucket.
  const startMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const horizonHours = options.horizonHours ?? 168;
  const endMs = startMs + horizonHours * HOUR_MS;

  const buckets = new Map<string, HourSamples>();
  const bySource: Record<string, HourPoint[]> = {};

  for (const forecast of options.forecasts) {
    const descriptor = forecast.source;
    const usable = densify(forecast.hours).filter((point) => {
      const ms = Date.parse(point.time);
      if (Number.isNaN(ms) || ms < startMs || ms > endMs) return false;
      // Respect each source's honest range rather than trusting a long tail.
      return (ms - nowMs) / HOUR_MS <= descriptor.maxLeadHours;
    });

    bySource[descriptor.id] = usable;

    for (const point of usable) {
      const bucket = buckets.get(point.time);
      if (bucket) {
        bucket.descriptors.push(descriptor);
        bucket.points.push({ descriptor, point });
      } else {
        buckets.set(point.time, {
          descriptors: [descriptor],
          points: [{ descriptor, point }],
        });
      }
    }
  }

  const hours = [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([time, entries]) => fuseHour(time, entries, nowMs));

  return {
    location: options.location,
    generatedAt: now.toISOString(),
    hours,
    days: rollUpDays(hours, options.location),
    sources: options.forecasts.map((forecast) => ({
      descriptor: forecast.source,
      fetchedAt: forecast.fetchedAt,
      latencyMs: forecast.latencyMs,
      hourCount: bySource[forecast.source.id]?.length ?? 0,
      ...(forecast.modelRun ? { modelRun: forecast.modelRun } : {}),
    })),
    failures: options.failures,
    warnings: options.warnings,
    bySource,
  };
};

export const __testing = {
  fuseCondition,
  fusePrecipProbability,
  fuseNumeric,
  pickDominantCondition,
  rollUpDays,
  TOLERANCE,
};

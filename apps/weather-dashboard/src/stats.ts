/** Weighted statistics used by the fusion engine. Pure functions, no I/O. */

export type Sample = {
  sourceId: string;
  value: number;
  weight: number;
};

const totalWeight = (samples: Sample[]): number =>
  samples.reduce((sum, sample) => sum + sample.weight, 0);

export const weightedMean = (samples: Sample[]): number => {
  const total = totalWeight(samples);
  if (total === 0) return Number.NaN;
  return samples.reduce((sum, s) => sum + s.value * s.weight, 0) / total;
};

/**
 * Weighted median: the value at which cumulative weight crosses half.
 * Resistant to a single source producing nonsense — which does happen, and
 * which a plain mean would happily fold into the answer.
 */
export const weightedMedian = (samples: Sample[]): number => {
  if (samples.length === 0) return Number.NaN;
  if (samples.length === 1) return samples[0]!.value;

  const sorted = [...samples].sort((a, b) => a.value - b.value);
  const total = totalWeight(sorted);
  if (total === 0) return Number.NaN;

  const half = total / 2;
  let cumulative = 0;
  for (const [index, sample] of sorted.entries()) {
    const next = cumulative + sample.weight;
    if (next >= half) {
      // Exactly on the boundary: average with the following sample so an even
      // split of two sources returns their midpoint rather than the lower one.
      if (next === half && index + 1 < sorted.length) {
        return (sample.value + sorted[index + 1]!.value) / 2;
      }
      return sample.value;
    }
    cumulative = next;
  }
  return sorted[sorted.length - 1]!.value;
};

export const weightedStdDev = (samples: Sample[], mean: number): number => {
  const total = totalWeight(samples);
  if (total === 0 || samples.length < 2) return 0;
  const variance =
    samples.reduce(
      (sum, s) => sum + s.weight * (s.value - mean) * (s.value - mean),
      0,
    ) / total;
  return Math.sqrt(Math.max(0, variance));
};

/**
 * Robust weighted mean: anchor on the weighted median, discard samples further
 * than `trimSigma` deviations from it, then take the weighted mean of what is
 * left.
 *
 * This is the combiner for most continuous variables. A plain mean is pulled
 * around by one broken source; a plain median throws away real information from
 * the sources that agree. Trimming then averaging keeps both properties.
 */
export const robustWeightedMean = (
  samples: Sample[],
  trimSigma = 2,
): { value: number; kept: Sample[] } => {
  if (samples.length === 0) return { value: Number.NaN, kept: [] };
  if (samples.length <= 2) return { value: weightedMean(samples), kept: samples };

  const median = weightedMedian(samples);
  const deviation = weightedStdDev(samples, median);
  if (deviation === 0) return { value: median, kept: samples };

  const kept = samples.filter(
    (sample) => Math.abs(sample.value - median) <= trimSigma * deviation,
  );
  // Never trim everything away.
  if (kept.length === 0) return { value: median, kept: samples };
  return { value: weightedMean(kept), kept };
};

const DEG = Math.PI / 180;

/**
 * Circular weighted mean, for wind direction. Averaging 350° and 10°
 * arithmetically gives 180° — exactly backwards — so directions are averaged
 * as unit vectors.
 */
export const circularWeightedMean = (
  samples: Sample[],
): { degrees: number; concentration: number } => {
  const total = totalWeight(samples);
  if (total === 0 || samples.length === 0) {
    return { degrees: Number.NaN, concentration: 0 };
  }
  let x = 0;
  let y = 0;
  for (const sample of samples) {
    x += sample.weight * Math.cos(sample.value * DEG);
    y += sample.weight * Math.sin(sample.value * DEG);
  }
  x /= total;
  y /= total;
  const degrees = ((Math.atan2(y, x) / DEG) % 360 + 360) % 360;
  // Resultant length: 1 = perfect agreement, 0 = directions cancel out.
  const concentration = Math.min(1, Math.hypot(x, y));
  return { degrees, concentration };
};

/**
 * Circular standard deviation in degrees, derived from the resultant length.
 * Yamartino's approximation; finite for any concentration above zero.
 */
export const circularStdDev = (concentration: number): number => {
  if (concentration <= 0) return 180;
  if (concentration >= 1) return 0;
  // Clamped: beyond 180 degrees of circular spread the directions are simply
  // uncorrelated, and a larger number carries no extra meaning.
  return Math.min(180, Math.sqrt(-2 * Math.log(concentration)) / DEG);
};

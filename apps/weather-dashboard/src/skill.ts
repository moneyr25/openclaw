import type { ModelFamily, SourceDescriptor } from "./types.ts";

/**
 * How much each model family's vote is worth, how that changes with lead time,
 * and how much its members repeat each other.
 *
 * These are informed priors, not measured skill. Three effects drive them:
 *
 *  1. Convection-permitting models (the Met Office UKV at 2 km) resolve
 *     showers, sea breezes, coastal effects and valley fog that global models
 *     smear into drizzle everywhere. That advantage is large in the first day
 *     and gone by day 4, when the model has run out of its own domain and is
 *     being driven by its global parent anyway.
 *  2. ECMWF's IFS has for years been the most skilful global model in the
 *     medium range, so it should win the argument at day 5 even where the UKV
 *     won at hour 6.
 *  3. A commercial forecaster is not an independent model — it is a
 *     post-processed blend of the models already in this set. Its marginal
 *     information is real but modest, and two of them are far more alike than
 *     two raw models are.
 *
 * `shortRange` applies at lead 0, `longRange` at lead 120 h and beyond, with a
 * linear ramp in between. Adjust here — nothing else in the app hard-codes a
 * source preference.
 */
export type SkillProfile = {
  shortRange: number;
  longRange: number;
  /**
   * How alike this family's members are, from 0 (fully independent) to 1
   * (identical). Drives the effective sample size in `computeWeights`, which is
   * what stops several feeds of one forecast from voting several times.
   */
  correlation: number;
};

export const FAMILY_SKILL: Record<ModelFamily, SkillProfile> = {
  // Met Office: UKV 2 km over the UK, then Global Spot. The DataHub feed and
  // the Open-Meteo feed are near enough the same model output.
  ukmo: { shortRange: 1.0, longRange: 0.78, correlation: 0.95 },
  // ECMWF IFS: the medium-range benchmark. MET Norway sits here too, but it
  // post-processes the run rather than echoing it, so it is not quite a copy.
  ecmwf: { shortRange: 0.86, longRange: 1.0, correlation: 0.88 },
  // DWD ICON: strong European performer, ICON-EU at ~7 km.
  icon: { shortRange: 0.78, longRange: 0.74, correlation: 0.9 },
  // Météo-France ARPEGE/AROME: good over the Channel and southern England.
  arpege: { shortRange: 0.7, longRange: 0.55, correlation: 0.9 },
  // NOAA GFS: useful independent signal, weaker over Europe.
  gfs: { shortRange: 0.6, longRange: 0.58, correlation: 0.9 },
  // Environment Canada GEM.
  gem: { shortRange: 0.52, longRange: 0.5, correlation: 0.9 },
  // AccuWeather and Apple. Genuine forecast systems with their own bias
  // correction, statistical post-processing and (for AccuWeather) human
  // forecaster intervention — so they carry real skill the raw models do not,
  // and they differ from each other more than two thin API wrappers would.
  proprietary: { shortRange: 0.72, longRange: 0.62, correlation: 0.6 },
  // Thinner commercial wrappers over the same public models.
  blend: { shortRange: 0.5, longRange: 0.45, correlation: 0.8 },
};

/** Lead time at which `longRange` fully takes over. */
const RAMP_HOURS = 120;

/** How much of a family's sampling gain to actually pay out. */
const SAMPLING_GAIN = 0.35;

/** Ceiling on that gain, so no family can run away with the vote. */
const MAX_FAMILY_BONUS = 1.25;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const familySkill = (
  family: ModelFamily,
  leadHours: number,
): number => {
  const profile = FAMILY_SKILL[family];
  const t = clamp(leadHours / RAMP_HOURS, 0, 1);
  return profile.shortRange + (profile.longRange - profile.shortRange) * t;
};

/**
 * Effective sample size for `count` members with mutual correlation `rho`.
 *
 * The standard result: n / (1 + rho(n - 1)). Two identical feeds (rho = 1)
 * count as one opinion; two unrelated ones (rho = 0) count as two. Everything
 * in between — which is where real forecast sources actually live — lands
 * proportionally.
 */
export const effectiveSampleSize = (count: number, rho: number): number => {
  if (count <= 1) return count;
  return count / (1 + clamp(rho, 0, 1) * (count - 1));
};

/**
 * Extra credit for resolving terrain and convection, decaying over the first
 * three days. A 2 km model and a 25 km model disagreeing about a shower over
 * Snowdonia at hour 3 is not a 50/50 argument.
 */
const resolutionBonus = (resolutionKm: number, leadHours: number): number => {
  const decay = clamp(1 - leadHours / 72, 0, 1);
  // 2 km -> +0.18, 10 km -> +0.06, 25 km -> 0.
  const sharpness = clamp((25 - resolutionKm) / 23, 0, 1);
  return 0.18 * sharpness * decay;
};

/**
 * Turn a set of contributing sources into per-source weights that do not
 * double-count.
 *
 * The subtle failure mode in any multi-source dashboard: MET Norway, the ECMWF
 * feed and half the commercial APIs are all reading the same ECMWF run.
 * Averaging them naively lets one model outvote several genuinely independent
 * ones, and — worse — makes their agreement look like confirmation when it is
 * really just the same forecast counted three times.
 *
 * So weight is allocated per *family* first, then split between that family's
 * members. A family with several members earns a bonus scaled by how
 * independent those members actually are, never a multiple.
 */
export const computeWeights = (
  sources: SourceDescriptor[],
  leadHours: number,
): Map<string, number> => {
  const byFamily = new Map<ModelFamily, SourceDescriptor[]>();
  for (const source of sources) {
    const members = byFamily.get(source.family);
    if (members) members.push(source);
    else byFamily.set(source.family, [source]);
  }

  const weights = new Map<string, number>();
  for (const [family, members] of byFamily) {
    const base = familySkill(family, leadHours);
    const independent = effectiveSampleSize(
      members.length,
      FAMILY_SKILL[family].correlation,
    );
    const bonus = clamp(
      1 + SAMPLING_GAIN * (independent - 1),
      1,
      MAX_FAMILY_BONUS,
    );
    const familyTotal = base * bonus;

    // Within a family, the sharper model takes the larger share.
    const shares = members.map(
      (member) => 1 + resolutionBonus(member.resolutionKm, leadHours),
    );
    const shareTotal = shares.reduce((sum, share) => sum + share, 0);

    for (const [index, member] of members.entries()) {
      const share = shares[index] ?? 1;
      weights.set(member.id, (familyTotal * share) / shareTotal);
    }
  }

  return weights;
};

/**
 * Number of independent families represented — the honest "how many opinions
 * do I actually have" count, used for confidence rather than the raw source
 * count.
 */
export const countFamilies = (sources: SourceDescriptor[]): number =>
  new Set(sources.map((source) => source.family)).size;

export const __testing = { resolutionBonus, RAMP_HOURS, SAMPLING_GAIN };

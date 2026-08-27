import type { ModelFamily, SourceDescriptor } from "./types.ts";

/**
 * How much each model family's vote is worth, and how that changes with lead
 * time.
 *
 * These are informed priors, not measured skill. Two effects drive them:
 *
 *  1. Convection-permitting models (the Met Office UKV at 2 km) resolve
 *     showers, sea breezes, coastal effects and valley fog that global models
 *     smear into drizzle everywhere. That advantage is large in the first day
 *     and gone by day 4, when the model has run out of its own domain and is
 *     being driven by its global parent anyway.
 *  2. ECMWF's IFS has for years been the most skilful global model in the
 *     medium range, so it should win the argument at day 5 even where the UKV
 *     won at hour 6.
 *
 * `shortRange` applies at lead 0, `longRange` at lead 120 h and beyond, with a
 * linear ramp in between. Adjust here — nothing else in the app hard-codes a
 * source preference.
 */
export type SkillProfile = {
  shortRange: number;
  longRange: number;
};

export const FAMILY_SKILL: Record<ModelFamily, SkillProfile> = {
  // Met Office: UKV 2 km over the UK, then Global Spot.
  ukmo: { shortRange: 1.0, longRange: 0.78 },
  // ECMWF IFS: the medium-range benchmark.
  ecmwf: { shortRange: 0.86, longRange: 1.0 },
  // DWD ICON: strong European performer, ICON-EU at ~7 km.
  icon: { shortRange: 0.78, longRange: 0.74 },
  // Météo-France ARPEGE/AROME: good over the Channel and southern England.
  arpege: { shortRange: 0.7, longRange: 0.55 },
  // NOAA GFS: useful independent signal, weaker over Europe.
  gfs: { shortRange: 0.6, longRange: 0.58 },
  // Environment Canada GEM.
  gem: { shortRange: 0.52, longRange: 0.5 },
  // Commercial blends. Already downstream of the models above, so they add
  // little independent information and are weighted accordingly.
  blend: { shortRange: 0.5, longRange: 0.45 },
};

/** Lead time at which `longRange` fully takes over. */
const RAMP_HOURS = 120;

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
 * The subtle failure mode in any multi-source dashboard: MET Norway, the
 * ECMWF feed and half the commercial APIs are all reading the same ECMWF run.
 * Averaging them naively lets one model outvote five genuinely independent
 * ones, and — worse — makes their agreement look like confirmation when it is
 * really just the same forecast counted three times.
 *
 * So weight is allocated per *family* first, then split between that family's
 * members. A family with several members earns a small bonus (up to 20%) for
 * sampling itself better, but never a multiple.
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
    const multiMemberBonus = Math.min(1.2, 1 + 0.1 * (members.length - 1));
    const familyTotal = base * multiMemberBonus;

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

export const __testing = { resolutionBonus, RAMP_HOURS };

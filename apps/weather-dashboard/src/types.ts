/**
 * Shared vocabulary for the whole app. Every upstream source is normalised into
 * these shapes before the fusion engine ever sees it, so adding a source never
 * touches the aggregation maths.
 */

export type Coordinates = {
  latitude: number;
  longitude: number;
};

export type ResolvedLocation = Coordinates & {
  /** Human label, e.g. "Shoreditch, Hackney, England". Best effort. */
  label?: string;
  /** Metres above sea level, when a source tells us. */
  elevation?: number;
  /** IANA zone the forecast should be displayed in. */
  timezone?: string;
  /** How the coordinates were obtained. Drives the UI precision hint. */
  origin: "gps" | "search" | "manual" | "default";
  /** GPS horizontal accuracy in metres, when the browser reports one. */
  accuracyMetres?: number;
};

/**
 * Closed condition taxonomy. Every provider has its own icon vocabulary; they
 * all collapse into this so the consensus vote compares like with like.
 * Ordered loosely by severity, which `conditionSeverity` relies on.
 */
export const CONDITIONS = [
  "clear",
  "partly-cloudy",
  "cloudy",
  "fog",
  "drizzle",
  "rain",
  "heavy-rain",
  "sleet",
  "snow",
  "hail",
  "thunder",
] as const;

export type Condition = (typeof CONDITIONS)[number];

/** Continuous variables the fusion engine knows how to combine. */
export const NUMERIC_VARIABLES = [
  "tempC",
  "apparentC",
  "precipMm",
  "precipProbPct",
  "windKph",
  "gustKph",
  "windDirDeg",
  "humidityPct",
  "cloudPct",
  "pressureHpa",
  "uvIndex",
  "visibilityKm",
] as const;

export type NumericVariable = (typeof NUMERIC_VARIABLES)[number];

/** A single hour of forecast from a single source. All fields optional: no
 * source provides every variable, and a missing variable must never be
 * confused with a zero. */
export type HourPoint = {
  /** Start of the hour, ISO-8601 in UTC (always `...Z`). */
  time: string;
} & Partial<Record<NumericVariable, number>> & {
    condition?: Condition;
  };

/**
 * Correlation family. Two sources in the same family are largely reading the
 * same underlying numerical model, so the fusion engine must not treat their
 * agreement as independent confirmation. See `src/skill.ts`.
 */
export type ModelFamily =
  | "ukmo"
  | "ecmwf"
  | "icon"
  | "gfs"
  | "arpege"
  | "gem"
  | "proprietary"
  | "blend";

export type SourceDescriptor = {
  id: string;
  label: string;
  /** Short attribution shown in the UI footer. */
  attribution: string;
  family: ModelFamily;
  /** Native horizontal grid spacing in km over the UK; smaller resolves
   * showers, sea breezes and valley fog that global models smear out. */
  resolutionKm: number;
  /** Env var that must be set for this source to be usable, if any. */
  requiresEnv?: string;
  /** Furthest lead time this source is useful for, in hours. */
  maxLeadHours: number;
};

export type SourceForecast = {
  source: SourceDescriptor;
  hours: HourPoint[];
  fetchedAt: string;
  /** Wall-clock milliseconds the upstream call took. Surfaced for debugging. */
  latencyMs: number;
  /** Populated by the source when it can tell us which model run this is. */
  modelRun?: string;
};

export type SourceFailure = {
  sourceId: string;
  label: string;
  reason: string;
  /** True when the source is simply unconfigured rather than broken. */
  skipped: boolean;
};

/** One fused variable at one hour. */
export type FusedValue = {
  value: number;
  /** Number of independent model families that contributed. */
  contributors: number;
  /** Weighted spread across contributors, in the variable's own units. */
  spread: number;
  /** Low/high of the plausible range (weighted 10th/90th-ish percentile). */
  low: number;
  high: number;
  /** 0-100. High means the sources agree tightly relative to what matters
   * for this variable. */
  confidence: number;
};

export type FusedHour = {
  time: string;
  leadHours: number;
  values: Partial<Record<NumericVariable, FusedValue>>;
  condition?: {
    value: Condition;
    confidence: number;
    votes: Array<{ condition: Condition; weight: number }>;
  };
};

export type FusedDay = {
  date: string;
  minTempC?: FusedValue;
  maxTempC?: FusedValue;
  totalPrecipMm?: FusedValue;
  maxPrecipProbPct?: FusedValue;
  maxWindKph?: FusedValue;
  maxGustKph?: FusedValue;
  maxUvIndex?: FusedValue;
  condition?: Condition;
  /** Mean of the hourly confidences for the day; a quick "how much should I
   * trust this day" number. */
  confidence: number;
  sunrise?: string;
  sunset?: string;
};

export type Warning = {
  id: string;
  title: string;
  level?: "yellow" | "amber" | "red" | "unknown";
  summary?: string;
  link?: string;
  published?: string;
  source: string;
};

export type AggregateResult = {
  location: ResolvedLocation;
  generatedAt: string;
  hours: FusedHour[];
  days: FusedDay[];
  sources: Array<{
    descriptor: SourceDescriptor;
    fetchedAt: string;
    latencyMs: number;
    hourCount: number;
    modelRun?: string;
  }>;
  failures: SourceFailure[];
  warnings: Warning[];
  /** Per-source hourly series, so the UI can show who disagrees and by how
   * much. Keyed by source id. */
  bySource: Record<string, HourPoint[]>;
};

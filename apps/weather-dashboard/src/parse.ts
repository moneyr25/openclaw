/**
 * Defensive readers for upstream JSON.
 *
 * Weather APIs add, rename and drop fields between model upgrades, and several
 * of them return `null` for "this model does not produce that variable". A
 * missing variable must degrade one field, never fail a whole source, so
 * everything here returns `undefined` rather than throwing.
 */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

export const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

export const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

/** Read `record[key]` as a number. */
export const numberAt = (
  record: unknown,
  key: string,
): number | undefined => (isRecord(record) ? asNumber(record[key]) : undefined);

export const stringAt = (
  record: unknown,
  key: string,
): string | undefined => (isRecord(record) ? asString(record[key]) : undefined);

/** Walk a dotted path, e.g. `path(json, "data.instant.details")`. */
export const path = (value: unknown, dotted: string): unknown => {
  let current = value;
  for (const key of dotted.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
};

/**
 * Pick a series out of an Open-Meteo `hourly` block.
 *
 * Open-Meteo suffixes variable names with the model id when more than one model
 * is requested (`temperature_2m_ukmo_seamless`). We request one model per call,
 * but tolerating both shapes means a change on their side degrades nothing.
 */
export const pickSeries = (
  block: unknown,
  variable: string,
): Array<number | null> | undefined => {
  if (!isRecord(block)) return undefined;
  const exact = block[variable];
  if (Array.isArray(exact)) return exact as Array<number | null>;
  const prefixed = Object.keys(block).find((key) =>
    key.startsWith(`${variable}_`),
  );
  if (!prefixed) return undefined;
  const series = block[prefixed];
  return Array.isArray(series) ? (series as Array<number | null>) : undefined;
};

/** Normalise any parseable timestamp to an exact UTC hour, ISO-8601. */
export const toUtcHour = (input: string | number): string | undefined => {
  const date =
    typeof input === "number"
      ? new Date(input * (input > 1e11 ? 1 : 1000))
      : new Date(/(Z|[+-]\d{2}:?\d{2})$/u.test(input) ? input : `${input}Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
};

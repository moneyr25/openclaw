import { buildUrl, fetchJson } from "./http.ts";
import { asArray, isRecord, numberAt, stringAt } from "./parse.ts";
import { round } from "./units.ts";
import type { Coordinates } from "./types.ts";

/**
 * Place lookup. Both providers are keyless.
 *
 * Reverse geocoding exists only to put a human name on coordinates the browser
 * already gave us — it never influences the forecast, so a failure here
 * degrades to showing the coordinates and nothing more.
 */

const SEARCH_ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";
const REVERSE_ENDPOINT =
  "https://api.bigdatacloud.net/data/reverse-geocode-client";

export type Place = {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
  admin2?: string;
  timezone?: string;
  elevation?: number;
  /** Postcode-style results carry no admin hierarchy worth showing. */
  label: string;
};

const buildLabel = (parts: Array<string | undefined>): string =>
  parts.filter((part): part is string => Boolean(part)).join(", ");

export const searchPlaces = async (
  query: string,
  options: { userAgent: string; countryCode?: string; signal?: AbortSignal },
): Promise<Place[]> => {
  const json = await fetchJson<unknown>(
    buildUrl(SEARCH_ENDPOINT, {
      name: query,
      count: 8,
      language: "en",
      format: "json",
      countryCode: options.countryCode,
    }),
    {
      headers: { "user-agent": options.userAgent },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );

  const results = asArray(isRecord(json) ? json["results"] : undefined);
  const places: Place[] = [];
  for (const entry of results) {
    if (!isRecord(entry)) continue;
    const name = stringAt(entry, "name");
    const latitude = numberAt(entry, "latitude");
    const longitude = numberAt(entry, "longitude");
    if (!name || latitude === undefined || longitude === undefined) continue;

    const admin1 = stringAt(entry, "admin1");
    const admin2 = stringAt(entry, "admin2");
    const country = stringAt(entry, "country");
    const timezone = stringAt(entry, "timezone");
    const elevation = numberAt(entry, "elevation");

    places.push({
      name,
      latitude,
      longitude,
      label: buildLabel([name, admin2, admin1, country]),
      ...(country ? { country } : {}),
      ...(admin1 ? { admin1 } : {}),
      ...(admin2 ? { admin2 } : {}),
      ...(timezone ? { timezone } : {}),
      ...(elevation !== undefined ? { elevation } : {}),
    });
  }
  return places;
};

/** Best-effort name for a coordinate pair. Never throws. */
export const reverseGeocode = async (
  coords: Coordinates,
  options: { userAgent: string; signal?: AbortSignal },
): Promise<string | undefined> => {
  try {
    const json = await fetchJson<unknown>(
      buildUrl(REVERSE_ENDPOINT, {
        latitude: round(coords.latitude, 4),
        longitude: round(coords.longitude, 4),
        localityLanguage: "en",
      }),
      {
        headers: { "user-agent": options.userAgent },
        timeoutMs: 6000,
        retry: false,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (!isRecord(json)) return undefined;

    const locality = stringAt(json, "locality");
    const city = stringAt(json, "city");
    const subdivision = stringAt(json, "principalSubdivision");
    const country = stringAt(json, "countryName");

    // "Shoreditch, Hackney, England" reads better than any single field, but
    // drop repeats — locality and city are often identical.
    const parts = [locality, city === locality ? undefined : city, subdivision];
    const label = buildLabel(
      country === "United Kingdom" ? parts : [...parts, country],
    );
    return label === "" ? undefined : label;
  } catch {
    return undefined;
  }
};

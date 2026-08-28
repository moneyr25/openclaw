import { createOpenMeteoSource } from "./open-meteo.ts";
import { createMetOfficeSource, MET_OFFICE_DESCRIPTOR } from "./met-office.ts";
import { createMetNorwaySource } from "./met-norway.ts";
import {
  createOpenWeatherMapSource,
  OPENWEATHERMAP_DESCRIPTOR,
} from "./openweathermap.ts";
import { createWeatherApiSource, WEATHERAPI_DESCRIPTOR } from "./weatherapi.ts";
import { createAccuWeatherSource, ACCUWEATHER_DESCRIPTOR } from "./accuweather.ts";
import {
  createAppleWeatherKitSource,
  APPLE_WEATHERKIT_DESCRIPTOR,
} from "./apple-weatherkit.ts";
import type { AppConfig } from "../config-core.ts";
import type {
  Coordinates,
  SourceDescriptor,
  SourceFailure,
  SourceForecast,
} from "../types.ts";

export type WeatherSource = {
  descriptor: SourceDescriptor;
  fetch: (coords: Coordinates, signal?: AbortSignal) => Promise<SourceForecast>;
};

/**
 * The keyless backbone: six independent numerical weather models, one request
 * each, via Open-Meteo.
 *
 * `*_seamless` variants stitch each centre's high-resolution short-range model
 * to its global model as lead time grows, which is exactly the behaviour we
 * want per source — the fusion engine then handles the cross-centre blend.
 */
const OPEN_METEO_MODELS: Array<{
  descriptor: SourceDescriptor;
  modelId: string;
}> = [
  {
    modelId: "ukmo_seamless",
    descriptor: {
      id: "om-ukmo",
      label: "Met Office UKV / Global (via Open-Meteo)",
      attribution: "Met Office via Open-Meteo",
      family: "ukmo",
      // UKV is convection-permitting at 2 km over the UK: the only model in
      // this set that resolves individual showers rather than smearing them.
      resolutionKm: 2,
      maxLeadHours: 168,
    },
  },
  {
    modelId: "ecmwf_ifs025",
    descriptor: {
      id: "om-ecmwf",
      label: "ECMWF IFS 0.25°",
      attribution: "ECMWF via Open-Meteo",
      family: "ecmwf",
      resolutionKm: 25,
      maxLeadHours: 168,
    },
  },
  {
    modelId: "icon_seamless",
    descriptor: {
      id: "om-icon",
      label: "DWD ICON",
      attribution: "Deutscher Wetterdienst via Open-Meteo",
      family: "icon",
      resolutionKm: 7,
      maxLeadHours: 168,
    },
  },
  {
    modelId: "gfs_seamless",
    descriptor: {
      id: "om-gfs",
      label: "NOAA GFS",
      attribution: "NOAA via Open-Meteo",
      family: "gfs",
      resolutionKm: 13,
      maxLeadHours: 168,
    },
  },
  {
    modelId: "meteofrance_seamless",
    descriptor: {
      id: "om-arpege",
      label: "Météo-France ARPEGE / AROME",
      attribution: "Météo-France via Open-Meteo",
      family: "arpege",
      resolutionKm: 10,
      // ARPEGE runs to ~4 days; beyond that this source simply stops
      // contributing and the others carry the forecast.
      maxLeadHours: 96,
    },
  },
  {
    modelId: "gem_seamless",
    descriptor: {
      id: "om-gem",
      label: "Environment Canada GEM",
      attribution: "Environment Canada via Open-Meteo",
      family: "gem",
      resolutionKm: 15,
      maxLeadHours: 168,
    },
  },
];

/** Sources that need a key, listed so the UI can explain what is missing. */
export const OPTIONAL_DESCRIPTORS: SourceDescriptor[] = [
  MET_OFFICE_DESCRIPTOR,
  ACCUWEATHER_DESCRIPTOR,
  APPLE_WEATHERKIT_DESCRIPTOR,
  OPENWEATHERMAP_DESCRIPTOR,
  WEATHERAPI_DESCRIPTOR,
];

export const buildSources = (config: AppConfig): WeatherSource[] => {
  const sources: WeatherSource[] = OPEN_METEO_MODELS.map((model) =>
    createOpenMeteoSource(model.descriptor, model.modelId),
  );

  sources.push(createMetNorwaySource({ userAgent: config.userAgent }));

  if (config.metOfficeApiKey) {
    sources.push(
      createMetOfficeSource({
        apiKey: config.metOfficeApiKey,
        baseUrl: config.metOfficeBaseUrl,
        userAgent: config.userAgent,
      }),
    );
  }
  if (config.openWeatherMapApiKey) {
    sources.push(createOpenWeatherMapSource({ apiKey: config.openWeatherMapApiKey }));
  }
  if (config.weatherApiKey) {
    sources.push(createWeatherApiSource({ apiKey: config.weatherApiKey }));
  }
  if (config.accuWeatherApiKey) {
    sources.push(
      createAccuWeatherSource({
        apiKey: config.accuWeatherApiKey,
        hourlyRange: config.accuWeatherHourlyRange,
        userAgent: config.userAgent,
      }),
    );
  }
  if (config.appleWeatherKit) {
    sources.push(
      createAppleWeatherKitSource({
        ...config.appleWeatherKit,
        userAgent: config.userAgent,
      }),
    );
  }

  return sources;
};

/**
 * Descriptors for keyed sources the operator has not configured.
 *
 * `activeIds` is what is genuinely running, so a source can never be reported
 * as both live and unconfigured.
 */
export const skippedSources = (
  config: AppConfig,
  activeIds: Iterable<string> = [],
): SourceFailure[] => {
  const configured = new Set<string>(activeIds);
  if (config.metOfficeApiKey) configured.add(MET_OFFICE_DESCRIPTOR.id);
  if (config.openWeatherMapApiKey) configured.add(OPENWEATHERMAP_DESCRIPTOR.id);
  if (config.weatherApiKey) configured.add(WEATHERAPI_DESCRIPTOR.id);
  if (config.accuWeatherApiKey) configured.add(ACCUWEATHER_DESCRIPTOR.id);
  if (config.appleWeatherKit) configured.add(APPLE_WEATHERKIT_DESCRIPTOR.id);

  return OPTIONAL_DESCRIPTORS.filter(
    (descriptor) => !configured.has(descriptor.id),
  ).map((descriptor) => ({
    sourceId: descriptor.id,
    label: descriptor.label,
    reason: `not configured (set ${descriptor.requiresEnv})`,
    skipped: true,
  }));
};

/**
 * Fetch every source in parallel. One slow or broken upstream must never hold
 * the dashboard hostage, so failures are collected and returned alongside the
 * successes rather than thrown.
 */
export const fetchAllSources = async (
  sources: WeatherSource[],
  coords: Coordinates,
  options: { timeoutMs?: number } = {},
): Promise<{ forecasts: SourceForecast[]; failures: SourceFailure[] }> => {
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error("source fetch deadline exceeded")),
    options.timeoutMs ?? 20_000,
  );

  try {
    const settled = await Promise.allSettled(
      sources.map((source) => source.fetch(coords, controller.signal)),
    );

    const forecasts: SourceForecast[] = [];
    const failures: SourceFailure[] = [];

    for (const [index, result] of settled.entries()) {
      const source = sources[index];
      if (!source) continue;
      if (result.status === "fulfilled") {
        forecasts.push(result.value);
      } else {
        const reason =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        failures.push({
          sourceId: source.descriptor.id,
          label: source.descriptor.label,
          reason,
          skipped: false,
        });
      }
    }

    return { forecasts, failures };
  } finally {
    clearTimeout(deadline);
  }
};

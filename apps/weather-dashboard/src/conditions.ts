import type { Condition } from "./types.ts";

/**
 * Provider icon vocabularies -> our closed taxonomy.
 *
 * Every mapping here is a lossy judgement call, so they all live in one file
 * where they can be reviewed together rather than scattered through adapters.
 */

/** WMO 4677 present-weather codes, as used by Open-Meteo. */
export const wmoCodeToCondition = (code: number): Condition => {
  if (code === 0) return "clear";
  if (code === 1 || code === 2) return "partly-cloudy";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code === 61 || code === 63 || code === 80 || code === 81) return "rain";
  if (code === 65 || code === 82) return "heavy-rain";
  if (code === 66 || code === 67) return "sleet";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code === 96 || code === 99) return "hail";
  if (code >= 95) return "thunder";
  return "cloudy";
};

/**
 * Met Office DataHub `significantWeatherCode` (0-30, plus -1 for "trace rain").
 * Night/day pairs collapse to the same condition because we render our own
 * day/night icons from the sun position.
 */
export const metOfficeCodeToCondition = (code: number): Condition => {
  switch (code) {
    case -1:
      return "drizzle";
    case 0:
    case 1:
      return "clear";
    case 2:
    case 3:
      return "partly-cloudy";
    case 5:
    case 6:
      return "fog";
    case 7:
    case 8:
      return "cloudy";
    case 11:
      return "drizzle";
    case 9:
    case 10:
    case 12:
      return "rain";
    case 13:
    case 14:
    case 15:
      return "heavy-rain";
    case 16:
    case 17:
    case 18:
      return "sleet";
    case 19:
    case 20:
    case 21:
      return "hail";
    case 22:
    case 23:
    case 24:
    case 25:
    case 26:
    case 27:
      return "snow";
    case 28:
    case 29:
    case 30:
      return "thunder";
    default:
      return "cloudy";
  }
};

/**
 * MET Norway / Yr `symbol_code`, e.g. "partlycloudy_day", "heavyrainandthunder".
 * The `_day` / `_night` / `_polartwilight` suffix carries no weather meaning.
 */
export const metNorwaySymbolToCondition = (symbol: string): Condition => {
  const base = symbol.replace(/_(day|night|polartwilight)$/u, "");
  if (base.includes("thunder")) return "thunder";
  if (base.includes("snow")) return "snow";
  if (base.includes("sleet")) return "sleet";
  if (base.startsWith("heavyrain")) return "heavy-rain";
  if (base.includes("rain")) return "rain";
  if (base === "fog") return "fog";
  if (base === "cloudy") return "cloudy";
  if (base === "partlycloudy") return "partly-cloudy";
  if (base === "fair") return "partly-cloudy";
  if (base === "clearsky") return "clear";
  return "cloudy";
};

/** OpenWeatherMap numeric condition ids (2xx thunder, 3xx drizzle, ...). */
export const openWeatherIdToCondition = (id: number): Condition => {
  if (id >= 200 && id < 300) return "thunder";
  if (id >= 300 && id < 400) return "drizzle";
  if (id === 502 || id === 503 || id === 504 || id === 522) return "heavy-rain";
  if (id === 511) return "sleet";
  if (id >= 500 && id < 600) return "rain";
  if (id === 611 || id === 612 || id === 613 || id === 615 || id === 616) {
    return "sleet";
  }
  if (id >= 600 && id < 700) return "snow";
  if (id === 701 || id === 741) return "fog";
  if (id >= 700 && id < 800) return "fog";
  if (id === 800) return "clear";
  if (id === 801 || id === 802) return "partly-cloudy";
  if (id === 803 || id === 804) return "cloudy";
  return "cloudy";
};

/** WeatherAPI.com condition codes. */
export const weatherApiCodeToCondition = (code: number): Condition => {
  switch (code) {
    case 1000:
      return "clear";
    case 1003:
      return "partly-cloudy";
    case 1006:
    case 1009:
      return "cloudy";
    case 1030:
    case 1135:
    case 1147:
      return "fog";
    case 1063:
    case 1150:
    case 1153:
    case 1180:
    case 1183:
    case 1240:
      return "drizzle";
    case 1186:
    case 1189:
    case 1243:
      return "rain";
    case 1192:
    case 1195:
    case 1246:
      return "heavy-rain";
    case 1069:
    case 1204:
    case 1207:
    case 1249:
    case 1252:
      return "sleet";
    case 1237:
    case 1261:
    case 1264:
      return "hail";
    case 1087:
    case 1273:
    case 1276:
    case 1279:
    case 1282:
      return "thunder";
    default:
      if (code >= 1210 && code <= 1237) return "snow";
      if (code >= 1255 && code <= 1264) return "snow";
      return "cloudy";
  }
};

/**
 * AccuWeather numeric weather icons (1-44).
 *
 * Day and night variants collapse together — we render our own day/night icons
 * from the sun position. AccuWeather has no distinct "heavy rain" icon, so the
 * adapter upgrades `rain` using the forecast rainfall rate instead.
 */
export const accuWeatherIconToCondition = (icon: number): Condition => {
  switch (icon) {
    case 1:
    case 2:
    case 30:
    case 31:
    case 33:
    case 34:
      return "clear";
    case 3:
    case 4:
    case 5:
    case 32:
    case 35:
    case 36:
    case 37:
      return "partly-cloudy";
    case 6:
    case 7:
    case 8:
    case 38:
      return "cloudy";
    case 11:
      return "fog";
    case 12:
    case 13:
    case 14:
    case 18:
    case 39:
    case 40:
      return "rain";
    case 15:
    case 16:
    case 17:
    case 41:
    case 42:
      return "thunder";
    case 19:
    case 20:
    case 21:
    case 22:
    case 23:
    case 43:
    case 44:
      return "snow";
    case 24:
      return "hail";
    case 25:
    case 26:
    case 29:
      return "sleet";
    default:
      return "cloudy";
  }
};

/**
 * Apple WeatherKit `conditionCode` strings.
 *
 * WeatherKit's vocabulary separates intensity ("Rain" vs "HeavyRain") and
 * coverage ("ScatteredShowers"), both of which flatten into our taxonomy.
 */
export const appleConditionToCondition = (code: string): Condition => {
  switch (code) {
    case "Clear":
    case "MostlyClear":
    case "Hot":
    case "Frigid":
      return "clear";
    case "PartlyCloudy":
    case "MostlyCloudy":
    case "Breezy":
    case "Windy":
      return "partly-cloudy";
    case "Cloudy":
      return "cloudy";
    case "Fog":
    case "Haze":
    case "Smoke":
    case "Dust":
      return "fog";
    case "Drizzle":
    case "FreezingDrizzle":
      return "drizzle";
    case "Rain":
    case "Showers":
    case "ScatteredShowers":
    case "MixedRainfall":
      return "rain";
    case "HeavyRain":
    case "TropicalStorm":
    case "Hurricane":
      return "heavy-rain";
    case "Sleet":
    case "MixedRainAndSleet":
    case "MixedRainAndSnow":
    case "MixedSnowAndSleet":
    case "FreezingRain":
      return "sleet";
    case "Flurries":
    case "Snow":
    case "SnowShowers":
    case "ScatteredSnowShowers":
    case "HeavySnow":
    case "Blizzard":
    case "BlowingSnow":
      return "snow";
    case "Hail":
      return "hail";
    case "Thunderstorms":
    case "SevereThunderstorm":
    case "IsolatedThunderstorms":
    case "ScatteredThunderstorms":
    case "StrongStorms":
      return "thunder";
    default:
      // WeatherKit adds condition codes over time; an unknown one should read
      // as "unremarkable", not as a made-up severe outcome.
      return "cloudy";
  }
};

/**
 * Severity ranking. Two jobs, which is why the exact order matters:
 *
 *  - Breaking consensus ties towards the more consequential outcome. A 50/50
 *    split between "cloudy" and "thunder" should not render as a cloud: being
 *    warned about a storm that does not arrive costs less than being surprised
 *    by one that does.
 *  - Measuring how far apart two forecasts really are. Neighbouring entries
 *    must be genuine neighbours, so intensities within one precipitation type
 *    stay contiguous (drizzle, rain, heavy rain) and `fog` sits with the dry
 *    conditions it belongs to rather than between them.
 */
const SEVERITY: Record<Condition, number> = {
  clear: 0,
  "partly-cloudy": 1,
  cloudy: 2,
  fog: 3,
  drizzle: 4,
  rain: 5,
  "heavy-rain": 6,
  sleet: 7,
  snow: 8,
  hail: 9,
  thunder: 10,
};

export const conditionSeverity = (condition: Condition): number =>
  SEVERITY[condition];

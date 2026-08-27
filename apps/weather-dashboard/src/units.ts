/** Unit conversions. Everything inside the app is metric + Celsius + km/h;
 * conversion to the user's display units happens in the browser only. */

export const fahrenheitToCelsius = (f: number): number => ((f - 32) * 5) / 9;
export const celsiusToFahrenheit = (c: number): number => (c * 9) / 5 + 32;

export const msToKph = (ms: number): number => ms * 3.6;
export const mphToKph = (mph: number): number => mph * 1.609344;
export const knotsToKph = (kn: number): number => kn * 1.852;
export const kphToMph = (kph: number): number => kph / 1.609344;

export const inchesToMm = (inches: number): number => inches * 25.4;
export const metresToKm = (m: number): number => m / 1000;
export const paToHpa = (pa: number): number => pa / 100;

/** Round to a sane number of decimals so JSON payloads stay small and the UI
 * never shows 12.300000000000001. */
export const round = (value: number, decimals = 1): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/**
 * Apparent temperature ("feels like") using the Australian BoM formula, which
 * blends humidity and wind and behaves sensibly across the whole UK range —
 * unlike wind chill (cold only) or heat index (hot only).
 * @param tempC dry bulb temperature
 * @param humidityPct relative humidity 0-100
 * @param windKph 10m wind speed
 */
export const apparentTemperature = (
  tempC: number,
  humidityPct: number,
  windKph: number,
): number => {
  const windMs = windKph / 3.6;
  // Water vapour pressure in hPa.
  const vapourPressure =
    (humidityPct / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC));
  return tempC + 0.33 * vapourPressure - 0.7 * windMs - 4.0;
};

/** Compass point for a bearing in degrees. */
const COMPASS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
] as const;

export const bearingToCompass = (degrees: number): string => {
  const index = Math.round(((degrees % 360) + 360) % 360 / 22.5) % 16;
  return COMPASS[index] ?? "N";
};

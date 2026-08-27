/**
 * Sunrise / sunset from the NOAA solar position equations.
 *
 * Computed locally rather than taken from a provider: it is deterministic, it
 * costs no API budget, and it stays available when every upstream is down.
 * Accurate to well under a minute at UK latitudes.
 */

const DEG = Math.PI / 180;

/** Standard refraction-corrected solar zenith for sunrise/sunset. */
const ZENITH_DEG = 90.833;

const dayOfYear = (date: Date): number => {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  return Math.floor((date.getTime() - start) / 86_400_000);
};

type SolarTimes = {
  sunrise?: string;
  sunset?: string;
  /** True when the sun never sets on this date at this latitude. */
  polarDay: boolean;
  /** True when the sun never rises. */
  polarNight: boolean;
};

export const solarTimes = (
  latitude: number,
  longitude: number,
  date: Date,
): SolarTimes => {
  const gamma =
    ((2 * Math.PI) / 365) * (dayOfYear(date) - 1 + (12 - 12) / 24);

  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));

  const declination =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  const latRad = latitude * DEG;
  const cosHourAngle =
    Math.cos(ZENITH_DEG * DEG) / (Math.cos(latRad) * Math.cos(declination)) -
    Math.tan(latRad) * Math.tan(declination);

  // Outside [-1, 1] the sun never crosses the horizon on this date.
  if (cosHourAngle > 1) return { polarDay: false, polarNight: true };
  if (cosHourAngle < -1) return { polarDay: true, polarNight: false };

  const hourAngleDeg = Math.acos(cosHourAngle) / DEG;
  const midnight = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );

  const toIso = (minutesUtc: number): string =>
    new Date(midnight + minutesUtc * 60_000).toISOString();

  return {
    sunrise: toIso(720 - 4 * (longitude + hourAngleDeg) - eqTime),
    sunset: toIso(720 - 4 * (longitude - hourAngleDeg) - eqTime),
    polarDay: false,
    polarNight: false,
  };
};

/** Is the sun above the horizon at `instant`? Drives day/night icon choice. */
export const isDaylight = (
  latitude: number,
  longitude: number,
  instant: Date,
): boolean => {
  const times = solarTimes(latitude, longitude, instant);
  if (times.polarDay) return true;
  if (times.polarNight) return false;
  if (!times.sunrise || !times.sunset) return true;
  const t = instant.getTime();
  return t >= Date.parse(times.sunrise) && t <= Date.parse(times.sunset);
};

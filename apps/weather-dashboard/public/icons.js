/**
 * Inline SVG weather icons.
 *
 * These are the only strings in the app that are ever assigned with innerHTML;
 * everything derived from an API response goes through textContent, because
 * warning text and place names come from feeds we do not control.
 */

const svg = (body) =>
  `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.6"
     stroke-linecap="round" stroke-linejoin="round" role="img">${body}</svg>`;

const SUN = `<circle cx="16" cy="16" r="6" stroke="#e8a33d" fill="#f6c56a" />
  <g stroke="#e8a33d">
    <path d="M16 3v3M16 26v3M3 16h3M26 16h3M6.8 6.8l2.1 2.1M23.1 23.1l2.1 2.1M25.2 6.8l-2.1 2.1M8.9 23.1l-2.1 2.1" />
  </g>`;

const MOON = `<path d="M22 19.5A9 9 0 0 1 12.5 10a9 9 0 1 0 9.5 9.5Z"
  stroke="#b9c4dd" fill="#d7dfef" />`;

const CLOUD = `<path d="M9.5 24h13a5 5 0 0 0 .6-9.96A7.5 7.5 0 0 0 8.8 15.2 4.4 4.4 0 0 0 9.5 24Z"
  stroke="#8e9bb5" fill="#c8d2e4" />`;

const SMALL_CLOUD = `<path d="M12 25h11a4.4 4.4 0 0 0 .5-8.77A6.6 6.6 0 0 0 11.4 17 3.9 3.9 0 0 0 12 25Z"
  stroke="#8e9bb5" fill="#c8d2e4" />`;

const drops = (count, colour = "#4a90d9") =>
  Array.from({ length: count }, (_, index) => {
    const x = 12 + index * 4;
    return `<path d="M${x} 26.5l-1.2 2.6" stroke="${colour}" stroke-width="2" />`;
  }).join("");

const flakes = (count) =>
  Array.from({ length: count }, (_, index) => {
    const x = 12 + index * 4;
    return `<path d="M${x} 27.5v2.4M${x - 1} 28.1l2 1.2M${x + 1} 28.1l-2 1.2"
      stroke="#9ec9ec" stroke-width="1.3" />`;
  }).join("");

const ICONS = {
  clear: { day: svg(SUN), night: svg(MOON) },
  "partly-cloudy": {
    day: svg(
      `<g transform="translate(-2 -3) scale(0.78)">${SUN}</g>${SMALL_CLOUD}`,
    ),
    night: svg(
      `<g transform="translate(1 -2) scale(0.8)">${MOON}</g>${SMALL_CLOUD}`,
    ),
  },
  cloudy: { day: svg(CLOUD), night: svg(CLOUD) },
  fog: {
    day: svg(
      `${CLOUD}<g stroke="#9aa6bd"><path d="M8 27h16M10 30h12" /></g>`,
    ),
    night: null,
  },
  drizzle: { day: svg(`${CLOUD}${drops(2, "#7bb0e0")}`), night: null },
  rain: { day: svg(`${CLOUD}${drops(3)}`), night: null },
  "heavy-rain": {
    day: svg(`${CLOUD}${drops(4, "#2f6fb5")}`),
    night: null,
  },
  sleet: { day: svg(`${CLOUD}${drops(2)}${flakes(1)}`), night: null },
  snow: { day: svg(`${CLOUD}${flakes(3)}`), night: null },
  hail: {
    day: svg(
      `${CLOUD}<g fill="#c3d6ea" stroke="#7d93b3"><circle cx="13" cy="28" r="1.6" />
       <circle cx="18" cy="28.6" r="1.6" /><circle cx="23" cy="28" r="1.6" /></g>`,
    ),
    night: null,
  },
  thunder: {
    day: svg(
      `${CLOUD}<path d="M17 25l-4 5h3.5l-1.5 4 5.5-6H17l1.6-3Z"
        fill="#f2c23e" stroke="#d19d1c" />`,
    ),
    night: null,
  },
};

const LABELS = {
  clear: "Clear",
  "partly-cloudy": "Partly cloudy",
  cloudy: "Cloudy",
  fog: "Fog",
  drizzle: "Drizzle",
  rain: "Rain",
  "heavy-rain": "Heavy rain",
  sleet: "Sleet",
  snow: "Snow",
  hail: "Hail",
  thunder: "Thunderstorms",
};

export const conditionIcon = (condition, isDay = true) => {
  const entry = ICONS[condition] ?? ICONS.cloudy;
  return (isDay ? entry.day : (entry.night ?? entry.day)) ?? ICONS.cloudy.day;
};

export const conditionLabel = (condition) => LABELS[condition] ?? "Cloudy";

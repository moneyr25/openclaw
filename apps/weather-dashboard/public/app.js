import { conditionIcon, conditionLabel } from "/icons.js";

/**
 * Dashboard UI.
 *
 * Everything derived from an API response is written with textContent; the only
 * innerHTML assignments are the icon SVGs from icons.js. Warning text arrives
 * from a scraped RSS feed, so it is never treated as markup.
 */

const REFRESH_MS = 10 * 60 * 1000;
const STORAGE_KEY = "weather-dashboard:v1";

const el = (id) => document.getElementById(id);

const state = {
  location: null,
  data: null,
  units: "metric",
  selectedHourIndex: 0,
};

/* ---------- persistence ---------- */

const loadStored = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

const store = (patch) => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...loadStored(), ...patch }),
    );
  } catch {
    /* Private browsing and blocked site data both land here; not fatal. */
  }
};

/* ---------- units ---------- */

const temp = (celsius) =>
  state.units === "imperial" ? (celsius * 9) / 5 + 32 : celsius;

const tempUnit = () => (state.units === "imperial" ? "°F" : "°C");

const speed = (kph) => (state.units === "imperial" ? kph / 1.609344 : kph);

const speedUnit = () => (state.units === "imperial" ? "mph" : "km/h");

const fmt = (value, digits = 0) =>
  value === undefined || value === null || Number.isNaN(value)
    ? "–"
    : value.toFixed(digits);

const compass = (degrees) => {
  const points = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return points[Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16];
};

/* ---------- time ---------- */

const zone = () => state.data?.location?.timezone ?? undefined;

const timeFormat = (options) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: zone(), ...options });

const hourLabel = (iso) =>
  timeFormat({ hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date(iso),
  );

const dayLabel = (iso, index) => {
  if (index === 0) return "Today";
  if (index === 1) return "Tomorrow";
  return timeFormat({ weekday: "short" }).format(new Date(`${iso}T12:00:00Z`));
};

/** Daylight at an hour, from the day's own sunrise/sunset. */
const isDaytime = (iso) => {
  const day = state.data?.days?.find((entry) =>
    iso.startsWith(entry.date) ||
    (entry.sunrise && new Date(iso).toDateString() === new Date(entry.sunrise).toDateString()),
  );
  if (!day?.sunrise || !day?.sunset) {
    const hour = new Date(iso).getUTCHours();
    return hour >= 7 && hour < 19;
  }
  const t = Date.parse(iso);
  return t >= Date.parse(day.sunrise) && t <= Date.parse(day.sunset);
};

/* ---------- rendering ---------- */

const setBanner = (message, variant) => {
  const node = el("banner");
  if (!message) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  node.hidden = false;
  node.textContent = message;
  node.className = variant === "error" ? "banner banner--error" : "banner";
};

const renderWarnings = (warnings) => {
  const container = el("warnings");
  container.textContent = "";
  if (!warnings || warnings.length === 0) {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  for (const warning of warnings.slice(0, 5)) {
    const box = document.createElement("div");
    box.className = `warning warning--${warning.level ?? "unknown"}`;

    const title = document.createElement("strong");
    title.textContent = warning.title;
    box.append(title);

    if (warning.summary) {
      const summary = document.createElement("span");
      summary.className = "small";
      summary.textContent = warning.summary.slice(0, 400);
      box.append(summary);
    }
    if (warning.link) {
      const link = document.createElement("a");
      link.href = warning.link;
      link.rel = "noopener noreferrer";
      link.target = "_blank";
      link.className = "small";
      link.textContent = " Details";
      box.append(link);
    }
    container.append(box);
  }
};

const statRow = (label, value) => {
  const wrapper = document.createElement("div");
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  wrapper.append(dt, dd);
  return wrapper;
};

const renderNow = (data) => {
  const hour = data.hours[0];
  if (!hour) return;

  const values = hour.values;
  el("now-icon").innerHTML = hour.condition
    ? conditionIcon(hour.condition.value, isDaytime(hour.time))
    : "";

  el("now-temp").textContent =
    values.tempC === undefined
      ? "–"
      : `${fmt(temp(values.tempC.value))}${tempUnit()}`;

  el("now-condition").textContent = hour.condition
    ? conditionLabel(hour.condition.value)
    : "";

  el("now-feels").textContent =
    values.apparentC === undefined
      ? ""
      : `Feels like ${fmt(temp(values.apparentC.value))}${tempUnit()}`;

  const stats = el("now-stats");
  stats.textContent = "";
  if (values.precipProbPct) {
    stats.append(statRow("Rain chance", `${fmt(values.precipProbPct.value)}%`));
  }
  if (values.precipMm) {
    stats.append(statRow("Rain", `${fmt(values.precipMm.value, 1)} mm/h`));
  }
  if (values.windKph) {
    const direction = values.windDirDeg
      ? ` ${compass(values.windDirDeg.value)}`
      : "";
    stats.append(
      statRow(
        "Wind",
        `${fmt(speed(values.windKph.value))} ${speedUnit()}${direction}`,
      ),
    );
  }
  if (values.gustKph) {
    stats.append(
      statRow("Gusts", `${fmt(speed(values.gustKph.value))} ${speedUnit()}`),
    );
  }
  if (values.humidityPct) {
    stats.append(statRow("Humidity", `${fmt(values.humidityPct.value)}%`));
  }
  if (values.pressureHpa) {
    stats.append(statRow("Pressure", `${fmt(values.pressureHpa.value)} hPa`));
  }
  if (values.uvIndex) {
    stats.append(statRow("UV index", fmt(values.uvIndex.value)));
  }
  if (values.visibilityKm) {
    stats.append(statRow("Visibility", `${fmt(values.visibilityKm.value)} km`));
  }

  const confidence = values.tempC?.confidence ?? 0;
  el("now-confidence-value").textContent = `${confidence}%`;
  el("now-confidence-bar").style.width = `${confidence}%`;

  const contributors = values.tempC?.contributors ?? 0;
  el("now-range").textContent = values.tempC
    ? `${contributors} independent model${contributors === 1 ? "" : "s"} span ` +
      `${fmt(temp(values.tempC.low))}–${fmt(temp(values.tempC.high))}${tempUnit()}`
    : "";
};

const renderHourly = (data) => {
  const container = el("hourly");
  container.textContent = "";
  const hours = data.hours.slice(0, 24);

  for (const hour of hours) {
    const item = document.createElement("div");
    item.className = "hour";
    item.setAttribute("role", "listitem");

    const time = document.createElement("span");
    time.className = "hour__time";
    time.textContent = hourLabel(hour.time);

    const icon = document.createElement("span");
    icon.className = "hour__icon";
    if (hour.condition) {
      icon.innerHTML = conditionIcon(hour.condition.value, isDaytime(hour.time));
    }

    const value = document.createElement("span");
    value.className = "hour__temp";
    value.textContent =
      hour.values.tempC === undefined
        ? "–"
        : `${fmt(temp(hour.values.tempC.value))}°`;

    const pop = hour.values.precipProbPct?.value ?? 0;
    const bar = document.createElement("span");
    bar.className = "hour__rain";
    const fill = document.createElement("span");
    // Scaled against 100%, not against the day's maximum: a flat 5% chance
    // must look like 5%, not like half a bar.
    fill.style.height = `${Math.max(2, pop)}%`;
    // Confidence drives opacity: a rain bar the models argue about looks faint.
    const confidence = hour.values.precipProbPct?.confidence ?? 50;
    fill.style.opacity = `${0.35 + (confidence / 100) * 0.65}`;
    bar.append(fill);

    const popText = document.createElement("span");
    popText.className = "hour__pop";
    popText.textContent = `${Math.round(pop)}%`;

    const agreement = hour.values.tempC
      ? `, models agree ${hour.values.tempC.confidence}%`
      : "";
    item.title =
      `${hourLabel(hour.time)} — ${
        hour.condition ? conditionLabel(hour.condition.value) : "unknown"
      }, ${fmt(pop)}% rain chance${agreement}`;

    item.append(time, icon, value, bar, popText);
    container.append(item);
  }
};

const renderDaily = (data) => {
  const container = el("daily");
  container.textContent = "";
  const days = data.days.slice(0, 7);
  if (days.length === 0) return;

  const lows = days.map((day) => day.minTempC?.low ?? day.minTempC?.value ?? 0);
  const highs = days.map((day) => day.maxTempC?.high ?? day.maxTempC?.value ?? 0);
  const floor = Math.min(...lows);
  const ceiling = Math.max(...highs);
  const span = Math.max(1, ceiling - floor);
  const position = (value) => ((value - floor) / span) * 100;

  for (const [index, day] of days.entries()) {
    const row = document.createElement("div");
    row.className = "day";

    const name = document.createElement("span");
    name.className = "day__name";
    name.textContent = dayLabel(day.date, index);

    const icon = document.createElement("span");
    icon.className = "day__icon";
    if (day.condition) icon.innerHTML = conditionIcon(day.condition, true);

    const low = document.createElement("span");
    low.className = "day__low";
    low.textContent =
      day.minTempC === undefined ? "–" : `${fmt(temp(day.minTempC.value))}°`;

    const track = document.createElement("span");
    track.className = "day__track";
    if (day.minTempC && day.maxTempC) {
      const spread = document.createElement("span");
      spread.className = "day__spread";
      spread.style.left = `${position(day.minTempC.low)}%`;
      spread.style.width = `${Math.max(
        2,
        position(day.maxTempC.high) - position(day.minTempC.low),
      )}%`;

      const range = document.createElement("span");
      range.className = "day__range";
      range.style.left = `${position(day.minTempC.value)}%`;
      range.style.width = `${Math.max(
        2,
        position(day.maxTempC.value) - position(day.minTempC.value),
      )}%`;

      track.append(spread, range);
    }

    const high = document.createElement("span");
    high.className = "day__high";
    high.textContent =
      day.maxTempC === undefined ? "–" : `${fmt(temp(day.maxTempC.value))}°`;

    const pop = document.createElement("span");
    pop.className = "day__pop";
    const chance = day.maxPrecipProbPct?.value ?? 0;
    const rain = day.totalPrecipMm?.value ?? 0;
    pop.textContent = chance >= 5 ? `${Math.round(chance)}%` : "—";

    row.title =
      `${dayLabel(day.date, index)}: ${
        day.condition ? conditionLabel(day.condition) : "unknown"
      }, ` +
      `${fmt(temp(day.minTempC?.value ?? 0))}–${fmt(
        temp(day.maxTempC?.value ?? 0),
      )}${tempUnit()}, ` +
      `${fmt(rain, 1)} mm expected, models agree ${day.confidence}%`;

    row.append(name, icon, low, track, high, pop);
    container.append(row);
  }
};

const renderSourcePicker = (data) => {
  const select = el("source-hour");
  const previous = state.selectedHourIndex;
  select.textContent = "";
  data.hours.slice(0, 24).forEach((hour, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = index === 0 ? "now" : hourLabel(hour.time);
    select.append(option);
  });
  select.value = String(Math.min(previous, Math.max(0, data.hours.length - 1)));
};

const renderSources = (data) => {
  const body = el("sources-body");
  body.textContent = "";

  const index = state.selectedHourIndex;
  const hour = data.hours[index];
  if (!hour) return;
  const consensus = hour.values.tempC?.value;

  const rows = data.sources
    .map((entry) => {
      const point = (data.bySource[entry.descriptor.id] ?? []).find(
        (candidate) => candidate.time === hour.time,
      );
      return { entry, point };
    })
    .filter((row) => row.point !== undefined)
    .sort((a, b) => (a.point.tempC ?? 0) - (b.point.tempC ?? 0));

  for (const { entry, point } of rows) {
    const tr = document.createElement("tr");

    const cells = [
      entry.descriptor.label,
      entry.descriptor.family.toUpperCase(),
      `${entry.descriptor.resolutionKm} km`,
      point.tempC === undefined ? "–" : `${fmt(temp(point.tempC), 1)}${tempUnit()}`,
      "",
      point.precipMm === undefined ? "–" : `${fmt(point.precipMm, 1)} mm`,
    ];

    for (const [cellIndex, text] of cells.entries()) {
      const td = document.createElement("td");
      if (cellIndex === 4 && consensus !== undefined && point.tempC !== undefined) {
        const delta = point.tempC - consensus;
        td.textContent = `${delta >= 0 ? "+" : ""}${fmt(delta, 1)}`;
        // Two degrees off the consensus is a genuine disagreement worth seeing.
        if (Math.abs(delta) >= 2) td.className = "outlier";
      } else {
        td.textContent = text;
      }
      tr.append(td);
    }
    body.append(tr);
  }

  const status = el("source-status");
  status.textContent = "";
  for (const entry of data.sources) {
    const chip = document.createElement("span");
    chip.className = "chip chip--live";
    chip.textContent = `${entry.descriptor.label} · ${entry.latencyMs} ms`;
    status.append(chip);
  }
  for (const failure of data.failures ?? []) {
    const chip = document.createElement("span");
    chip.className = failure.skipped ? "chip" : "chip chip--failed";
    chip.textContent = `${failure.label} · ${failure.reason}`;
    chip.title = failure.reason;
    status.append(chip);
  }

  const attributions = [
    ...new Set(data.sources.map((entry) => entry.descriptor.attribution)),
  ];
  el("attribution").textContent = `Data: ${attributions.join(" · ")}`;
};

const renderLocation = (data) => {
  el("place").textContent = data.location.label ??
    `${data.location.latitude.toFixed(3)}, ${data.location.longitude.toFixed(3)}`;

  const bits = [];
  if (data.location.origin === "gps") {
    bits.push(
      data.location.accuracyMetres
        ? `precise location ±${Math.round(data.location.accuracyMetres)} m`
        : "precise location",
    );
  }
  bits.push(
    `${data.location.latitude.toFixed(4)}, ${data.location.longitude.toFixed(4)}`,
  );
  const families = new Set(data.sources.map((entry) => entry.descriptor.family));
  bits.push(
    `${data.sources.length} feeds · ${families.size} independent models`,
  );
  el("precision").textContent = bits.join(" · ");

  el("generated").textContent = `Updated ${timeFormat({
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(data.generatedAt))}${data.stale ? " (cached — refresh failed)" : ""}`;
};

const render = () => {
  const data = state.data;
  if (!data) return;
  el("main").hidden = false;
  renderLocation(data);
  renderWarnings(data.warnings);
  renderNow(data);
  renderHourly(data);
  renderDaily(data);
  renderSourcePicker(data);
  renderSources(data);
};

/* ---------- data ---------- */

const fetchForecast = async (location) => {
  const params = new URLSearchParams({
    lat: String(location.latitude),
    lon: String(location.longitude),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    origin: location.origin ?? "manual",
  });
  if (location.label) params.set("label", location.label);
  if (location.accuracyMetres) {
    params.set("accuracy", String(Math.round(location.accuracyMetres)));
  }

  const response = await fetch(`/api/forecast?${params}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "forecast unavailable");
  return payload;
};

const load = async (location) => {
  state.location = location;
  setBanner("Fetching every model…");
  try {
    state.data = await fetchForecast(location);
    setBanner(
      state.data.stale
        ? "Showing the last good forecast — a refresh just failed."
        : null,
    );
    render();
    store({
      location: {
        latitude: location.latitude,
        longitude: location.longitude,
        label: state.data.location.label ?? location.label,
        origin: location.origin,
      },
    });
  } catch (error) {
    setBanner(`Could not build a forecast: ${error.message}`, "error");
  }
};

/* ---------- location ---------- */

const requestPreciseLocation = () =>
  new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("this browser has no geolocation"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMetres: position.coords.accuracy,
          origin: "gps",
        }),
      (error) => reject(new Error(error.message || "location refused")),
      // High accuracy is the whole point; allow a slightly stale fix so a
      // warm GPS returns instantly rather than spinning.
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 120_000 },
    );
  });

const useMyLocation = async () => {
  setBanner("Asking your browser for a precise fix…");
  try {
    const location = await requestPreciseLocation();
    await load(location);
  } catch (error) {
    const stored = loadStored().location;
    if (stored) {
      setBanner(`${error.message} — using your last location instead.`);
      await load(stored);
    } else {
      setBanner(
        `${error.message}. Search for a town or postcode above to continue.`,
        "error",
      );
    }
  }
};

const runSearch = async (query) => {
  const container = el("search-results");
  container.textContent = "";
  container.hidden = true;

  try {
    const response = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "search failed");
    if (!payload.results || payload.results.length === 0) {
      setBanner(`Nothing found for “${query}”.`);
      return;
    }

    setBanner(null);
    container.hidden = false;
    for (const place of payload.results) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = place.label;
      button.addEventListener("click", () => {
        container.hidden = true;
        el("search-input").value = "";
        void load({
          latitude: place.latitude,
          longitude: place.longitude,
          label: place.label,
          origin: "search",
        });
      });
      container.append(button);
    }
  } catch (error) {
    setBanner(`Search failed: ${error.message}`, "error");
  }
};

/* ---------- wiring ---------- */

const init = () => {
  const stored = loadStored();
  state.units = stored.units === "imperial" ? "imperial" : "metric";
  el("units").textContent = tempUnit();

  el("units").addEventListener("click", () => {
    state.units = state.units === "metric" ? "imperial" : "metric";
    el("units").textContent = tempUnit();
    store({ units: state.units });
    render();
  });

  el("locate").addEventListener("click", () => {
    void useMyLocation();
  });

  el("search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const query = el("search-input").value.trim();
    if (query.length >= 2) void runSearch(query);
  });

  el("source-hour").addEventListener("change", (event) => {
    state.selectedHourIndex = Number(event.target.value) || 0;
    if (state.data) renderSources(state.data);
  });

  // Refresh on a timer, and whenever the tab comes back into focus after the
  // data has had time to go stale.
  setInterval(() => {
    if (state.location) void load(state.location);
  }, REFRESH_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !state.data) return;
    const age = Date.now() - Date.parse(state.data.generatedAt);
    if (age > REFRESH_MS) void load(state.location);
  });

  void useMyLocation();
};

init();

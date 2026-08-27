# Weather consensus dashboard

An aggregated UK weather forecast. It opens on your precise location, asks
several independent forecast models the same question, and shows you both the
consensus answer **and how much the models actually agree** — because a
forecast that six models agree on and a forecast they are arguing about should
not look the same on screen.

Zero runtime dependencies. Node 22.6+ only.

```bash
cd apps/weather-dashboard
cp .env.example .env      # optional — it runs with no keys at all
npm start                 # http://127.0.0.1:8787
```

## What it aggregates

| Source | Model family | Grid over the UK | Key needed |
| --- | --- | --- | --- |
| Met Office UKV / Global (via Open-Meteo) | `ukmo` | 2 km | no |
| Met Office DataHub, Site Specific | `ukmo` | 2 km | yes |
| ECMWF IFS 0.25° (via Open-Meteo) | `ecmwf` | 25 km | no |
| MET Norway / Yr | `ecmwf` | 9 km | no |
| DWD ICON (via Open-Meteo) | `icon` | 7 km | no |
| NOAA GFS (via Open-Meteo) | `gfs` | 13 km | no |
| Météo-France ARPEGE/AROME (via Open-Meteo) | `arpege` | 10 km | no |
| Environment Canada GEM (via Open-Meteo) | `gem` | 15 km | no |
| OpenWeatherMap | `blend` | 11 km | yes |
| WeatherAPI.com | `blend` | 12 km | yes |
| Met Office severe weather warnings (RSS) | — | — | no |

With no keys configured you still get **six independent models plus MET
Norway**. Keyed sources are skipped cleanly and the dashboard says which ones
and why.

## How the consensus is built

This is the part that decides whether the forecast is actually any good, so it
is worth reading before trusting it.

**1. Everything is normalised first.** Each adapter converts its provider's
units and icon vocabulary into one shared hourly shape (`src/types.ts`). A
missing variable stays missing — it never silently becomes zero.

**2. Weight follows skill, and skill depends on lead time.** The Met Office
UKV is convection-permitting at 2 km: it resolves individual showers, sea
breezes and valley fog that a 25 km global model smears into drizzle
everywhere. That advantage is large at hour 3 and gone by day 4. ECMWF's IFS
is the strongest global model in the medium range. So the weighting favours
the Met Office early and hands over to ECMWF by day 5, ramping linearly in
between (`src/skill.ts`, and `GET /api/weights` to inspect it live).

**3. Correlated sources do not get to vote twice.** This is the failure mode
most multi-source dashboards have. MET Norway, the ECMWF feed and most
commercial APIs are all reading the same ECMWF run. Averaging them naively
lets one model outvote several genuinely independent ones — and, worse, makes
their agreement look like confirmation when it is the same forecast counted
three times. Weight is therefore allocated **per model family** and then split
between that family's members. A family with several feeds earns a small
sampling bonus (up to 20%), never a multiple.

**4. Robust combination, not a plain average.** Continuous variables use a
weighted median as an anchor, discard samples more than two deviations from
it, then take the weighted mean of the rest — so one broken source cannot drag
the answer, while the sources that agree still all contribute. Wind direction
is averaged as unit vectors, because the arithmetic mean of 350° and 10° is
180°, exactly backwards. Precipitation deliberately keeps its outliers: the
one model resolving a convective shower is the signal, not the noise.

**5. Rain probability uses two kinds of evidence.** Only some models publish a
probability. For the rest, the *fraction of the weighted ensemble producing
measurable rain* is itself a probability — often better calibrated, since it
comes from real disagreement between independent models rather than one
model's post-processing. Where both exist, they are blended 60/40.

**6. Disagreement is shown, not hidden.** Every fused value carries a spread,
an 80% range and a confidence score. Confidence falls when the models disagree
relative to what matters for that variable, when few *independent* families
contributed, and as lead time grows — six models agreeing about next Thursday
are still six models guessing about next Thursday. Nothing ever reads as 100%.

Sunrise and sunset are computed locally from the NOAA solar equations rather
than taken from a provider: deterministic, free, and still correct when every
upstream is down.

## Precise location

On load the page asks the browser for a high-accuracy fix and shows the
reported accuracy radius. Coordinates are rounded to 4 decimals (~11 m) before
they reach any upstream, and to 3 decimals (~110 m) for the cache key, so
standing still with GPS jitter is a cache hit rather than a fresh fan-out to
ten APIs. If you decline the permission it falls back to your last location,
then to search. Nothing is stored server-side.

## Configuration

Every key is optional; see `.env.example`. The two worth adding:

- **`MET_OFFICE_API_KEY`** — the authoritative UK source, the same Site
  Specific data behind the Met Office's own app. Free tier at
  <https://datahub.metoffice.gov.uk/>.
- **`MET_NORWAY_CONTACT`** — an email or URL. MET Norway's terms require a
  real contact in the `User-Agent` and answer anonymous requests with 403.

## Verifying it against the real APIs

Adapters were written against published API documentation. Confirm the
documentation matches reality from a machine with network access:

```bash
npm run verify              # defaults to central London
npm run verify 53.48 -2.24  # or anywhere
```

It calls every configured source for real and prints which variables parsed,
how many hours came back, and the exact mismatch when something has moved.
Run it after any upstream model upgrade.

## Development

```bash
npm test          # unit tests, no network
npm run dev       # auto-restarting server
node --experimental-strip-types scripts/demo.ts   # synthetic data, no API calls
```

`scripts/demo.ts` runs the real server and the real fusion engine against
deterministic synthetic model output, so the UI can be developed and reviewed
without burning free-tier quota.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/forecast?lat=&lon=&tz=&label=&origin=&accuracy=` | Fused forecast plus every source's own series |
| `GET /api/geocode?q=` | Place search |
| `GET /api/weights` | The skill priors driving the weighting |
| `GET /api/health` | Active sources, unconfigured sources, cache size |

A source that fails appears in `failures[]` with its reason rather than taking
the forecast down. If a refresh fails entirely, the last good forecast is
served with `stale: true`.

## Notes and limits

- **The weights are informed priors, not measured skill.** They encode
  well-established properties of these models, but the honest next step is to
  score each source against observations over time and let the weights follow
  the measured error. `src/skill.ts` is the single place that would change.
- **Warnings are scraped from RSS**, the one surface here with no API contract.
  It is fail-soft and the URL is configurable via `MET_OFFICE_WARNINGS_URL`.
- **This app sits outside the pnpm workspace on purpose.** It has no
  dependencies, adds nothing to the root package, ships in no build, and runs
  its tests with `node --test` rather than the repo's Vitest lanes. It is a
  self-contained app under `apps/`, like the native apps beside it.

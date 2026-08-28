# Weather consensus dashboard

An aggregated UK weather forecast. It opens on your precise location, asks
several independent forecast models the same question, and shows you both the
consensus answer **and how much the models actually agree** — because a
forecast that six models agree on and a forecast they are arguing about should
not look the same on screen.

Zero runtime dependencies — it runs on Node 22.6+ or on Cloudflare Workers from
the same source.

**Locally:**

```bash
cd apps/weather-dashboard
cp .env.example .env      # optional — it runs with no keys at all
npm start                 # http://127.0.0.1:8787
```

**Deployed, to get a URL your phone can use:** see [Deploying](#deploying).

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
| AccuWeather | `proprietary` | 11 km | yes |
| Apple Weather (WeatherKit) | `proprietary` | 10 km | yes |
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
three times.

Weight is therefore allocated **per model family** and then split between that
family's members, with the family's bonus scaled by how independent those
members actually are. Each family declares a correlation coefficient and the
weighting uses the standard effective-sample-size result, `n / (1 + ρ(n−1))`:
two feeds of the same Met Office run (ρ = 0.95) count as barely more than one
opinion, while AccuWeather and Apple (ρ = 0.6) — genuinely different forecast
systems — count as noticeably more. Never as a multiple.

This is also why AccuWeather and Apple sit in a `proprietary` family rather
than getting one each. They carry real skill the raw models do not: their own
bias correction, statistical post-processing, and in AccuWeather's case human
forecaster intervention. But they are still *downstream* of the same models
already in this set, so their agreement with each other is not independent
evidence. They are weighted above the thin commercial wrappers and below the
raw models they derive from.

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

**AccuWeather** needs one key from <https://developer.accuweather.com/>. The
free plan allows 50 calls a day and serves 12 hours ahead, so it sharpens the
short range rather than the week. Coordinates must first be resolved to a
location key; that key never changes, so it is cached in process and a refresh
costs a single call. `ACCUWEATHER_HOURLY_RANGE` unlocks longer tiers on a paid
plan and is validated at startup, because asking for a tier your key cannot
reach returns a 401 that reads exactly like a bad key.

**Apple WeatherKit** needs four values rather than one, because it authenticates
with a signed token instead of an API key: a Team ID, a Services ID, a Key ID
and the `.p8` private key (see `.env.example` for where each lives in the
developer portal). It requires a paid Apple Developer account. Two details in
the token are easy to get wrong and both fail as an opaque 401 — the JWT header
needs a non-standard `id` claim of `TEAM_ID.SERVICE_ID`, and the ES256
signature must be JOSE's raw `r||s` pair rather than the DER encoding Node
emits by default. Both are handled in `src/sources/apple-weatherkit.ts` and
covered by tests. Supplying only some of the four is treated as a mistake and
fails loudly at startup, rather than silently running one source short.

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

## Deploying

The app runs on Cloudflare Workers with no code changes and no build step —
`src/app.ts` is already a Web-standard `Request -> Response` handler, which is
what the Workers runtime wants. Node gets a thin `node:http` bridge; Workers
calls it directly. One implementation, so the two cannot drift.

```bash
cd apps/weather-dashboard
npm run deploy            # npx wrangler deploy — prompts a browser login
```

That prints a URL like `https://weather-consensus.<your-subdomain>.workers.dev`.
It is HTTPS, so precise geolocation works on a phone. The free plan covers
100,000 requests a day, and files under `public/` are served straight from
Cloudflare's edge without invoking the Worker at all, so only `/api/*` counts
against that.

Before the first deploy, edit `MET_NORWAY_CONTACT` in `wrangler.toml` to a real
address — MET Norway's terms require one and answer anonymous requests with 403.

API keys go in as encrypted secrets, never in `wrangler.toml`:

```bash
npm run secret MET_OFFICE_API_KEY
npm run secret ACCUWEATHER_API_KEY
npm run secret APPLE_WEATHERKIT_PRIVATE_KEY   # paste the .p8 contents
```

To run the Workers runtime locally, copy `.dev.vars.example` to `.dev.vars`
(git-ignored) and run `npm run dev:worker`.

### Keeping the Worker build clean

The Worker and the Node server share almost all their code, so it is easy to
add an import to a shared module that quietly pulls in `node:fs` — which fails
at deploy time or, worse, on the first request.

```bash
npm run check:worker
```

walks the import graph from `worker/index.ts` and fails if it reaches a `node:`
builtin or any bare specifier. It caught exactly that on its first run. Node-only
code is confined to `src/server.ts` and `src/config.ts`; configuration is
otherwise built by the pure `src/config-core.ts`, from `process.env` on Node and
from the bindings object on Workers.

The WeatherKit token is signed with WebCrypto rather than `node:crypto` for the
same reason — and it turns out to be the better API anyway, since WebCrypto's
ECDSA already emits the raw `r||s` pair JOSE requires.

### Notes on the Workers deployment

- **Caching is per isolate.** A warm isolate answers repeat requests without
  touching an upstream; an evicted one starts cold and re-fetches. That is fine
  for a personal dashboard, but if you are on AccuWeather's free tier (50 calls
  a day) and open the page constantly, put the Cache API or a KV namespace in
  front of `/api/forecast`.
- **No file system**, so `APPLE_WEATHERKIT_PRIVATE_KEY_PATH` is rejected there
  with an error saying to use the inline key. Everything else works identically.

## Development

```bash
npm test            # unit tests, no network
npm run dev         # auto-restarting Node server
npm run dev:worker  # the real Workers runtime, locally
npm run demo        # synthetic data, no API calls
npm run check:worker
```

`npm run demo` runs the real server and the real fusion engine against
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
- **BBC Weather is not included.** It is the other app most UK users mean, and
  its data (DTN, formerly MeteoGroup) would be a genuinely independent addition
  — but it has no public API, only an undocumented internal endpoint. Adding a
  parser written blind against it would be guesswork; capturing one real
  response is enough to write it properly.
- **This app sits outside the pnpm workspace on purpose.** It has no
  dependencies, adds nothing to the root package, ships in no build, and runs
  its tests with `node --test` rather than the repo's Vitest lanes. It is a
  self-contained app under `apps/`, like the native apps beside it.

# BusTAudio — Stremio Audiobook Addon

A Stremio addon that searches for audiobooks and resolves **playable / downloadable
links through your TorBox account**. Each user installs it with their own TorBox
API key baked into the install URL, so there's no shared server state and no
database.

## How it works

```
Stremio  ──search──▶  addon  ──▶  AudiobookBay (or Jackett)  ──▶  list of torrents
                          └──▶  TorBox checkcached (batch)   ──▶  ⚡ instant ones first
                          └──▶  Open Library                 ──▶  covers + authors
Stremio  ──stream──▶  addon  ──▶  TorBox:  checkcached → createtorrent → mylist → requestdl
                                   └──▶  direct HTTPS link per audio file
```

The link `requestdl` returns is a plain HTTPS URL — Stremio plays it, and you can
also paste it into a browser, `curl`, `aria2`, IDM, etc. to **download** the file.

TorBox endpoints used (base `https://api.torbox.app/v1/api`):
`/torrents/checkcached`, `/torrents/createtorrent`, `/torrents/mylist`,
`/torrents/requestdl`.

## Features

- **Instant-vs-not labeling.** Before showing results, the addon asks TorBox
  which torrents are already cached (one batched call) and floats those to the
  top with an `⚡ Instant` tag — so you're not picking blindly.
- **Instant-only mode (optional).** Tick it on the configure page (or set
  `INSTANT_ONLY=1`) to hide anything TorBox can't stream immediately, so every
  result plays with no wait.
- **Quality-aware sorting.** Within cached/uncached groups, results are ranked by
  a rough quality score (bitrate, container, size) so cleaner rips surface first.
- **Right player for the format.** Browser-playable files (mp3/m4a/…) play inline;
  m4b/flac/etc. are flagged `notWebReady` so Stremio routes them to an external
  player instead of failing quietly.
- **Real cover art + author** from Open Library (best-effort, cached, never blocks).
- **Format / bitrate / size** parsed from AudiobookBay and shown on tiles, the
  detail page, and each stream.
- **Fast + resilient.** Search pages, detail pages, cover lookups, cache-status
  checks, and resolved playable streams are all memoized with TTLs; outbound
  requests are concurrency-limited; and scrapes retry with backoff. Re-opening a
  book serves cached links instantly without re-hitting the API. Cover lookups
  try iTunes first and only fall back to Google Books / Open Library on a miss,
  and a search never waits more than 3 s for covers — slower lookups finish in
  the background and are cached for the next search.
- **Search pagination** (Stremio's infinite scroll / `skip`).
- **Health route:** `GET /<config>/health` reports whether your TorBox key is
  valid, which sources are configured, and whether instant-only is on. When
  `ACCESS_TOKENS` is set it answers **403** for a link with a missing or wrong
  token (as every other route does), so the app rejects a bad link at setup
  instead of connecting and then failing every search. The bare `GET /health`
  stays open as a liveness probe.
- **Tests + CI.** `npm test` runs the parsing/caching/id/quality suite (no
  network); a GitHub Actions workflow runs it on Node 18/20/22.

## 📱 Looking for a better Mobile Experience? 

While Stremio is fantastic for TV screens, its built-in player isn't natively designed for long-form audiobooks on mobile devices (handling things like precise sleep timers, background lock-screen controls, or offline downloads). 

If you plan to listen on your phone, it is highly recommended to use the **BusTAudioBooks Mobile App** instead!

### Why use the Companion App?
*   📥 **True Offline Downloads:** Native background downloading that survives screen-locks and app kills so you can listen completely offline.
*   🎧 **Dedicated Audiobook Player:** Real chapters from single-file M4B books (titles on the lock screen too), whole-book time left, fine-grained speed control, smart rewind, custom skip intervals, and bookmarks.
*   ⏳ **Sleep Timer:** By minutes, end of chapter, or end of part — with an optional fade-out — and it keeps working in the background.
*   🩹 **Self-Healing Streams:** Expired TorBox links are silently re-resolved behind the scenes so your playback never randomly stops mid-sentence.
*   🔒 **Zero Extra Configuration:** It is completely plug-and-play. You just open the app and paste the exact same Stremio `manifest.json` install link you already generated. 

👉 **Check out the project and download the latest Android APK here:** [BusTAudioBooks Mobile Repository](https://github.com/AFK-Goblin/BusTAudioBooks-App)


### Environment variables

| Var | Purpose |
|-----|---------|
| `PORT` | Listen port (default 7000) |
| `ABB_DOMAIN` | Default AudiobookBay domain if a user doesn't set one per-install |
| `INSTANT_ONLY` | Set to `1` to force instant-only for every install on this instance |

## 📱 Mobile app API

The [BusTAudioBooks Mobile App](https://github.com/AFK-Goblin/BusTAudioBooks-App)
talks to `/<config>/app/*` on this same server:

- `GET /<config>/app/search?q=...&page=N` — audiobook search. Answers 503 with
  `{ results: [], error }` when no search source is configured or every source
  failed (e.g. AudiobookBay behind a Cloudflare challenge), so the app can say
  why instead of showing "No results". Failures are never cached. Jackett
  requests time out after 15 s.
- `GET /<config>/app/streams/<id>` — playable files. Each entry carries `size`
  (bytes, or `null` when TorBox doesn't report one), which the app uses to
  estimate whole-book length for multi-part audiobooks; Stremio streams carry
  the same number as the standard `behaviorHints.videoSize`.
- `GET /<config>/app/details/<id>` — synopsis, genre and year for the book page
  (iTunes, then Google Books; only used when the matched title really is this
  book; cached a day).
- `GET /<config>/app/series/<id>` — the book's series in order and the next book
  (Audible's public catalogue, no key needed; `{ series: null }` for standalone
  books or no match; cached a day). Powers the app's "Next in series".
- `GET /<config>/app/similar/<id>` — "Because you listened to…": books Audible's
  listeners also enjoyed plus the author's other books, outside this book's own
  series, one per other series (`{ similar: null }` when nothing matches; cached a day).
- `GET /<config>/app/version` — latest APK info for the in-app update prompt:
  `APP_LATEST_VERSION` + `APP_APK_URL` if set, otherwise the latest release of
  the app's GitHub repo with an `.apk` attached (`APP_RELEASES_REPO` picks
  another repo, `none` turns it off; cached an hour).

Comics were removed in 3.0. App versions that still show a Comics tab get
HTTP 410 with "Comics were removed…" from the old comic routes.

## Setup

```bash
npm install
npm start
```

Then open **http://127.0.0.1:7000/configure**, paste:

- **TorBox API key** — from torbox.app → Settings → API (required)
- **AudiobookBay domain** — the current working ABB domain, e.g. `audiobookbay.lu`
  (this enables search with **no extra software** to run)

Click *Generate install link* → *Install in Stremio*.

## Where it searches

Two built-in sources, in `src/sources.js`:

1. **AudiobookBay (default).** Scraped directly by the addon — no Jackett or
   Prowlarr process needed. Just set the current ABB domain on the configure page
   (or the `ABB_DOMAIN` env var).
2. **Jackett / Prowlarr (optional).** Only used if you fill in its URL + key under
   "Advanced" on the configure page.

Both return `{ name, infohash, magnet, size, seeders, tracker }`, so adding more
sources is just another function merged into `searchAudiobooks()`.

### Caveats for the ABB scraper

- **Domain rotation.** ABB changes domains fairly often. When search goes quiet,
  update the domain on the configure page — no redeploy needed if you used the
  per-install field; one env-var change if you baked it into the host.
- **Cloudflare.** If ABB is behind a Cloudflare challenge, a plain fetch can't get
  through; the addon detects this and logs it. You'd then need a FlareSolverr-style
  solver or a different domain.
- **Selector drift.** Parsing is regex-based against ABB's known layout. If they
  restructure the HTML, tweak `parseAbbList` / `parseAbbDetail` in `sources.js`.
  (For sturdier scraping you can swap in `cheerio` — it's a one-function change.)

## Run it off your machine (recommended)

So that *nothing* runs locally — not Jackett, not even the addon — deploy the
addon to a host and just paste its HTTPS URL into Stremio. Stremio requires HTTPS
for remote addons, which all these provide for free:

- **Render / Railway / Fly.io / Koyeb** — connect this repo (or push the included
  `Dockerfile`), and you get a URL like `https://yourapp.onrender.com`. Open
  `…/configure` there, generate your install link, install. Set `ABB_DOMAIN` as an
  env var on the host so you can update it without redeploying code.
- **Any VPS** — `docker build -t torbox-audiobooks . && docker run -p 7000:7000 -e ABB_DOMAIN=audiobookbay.lu torbox-audiobooks`,
  then put it behind HTTPS (Caddy / Nginx / Cloudflare Tunnel).

Because each user's TorBox key lives inside their own install URL, a single
deployed instance can safely serve just you (or several people) without sharing
credentials.

## Uncached torrents

If a torrent isn't already cached on TorBox, the addon adds it (TorBox starts
pulling it from peers) and the stream shows a `⏳ Downloading…` entry. Re-open the
title after a bit and the playable file links appear. If you only ever want
instant results, you can gate on `checkCached()` in `torbox.js` and skip uncached
items.

## Notes

- **Custom content type.** Audiobooks use a custom `audiobook` type. Stremio shows
  it under Discover and its player handles audio. Rendering of custom types can
  vary slightly between Stremio clients.
- **Multi-file audiobooks** (a folder of MP3 chapters) appear as one stream per
  file, sorted naturally. Single-file `.m4b` shows as one stream.
- **Hosting.** For use beyond your own machine, deploy behind HTTPS (Stremio
  requires HTTPS for remote addons). Any Node host works; set `PORT` via env.
- **Content.** Point your indexer at sources you're entitled to use — e.g.
  public-domain audiobooks (LibriVox and similar) are freely shareable.

## Files

| File | Purpose |
|------|---------|
| `src/index.js` | Express server, configure page, manifest/catalog/meta/stream/health routes |
| `src/torbox.js` | TorBox API client + `resolveStreams()` flow + batch cache checks |
| `src/sources.js` | Search sources: AudiobookBay scraper (default) + optional Jackett |
| `src/metadata.js` | Cover art + author enrichment via Open Library (cached) |
| `src/series.js` | Series lookup (Audible catalogue) for "Next in series" |
| `src/cache.js` | TTL/LRU cache, concurrency limiter, timeout helper |
| `src/itemid.js` | Encode/decode the payload carried in item ids |
| `src/manifest.js` | Addon manifest (custom `audiobook` type, search catalog) |
| `src/config.js` | Packs the API key into the install URL |
| `test/parse.test.js` | Unit tests for the pure logic |

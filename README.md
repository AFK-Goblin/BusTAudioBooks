# BusTAudio — Stremio Audiobook Addon

A Stremio addon that searches for audiobooks and resolves **playable / downloadable
links through your TorBox or AllDebrid account**. Each user configures it with their own provider
API key baked into the install URL, so there's no shared server state and no
database.

## French trackers + AllDebrid (companion app)

The backend now supports direct **C411, Tr4ker, and Torr9** audiobook searches
and **AllDebrid** playback. Jackett is not required for these sources. Existing
TorBox install links and the optional Jackett integration continue to work.

1. Run `npm install`, then `npm start` (Node 18 or newer).
2. Open `http://localhost:7000/configure`.
3. Select AllDebrid or TorBox and enter that provider's API key.
4. Enable **French audiobook trackers**, then tick each tracker you use and enter
   its API key/passkey. Common settings let you prefer MP3/M4B and limit release
   size independently of your sources. Tracker searches use audiobook category `3030`.
5. Generate the companion app link and paste it into the app's setup screen.

**Book language:** choose **All languages**, **French only**, or **English only**
under common settings. The exclusive choices filter audiobook search results on
the server before the result limit is applied. C411, Tr4ker and Torr9 releases
default to French when no language is specified. Explicit language fields or
release tags override that default. AudiobookBay and other sources must provide
an explicit language field or release tag to pass an exclusive filter; a French
book title or metadata cover alone is insufficient. Ambiguous multilingual
releases are excluded. Generate a new install link after changing this setting
and reconnect the app with that link.

Existing install links using `preferredLanguage` keep their original ordering
behavior. Without an exclusive filter, French tracker installs still sort French
releases first. Searches do not translate the user's query.

Metadata searches normalize dotted release names, release years, volume markers
(such as `T01`), and author initials, and use French catalog settings
for French books (Apple's France storefront, Google Books' language restriction,
and Open Library's language preference). Covers, author names, and canonical
titles depend on catalog matches. Cleaned release titles are used when no match
is found. The original release name and item ID remain available for resolution.
Chapter display labels use the MP3 filename without its torrent folder prefix;
full paths remain in the file identity. Already saved/downloaded app entries may
retain their previously stored labels until reloaded.

**Testing from a phone:** open the configure page using your computer's LAN
address, for example `http://192.168.1.20:7000/configure`, and generate the link
there. The phone and computer must be on the same network, with port 7000
reachable. `localhost` on a phone refers to the phone, not your computer.
For remote use, expose this service through HTTPS. `PUBLIC_URL=https://your-host`
can set the public origin for AllDebrid chapter redirects behind a reverse proxy.
The computer/server must remain running, including when later chapters start.

**AllDebrid behavior:** searches never upload or delete torrents. Its readiness
indicator means a book is known ready in your account, not globally cached.
Some API status responses omit hashes; uploads made through this server are
remembered in memory for up to 24 hours to associate those IDs with search hashes.
Leave the ready-only option off initially. Opening a book uploads its original
`.torrent` (preserving private tracker details), or its magnet, when needed.
If it is still downloading, reopen it later. All audio files are returned in
natural filename order, preserving directory names. Individual chapter URLs
unlock on demand and redirect to AllDebrid; this backend does not relay audio.

Tracker endpoint URLs can be overridden on the configure page. Defaults follow
current C411/Tr4ker Torznab interfaces and Frenchio's Torr9 adapter. Torr9's legacy
endpoint and all authenticated tracker access require live validation with your
account. These integrations do not guarantee tracker availability or inventory.
AllDebrid may reject some hosting/VPN IPs (`MAGNET_NO_SERVER` / `AUTH_BLOCKED`);
its API error code is surfaced by the backend.

The generated link contains your provider and tracker credentials: keep it
private. The companion app source in `others/` is a reference and is not modified
or bundled with this backend. Its existing health check uses `torboxKeyValid`;
for compatibility that field reports the selected provider's validity. New clients
can use `provider` and `providerKeyValid` instead.

Run `npm test` for backend tests, including mocked provider flows and companion
API integration. Real account downloads and device playback require manual testing.

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
  book serves cached links instantly without re-hitting the API.
- **Search pagination** (Stremio's infinite scroll / `skip`).
- **Health route:** `GET /<config>/health` reports whether your TorBox key is
  valid, which sources are configured, and whether instant-only is on.
- **Tests + CI.** `npm test` runs the parsing/caching/id/quality suite (no
  network); a GitHub Actions workflow runs it on Node 18/20/22.

## 📱 Looking for a better Mobile Experience? 

While Stremio is fantastic for TV screens, its built-in player isn't natively designed for long-form audiobooks on mobile devices (handling things like precise sleep timers, background lock-screen controls, or offline downloads). 

If you plan to listen on your phone, it is highly recommended to use the **BusTAudioBooks Mobile App** instead!

### Why use the Companion App?
*   📥 **True Offline Downloads:** Native background downloading that survives screen-locks and app kills so you can listen completely offline.
*   🎧 **Dedicated Audiobook Player:** Built-in chapter menus, persistent speed controls, custom skip intervals, and bookmarks.
*   ⏳ **Sleep Timer:** A dedicated sleep timer (by minutes or end-of-chapter) that keeps working perfectly in the background.
*   🩹 **Self-Healing Streams:** Expired TorBox links are silently re-resolved behind the scenes so your playback never randomly stops mid-sentence.
*   🔒 **Zero Extra Configuration:** It is completely plug-and-play. You just open the app and paste the exact same Stremio `manifest.json` install link you already generated. 

👉 **Check out the project and download the latest Android APK here:** [BusTAudioBooks Mobile Repository](https://github.com/AFK-Goblin/BusTAudioBooks-App)


### Environment variables

| Var | Purpose |
|-----|---------|
| `PORT` | Listen port (default 7000) |
| `ABB_DOMAIN` | Override the built-in `audiobookbay.lu` default; per-install overrides take priority |
| `INSTANT_ONLY` | Set to `1` to force instant-only for every install on this instance |
| `COMIC_CATEGORIES` | Torznab categories for the app's Comics search (default `7030`) |

## 📚 Comics (mobile app only)

The [BusTAudioBooks Mobile App](https://github.com/AFK-Goblin/BusTAudioBooks-App)
also gets a **Comics** tab powered by this same server. It's app-only — nothing
changes in Stremio. Two sources:

- **Series (MangaDex)** — ongoing manga/webtoons via MangaDex's official API:
  `GET /<config>/app/search?q=...&type=comic&source=series`, then
  `GET /<config>/app/chapters/<id>` and `GET /<config>/app/pages/<chapterId>`
  (`?saver=1` for data-saver pages, `?fresh=1` to bypass the cache when a page
  URL expires). No user config needed; the server rate-limits itself well under
  MangaDex's caps and sends a proper User-Agent. Set `MANGADEX_DISABLED=1` to
  turn the source off. Licensed series may show few/no chapters — their pages
  live on the publisher's site; that's what the Torrents source is for.
- **Torrents (Jackett + TorBox)** — finished/bundled series, as below.

- **Search** rides on your Jackett/Prowlarr (Torznab category `7030` =
  Books/Comics), so add an indexer that carries comics/manga to enable it.
  AudiobookBay is not used for comics.
- The app API takes `GET /<config>/app/search?q=...&type=comic`; item ids carry
  the content type, so `/app/streams/<id>` needs no extra parameter.
- **Resolution** is the same TorBox flow, but filtered to comic files:
  `.cbz .cbr .cb7 .cbt .pdf` archives plus loose page images
  (`.jpg .png .webp .avif`).
- The app reads **CBZ** archives and loose-image torrents in its built-in
  vertical reader; CBR/PDF are download-only (open them with a reader of your
  choice).

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
| `src/cache.js` | TTL/LRU cache, concurrency limiter, timeout helper |
| `src/itemid.js` | Encode/decode the payload carried in item ids |
| `src/manifest.js` | Addon manifest (custom `audiobook` type, search catalog) |
| `src/config.js` | Packs the API key into the install URL |
| `test/parse.test.js` | Unit tests for the pure logic |

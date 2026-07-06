# BusTAudiobooks Stremio Audiobook Addon

A Stremio addon that searches for audiobooks and resolves playable or downloadable links through your TorBox account. Each user installs it with their own TorBox API key baked into the install URL, so there is no shared server state and no database.

## How it works

Stremio -> addon -> AudiobookBay (or Jackett) -> list of torrents
                 -> TorBox checkcached (batch) -> instant ones first
                 -> Open Library -> covers and authors

Stremio -> stream -> addon -> TorBox checkcached -> createtorrent -> mylist -> requestdl
                           -> direct HTTPS link per audio file

The link requestdl returns is a plain HTTPS URL. Stremio plays it, and you can also paste it into a browser, curl, aria2, IDM, etc. to download the file.

TorBox endpoints used (base https://api.torbox.app/v1/api):
/torrents/checkcached, /torrents/createtorrent, /torrents/mylist, /torrents/requestdl.

## Features

* Instant-vs-not labeling: Before showing results, the addon asks TorBox which torrents are already cached (one batched call) and floats those to the top with an instant tag so you are not picking blindly.
* Instant-only mode (optional): Tick it on the configure page (or set INSTANT_ONLY=1) to hide anything TorBox cannot stream immediately, so every result plays with no wait.
* Quality-aware sorting: Within cached and uncached groups, results are ranked by a rough quality score (bitrate, container, size) so cleaner rips surface first.
* Right player for the format: Browser-playable files (mp3, m4a) play inline. m4b and flac are flagged notWebReady so Stremio routes them to an external player instead of failing quietly.
* Real cover art and author from Open Library (best-effort, cached, never blocks).
* Format, bitrate, and size parsed from AudiobookBay and shown on tiles, the detail page, and each stream.
* Fast and resilient: Search pages, detail pages, cover lookups, cache-status checks, and resolved playable streams are all memoized with TTLs. Outbound requests are concurrency-limited, and scrapes retry with backoff. Re-opening a book serves cached links instantly without re-hitting the API.
* Search pagination (Stremio infinite scroll).
* Access gating: Optional shared-token gate using ACCESS_TOKENS to limit who can use your hosted instance.
* Health route: GET /<config>/health reports whether your TorBox key is valid, which sources are configured, and whether instant-only is on.
* Tests and CI: npm test runs the parsing, caching, id, and quality suite (no network). A GitHub Actions workflow runs it on Node 18, 20, and 22.

## Environment variables

PORT: Listen port (default 7000)
ABB_DOMAIN: Default AudiobookBay domain if a user does not set one per-install
INSTANT_ONLY: Set to 1 to force instant-only for every install on this instance
JACKETT_URL: Server-wide Jackett URL so friends do not need to configure it
JACKETT_API_KEY: Server-wide Jackett API key
ACCESS_TOKENS: Comma-separated list of passwords to restrict access to your instance

## Setup

npm install
npm start

Then open http://127.0.0.1:7000/configure and paste:
* TorBox API key from torbox.app Settings (required)
* AudiobookBay domain: the current working ABB domain, e.g. audiobookbay.lu (this enables search with no extra software to run)

Click Generate install link, then Install in Stremio.

## Where it searches

Two built-in sources in src/sources.js:

1. AudiobookBay (default): Scraped directly by the addon, so no Jackett or Prowlarr process is needed. Just set the current ABB domain on the configure page (or the ABB_DOMAIN env var).
2. Jackett or Prowlarr (optional): Only used if you fill in its URL and key under Advanced on the configure page. 

Note: If you have already set up server-wide search using environment variables (like ABB_DOMAIN or JACKETT_URL), the configuration page will automatically hide the Advanced dropdown and source fields. This is an intentional feature to keep the UI clean so your users only have to enter their TorBox key.

### Caveats for the ABB scraper

* Domain rotation: ABB changes domains fairly often. When search goes quiet, update the domain on the configure page. No redeploy is needed if you used the per-install field, or just one env-var change if you baked it into the host.
* Cloudflare: If ABB is behind a Cloudflare challenge, a plain fetch cannot get through. The addon detects this and logs it. You would then need a FlareSolverr-style solver or a different domain.
* Selector drift: Parsing is regex-based against ABB known layout. If they restructure the HTML, tweak parseAbbList or parseAbbDetail in sources.js. (For sturdier scraping you can swap in cheerio, which is a one-function change).

## Run it off your machine (recommended)

So that nothing runs locally, deploy the addon to a host and just paste its HTTPS URL into Stremio. Stremio requires HTTPS for remote addons, which all these provide for free:

* Render, Railway, Fly.io, or Koyeb: connect this repo (or push the included Dockerfile), and you get a URL like https://yourapp.onrender.com. Open /configure there, generate your install link, and install. Set ABB_DOMAIN as an env var on the host so you can update it without redeploying code.
* Any VPS: docker build -t torbox-audiobooks . && docker run -p 7000:7000 -e ABB_DOMAIN=audiobookbay.lu torbox-audiobooks, then put it behind HTTPS (Caddy, Nginx, or Cloudflare Tunnel).

Because each user TorBox key lives inside their own install URL, a single deployed instance can safely serve just you (or several people) without sharing credentials.

## Systemd / Linux Service (VPS)

If you are deploying on a Linux server without Docker, you can run the addon continuously as a background service using systemd.

Step 1: Create a system-wide environment file
Create a secure configuration file in your `/etc/` directory:
sudo tee /etc/bustaudio.env >/dev/null <<'EOF'
PORT=7000
JACKETT_URL=http://127.0.0.1:9117
JACKETT_API_KEY=your_jackett_key
ACCESS_TOKENS=your_secret_token
EOF

Step 2: Secure the file
sudo chmod 600 /etc/bustaudio.env

Step 3: Install the service
Copy the provided service file from the `deploy` folder to your systemd directory (be sure to edit it if your clone path is different):
sudo cp deploy/bustaudio.service /etc/systemd/system/

Step 4: Enable and start the addon
sudo systemctl daemon-reload
sudo systemctl enable bustaudio
sudo systemctl start bustaudio

## Uncached torrents

If a torrent is not already cached on TorBox, the addon adds it (TorBox starts pulling it from peers) and the stream shows a Downloading entry. Re-open the title after a bit and the playable file links appear. If you only ever want instant results, you can gate on checkCached() in torbox.js and skip uncached items.

## Notes

* Custom content type: Audiobooks use a custom audiobook type. Stremio shows it under Discover and its player handles audio. Rendering of custom types can vary slightly between Stremio clients.
* Multi-file audiobooks: A folder of MP3 chapters appears as one stream per file, sorted naturally. Single-file .m4b shows as one stream.
* Hosting: For use beyond your own machine, deploy behind HTTPS (Stremio requires HTTPS for remote addons). Any Node host works. Set PORT via env.
* Content: Point your indexer at sources you are entitled to use, e.g. public-domain audiobooks (LibriVox and similar) are freely shareable.

## Files

src/index.js: Express server, configure page, manifest, catalog, meta, stream, health routes
src/torbox.js: TorBox API client, resolveStreams flow, batch cache checks
src/sources.js: Search sources (AudiobookBay scraper and Jackett)
src/metadata.js: Cover art and author enrichment via Open Library (cached)
src/cache.js: TTL/LRU cache, concurrency limiter, timeout helper
src/itemid.js: Encode and decode the payload carried in item ids
src/manifest.js: Addon manifest (custom audiobook type, search catalog)
src/config.js: Packs the API key into the install URL
src/access.js: Optional shared-secret gate for hosting
test/parse.test.js: Unit tests for the pure logic

## Legal disclaimer

BusTAudioBooks is a neutral piece of software. It does not host, contain, or directly distribute any copyrighted material. It is just a search aggregator and API router that sends text and links to TorBox.

When you use this addon, you are plugging in your own TorBox API key. You are entirely responsible for the content you choose to access and for ensuring you have the legal right to stream or download it.

TorBox has its own Terms of Service regarding copyrighted material. You need to follow them. We encourage using this tool to access public-domain audiobooks (like those from LibriVox) that are freely and legally shareable.
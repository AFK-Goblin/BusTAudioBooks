// src/sources.js
// Where audiobook torrents come from. Two built-in sources:
//
//   1. AudiobookBay (ABB) — scraped directly, so NO Jackett/Prowlarr needed.
//   2. Jackett/Prowlarr   — optional, used only if you fill in its URL + key.
//
// Each source returns a normalized list of:
//   { name, infohash, magnet, size, seeders, tracker }
// `magnet` may be null — torbox.js will rebuild one from the infohash.
//
// `searchAudiobooks(config, query)` is the only function index.js calls.

const { TTLCache, pLimit, withRetry } = require("./cache");

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Caches keep searches snappy and reduce load on ABB (fewer requests = less
// chance of getting rate-limited or Cloudflare-challenged).
const listCache = new TTLCache(5 * 60 * 1000, 200); // search pages, 5 min
const detailCache = new TTLCache(60 * 60 * 1000, 1000); // detail pages, 1 h
const limitAbb = pLimit(5); // at most 5 concurrent ABB fetches

const AUDIOBOOK_CATEGORIES = []; // empty = don't filter; rely on the indexer being audiobook-only

// Torznab 7030 = Books/Comics. Overridable for indexers that file manga/comics
// elsewhere: COMIC_CATEGORIES="7030,8000" etc.
const COMIC_CATEGORIES = (process.env.COMIC_CATEGORIES || "7030")
  .split(",")
  .map((n) => parseInt(n, 10))
  .filter((n) => Number.isFinite(n));

// ---------------------------------------------------------------------------
// Small HTML helpers (dependency-free). For heavier scraping you could swap in
// `cheerio`, but regex keeps this zero-install and easy to host anywhere.
// ---------------------------------------------------------------------------
function stripTags(s) {
  return (s || "").replace(/<[^>]*>/g, "").trim();
}
function decodeEntities(s) {
  return (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&#0?38;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#8217;/g, "\u2019")
    .replace(/&#8216;/g, "\u2018")
    .replace(/&#8211;/g, "\u2013")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
function clean(s) {
  return decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim();
}
function sizeToBytes(numStr, unit) {
  const n = parseFloat(String(numStr).replace(/,/g, ""));
  if (!isFinite(n)) return 0;
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.round(n * (mult[unit.toUpperCase()] || 1));
}

// Rough "how good is this rip" score, used as a secondary sort so cleaner
// versions of the same book surface first. Higher is better.
function qualityScore(item) {
  let score = 0;
  // Bitrate dominates perceived audio quality.
  const br = item.bitrate && String(item.bitrate).match(/(\d+)/);
  if (br) score += Math.min(parseInt(br[1], 10), 512) * 10;
  // Container preference for audiobooks: chaptered/lossless slightly preferred.
  const fmt = (item.format || "").toLowerCase();
  if (/m4b/.test(fmt)) score += 400;
  else if (/flac|m4a|aac/.test(fmt)) score += 200;
  else if (/mp3/.test(fmt)) score += 100;
  // Size as a faint tiebreaker (bigger usually = higher bitrate).
  score += Math.min((item.size || 0) / (1024 * 1024), 2000) * 0.1;
  return Math.round(score);
}

// Comic equivalent of qualityScore. Bitrate is meaningless here; instead prefer
// formats the app can actually open (CBZ ≫ CBR — no RAR support on-device),
// with size as a faint "more pages / higher-res scans" tiebreaker.
function comicQualityScore(item) {
  let score = 0;
  const fmt = (item.format || "").toLowerCase();
  if (/cbz/.test(fmt)) score += 400;
  else if (/cb7|cbt/.test(fmt)) score += 250;
  else if (/pdf/.test(fmt)) score += 150;
  else if (/cbr/.test(fmt)) score += 50;
  score += Math.min((item.size || 0) / (1024 * 1024), 4000) * 0.1;
  return Math.round(score);
}

// ===========================================================================
// Source 1: AudiobookBay
// ===========================================================================
// ABB rotates domains often and occasionally changes its HTML. The domain is
// configurable (per-user in the configure page, or via the ABB_DOMAIN env var)
// so you can point at the current working one without editing code.
function abbDomain(config) {
  const raw = (config.abbDomain || process.env.ABB_DOMAIN || "").trim();
  if (!raw) return null;
  return raw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

async function abbFetchRaw(url) {
  return withRetry(
    async () => {
      const res = await fetch(url, {
        headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
      });
      if (!res.ok) throw new Error(`ABB HTTP ${res.status} for ${url}`);
      const text = await res.text();
      // Crude Cloudflare-challenge detection so the failure mode is obvious.
      if (/cf-browser-verification|Just a moment\.\.\./i.test(text)) {
        throw new Error("ABB is behind a Cloudflare challenge (needs a solver or a different domain)");
      }
      return text;
    },
    { retries: 2, baseDelayMs: 300 }
  );
}

// Cached + concurrency-limited fetch.
function abbFetch(url, cache) {
  if (cache) {
    const hit = cache.get(url);
    if (hit !== undefined) return Promise.resolve(hit);
  }
  return limitAbb(abbFetchRaw)(url).then((text) => {
    if (cache) cache.set(url, text);
    return text;
  });
}

// Parse a search-results page -> [{ title, detailUrl }]
function parseAbbList(html, domain) {
  const out = [];
  const seen = new Set();
  const push = (href, rawTitle) => {
    const title = clean(rawTitle);
    if (!title || seen.has(href)) return;
    seen.add(href);
    out.push({ title, detailUrl: `https://${domain}${href}` });
  };

  // Primary: post-title links marked rel="bookmark".
  const primary = /<a[^>]+href="(\/(?:abss|audio-books)\/[^"]+)"[^>]*rel="bookmark"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = primary.exec(html)) !== null) push(m[1], m[2]);

  // Fallback: any link into a book detail path (covers layout changes where
  // rel="bookmark" is dropped). Deduped against the primary matches.
  if (out.length === 0) {
    const fallback = /<a[^>]+href="(\/(?:abss|audio-books)\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = fallback.exec(html)) !== null) push(m[1], m[2]);
  }
  return out;
}

// Pull a labelled field value out of ABB's detail table, e.g. "Format" -> "MP3".
function grabField(html, label) {
  // Try the table-cell layout first: <td>Label:</td><td>VALUE</td>
  const cell = html.match(
    new RegExp(label + "\\s*:?\\s*<\\/td>\\s*<td[^>]*>\\s*([^<]{1,40})", "i")
  );
  if (cell) return clean(cell[1]);
  // Fall back to inline text: "Label: VALUE"
  const inline = html.match(new RegExp(label + "\\s*:?\\s*([A-Za-z0-9 .,/+]{1,40})", "i"));
  return inline ? clean(inline[1]) : null;
}

// Parse a detail page -> { infohash, trackers[], size, format, bitrate }
function parseAbbDetail(html) {
  let infohash = null;
  const idx = html.search(/info\s*hash/i);
  if (idx !== -1) {
    const after = html.slice(idx, idx + 400);
    const h = after.match(/([A-Fa-f0-9]{40})/);
    if (h) infohash = h[1].toLowerCase();
  }
  if (!infohash) {
    // Last resort: a magnet link present on the page.
    const mag = html.match(/xt=urn:btih:([0-9A-Fa-f]{40})/i);
    if (mag) infohash = mag[1].toLowerCase();
  }

  const trackers = [];
  const trRe = /(udp|https?):\/\/[^\s"'<>]+/gi;
  let t;
  while ((t = trRe.exec(html)) !== null) {
    const url = t[0];
    if (/announce/i.test(url) || url.startsWith("udp://")) trackers.push(url);
  }

  let size = 0;
  const sIdx = html.search(/file\s*size/i);
  if (sIdx !== -1) {
    const sm = html.slice(sIdx, sIdx + 120).match(/([\d.,]+)\s*(B|KB|MB|GB|TB)s?\b/i);
    if (sm) size = sizeToBytes(sm[1], sm[2]);
  }

  const format = grabField(html, "Format");
  let bitrate = grabField(html, "Bitrate");
  if (bitrate && !/kbps/i.test(bitrate)) bitrate = bitrate.replace(/\s+/g, " ").trim();

  return { infohash, trackers: [...new Set(trackers)], size, format, bitrate };
}

function buildMagnet(infohash, trackers, name) {
  if (!trackers || trackers.length === 0) return null; // torbox.js adds fallbacks
  const dn = name ? `&dn=${encodeURIComponent(name)}` : "";
  const tr = trackers.map((x) => `&tr=${encodeURIComponent(x)}`).join("");
  return `magnet:?xt=urn:btih:${infohash}${dn}${tr}`;
}

async function searchAudiobookBay(config, query, page = 1) {
  const domain = abbDomain(config);
  if (!domain) return []; // not configured

  const pagePath = page > 1 ? `/page/${page}` : "";
  const listUrl = `https://${domain}${pagePath}/?s=${encodeURIComponent(query)}`;
  let listHtml;
  try {
    listHtml = await abbFetch(listUrl, listCache);
  } catch (err) {
    console.error("ABB list fetch failed:", err.message);
    return [];
  }

  const posts = parseAbbList(listHtml, domain).slice(0, 12); // cap detail fetches

  const settled = await Promise.allSettled(
    posts.map(async (p) => {
      const detailHtml = await abbFetch(p.detailUrl, detailCache);
      const { infohash, trackers, size, format, bitrate } = parseAbbDetail(detailHtml);
      if (!infohash) return null;
      return {
        name: p.title,
        infohash,
        magnet: buildMagnet(infohash, trackers, p.title),
        size,
        seeders: 0, // ABB doesn't expose live seeder counts
        tracker: "AudiobookBay",
        format: format || null,
        bitrate: bitrate || null,
      };
    })
  );

  return settled
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value);
}

// ===========================================================================
// Source 2: Jackett / Prowlarr (optional)
// ===========================================================================
function pickInfohash(result) {
  if (result.InfoHash) return String(result.InfoHash).toLowerCase();
  const magnet = result.MagnetUri || "";
  const m = magnet.match(/xt=urn:btih:([0-9a-zA-Z]+)/i);
  return m ? m[1].toLowerCase() : null;
}

// Pull "[M4B] [128 Kbps]"-style tags out of a Jackett/ABB title.
function parseTitleTags(title) {
  const t = String(title || "");
  const fmt = (t.match(/\[(MP3|M4B|M4A|FLAC|AAC|OGG|OPUS|WAV)\]/i) || [])[1];
  const br = (t.match(/\[(\d+)\s?kbps\]/i) || [])[1];
  return { format: fmt ? fmt.toUpperCase() : null, bitrate: br ? `${br} kbps` : null };
}

// Comic release titles carry their format as "(CBZ)" / "[cbr]" / a bare word.
function parseComicTags(title) {
  const t = String(title || "");
  const fmt = (t.match(/[\[(]?\b(CBZ|CBR|CB7|CBT|PDF)\b[\])]?/i) || [])[1];
  return { format: fmt ? fmt.toUpperCase() : null, bitrate: null };
}

async function searchJackett(config, query, categories = AUDIOBOOK_CATEGORIES) {
  // Per-user config wins; otherwise fall back to server-wide env vars so a
  // shared instance can provide search without each user configuring Jackett.
  const base = (config.jackettUrl || process.env.JACKETT_URL || "").replace(/\/+$/, "");
  const apiKey = config.jackettApiKey || process.env.JACKETT_API_KEY || "";
  if (!base || !apiKey) return [];

  const url = new URL(`${base}/api/v2.0/indexers/all/results`);
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("Query", query);
  for (const cat of categories) url.searchParams.append("Category[]", String(cat));

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Jackett HTTP ${res.status}`);
  const json = await res.json();
  const results = Array.isArray(json.Results) ? json.Results : [];

  return results
    .map((r) => {
      const infohash = pickInfohash(r); // often null for ABB via Jackett
      // Jackett's `Link` is a /dl/ endpoint that yields the actual .torrent file.
      // We keep the result even without a hash/magnet and resolve it at play time.
      const torrentUrl = r.Link || null;
      if (!infohash && !r.MagnetUri && !torrentUrl) return null; // nothing usable
      const tags = parseTitleTags(r.Title);
      return {
        name: r.Title || "Unknown",
        infohash,
        magnet: r.MagnetUri || null,
        torrentUrl,
        size: typeof r.Size === "number" ? r.Size : 0,
        seeders: typeof r.Seeders === "number" ? r.Seeders : 0,
        tracker: r.Tracker || r.TrackerId || "",
        format: tags.format,
        bitrate: tags.bitrate,
      };
    })
    .filter(Boolean);
}

// ===========================================================================
// Combine all sources
// ===========================================================================
// De-duplicate by a stable key (infohash when we have one, else the torrent
// link), preferring the entry with more seeders / known size.
function dedupeAndSort(settled) {
  const all = [];
  for (const r of settled) {
    if (r.status === "fulfilled") all.push(...r.value);
    else console.error("source failed:", r.reason && r.reason.message);
  }

  const byKey = new Map();
  for (const item of all) {
    const key = item.infohash || item.torrentUrl || item.magnet || item.name;
    const existing = byKey.get(key);
    if (!existing || item.seeders > existing.seeders || (!existing.size && item.size)) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()].sort((a, b) => b.seeders - a.seeders);
}

async function searchAudiobooks(config, query, page = 1) {
  const results = await Promise.allSettled([
    searchAudiobookBay(config, query, page),
    page === 1 ? searchJackett(config, query) : Promise.resolve([]),
  ]);
  return dedupeAndSort(results);
}

// Comics come from Jackett only (ABB is audiobook-only). Same page-1-only rule
// as the audiobook Jackett path, since Jackett results aren't paginated here.
async function searchComics(config, query, page = 1) {
  if (page > 1) return [];
  const results = await Promise.allSettled([searchJackett(config, query, COMIC_CATEGORIES)]);
  return dedupeAndSort(results).map((r) => {
    const tags = parseComicTags(r.name);
    return { ...r, type: "comic", format: tags.format, bitrate: null };
  });
}

module.exports = {
  searchAudiobooks,
  searchComics,
  qualityScore,
  comicQualityScore,
  // exported for testing
  _parseAbbList: parseAbbList,
  _parseAbbDetail: parseAbbDetail,
  _buildMagnet: buildMagnet,
  _parseTitleTags: parseTitleTags,
  _parseComicTags: parseComicTags,
  _searchJackett: searchJackett,
};

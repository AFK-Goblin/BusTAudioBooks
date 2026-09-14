// src/mangadex.js
// The "Series" comic source: ongoing manga/webtoons via MangaDex's official
// REST API. Torrents cover finished/bundled series; weekly scanlations live
// here instead — no torrent, no TorBox, pages come straight from MangaDex's
// CDN over HTTPS.
//
// Etiquette (per https://api.mangadex.org/docs/2-limitations/):
//   - ~5 req/s per IP globally           → 250ms spacer + pLimit(4)
//   - 40 req/min on /at-home/server      → dedicated 1600ms spacer
//   - a real, non-spoofed User-Agent is REQUIRED on API calls
//   - never hardcode page baseUrls — they expire (~15 min) and vary by node
const { TTLCache, pLimit, withRetry } = require("./cache");

const MD_API = "https://api.mangadex.org";
const MD_UA = "BusTAudio/2.1.0 (+https://github.com/AFK-Goblin/BusTAudioBooks)";

const SEARCH_PAGE_SIZE = 24;
const FEED_PAGE_SIZE = 500; // documented max for feeds
const FEED_MAX_LOOPS = 6; // hard cap: 3000 chapters per series
const CONTENT_RATINGS = ["safe", "suggestive"];

// Minimum-interval gate: each caller waits until `ms` after the previous one.
function makeSpacer(ms) {
  let last = 0;
  let chain = Promise.resolve();
  return () => {
    chain = chain.then(async () => {
      const wait = last + ms - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
    });
    return chain;
  };
}

const spaceApi = makeSpacer(250); // ≤4/s < the 5/s cap
const spaceAtHome = makeSpacer(1600); // ≤37.5/min < the 40/min cap
const limitMd = pLimit(4);

const mdSearchCache = new TTLCache(5 * 60 * 1000, 200); // query|page
const mdFeedCache = new TTLCache(10 * 60 * 1000, 100); // mangaId -> full deduped feed
const mdPagesCache = new TTLCache(3 * 60 * 1000, 300); // chapterId|saver (short: baseUrl expires)

async function mdFetch(path, params = {}, { atHome = false } = {}) {
  const url = new URL(`${MD_API}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x));
    else if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return withRetry(
    () =>
      limitMd(async () => {
        await (atHome ? spaceAtHome() : spaceApi());
        const res = await fetch(url, { headers: { "User-Agent": MD_UA, Accept: "application/json" } });
        if (res.status === 429) {
          // Respect Retry-After (capped), then throw so withRetry re-runs us.
          // Note: withRetry adds its own small backoff (~400ms) on top — that
          // stacking is deliberate slack, not a bug; do not "fix" by removing
          // this sleep or a long Retry-After would be under-waited.
          const after = Math.min(parseInt(res.headers.get("retry-after"), 10) || 1, 5);
          await new Promise((r) => setTimeout(r, after * 1000));
          throw new Error("MangaDex rate limit (429)");
        }
        if (!res.ok) throw new Error(`MangaDex HTTP ${res.status} for ${path}`);
        return res.json();
      })(),
    { retries: 2, baseDelayMs: 400 }
  );
}

// ---------------------------------------------------------------------------
// Pure mapping helpers (unit-tested, no network)
// ---------------------------------------------------------------------------
function coverUrl(mangaId, fileName) {
  if (!mangaId || !fileName) return null;
  // Premade 512px-wide thumbnail; the FULL original filename stays in the URL.
  return `https://uploads.mangadex.org/covers/${mangaId}/${fileName}.512.jpg`;
}

function pickTitle(attributes) {
  const t = (attributes && attributes.title) || {};
  if (t.en) return t.en;
  const first = Object.values(t)[0];
  if (first) return first;
  const alts = (attributes && attributes.altTitles) || [];
  for (const alt of alts) if (alt.en) return alt.en;
  return "Untitled";
}

// GET /manga response -> normalized series list.
function parseMangaList(json) {
  const data = (json && json.data) || [];
  return data.map((m) => {
    const attrs = m.attributes || {};
    const rels = m.relationships || [];
    const cover = rels.find((r) => r.type === "cover_art");
    const author = rels.find((r) => r.type === "author");
    return {
      mangaId: m.id,
      title: pickTitle(attrs),
      description: ((attrs.description && (attrs.description.en || Object.values(attrs.description)[0])) || "")
        .slice(0, 500),
      status: attrs.status || null,
      year: attrs.year || null,
      author: (author && author.attributes && author.attributes.name) || null,
      coverFileName: (cover && cover.attributes && cover.attributes.fileName) || null,
    };
  });
}

// GET /manga/{id}/feed response -> raw chapter list.
function parseFeed(json) {
  const data = (json && json.data) || [];
  return data.map((c) => {
    const attrs = c.attributes || {};
    const group = (c.relationships || []).find((r) => r.type === "scanlation_group");
    return {
      id: c.id,
      num: attrs.chapter != null ? String(attrs.chapter) : null,
      title: attrs.title || null,
      pages: typeof attrs.pages === "number" ? attrs.pages : 0,
      publishedAt: attrs.publishAt || attrs.readableAt || null,
      group: (group && group.attributes && group.attributes.name) || null,
      externalUrl: attrs.externalUrl || null,
    };
  });
}

// Drop unhostable chapters, dedupe multi-group uploads, order for reading.
function filterAndDedupeChapters(chapters) {
  const hosted = (chapters || []).filter((c) => !c.externalUrl && c.pages > 0);

  // One entry per chapter number: keep the most recently published upload.
  // (null-numbered oneshots are all kept, keyed by their own id.)
  const byNum = new Map();
  for (const c of hosted) {
    const key = c.num != null ? `n:${c.num}` : `id:${c.id}`;
    const prev = byNum.get(key);
    if (!prev || String(c.publishedAt || "") > String(prev.publishedAt || "")) byNum.set(key, c);
  }

  return [...byNum.values()].sort((a, b) => {
    if (a.num == null && b.num == null) return String(a.publishedAt || "").localeCompare(String(b.publishedAt || ""));
    if (a.num == null) return 1; // oneshots last
    if (b.num == null) return -1;
    return parseFloat(a.num) - parseFloat(b.num);
  });
}

// GET /at-home/server/{id} response -> ordered page URLs. When data-saver is
// requested but the chapter has no dataSaver variant, fall back to full
// quality rather than returning zero pages (which would make it unreadable).
function buildPageUrls(atHomeJson, saver = false) {
  const base = atHomeJson && atHomeJson.baseUrl;
  const ch = atHomeJson && atHomeJson.chapter;
  if (!base || !ch || !ch.hash) return [];
  const useSaver = saver && Array.isArray(ch.dataSaver) && ch.dataSaver.length > 0;
  const files = (useSaver ? ch.dataSaver : ch.data) || [];
  const quality = useSaver ? "data-saver" : "data";
  return files.map((f) => `${base}/${quality}/${ch.hash}/${f}`);
}

// ---------------------------------------------------------------------------
// Public API (network + cache)
// ---------------------------------------------------------------------------
async function searchManga(query, page = 1) {
  const key = `${query.toLowerCase()}|${page}`;
  const hit = mdSearchCache.get(key);
  if (hit) return hit;

  const json = await mdFetch("/manga", {
    title: query,
    limit: SEARCH_PAGE_SIZE,
    offset: (page - 1) * SEARCH_PAGE_SIZE,
    "includes[]": ["cover_art", "author"],
    "availableTranslatedLanguage[]": ["en"],
    "contentRating[]": CONTENT_RATINGS,
    "order[relevance]": "desc",
  });
  const results = parseMangaList(json).map((m) => ({
    ...m,
    poster: coverUrl(m.mangaId, m.coverFileName),
  }));
  mdSearchCache.set(key, results);
  return results;
}

// Full English chapter list for a series: fetched in 500-chapter pages,
// filtered/deduped once, cached — so client-side pagination, checkmarks and
// "next chapter" all see one stable, complete list.
async function getChapterFeed(mangaId) {
  const hit = mdFeedCache.get(mangaId);
  if (hit) return hit;

  const feedPage = (offset) =>
    mdFetch(`/manga/${mangaId}/feed`, {
      limit: FEED_PAGE_SIZE,
      offset,
      "translatedLanguage[]": ["en"],
      "order[chapter]": "asc",
      "includes[]": ["scanlation_group"],
      "contentRating[]": CONTENT_RATINGS,
    });

  // First page tells us the total; remaining pages go out concurrently (the
  // spacer still paces them for etiquette, but their round-trips overlap
  // instead of stacking serially — matters for 1000+ chapter series).
  const first = await feedPage(0);
  const all = parseFeed(first);
  const total = typeof first.total === "number" ? first.total : all.length;
  if (total > all.length) {
    const offsets = [];
    for (let i = 1; i < FEED_MAX_LOOPS && i * FEED_PAGE_SIZE < total; i++) {
      if (i * FEED_PAGE_SIZE + FEED_PAGE_SIZE > 10000) break; // documented collection cap
      offsets.push(i * FEED_PAGE_SIZE);
    }
    const rest = await Promise.all(offsets.map((o) => feedPage(o)));
    for (const json of rest) all.push(...parseFeed(json));
  }

  const chapters = filterAndDedupeChapters(all);
  mdFeedCache.set(mangaId, chapters);
  return chapters;
}

// Page image URLs for one chapter. `fresh` skips the cache — used by the
// reader's self-heal when a baseUrl has expired mid-read.
async function getPages(chapterId, { saver = false, fresh = false } = {}) {
  const key = `${chapterId}|${saver ? "s" : "d"}`;
  if (!fresh) {
    const hit = mdPagesCache.get(key);
    if (hit) return hit;
  }
  const json = await mdFetch(`/at-home/server/${chapterId}`, {}, { atHome: true });
  const pages = buildPageUrls(json, saver);
  const result = { pages, pageCount: pages.length };
  mdPagesCache.set(key, result);
  return result;
}

module.exports = {
  searchManga,
  getChapterFeed,
  getPages,
  // exported for testing
  _parseMangaList: parseMangaList,
  _parseFeed: parseFeed,
  _filterAndDedupeChapters: filterAndDedupeChapters,
  _buildPageUrls: buildPageUrls,
  _coverUrl: coverUrl,
  _pickTitle: pickTitle,
  _makeSpacer: makeSpacer,
};

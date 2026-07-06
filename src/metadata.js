// src/metadata.js
// Best-effort cover art + author lookup so the catalog grid looks like real
// audiobooks instead of blank tiles. Tries audiobook-native sources first for
// much better coverage than a single books API:
//   1. iTunes Search (media=audiobook)  — purpose-built, high-res artwork
//   2. Google Books                     — huge catalogue incl. foreign titles
//   3. Open Library                     — free fallback
// Everything here is non-blocking and cached: if it all fails, the addon just
// falls back to the title with no poster.

const { TTLCache, withTimeout } = require("./cache");

const metaCache = new TTLCache(24 * 60 * 60 * 1000, 5000); // 24h

const NOISE = new RegExp(
  [
    "unabridged", "abridged", "audio ?books?", "audible",
    "mp3", "m4b", "m4a", "flac", "aac", "ogg", "opus", "wav", "vbr", "cbr",
    "\\d+\\s?kbps", "\\d+\\s?khz", "retail", "complete", "fully chaptered",
  ].join("|"),
  "gi"
);

function stripBrackets(s) {
  return String(s || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\{[^}]*\}/g, " ");
}

// ABB/Jackett titles are usually "Title - Author [tags]". Pull them apart so we
// can query providers precisely.
function parseNameParts(raw) {
  let s = stripBrackets(raw);
  s = s.replace(/narrated by.*$/i, " ").replace(NOISE, " ");
  s = s.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  const parts = s.split(/\s+[-–—:]\s+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { title: parts[0], author: parts.slice(1).join(" ").trim() || null };
  }
  return { title: s, author: null };
}

// Backwards-compatible helper (used in tests).
function cleanTitle(raw) {
  return parseNameParts(raw).title;
}

// iTunes artwork comes as 100x100; bump it to a crisp 600x600.
function upscaleItunes(url) {
  if (!url) return null;
  return url.replace(/\/\d+x\d+bb?\.(jpg|png|jpeg)/i, "/600x600bb.$1");
}

async function fromItunes(title, author) {
  const term = [title, author].filter(Boolean).join(" ");
  const url =
    "https://itunes.apple.com/search?media=audiobook&limit=1&term=" +
    encodeURIComponent(term);
  const res = await fetch(url);
  if (!res.ok) return null;
  const j = await res.json();
  const d = j.results && j.results[0];
  const poster = d && upscaleItunes(d.artworkUrl100 || d.artworkUrl60);
  if (!poster) return null;
  return { poster, author: (d && d.artistName) || author || null };
}

async function fromGoogleBooks(title, author) {
  const q = [title, author ? `inauthor:${author}` : ""].filter(Boolean).join("+");
  const url =
    "https://www.googleapis.com/books/v1/volumes?maxResults=1&country=US&q=" +
    encodeURIComponent(q);
  const res = await fetch(url);
  if (!res.ok) return null;
  const j = await res.json();
  const v = j.items && j.items[0] && j.items[0].volumeInfo;
  let img = v && v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail);
  if (!img) return null;
  img = img.replace(/^http:/, "https:").replace(/&edge=curl/, "");
  return { poster: img, author: (v.authors && v.authors[0]) || author || null };
}

async function fromOpenLibrary(title, author) {
  const q = [title, author].filter(Boolean).join(" ");
  const url =
    "https://openlibrary.org/search.json?limit=1&fields=title,author_name,cover_i&q=" +
    encodeURIComponent(q);
  const res = await fetch(url, { headers: { "User-Agent": "bustaudio-addon" } });
  if (!res.ok) return null;
  const j = await res.json();
  const d = j.docs && j.docs[0];
  if (!d || !d.cover_i) return null;
  return {
    poster: `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`,
    author: (d.author_name && d.author_name[0]) || author || null,
  };
}

// Returns { poster, author } — always resolves, never throws.
async function enrich(raw) {
  const key = String(raw || "").toLowerCase().trim();
  if (!key) return { poster: null, author: null };

  const hit = metaCache.get(key);
  if (hit !== undefined) return hit;

  const { title, author } = parseNameParts(raw);
  let result = { poster: null, author: author || null };

  if (title.length >= 2) {
    // Query all three in parallel (each guarded), then prefer by quality.
    const [it, gb, ol] = await Promise.all([
      withTimeout(fromItunes(title, author).catch(() => null), 2200, null),
      withTimeout(fromGoogleBooks(title, author).catch(() => null), 2200, null),
      withTimeout(fromOpenLibrary(title, author).catch(() => null), 2200, null),
    ]);
    const best = it || gb || ol;
    if (best) result = best;
  }

  metaCache.set(key, result); // cache even empty results to avoid re-querying
  return result;
}

module.exports = {
  enrich,
  cleanTitle,
  parseNameParts,
  _upscaleItunes: upscaleItunes,
  _metaCache: metaCache,
};

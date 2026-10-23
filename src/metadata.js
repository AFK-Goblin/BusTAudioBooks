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
  if (!res.ok) throw new Error(`iTunes HTTP ${res.status}`);
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
  if (!res.ok) throw new Error(`Google Books HTTP ${res.status}`);
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
  if (!res.ok) throw new Error(`Open Library HTTP ${res.status}`);
  const j = await res.json();
  const d = j.docs && j.docs[0];
  if (!d || !d.cover_i) return null;
  return {
    poster: `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`,
    author: (d.author_name && d.author_name[0]) || author || null,
  };
}

// { ok: true, value } when the provider answered (value may be null: no
// match), { ok: false } when it failed or ran past `ms`.
function tryProvider(run, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false }), ms);
    Promise.resolve()
      .then(run)
      .then(
        (value) => { clearTimeout(timer); resolve({ ok: true, value }); },
        () => { clearTimeout(timer); resolve({ ok: false }); }
      );
  });
}

// Returns { poster, author } — always resolves, never throws.
async function enrich(raw) {
  const name = String(raw || "").toLowerCase().trim();
  if (!name) return { poster: null, author: null };
  const key = name;

  const hit = metaCache.get(key);
  if (hit !== undefined) return hit;

  const { title, author } = parseNameParts(raw);
  let result = { poster: null, author: author || null };

  let failed = false;
  if (title.length >= 2) {
    // iTunes first (fast, ~0.4 s, best artwork). Only on a miss ask the other
    // two, together — Open Library alone often takes 1–2 s, and waiting on all
    // three for every result made searches take 10 s or more.
    const it = await tryProvider(() => fromItunes(title, author), 1500);
    if (it.ok && it.value) {
      result = it.value;
    } else {
      const [gb, ol] = await Promise.all([
        tryProvider(() => fromGoogleBooks(title, author), 2000),
        tryProvider(() => fromOpenLibrary(title, author), 2000),
      ]);
      const best = (gb.ok && gb.value) || (ol.ok && ol.value);
      if (best) result = best;
      failed = !best && (!it.ok || !gb.ok || !ol.ok);
    }
  }

  // Cache misses too, to avoid re-querying — but a miss caused by a rate limit
  // or timeout only briefly, or that title would stay coverless all day.
  metaCache.set(key, result, failed ? 10 * 60 * 1000 : undefined);
  return result;
}

// ---- details (the app's book page) -------------------------------------------
// A synopsis is only worth showing if it belongs to the right book, so details
// require the matched title to share most words with the torrent's title.
// (Covers in search keep their looser matching — a near-miss cover is harmless.)

const detailsCache = new TTLCache(24 * 60 * 60 * 1000, 2000);

const STOPWORDS = new Set(["the", "a", "an", "of", "and", "book", "series", "unabridged", "abridged"]);
function words(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOPWORDS.has(w));
}

// Share of the wanted title's words found in the candidate's title.
function titleOverlap(wanted, candidate) {
  const want = words(wanted);
  if (want.length === 0) return 0;
  const have = new Set(words(candidate));
  return want.filter((w) => have.has(w)).length / want.length;
}

// iTunes/Google descriptions are HTML; the app shows plain paragraphs.
function plainText(html) {
  return decodeHtml(
    String(html || "")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/\s*(p|div|li|h\d)\s*>/gi, "\n\n")
      .replace(/<\s*(p|div|li|h\d)(\s[^>]*)?>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function decodeHtml(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

const MAX_DESCRIPTION = 4000;

async function detailsFromItunes(title, author) {
  const term = [title, author].filter(Boolean).join(" ");
  const res = await fetch(
    "https://itunes.apple.com/search?media=audiobook&limit=5&term=" + encodeURIComponent(term)
  );
  if (!res.ok) return null;
  const j = await res.json();
  const match = (j.results || []).find((r) => titleOverlap(title, r.collectionName) >= 0.6);
  if (!match || !match.description) return null;
  return {
    description: plainText(match.description).slice(0, MAX_DESCRIPTION),
    genre: match.primaryGenreName || null,
    year: /^\d{4}/.test(match.releaseDate || "") ? Number(match.releaseDate.slice(0, 4)) : null,
    author: match.artistName || author || null,
  };
}

async function detailsFromGoogleBooks(title, author) {
  const q = [title, author ? `inauthor:${author}` : ""].filter(Boolean).join("+");
  const res = await fetch(
    "https://www.googleapis.com/books/v1/volumes?maxResults=5&country=US&q=" + encodeURIComponent(q)
  );
  if (!res.ok) return null;
  const j = await res.json();
  const v = (j.items || [])
    .map((item) => item.volumeInfo || {})
    .find((info) => info.description && titleOverlap(title, info.title) >= 0.6);
  if (!v) return null;
  return {
    description: plainText(v.description).slice(0, MAX_DESCRIPTION),
    genre: (v.categories && v.categories[0]) || null,
    year: /^\d{4}/.test(v.publishedDate || "") ? Number(v.publishedDate.slice(0, 4)) : null,
    author: (v.authors && v.authors[0]) || author || null,
  };
}

// Returns { description, genre, year, author } (fields may be null) — always
// resolves, never throws.
async function details(raw) {
  const key = String(raw || "").toLowerCase().trim();
  const hit = detailsCache.get(key);
  if (hit !== undefined) return hit;
  const { title, author } = parseNameParts(raw);
  let result = { description: null, genre: null, year: null, author: author || null };
  if (title.length >= 2) {
    const it = await withTimeout(detailsFromItunes(title, author).catch(() => null), 3000, null);
    const best = it || (await withTimeout(detailsFromGoogleBooks(title, author).catch(() => null), 3000, null));
    if (best) result = best;
  }
  // A miss may just be a slow provider: remember it briefly, a hit for a day.
  detailsCache.set(key, result, result.description ? undefined : 10 * 60 * 1000);
  return result;
}

module.exports = {
  enrich,
  details,
  cleanTitle,
  parseNameParts,
  _upscaleItunes: upscaleItunes,
  _metaCache: metaCache,
  _titleOverlap: titleOverlap,
  _plainText: plainText,
  _detailsCache: detailsCache,
};

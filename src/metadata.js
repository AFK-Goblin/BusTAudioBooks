// src/metadata.js
// Best-effort cover art + author lookup so the catalog grid looks like real
// audiobooks instead of blank tiles. Tries audiobook-native sources first for
// much better coverage than a single books API:
//   1. iTunes Search (media=audiobook)  — purpose-built, high-res artwork
//   2. Google Books                     — huge catalogue incl. foreign titles
//   3. Open Library                     — free fallback
// Everything here is non-blocking and cached: if it all fails, the addon just
// falls back to the title with no poster.

const { normalizeLanguage } = require("./language");
const { TTLCache, withTimeout } = require("./cache");

const inFlight = new Map();
const metaCache = new TTLCache(24 * 60 * 60 * 1000, 5000); // 24h

const NOISE = new RegExp(
  [
    "unabridged", "abridged", "audio ?books?", "audible",
    "mp3", "m4b", "m4a", "flac", "aac", "ogg", "opus", "wav", "vbr", "cbr",
    "\\d+\\s?kbps", "\\d+\\s?khz", "retail", "complete", "fully chaptered",
  ].join("|"),
  "gi"
);

// Comic release noise — applied ONLY to comic titles, never audiobooks:
// "digital" or a bare "V2" are legitimate words in book titles
// ("Digital Minimalism") and stripping them would break audiobook lookups.
const COMIC_NOISE = new RegExp(
  [
    "cbz", "cb7", "cbt", "digital", "webtoon", "scanlation",
    "\\bv\\d{1,3}\\b", "\\bc\\d{1,4}(?:-\\d{1,4})?\\b",
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
function parseNameParts(raw, type = "audiobook") {
  // A compact group suffix after a language/format marker is release noise,
  // e.g. "FR -PiXeL" or "[MP3]-SomeGroup". Keep ordinary hyphenated titles
  // and "Title - Author" separators intact.
  const withoutGroup = String(raw || '').replace(
    /(\b(?:FR|EN|FRENCH|ENGLISH|VFF|VFQ|VFI|MP3|M4B|M4A|FLAC|AAC|OGG|OPUS)\b[\s.\]})]*)-[\p{L}\d][\p{L}\d._-]{0,39}\s*$/iu, '$1');
  let s = stripBrackets(withoutGroup);
  // Release-group suffixes are not book metadata. NOTAG is common on French
  // trackers and may follow a hyphen without spaces.
  s = s.replace(/(?:^|[\s._-])NOTAG\s*$/i, " ");
  // Scene releases use dots/underscores instead of spaces. Keep decimal
  // numbers (e.g. volume 1.5), accents, apostrophes and meaningful title words.
  s = s.replace(/(?<!\d)\.|\.(?!\d)/g, " ").replace(/_/g, " ");
  s = s.replace(/\b(?:Tome|T|Vol(?:ume)?)\s*0*(\d+(?:\.\d+)?)\b/gi, "Tome $1");
  // Edition labels can be glued to the author by tracker title formatting
  // ("French EditionTravis Beacham"). Remove the label without the author.
  s = s.replace(/\b(?:french|english)\s+[ée]dition/gi, " ");
  s = s.replace(/\b(?:FRENCH|ENGLISH|FRANÇAIS|FRANCAIS|VFF|VFQ|VFI|MULTI)\b/g, " ");
  s = s.replace(/\b(?:FR|EN)\s*$/, " ");
  s = s.replace(/narrated by.*$/i, " ").replace(NOISE, " ");
  s = s.replace(/\b(?:livres?\s+audio|lu\s+par|non\s+abr[eé]g[eé])\b.*$/i, " ");
  if (type === "comic") s = s.replace(COMIC_NOISE, " ");
  // Release years constrain catalog searches unnecessarily; preserve a title
  // consisting only of a year (e.g. 1984).
  s = s.replace(/\s+(?:19|20)\d{2}\s*$/, " ");
  s = s.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  const parts = s.split(/\s+[-–—:]\s+/).map((x) => x.trim()).filter(Boolean);
  const initialedAuthor = /^(?:[A-Z]{2,3}\s+|(?:[A-Z]\s+){1,3})[\p{Lu}][\p{L}'’\-]+$/u;
  if (parts.length >= 2) {
    if (initialedAuthor.test(parts[0])) return { title: parts.slice(1).join(" - "), author: parts[0] };
    return { title: parts[0], author: parts.slice(1).join(" ").trim() || null };
  }
  const trailingAuthor = s.match(/\s+((?:[A-Z]{2,3}\s+|(?:[A-Z]\s+){1,3})[\p{Lu}][\p{L}'’\-]+)$/u);
  if (trailingAuthor) return { title: s.slice(0, trailingAuthor.index).trim(), author: trailingAuthor[1] };
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

function normalizeCompounds(text) {
  // Releases sometimes split productive prefixes which catalogs join, e.g.
  // "hyper sensible" / "hyper-sensible" versus "hypersensible".
  return String(text || '').replace(/\b(hyper|hypo)[\s-]+(?=[\p{L}]{3})/giu, '$1');
}
function tokens(text) {
  return normalizeCompounds(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().match(/[a-z0-9]+/g) || [];
}
function volumeNumber(text) {
  const match = String(text || '').match(/\b(?:tome|volume|vol|t|season|saison|book|livre)\s*(\d+(?:\.\d+)?)\b/i);
  return match ? Number(match[1]) : null;
}
function matchScore(query, candidate) {
  const wanted = tokens(query).filter(t => !['le', 'la', 'les', 'de', 'du', 'des', 'un', 'une', 'the', 'a', 'tome', 'volume'].includes(t));
  const available = new Set(tokens(candidate));
  // Initials may be written JK, J.K., or J K in release/catalog author names.
  const candidateTokens = tokens(candidate);
  for (let i = 0; i < candidateTokens.length - 1; i++) {
    if (candidateTokens[i].length === 1 && candidateTokens[i + 1].length === 1) available.add(candidateTokens[i] + candidateTokens[i + 1]);
  }
  const derivative = /\b(?:analyse|analysis|summary|résumé|resume|study guide|fiche de lecture)\b/i;
  if (derivative.test(candidate) && !derivative.test(query)) return 0;
  if (!wanted.length) return 0;
  // Do not show another volume's cover when numbered releases match otherwise.
  const volume = volumeNumber(query);
  const other = volumeNumber(candidate);
  if (volume !== null && other !== null && volume !== other) return 0;
  return wanted.filter(t => available.has(t)).length / wanted.length;
}
function catalogScore(query, title, author) {
  const score = matchScore(query, [title, author].filter(Boolean).join(' '));
  if (score === 0) return score;
  // Audio dramas may credit a cast/publisher instead of the book's author.
  // Accept an exact complete-title prefix followed only by a two-part proper
  // name. Do not relax arbitrary partial title or conflicting-volume matches.
  const titleTokens = tokens(title);
  const queryTokens = tokens(query);
  const name = String(query).match(/(?:^|\s)([\p{Lu}][\p{Ll}'’\-]+\s+[\p{Lu}][\p{Ll}'’\-]+)$/u)?.[1];
  const suffix = name ? tokens(name) : [];
  const stop = new Set(['and', 'the', 'of', 'et', 'de', 'du', 'des', 'la', 'le', 'les', 'un', 'une']);
  if (titleTokens.length >= 2 && suffix.length === 2 && !suffix.some(word => stop.has(word)) &&
      queryTokens.length === titleTokens.length + 2 &&
      titleTokens.every((word, i) => word === queryTokens[i]) &&
      suffix.every((word, i) => word === queryTokens[titleTokens.length + i])) return Math.max(score, 0.95);
  return score;
}
function bestMatch(items, query, getTitle, language, getAuthor = () => '') {
  return items.map(item => ({ item, score: catalogScore(query, getTitle(item), getAuthor(item)) }))
    .filter(entry => entry.score >= 0.6)
    .sort((a, b) => b.score - a.score ||
      Number(normalizeLanguage(b.item.language) === language) - Number(normalizeLanguage(a.item.language) === language))[0]?.item;
}
async function fetchJson(url, headers) {
  const res = await fetch(url, { signal: AbortSignal.timeout(2200), headers });
  return res.ok ? res.json() : null;
}
function metadataQuery(title, author) {
  // The catalog tokenizes initials separately: "JK Rowling" and "J K Rowling"
  // can return completely different editions even within the same storefront.
  const normalizedAuthor = String(author || '').replace(/\b([A-Z]{2,3})(?=\s+[\p{Lu}][\p{Ll}])/gu, initials => initials.split('').join(' '));
  // Keep series and author words, but omit release volume markers from the
  // provider query. The original normalized title still validates the match
  // and rejects a conflicting volume when the catalog supplies one.
  const queryTitle = title.replace(/\bTome\s*\d+(?:\.\d+)?\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return normalizeCompounds([queryTitle || title, normalizedAuthor].filter(Boolean).join(' '))
    .replace(/[!?]/g, ' ').replace(/\s+/g, ' ').trim();
}
async function fromItunes(title, author, language) {
  const url = new URL('https://itunes.apple.com/search');
  url.searchParams.set('media', 'audiobook');
  url.searchParams.set('limit', '5');
  url.searchParams.set('country', language === 'fr' ? 'FR' : 'US');
  url.searchParams.set('term', metadataQuery(title, author));
  const j = await fetchJson(url);
  const d = bestMatch(j?.results || [], title, x => x.collectionName || x.trackName, language, x => x.artistName);
  if (!d) return null;
  return { title: d.collectionName || d.trackName, poster: upscaleItunes(d.artworkUrl100 || d.artworkUrl60),
    author: d.artistName || author || null };
}
async function fromGoogleBooks(title, author, language) {
  const url = new URL('https://www.googleapis.com/books/v1/volumes');
  url.searchParams.set('maxResults', '5');
  url.searchParams.set('q', metadataQuery(title, author));
  if (language) url.searchParams.set('langRestrict', language);
  const j = await fetchJson(url);
  const volumes = (j?.items || []).map(item => item.volumeInfo).filter(Boolean);
  const v = bestMatch(volumes, title, x => [x.title, x.subtitle].filter(Boolean).join(' '), language, x => (x.authors || []).join(' '));
  if (!v) return null;
  const img = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail;
  return { title: [v.title, v.subtitle].filter(Boolean).join(' — '),
    poster: img ? img.replace(/^http:/, 'https:').replace(/&edge=curl/, '') : null,
    author: v.authors?.join(', ') || author || null };
}
async function fromOpenLibrary(title, author, language) {
  const url = new URL('https://openlibrary.org/search.json');
  url.searchParams.set('q', metadataQuery(title, author));
  url.searchParams.set('limit', '5');
  url.searchParams.set('fields', 'title,author_name,cover_i,language,editions');
  if (language) url.searchParams.set('lang', language);
  const j = await fetchJson(url, { 'User-Agent': 'bustaudio-addon' });
  const d = bestMatch(j?.docs || [], title, x => x.editions?.docs?.[0]?.title || x.title, language, x => (x.author_name || []).join(' '));
  if (!d) return null;
  return { title: d.editions?.docs?.[0]?.title || d.title, poster: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null,
    author: d.author_name?.join(', ') || author || null };
}

// Type and locale are part of the cache identity. Coalesce release variants
// which normalize to the same title so they share one metadata lookup.
async function enrich(raw, type = "audiobook", language = null) {
  language = normalizeLanguage(language);
  const { title, author } = parseNameParts(raw, type);
  const fallback = { title, poster: null, author: author || null };
  if (title.length < 2) return fallback;
  const key = JSON.stringify([type, language, title.toLowerCase(), author?.toLowerCase()]);
  const hit = metaCache.get(key);
  if (hit !== undefined) return hit;
  if (!inFlight.has(key)) inFlight.set(key, (async () => {
    const [it, gb, ol] = await Promise.all([
      type === 'comic' ? null : withTimeout(fromItunes(title, author, language).catch(() => null), 2200, null),
      withTimeout(fromGoogleBooks(title, author, language).catch(() => null), 2200, null),
      withTimeout(fromOpenLibrary(title, author, language).catch(() => null), 2200, null),
    ]);
    const best = it || gb || ol;
    const result = best ? { ...fallback, ...best, poster: it?.poster || gb?.poster || ol?.poster || null } : fallback;
    // A broad series query can find a useful representative cover, but must
    // not relabel a collection as whichever specific volume ranks first.
    if (best?.title && matchScore(best.title, title) < 0.6) result.title = title;
    // Retry transient empty lookups soon, rather than pinning them for a day.
    metaCache.set(key, result, best ? undefined : 60 * 1000);
    return result;
  })().finally(() => inFlight.delete(key)));
  return inFlight.get(key);
}

module.exports = {
  enrich,
  cleanTitle,
  parseNameParts,
  _upscaleItunes: upscaleItunes,
  _metaCache: metaCache,
  _matchScore: matchScore,
};

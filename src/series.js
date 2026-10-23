// src/series.js
// Which series a book belongs to, and the rest of that series in order, from
// Audible's public catalogue (no account or key needed). Powers the app's
// "Next in series" suggestions. Best-effort and cached: any failure is just
// "no series".
//
//   1. Find the book: keyword search with the torrent's cleaned name (then a
//      title + author search), and keep the best product whose title is
//      (nearly) all in that name. If the best match isn't in a series, the
//      book isn't either — a weaker match that is would be the wrong book.
//   2. Its series product lists the members with their positions.
//   3. One batch lookup gives their titles, covers and release dates.

const { TTLCache, withTimeout } = require("./cache");
const { parseNameParts, _titleOverlap: titleOverlap } = require("./metadata");

const AUDIBLE = "https://api.audible.com/1.0/catalog/products";
const STEP_MS = 4000;
const seriesCache = new TTLCache(24 * 60 * 60 * 1000, 2000);

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Audible HTTP ${res.status}`);
  return res.json();
}
const step = (url) => withTimeout(getJson(url).catch(() => null), STEP_MS, null);

// "Dungeon Crawler Carl, Book 2", "#2", "Vol. 2", "Book Two" → 2.
const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
function numberHint(name) {
  const m = String(name).match(/(?:\bbook|\bvol(?:ume)?\.?|#)\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
  if (!m) return null;
  const n = WORD_NUMBERS[m[1].toLowerCase()] || Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function position(sequence) {
  const n = parseFloat(String(sequence || "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// The series a product is numbered in (Stormlight #1 rather than the
// unnumbered Cosmere it also belongs to); of several, the one the torrent's
// name mentions (Harry Potter rather than Wizarding World).
function numberedSeries(product, name) {
  const numbered = (product.series || []).filter((s) => position(s.sequence) != null);
  if (numbered.length === 0) return null;
  return numbered.reduce((best, s) => (titleOverlap(s.title, name) > titleOverlap(best.title, name) ? s : best));
}

// "Harry Potter and the Chamber of Secrets, Book 2" → without the ", Book 2".
function bareTitle(title) {
  return String(title || "").replace(/,?\s*(?:book|vol(?:ume)?\.?|#|part)\s*\d+(?:\.\d+)?\s*$/i, "");
}

// How well an Audible product matches the torrent name; 0 = not this book.
function matchScore(product, name, title, author, hint) {
  const productTitle = bareTitle(product.title);
  // Nearly every word of the product's title must be in the torrent's name
  // (its subtitle may be left out — "…: A LitRPG Adventure" — at a small cost,
  // so "Mistborn: Secret History" doesn't tie with "Mistborn")...
  const whole = titleOverlap(productTitle, name);
  const inName = whole >= 0.75 ? whole : titleOverlap(productTitle.split(":")[0], name) - 0.1;
  if (inName < 0.65) return 0;
  // ...and it should cover most of the torrent's title (a product called just
  // "Carl" must not match everything with "Carl" in it). Names are sometimes
  // "Author - Title", so either half may be the title.
  const covers = Math.max(titleOverlap(title, productTitle), author ? titleOverlap(author, productTitle) : 0);
  let score = inName * 0.6 + covers * 0.4;
  // Any one of its authors named in the torrent counts (narrators and
  // co-authors are often left out).
  const authors = (product.authors || []).map((a) => a.name).filter(Boolean);
  if (authors.length && author) score += authors.some((a) => titleOverlap(a, name) >= 0.5) ? 0.2 : -0.3;
  // "(Full-Cast Edition)", "(Dramatized Adaptation)": only if the name says so.
  const note = (productTitle.match(/\(([^)]*)\)/) || [])[1];
  if (note && titleOverlap(note, name) < 0.5) score -= 0.1;
  const numbered = numberedSeries(product, name);
  if (hint != null && numbered && position(numbered.sequence) === hint) score += 0.3;
  return score;
}

// The query words that matter: Audible's keyword search wants every word, so
// "Book", "Vol." and numbers would rule the right book out.
function queryWords(text) {
  return String(text)
    .replace(/(?:\bbook|\bvol(?:ume)?\.?|#|\bpart)\s*\d+(?:\.\d+)?/gi, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/[^\p{L}\p{N}'’ ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "The Ghost Brigades: Old Man's War Book 2" → "The Ghost Brigades".
// Bracketed notes go too: "Red Rising (Part 1 of 2) (Dramatized Adaptation)".
function displayTitle(title, seriesName) {
  const bare = bareTitle(String(title || "").replace(/\s*[([][^)\]]*[)\]]/g, "")).trim();
  const colon = bare.indexOf(":");
  if (colon < 0) return bare;
  const tail = bare.slice(colon + 1);
  return /\b(book|vol(ume)?|part)\b/i.test(tail) || titleOverlap(seriesName, tail) >= 0.6 ? bare.slice(0, colon).trim() : bare;
}

// What to type into a torrent search: the main title, without a subtitle
// when the main title is specific enough on its own.
function searchTitle(title) {
  const head = title.split(":")[0].trim();
  return head.split(/\s+/).length >= 2 ? head : title;
}

function bookOf(product, today, seriesName) {
  const released = product.release_date || null;
  const title = displayTitle(product.title, seriesName);
  return {
    asin: product.asin,
    title,
    search: searchTitle(title),
    author: (product.authors || []).map((a) => a.name).join(", ") || null,
    poster: (product.product_images && (product.product_images["500"] || Object.values(product.product_images)[0])) || null,
    released,
    upcoming: !!released && released > today,
  };
}

// Audible products that could be this torrent, best first (score ≥ 0.6), and
// the cleaned name they were matched against. null when nothing matches.
async function rankMatches(raw) {
  const { title, author } = parseNameParts(raw);
  if (title.length < 2) return null;
  const name = [title, author].filter(Boolean).join(" ");
  const hint = numberHint(raw);
  const search = "num_results=20&products_sort_by=Relevance&response_groups=series,product_desc,contributors";
  const attempts = [
    `keywords=${encodeURIComponent(queryWords(name))}`,
    `title=${encodeURIComponent(queryWords(title))}${author ? `&author=${encodeURIComponent(author)}` : ""}`,
  ];
  let ranked = [];
  for (const query of attempts) {
    const found = await step(`${AUDIBLE}?${search}&${query}`);
    ranked = ((found && found.products) || [])
      .map((product) => ({ product, score: matchScore(product, name, title, author, hint) }))
      .filter((r) => r.score >= 0.6)
      .sort((a, b) => b.score - a.score);
    if (ranked.length) break;
  }
  return ranked.length ? { ranked, name } : null;
}

async function lookup(raw, today) {
  const found = await rankMatches(raw);
  if (!found) return null;
  const { ranked, name } = found;
  // The best match decides. If it's in a series, close runners-up are
  // fallbacks (some editions sit in a "series" of their own); if it isn't,
  // only an equally good edition of the same book may supply one.
  const best = ranked[0].score;
  const window = numberedSeries(ranked[0].product, name) ? 0.15 : 0.05;
  const candidates = ranked.filter((r) => r.score >= best - window && numberedSeries(r.product, name)).slice(0, 3);
  for (const candidate of candidates) {
    const found = await seriesOf(candidate.product, numberedSeries(candidate.product, name), today);
    if (found) return found;
  }
  return null;
}

async function seriesOf(product, own, today) {
  const seriesProduct = await step(`${AUDIBLE}/${own.asin}?response_groups=relationships,product_desc`);
  const members = (((seriesProduct && seriesProduct.product) || {}).relationships || [])
    .filter((r) => r.relationship_type === "series" && position(r.sequence) != null)
    .sort((a, b) => position(a.sequence) - position(b.sequence));
  // Some series list a book twice (another edition): first one per position.
  const seen = new Set();
  const ordered = members.filter((r) => !seen.has(r.sequence) && seen.add(r.sequence));
  if (ordered.length < 2) return null;

  const details = await step(
    `${AUDIBLE}?asins=${ordered.slice(0, 50).map((r) => r.asin).join(",")}&response_groups=product_desc,contributors,media,product_attrs`,
  );
  const byAsin = new Map(((details && details.products) || []).map((p) => [p.asin, p]));
  const books = ordered
    .filter((r) => byAsin.has(r.asin))
    .map((r) => ({ ...bookOf(byAsin.get(r.asin), today, own.title), position: r.sequence }));
  if (books.length < 2) return null;
  const current = position(own.sequence);
  for (const book of books) book.current = book.asin === product.asin || position(book.position) === current;
  const next = current == null ? null : books.find((b) => position(b.position) > current) || null;
  return {
    name: own.title,
    position: own.sequence,
    total: books.length,
    books,
    next,
  };
}

// { name, position, total, books: [...], next } or null — never throws.
async function seriesFor(raw, now = Date.now()) {
  const key = String(raw || "").toLowerCase().trim();
  const hit = seriesCache.get(key);
  if (hit !== undefined) return hit;
  const today = new Date(now).toISOString().slice(0, 10);
  const result = await lookup(raw, today).catch(() => null);
  // A miss may be Audible having a bad minute: try again sooner.
  seriesCache.set(key, result, result ? undefined : 30 * 60 * 1000);
  return result;
}

// ---- "Because you listened to…" ------------------------------------------------
// Audible's "listeners also enjoyed" plus the author's other books, without
// this book's own series (that's "Next in series") and one pick per other series.

const similarCache = new TTLCache(24 * 60 * 60 * 1000, 2000);
const SIMILAR_MAX = 10;
const SIM_GROUPS = "product_desc,contributors,series,media,product_attrs";

async function similarLookup(raw, today) {
  const found = await rankMatches(raw);
  if (!found) return null;
  const product = found.ranked[0].product;
  const [listeners, byAuthor] = await Promise.all([
    step(`${AUDIBLE}/${product.asin}/sims?similarity_type=RawSimilarities&num_results=12&response_groups=${SIM_GROUPS}`),
    step(`${AUDIBLE}/${product.asin}/sims?similarity_type=ByTheSameAuthor&num_results=12&response_groups=${SIM_GROUPS}`),
  ]);
  const seen = new Set([product.asin]);
  const seenSeries = new Set((product.series || []).map((s) => s.asin));
  const books = [];
  const candidates = [
    ...((listeners && listeners.similar_products) || []).map((p) => ({ p, kind: "similar" })),
    ...((byAuthor && byAuthor.similar_products) || []).map((p) => ({ p, kind: "author" })),
  ];
  for (const { p, kind } of candidates) {
    if (!p || !p.asin || seen.has(p.asin)) continue;
    if (p.language && !/english/i.test(p.language)) continue;
    const series = numberedSeries(p, "");
    if (series && seenSeries.has(series.asin)) continue;
    seen.add(p.asin);
    if (series) seenSeries.add(series.asin);
    books.push({
      ...bookOf(p, today, series ? series.title : ""),
      series: series ? { name: series.title, position: series.sequence } : null,
      kind,
    });
    if (books.length >= SIMILAR_MAX) break;
  }
  return books.length ? { because: displayTitle(product.title, ""), books } : null;
}

// { because, books: [{ title, search, author, poster, released, upcoming, series, kind }] } or null.
async function similarFor(raw, now = Date.now()) {
  const key = String(raw || "").toLowerCase().trim();
  const hit = similarCache.get(key);
  if (hit !== undefined) return hit;
  const today = new Date(now).toISOString().slice(0, 10);
  const result = await similarLookup(raw, today).catch(() => null);
  similarCache.set(key, result, result ? undefined : 30 * 60 * 1000);
  return result;
}

module.exports = { seriesFor, similarFor, _numberHint: numberHint, _seriesCache: seriesCache, _similarCache: similarCache };

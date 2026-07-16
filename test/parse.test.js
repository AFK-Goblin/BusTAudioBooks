// test/parse.test.js
// Run with:  npm test   (uses Node's built-in test runner, no deps)
const test = require("node:test");
const assert = require("node:assert/strict");

const { TTLCache, pLimit, withTimeout, withRetry } = require("../src/cache");
const sources = require("../src/sources");
const { cleanTitle, parseNameParts, _upscaleItunes } = require("../src/metadata");
const { encodeItemId, decodeItemId } = require("../src/itemid");
const tb = require("../src/torbox");
const { makeAccess, safeEqual } = require("../src/access");

// ---------------------------------------------------------------------------
test("TTLCache stores, expires, and evicts (LRU)", async () => {
  const c = new TTLCache(20, 2);
  c.set("a", 1);
  assert.equal(c.get("a"), 1);

  c.set("b", 2);
  c.set("c", 3); // exceeds max=2 -> evicts least-recently-used ("a")
  assert.equal(c.get("a"), undefined);
  assert.equal(c.get("c"), 3);

  c.set("d", 4, 10);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(c.get("d"), undefined); // expired
});

test("pLimit caps concurrency", async () => {
  let active = 0;
  let peak = 0;
  const limit = pLimit(2);
  const task = limit(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
  });
  await Promise.all([task(), task(), task(), task(), task()]);
  assert.ok(peak <= 2, `peak concurrency was ${peak}`);
});

test("withTimeout returns fallback on slow/failing promises", async () => {
  const slow = new Promise((r) => setTimeout(() => r("late"), 50));
  assert.equal(await withTimeout(slow, 10, "fallback"), "fallback");

  const failing = Promise.reject(new Error("boom"));
  assert.equal(await withTimeout(failing, 50, "safe"), "safe");

  const fast = Promise.resolve("ok");
  assert.equal(await withTimeout(fast, 50, "fallback"), "ok");
});

test("withRetry retries transient failures then succeeds", async () => {
  let calls = 0;
  const flaky = () => {
    calls++;
    if (calls < 3) return Promise.reject(new Error("transient"));
    return Promise.resolve("done");
  };
  const out = await withRetry(flaky, { retries: 3, baseDelayMs: 1 });
  assert.equal(out, "done");
  assert.equal(calls, 3);
});

test("withRetry gives up after exhausting retries", async () => {
  let calls = 0;
  const always = () => {
    calls++;
    return Promise.reject(new Error("nope"));
  };
  await assert.rejects(() => withRetry(always, { retries: 2, baseDelayMs: 1 }));
  assert.equal(calls, 3); // initial + 2 retries
});

// ---------------------------------------------------------------------------
test("ABB list parsing extracts titles + detail urls and decodes entities", () => {
  const html = `
    <div class="postTitle"><h2><a href="/abss/dune/" rel="bookmark" title="Dune">Dune &#8211; Frank Herbert</a></h2></div>
    <div class="postTitle"><h2><a href="/abss/the-hobbit/" rel="bookmark">The Hobbit</a></h2></div>
    <a href="/page/2/?s=x">next</a>`;
  const list = sources._parseAbbList(html, "abb.test");
  assert.equal(list.length, 2);
  assert.equal(list[0].detailUrl, "https://abb.test/abss/dune/");
  assert.ok(list[0].title.includes("\u2013")); // en-dash decoded
});

test("ABB detail parsing extracts infohash, size, trackers, format, bitrate", () => {
  const html = `
    <tr><td>Format:</td><td>MP3</td></tr>
    <tr><td>Bitrate:</td><td>64 Kbps</td></tr>
    <tr><td>File Size:</td><td>350.5 MBs</td></tr>
    <tr><td>Info Hash:</td><td>0123456789ABCDEF0123456789ABCDEF01234567</td></tr>
    Tracker: udp://tracker.opentrackr.org:1337/announce
    http://bad.example/notatracker`;
  const d = sources._parseAbbDetail(html);
  assert.match(d.infohash, /^[0-9a-f]{40}$/);
  assert.equal(d.infohash, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(d.size, Math.round(350.5 * 1024 * 1024));
  assert.equal(d.format, "MP3");
  assert.match(d.bitrate, /64/);
  assert.deepEqual(d.trackers, ["udp://tracker.opentrackr.org:1337/announce"]);
});

test("buildMagnet returns a magnet with trackers, or null when none", () => {
  const ih = "0123456789abcdef0123456789abcdef01234567";
  const mag = sources._buildMagnet(ih, ["udp://t.example:80/announce"], "Dune");
  assert.match(mag, /xt=urn:btih:0123456789abcdef/);
  assert.match(mag, /tr=udp/);
  assert.equal(sources._buildMagnet(ih, [], "x"), null);
});

// ---------------------------------------------------------------------------
test("cleanTitle strips noise for metadata lookup", () => {
  const q = cleanTitle("Dune – Frank Herbert [Scott Brick] (Unabridged) 64kbps MP3");
  assert.ok(!/unabridged/i.test(q));
  assert.ok(!/kbps/i.test(q));
  assert.ok(!/\[|\]|\(|\)/.test(q));
  assert.ok(/Dune/.test(q));
});

test("parseNameParts splits Title - Author and drops tags", () => {
  assert.deepEqual(parseNameParts("Dune - Frank Herbert [M4B] [128 Kbps]"), {
    title: "Dune",
    author: "Frank Herbert",
  });
  const solo = parseNameParts("Some Standalone Title [MP3]");
  assert.equal(solo.title, "Some Standalone Title");
  assert.equal(solo.author, null);
});

test("upscaleItunes bumps artwork resolution", () => {
  assert.equal(
    _upscaleItunes("https://is1.mzstatic.com/image/thumb/abc/100x100bb.jpg"),
    "https://is1.mzstatic.com/image/thumb/abc/600x600bb.jpg"
  );
  assert.equal(_upscaleItunes(null), null);
});

// ---------------------------------------------------------------------------
test("item id round-trips all fields and is URL-safe", () => {
  const item = {
    infohash: "0123456789abcdef0123456789abcdef01234567",
    magnet: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
    torrentUrl: "http://127.0.0.1:9117/dl/audiobookbay/?jackett_apikey=x&path=abc",
    name: "Dune – Frank Herbert",
    format: "M4B",
    bitrate: "128 kbps",
    size: 367525888,
  };
  const id = encodeItemId(item);
  assert.ok(id.startsWith("tbab:"));
  assert.ok(!/[^A-Za-z0-9_:-]/.test(id)); // colon prefix + base64url only
  const back = decodeItemId(id);
  assert.equal(back.infohash, item.infohash);
  assert.equal(back.name, item.name);
  assert.equal(back.torrentUrl, item.torrentUrl);
  assert.equal(back.format, "M4B");
  assert.equal(back.size, 367525888);
  assert.equal(decodeItemId("not-ours"), null);
});

test("item id works for hashless (torrent-link-only) items", () => {
  const item = { name: "Some Book", torrentUrl: "http://127.0.0.1:9117/dl/x?path=y" };
  const back = decodeItemId(encodeItemId(item));
  assert.equal(back.infohash, undefined);
  assert.equal(back.torrentUrl, item.torrentUrl);
});

test("item id carries the content type; absent type = audiobook (backward compat)", () => {
  const comic = decodeItemId(encodeItemId({ name: "Solo Leveling v01", type: "comic" }));
  assert.equal(comic.type, "comic");

  // Ids minted by older builds (no `t` key) must decode as audiobooks.
  const oldId = decodeItemId(encodeItemId({ name: "Dune - Frank Herbert" }));
  assert.equal(oldId.type, "audiobook");
  const handBuilt =
    "tbab:" + Buffer.from(JSON.stringify({ n: "Legacy Book" }), "utf8").toString("base64url");
  assert.equal(decodeItemId(handBuilt).type, "audiobook");
});

test("comic noise stripping never touches audiobook titles", () => {
  // "digital" / bare "V2" are real words in book titles — only comics strip them.
  const audio = parseNameParts("Digital Minimalism - Cal Newport");
  assert.equal(audio.title, "Digital Minimalism");
  const comic = parseNameParts("Solo Leveling v01 Digital CBZ", "comic");
  assert.equal(comic.title, "Solo Leveling");
});

test("parseComicTags pulls archive format from comic release titles", () => {
  assert.deepEqual(sources._parseComicTags("Solo Leveling v01 (2021) (Digital) (CBZ)"), {
    format: "CBZ",
    bitrate: null,
  });
  assert.deepEqual(sources._parseComicTags("One Piece c1001 [cbr]"), {
    format: "CBR",
    bitrate: null,
  });
  assert.deepEqual(sources._parseComicTags("No tags here"), { format: null, bitrate: null });
});

test("parseTitleTags pulls format + bitrate from ABB-style titles", () => {
  assert.deepEqual(sources._parseTitleTags("Dune - Frank Herbert [M4B] [128 Kbps]"), {
    format: "M4B",
    bitrate: "128 kbps",
  });
  assert.deepEqual(sources._parseTitleTags("Dune - Frank Herbert [MP3]"), {
    format: "MP3",
    bitrate: null,
  });
  assert.deepEqual(sources._parseTitleTags("No tags here"), { format: null, bitrate: null });
});

// ---------------------------------------------------------------------------
test("torbox helpers: infohash parsing, magnet rebuild, audio detection, bytes", () => {
  const ih = "0123456789abcdef0123456789abcdef01234567";
  const mag = tb.magnetFromInfohash(ih, "Book");
  assert.equal(tb.infohashFromMagnet(mag), ih);
  assert.equal(tb.isAudioFile("Chapter 01.m4b"), true);
  assert.equal(tb.isAudioFile("cover.jpg"), false);
  assert.equal(tb.formatBytes(0), "");
  assert.equal(tb.formatBytes(1536), "1.5 KB");
});

test("isComicFile: archives and page images yes, audio/junk no", () => {
  assert.equal(tb.isComicFile("Solo Leveling v01.cbz"), true);
  assert.equal(tb.isComicFile("volume2.CBR"), true);
  assert.equal(tb.isComicFile("pages/001.webp"), true);
  assert.equal(tb.isComicFile("page_010.jpg"), true);
  assert.equal(tb.isComicFile("book.m4b"), false);
  assert.equal(tb.isComicFile("info.nfo"), false);
});

test("webReadyForFile: browser-playable vs external-only formats", () => {
  assert.equal(tb.webReadyForFile("part1.mp3"), true);
  assert.equal(tb.webReadyForFile("part1.m4a"), true);
  assert.equal(tb.webReadyForFile("book.m4b"), false); // external player
  assert.equal(tb.webReadyForFile("book.flac"), false);
});

test("qualityScore ranks higher bitrate / better container above worse ones", () => {
  const hi = sources.qualityScore({ format: "M4B", bitrate: "128 Kbps", size: 500 * 1024 * 1024 });
  const lo = sources.qualityScore({ format: "MP3", bitrate: "32 Kbps", size: 120 * 1024 * 1024 });
  assert.ok(hi > lo, `expected ${hi} > ${lo}`);
  // Missing fields shouldn't throw and should score low.
  assert.equal(typeof sources.qualityScore({}), "number");
});

test("comicQualityScore prefers CBZ over CBR, then size", () => {
  const size = 300 * 1024 * 1024;
  const cbz = sources.comicQualityScore({ format: "CBZ", size });
  const cbr = sources.comicQualityScore({ format: "CBR", size });
  assert.ok(cbz > cbr, `expected ${cbz} > ${cbr}`);
  const bigCbz = sources.comicQualityScore({ format: "CBZ", size: size * 2 });
  assert.ok(bigCbz > cbz, `expected ${bigCbz} > ${cbz}`);
  assert.equal(typeof sources.comicQualityScore({}), "number");
});

test("access gate: disabled when no tokens configured", () => {
  const a = makeAccess({});
  assert.equal(a.required, false);
  assert.equal(a.valid(undefined), true); // open instance
  assert.equal(a.valid("anything"), true);
});

test("access gate: enforces matching token from a list", () => {
  const a = makeAccess({ ACCESS_TOKENS: "alpha, bravo ,charlie" });
  assert.equal(a.required, true);
  assert.equal(a.valid("bravo"), true); // trimmed
  assert.equal(a.valid("charlie"), true);
  assert.equal(a.valid("delta"), false);
  assert.equal(a.valid(""), false);
  assert.equal(a.valid(undefined), false);
});

test("safeEqual compares without throwing on length mismatch", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("abc", "xyz"), false);
});

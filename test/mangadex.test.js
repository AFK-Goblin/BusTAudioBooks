// Unit tests for the pure MangaDex mapping logic (no network).
// Run with: npm test
const test = require("node:test");
const assert = require("node:assert/strict");

const md = require("../src/mangadex");
const { encodeItemId, decodeItemId } = require("../src/itemid");

// ---------------------------------------------------------------------------
const MANGA_LIST_FIXTURE = {
  data: [
    {
      id: "32d76d19-8a05-4db0-9fc2-e0b0648fe9d0",
      attributes: {
        title: { en: "Solo Leveling" },
        description: { en: "Ten years ago, the Gate appeared." },
        status: "completed",
        year: 2018,
      },
      relationships: [
        { type: "author", attributes: { name: "Chugong" } },
        { type: "cover_art", attributes: { fileName: "aa1b2c3d.jpg" } },
      ],
    },
    {
      id: "d1c0d3f9-0000-4444-8888-123456789abc",
      attributes: {
        // No English title — must fall back to the first available value.
        title: { ja: "俺だけレベルアップな件" },
        description: {},
      },
      relationships: [],
    },
  ],
};

test("mangadex: parseMangaList maps ids, titles, covers, author", () => {
  const out = md._parseMangaList(MANGA_LIST_FIXTURE);
  assert.equal(out.length, 2);
  assert.equal(out[0].mangaId, "32d76d19-8a05-4db0-9fc2-e0b0648fe9d0");
  assert.equal(out[0].title, "Solo Leveling");
  assert.equal(out[0].author, "Chugong");
  assert.equal(out[0].coverFileName, "aa1b2c3d.jpg");
  assert.equal(out[0].status, "completed");
  // Fallback title when no `en` key exists.
  assert.equal(out[1].title, "俺だけレベルアップな件");
  assert.equal(out[1].coverFileName, null);
});

test("mangadex: coverUrl keeps the full original filename and appends .512.jpg", () => {
  assert.equal(
    md._coverUrl("32d76d19-8a05-4db0-9fc2-e0b0648fe9d0", "aa1b2c3d.png"),
    "https://uploads.mangadex.org/covers/32d76d19-8a05-4db0-9fc2-e0b0648fe9d0/aa1b2c3d.png.512.jpg"
  );
  assert.equal(md._coverUrl("x", null), null);
});

// ---------------------------------------------------------------------------
const FEED_FIXTURE = {
  total: 6,
  data: [
    {
      id: "ch-12-old",
      attributes: { chapter: "12", title: "Duel", pages: 30, publishAt: "2023-01-01T00:00:00+00:00" },
      relationships: [{ type: "scanlation_group", attributes: { name: "Old Group" } }],
    },
    {
      id: "ch-12-new",
      attributes: { chapter: "12", title: "Duel", pages: 31, publishAt: "2024-06-01T00:00:00+00:00" },
      relationships: [{ type: "scanlation_group", attributes: { name: "New Group" } }],
    },
    {
      id: "ch-external",
      attributes: { chapter: "13", pages: 0, publishAt: "2024-01-01T00:00:00+00:00", externalUrl: "https://official.example/13" },
      relationships: [],
    },
    {
      id: "ch-zero-pages",
      attributes: { chapter: "14", pages: 0, publishAt: "2024-01-02T00:00:00+00:00" },
      relationships: [],
    },
    {
      id: "ch-oneshot",
      attributes: { chapter: null, title: "Oneshot", pages: 12, publishAt: "2022-05-05T00:00:00+00:00" },
      relationships: [],
    },
    {
      id: "ch-12-5",
      attributes: { chapter: "12.5", title: "Extra", pages: 8, publishAt: "2024-02-02T00:00:00+00:00" },
      relationships: [],
    },
    {
      id: "ch-2",
      attributes: { chapter: "2", title: null, pages: 20, publishAt: "2023-02-02T00:00:00+00:00" },
      relationships: [],
    },
  ],
};

test("mangadex: feed filter drops external/pageless, dedupes by number, sorts numerically", () => {
  const chapters = md._filterAndDedupeChapters(md._parseFeed(FEED_FIXTURE));
  const ids = chapters.map((c) => c.id);
  // externalUrl and pages:0 chapters are gone
  assert.ok(!ids.includes("ch-external"));
  assert.ok(!ids.includes("ch-zero-pages"));
  // duplicate chapter 12: most recent publishAt wins
  assert.ok(ids.includes("ch-12-new"));
  assert.ok(!ids.includes("ch-12-old"));
  // numeric order: 2 < 12 < 12.5, oneshot (null num) last
  assert.deepEqual(ids, ["ch-2", "ch-12-new", "ch-12-5", "ch-oneshot"]);
  assert.equal(chapters[1].group, "New Group");
});

// ---------------------------------------------------------------------------
const AT_HOME_FIXTURE = {
  baseUrl: "https://node7.mangadex.network",
  chapter: {
    hash: "3303dd03ac8d27452cce3f2a882e94b2",
    data: ["1-full.png", "2-full.png"],
    dataSaver: ["1-small.jpg", "2-small.jpg"],
  },
};

test("mangadex: buildPageUrls constructs data and data-saver URLs", () => {
  assert.deepEqual(md._buildPageUrls(AT_HOME_FIXTURE, false), [
    "https://node7.mangadex.network/data/3303dd03ac8d27452cce3f2a882e94b2/1-full.png",
    "https://node7.mangadex.network/data/3303dd03ac8d27452cce3f2a882e94b2/2-full.png",
  ]);
  assert.deepEqual(md._buildPageUrls(AT_HOME_FIXTURE, true), [
    "https://node7.mangadex.network/data-saver/3303dd03ac8d27452cce3f2a882e94b2/1-small.jpg",
    "https://node7.mangadex.network/data-saver/3303dd03ac8d27452cce3f2a882e94b2/2-small.jpg",
  ]);
  assert.deepEqual(md._buildPageUrls({}, false), []);
});

test("mangadex: data-saver falls back to full quality when no dataSaver variant exists", () => {
  const noSaver = {
    baseUrl: "https://node7.mangadex.network",
    chapter: { hash: "abc123", data: ["1-full.png"], dataSaver: [] },
  };
  // saver requested, but the chapter must still be readable.
  assert.deepEqual(md._buildPageUrls(noSaver, true), [
    "https://node7.mangadex.network/data/abc123/1-full.png",
  ]);
});

// ---------------------------------------------------------------------------
test("mangadex: item ids round-trip provider + mangaId; legacy ids stay torrent", () => {
  const id = encodeItemId({
    name: "Solo Leveling",
    type: "comic",
    provider: "mangadex",
    mangaId: "32d76d19-8a05-4db0-9fc2-e0b0648fe9d0",
  });
  assert.ok(!/[^A-Za-z0-9_:-]/.test(id)); // still URL-safe
  const back = decodeItemId(id);
  assert.equal(back.type, "comic");
  assert.equal(back.provider, "mangadex");
  assert.equal(back.mangaId, "32d76d19-8a05-4db0-9fc2-e0b0648fe9d0");

  // Torrent comic and legacy audiobook ids decode with provider "torrent".
  assert.equal(decodeItemId(encodeItemId({ name: "X", type: "comic" })).provider, "torrent");
  assert.equal(decodeItemId(encodeItemId({ name: "Y" })).provider, "torrent");
});

test("mangadex: chapter download dir ids stay unique within safe()'s 80 chars", () => {
  // Mirrors the app's downloads.js safe(): sanitize then slice to 80.
  const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  const a = safe("md-32d76d19-8a05-4db0-9fc2-e0b0648fe9d0-e3c94fd8-563d-4bd1-a1cf-8e39fbbcd451");
  const b = safe("md-32d76d19-8a05-4db0-9fc2-e0b0648fe9d0-ffffffff-ffff-ffff-ffff-ffffffffffff");
  assert.equal(a.length <= 80, true);
  assert.notEqual(a, b); // uuid pair fits inside the slice → no collisions
  assert.equal(a, "md-32d76d19-8a05-4db0-9fc2-e0b0648fe9d0-e3c94fd8-563d-4bd1-a1cf-8e39fbbcd451");
});

test("mangadex: makeSpacer enforces the minimum interval", async () => {
  const spacer = md._makeSpacer(30);
  const t0 = Date.now();
  await spacer();
  await spacer();
  await spacer();
  assert.ok(Date.now() - t0 >= 55, "three spaced calls should take ≥ ~2 intervals");
});

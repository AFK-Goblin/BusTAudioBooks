// test/details.test.js — book-page details (synopsis/genre/year), providers stubbed.
const test = require("node:test");
const assert = require("node:assert/strict");
const metadata = require("../src/metadata");

function stubFetch(routes) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    const host = new URL(url).host;
    const body = routes[host];
    if (body === undefined) throw new Error(`unexpected ${url}`);
    return { ok: true, json: async () => body };
  };
  return { calls, restore: () => { global.fetch = real; } };
}

test("details: takes the first iTunes result whose title actually matches", async () => {
  metadata._detailsCache.m.clear();
  const f = stubFetch({
    "itunes.apple.com": {
      results: [
        { collectionName: "The Martian (Unabridged)", description: "Wrong book" },
        {
          collectionName: "Project Hail Mary (Unabridged)", artistName: "Andy Weir", primaryGenreName: "Sci-Fi & Fantasy",
          releaseDate: "2021-05-04T07:00:00Z", description: "<b>Ryland Grace</b> is the sole survivor.<br><br>On a&nbsp;desperate mission.",
        },
      ],
    },
  });
  try {
    const d = await metadata.details("Project Hail Mary - Andy Weir [M4B 64kbps]");
    assert.deepEqual(d, {
      description: "Ryland Grace is the sole survivor.\n\nOn a desperate mission.",
      genre: "Sci-Fi & Fantasy", year: 2021, author: "Andy Weir",
    });
    await metadata.details("Project Hail Mary - Andy Weir [M4B 64kbps]");
    assert.equal(f.calls.length, 1, "second lookup is served from cache");
  } finally {
    f.restore();
  }
});

test("details: no confident match means no synopsis rather than the wrong one", async () => {
  metadata._detailsCache.m.clear();
  const f = stubFetch({
    "itunes.apple.com": { results: [{ collectionName: "Something Else Entirely", description: "Nope" }] },
    "www.googleapis.com": { items: [{ volumeInfo: { title: "Also Different", description: "Nope" } }] },
  });
  try {
    const d = await metadata.details("Obscure Title - Some Author");
    assert.equal(d.description, null);
    assert.equal(d.author, "Some Author");
  } finally {
    f.restore();
  }
});

test("details: falls back to Google Books", async () => {
  metadata._detailsCache.m.clear();
  const f = stubFetch({
    "itunes.apple.com": { results: [] },
    "www.googleapis.com": { items: [{ volumeInfo: { title: "Dungeon Crawler Carl", authors: ["Matt Dinniman"], description: "<p>One.</p><p>Two.</p>", categories: ["Fiction"], publishedDate: "2020-09" } }] },
  });
  try {
    const d = await metadata.details("Dungeon Crawler Carl - Matt Dinniman");
    assert.deepEqual(d, { description: "One.\n\nTwo.", genre: "Fiction", year: 2020, author: "Matt Dinniman" });
  } finally {
    f.restore();
  }
});

test("title overlap ignores case, accents, brackets and filler words", () => {
  assert.equal(metadata._titleOverlap("Les Misérables", "Les Miserables (Unabridged)"), 1);
  assert.equal(metadata._titleOverlap("The Way of Kings", "Way of Kings: Book One"), 1);
  assert.ok(metadata._titleOverlap("The Way of Kings", "Words of Radiance") < 0.6);
});

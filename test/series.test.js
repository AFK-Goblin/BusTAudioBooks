// test/series.test.js — series lookup against a fake Audible catalogue.
const test = require("node:test");
const assert = require("node:assert/strict");
const { seriesFor, similarFor, _numberHint, _seriesCache, _similarCache } = require("../src/series");

const author = (name) => ({ name });
const DCC = { asin: "S-DCC", title: "Dungeon Crawler Carl" };
const PRODUCTS = {
  b1: { asin: "b1", title: "Dungeon Crawler Carl", authors: [author("Matt Dinniman")], series: [{ ...DCC, sequence: "1" }], release_date: "2021-01-28" },
  b2: { asin: "b2", title: "Carl's Doomsday Scenario", authors: [author("Matt Dinniman")], series: [{ ...DCC, sequence: "2" }], release_date: "2021-04-22" },
  b6: { asin: "b6", title: "The Eye of the Bedlam Bride", authors: [author("Matt Dinniman")], series: [{ ...DCC, sequence: "6" }], release_date: "2023-08-22" },
  b8: { asin: "b8", title: "A Parade of Horribles", authors: [author("Matt Dinniman")], series: [{ ...DCC, sequence: "8" }], release_date: "2099-05-12" },
  phm: { asin: "phm", title: "Project Hail Mary", authors: [author("Andy Weir")], series: [], release_date: "2021-05-04" },
  hm: { asin: "hm", title: "Hail Mary", authors: [author("Someone Else")], series: [{ asin: "S-RZR", title: "Red Zone Rivals", sequence: "0.5" }] },
};
const SERIES = {
  "S-DCC": ["b2", "b6", "b1", "b8"].map((asin) => ({ asin, relationship_type: "series", sequence: PRODUCTS[asin].series[0].sequence })),
};
PRODUCTS.wool = { asin: "wool", title: "Wool (Dramatized Adaptation)", authors: [author("Hugh Howey")], series: [{ asin: "S-SILO", title: "The Silo Saga", sequence: "1" }], language: "english" };
PRODUCTS.shift = { asin: "shift", title: "Shift", authors: [author("Hugh Howey")], series: [{ asin: "S-SILO", title: "The Silo Saga", sequence: "2" }], language: "english" };
PRODUCTS.es = { asin: "es", title: "El juego", authors: [author("Alguien")], series: [], language: "spanish" };
PRODUCTS.dob = { asin: "dob", title: "Dominion of Blades", authors: [author("Matt Dinniman")], series: [{ asin: "S-DOB", title: "Dominion of Blades", sequence: "1" }], language: "english" };
const SIMS = {
  "b1:RawSimilarities": ["b2", "wool", "shift", "es"],
  "b1:ByTheSameAuthor": ["b6", "dob"],
};
const SEARCH = {
  "Dungeon Crawler Carl Matt Dinniman": ["b6", "b1", "b2"], // relevance puts a later book first
  "Carl's Doomsday Scenario Matt Dinniman": ["b2", "b1"],
  "Project Hail Mary Andy Weir": ["phm", "hm"],
};

function fakeAudible() {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    const json = (body) => ({ ok: true, json: async () => body });
    const sims = u.pathname.match(/\/products\/([^/]+)\/sims$/);
    if (sims) return json({ similar_products: (SIMS[`${sims[1]}:${u.searchParams.get("similarity_type")}`] || []).map((a) => PRODUCTS[a]) });
    const id = u.pathname.split("/products/")[1];
    if (id) return json({ product: { asin: id, relationships: SERIES[id] || [] } });
    if (u.searchParams.get("asins")) return json({ products: u.searchParams.get("asins").split(",").map((a) => PRODUCTS[a]).filter(Boolean) });
    const keywords = u.searchParams.get("keywords");
    return json({ products: (SEARCH[keywords] || []).map((a) => PRODUCTS[a]) });
  };
  return { calls, restore: () => { global.fetch = realFetch; } };
}

test.beforeEach(() => { _seriesCache.m.clear(); _similarCache.m.clear(); });

test("finds the book's place in its series and the next one, in order", async () => {
  const audible = fakeAudible();
  try {
    const s = await seriesFor("Dungeon Crawler Carl - Matt Dinniman [M4B]", Date.UTC(2026, 9, 23));
    assert.equal(s.name, "Dungeon Crawler Carl");
    assert.equal(s.position, "1");
    assert.deepEqual(s.books.map((b) => [b.position, b.title, b.current]), [
      ["1", "Dungeon Crawler Carl", true], ["2", "Carl's Doomsday Scenario", false],
      ["6", "The Eye of the Bedlam Bride", false], ["8", "A Parade of Horribles", false],
    ]);
    assert.equal(s.next.title, "Carl's Doomsday Scenario");
    assert.equal(s.books[3].upcoming, true); // not released yet
    // Cached: asking again costs nothing.
    const before = audible.calls.length;
    await seriesFor("Dungeon Crawler Carl - Matt Dinniman [M4B]");
    assert.equal(audible.calls.length, before);
  } finally {
    audible.restore();
  }
});

test("the second book's next is the next one Audible has", async () => {
  const audible = fakeAudible();
  try {
    const s = await seriesFor("Carl's Doomsday Scenario - Matt Dinniman");
    assert.equal(s.position, "2");
    assert.equal(s.next.position, "6");
  } finally {
    audible.restore();
  }
});

test("a standalone book has no series, even if a different book in one shares words", async () => {
  const audible = fakeAudible();
  try {
    assert.equal(await seriesFor("Project Hail Mary - Andy Weir"), null);
  } finally {
    audible.restore();
  }
});

test("Audible being down is just 'no series'", async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  try {
    assert.equal(await seriesFor("Dungeon Crawler Carl - Matt Dinniman"), null);
  } finally {
    global.fetch = realFetch;
  }
});

test("book numbers in torrent names", () => {
  assert.equal(_numberHint("The Gate of the Feral Gods (Dungeon Crawler Carl, Book 4)"), 4);
  assert.equal(_numberHint("Old Man's War #1"), 1);
  assert.equal(_numberHint("Defiance of the Fall Vol. 12"), 12);
  assert.equal(_numberHint("Book Two of the Saga"), 2);
  assert.equal(_numberHint("Project Hail Mary"), null);
});

test("because you listened: other series and the author's other books, not this series", async () => {
  const audible = fakeAudible();
  try {
    const r = await similarFor("Dungeon Crawler Carl - Matt Dinniman [M4B]");
    assert.equal(r.because, "Dungeon Crawler Carl");
    assert.deepEqual(r.books.map((b) => [b.kind, b.title, b.series && b.series.name]), [
      ["similar", "Wool", "The Silo Saga"], // book 2 of the same other series is left out, so is Spanish
      ["author", "Dominion of Blades", "Dominion of Blades"],
    ]);
    assert.equal(r.books[0].search, "Wool");
  } finally {
    audible.restore();
  }
});

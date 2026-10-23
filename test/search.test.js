// test/search.test.js — source failures surface as errors, never as "no results".
const test = require("node:test");
const assert = require("node:assert/strict");
const sources = require("../src/sources");

const LIST = (slug) => `<div class="postTitle"><h2><a href="/abss/${slug}/" rel="bookmark">Dune &#8211; Frank Herbert</a></h2></div>`;
const DETAIL = `<tr><td>Format:</td><td>M4B</td></tr><tr><td>Info Hash:</td><td>${"a".repeat(40)}</td></tr>`;

function stubFetch(handler) {
  const real = global.fetch;
  global.fetch = async (url, init) => handler(new URL(url), init);
  return () => { global.fetch = real; };
}
const html = (body) => ({ ok: true, status: 200, text: async () => body });

test("search: a Cloudflare-blocked AudiobookBay is reported, not shown as 'no results'", async () => {
  const restore = stubFetch(async () => html("<title>Just a moment...</title>"));
  try {
    await assert.rejects(
      sources.searchAudiobooks({ abbDomain: "abb.test" }, "cloudflare query"),
      (err) => err.name === "SearchUnavailableError" && /AudiobookBay: .*Cloudflare/.test(err.message),
    );
  } finally {
    restore();
  }
});

test("search: with nothing configured the error says what to set up", async () => {
  await assert.rejects(sources.searchAudiobooks({}, "anything"), /No search source is set up/);
});

test("search: one failed source still returns the other's results, marked partial", async () => {
  const restore = stubFetch(async (url) => {
    if (url.host === "jackett.test") return { ok: false, status: 500, json: async () => ({}) };
    if (url.pathname.startsWith("/abss/")) return html(DETAIL);
    return html(LIST("dune-partial"));
  });
  try {
    const results = await sources.searchAudiobooks({ abbDomain: "abb.test", jackettUrl: "http://jackett.test", jackettApiKey: "k" }, "partial query");
    assert.equal(results.length, 1);
    assert.equal(results.partial, true);
    assert.equal(results[0].infohash, "a".repeat(40));
  } finally {
    restore();
  }
});

test("search: Jackett requests carry a timeout", async () => {
  let signal;
  const restore = stubFetch(async (_url, init) => {
    signal = init && init.signal;
    return { ok: true, status: 200, json: async () => ({ Results: [] }) };
  });
  try {
    const results = await sources.searchAudiobooks({ jackettUrl: "http://jackett.test", jackettApiKey: "k" }, "timeout query");
    assert.deepEqual([...results], []);
    assert.ok(signal instanceof AbortSignal);
  } finally {
    restore();
  }
});

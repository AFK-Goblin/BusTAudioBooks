// test/search-speed.test.js — search answers quickly even when cover lookups
// are slow or hang; covers never cost more than the enrichment budget.
const test = require("node:test");
const assert = require("node:assert/strict");

const { app } = require("../src/index");
const { encodeConfig } = require("../src/config");

const TITLES = [
  "Fast One - Author A", "Fast Two - Author B", "Fast Three - Author C", "Fast Four - Author D",
  "Slow One - Writer E", "Slow Two - Writer F",
  "Stuck One - Nobody G", "Stuck Two - Nobody H",
];
const calls = { itunes: [], openlibrary: [], google: [] };
const hang = () => new Promise(() => {});
const later = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const html = (body) => ({ ok: true, status: 200, text: async () => body });

const realFetch = global.fetch;
function route(url) {
  const u = new URL(url);
  if (u.host === "abb.test" && u.pathname.startsWith("/abss/")) {
    const i = Number(u.pathname.split("-").pop().replace("/", ""));
    return html(`<tr><td>Format:</td><td>MP3</td></tr><tr><td>Info Hash:</td><td>${String(i).repeat(40).slice(0, 40)}</td></tr>`);
  }
  if (u.host === "abb.test") {
    return html(TITLES.map((t, i) => `<a href="/abss/book-${i}/" rel="bookmark">${t}</a>`).join("\n"));
  }
  if (u.host === "api.torbox.app") return json({ success: true, data: {} });
  const term = decodeURIComponent(u.searchParams.get("term") || u.searchParams.get("q") || "");
  if (u.host === "itunes.apple.com") {
    calls.itunes.push(term);
    if (term.startsWith("Fast")) return json({ results: [{ artworkUrl100: `https://art/${term.split(" ")[1]}/100x100bb.jpg`, artistName: "iTunes" }] });
    return hang();
  }
  if (u.host === "openlibrary.org") {
    calls.openlibrary.push(term);
    if (term.startsWith("Slow")) return later(50, json({ docs: [{ cover_i: 7, author_name: ["OL"] }] }));
    return hang();
  }
  if (u.host === "www.googleapis.com") {
    calls.google.push(term);
    return term.startsWith("Slow") ? json({ items: [] }) : hang();
  }
  throw new Error(`unexpected ${url}`);
}

async function withServer(run) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  global.fetch = async (url, init) => (String(url).startsWith(base) ? realFetch(url, init) : route(url));
  try {
    await run(base);
  } finally {
    global.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
  }
}

test("search answers within the cover budget, with covers that are ready", async () => {
  await withServer(async (base) => {
    const cfg = encodeConfig({ apiKey: "k", abbDomain: "abb.test" });
    const started = Date.now();
    const res = await realFetch(`${base}/${cfg}/app/search?q=books`);
    const elapsed = Date.now() - started;
    const { results } = await res.json();
    assert.equal(res.status, 200);
    assert.equal(results.length, 8);
    // Old behaviour waited on every provider for every result; now the reply
    // comes at the 3 s budget even though two lookups never finish.
    assert.ok(elapsed < 3800, `search took ${elapsed} ms`);

    const byTitle = Object.fromEntries(results.map((r) => [r.title, r]));
    assert.equal(byTitle["Fast One - Author A"].poster, "https://art/One/600x600bb.jpg");
    assert.equal(byTitle["Slow One - Writer E"].poster, "https://covers.openlibrary.org/b/id/7-L.jpg");
    assert.equal(byTitle["Stuck One - Nobody G"].poster, null);
    assert.equal(byTitle["Stuck One - Nobody G"].author, "Nobody G"); // parsed from the title

    // iTunes hits never trigger the slower fallbacks.
    assert.equal(calls.openlibrary.some((t) => t.startsWith("Fast")), false);
    assert.equal(calls.google.some((t) => t.startsWith("Fast")), false);

    // Repeating the search reuses the cached results and cached covers.
    await later(800);
    const again = Date.now();
    const second = await (await realFetch(`${base}/${cfg}/app/search?q=books`)).json();
    assert.ok(Date.now() - again < 1000, "cached search should be quick");
    assert.equal(second.results.find((r) => r.title === "Slow Two - Writer F").poster, "https://covers.openlibrary.org/b/id/7-L.jpg");
  });
});

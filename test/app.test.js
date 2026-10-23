// test/app.test.js — HTTP-level checks of the app API, with TorBox stubbed.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.ACCESS_TOKENS = "friend-token";
const torbox = require("../src/torbox");
const { app } = require("../src/index");
const { encodeConfig } = require("../src/config");
const { encodeItemId } = require("../src/itemid");

async function withServer(run) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a configured health check rejects a wrong access token before touching TorBox", async () => {
  const original = torbox.validateKey;
  let calls = 0;
  torbox.validateKey = async () => { calls++; return true; };
  try {
    await withServer(async (base) => {
      const bad = await fetch(`${base}/${encodeConfig({ apiKey: "k", token: "wrong" })}/health`);
      assert.equal(bad.status, 403);
      assert.equal(calls, 0);

      const good = await fetch(`${base}/${encodeConfig({ apiKey: "k", token: "friend-token" })}/health`);
      assert.equal(good.status, 200);
      const body = await good.json();
      assert.equal(body.torboxKeyValid, true);
      assert.equal(body.accessGate, true);

      // The unconfigured liveness probe stays open for monitoring.
      assert.equal((await fetch(`${base}/health`)).status, 200);
    });
  } finally {
    torbox.validateKey = original;
  }
});

test("/app/streams reports each file's size", async () => {
  const original = torbox.resolveStreams;
  torbox.resolveStreams = async () => ({
    ready: true,
    status: "ok",
    streams: [
      { url: "https://cdn.example/1", behaviorHints: { filename: "01.mp3", videoSize: 1234 } },
      { url: "https://cdn.example/2", behaviorHints: { filename: "02.mp3" } },
    ],
  });
  try {
    await withServer(async (base) => {
      const cfg = encodeConfig({ apiKey: "size-test-key", token: "friend-token" });
      const id = encodeItemId({ infohash: "a".repeat(40), name: "Book - Author" });
      const res = await fetch(`${base}/${cfg}/app/streams/${id}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.streams.map((s) => [s.filename, s.size]), [["01.mp3", 1234], ["02.mp3", null]]);
    });
  } finally {
    torbox.resolveStreams = original;
  }
});

test("resolveStreams carries TorBox file sizes as behaviorHints.videoSize", async () => {
  const realFetch = global.fetch;
  const hash = "b".repeat(40);
  global.fetch = async (url) => {
    const u = new URL(url);
    const json = (data) => ({ json: async () => ({ success: true, data }) });
    if (u.pathname.endsWith("/torrents/mylist")) {
      return json([{
        id: 7, hash, download_present: true,
        files: [
          { id: 1, name: "Book/02.mp3", short_name: "02.mp3", size: 2000 },
          { id: 0, name: "Book/01.mp3", short_name: "01.mp3", size: 1000 },
          { id: 2, name: "Book/cover.jpg", short_name: "cover.jpg", size: 50 },
        ],
      }]);
    }
    if (u.pathname.endsWith("/torrents/requestdl")) return json(`https://cdn.example/${u.searchParams.get("file_id")}`);
    throw new Error(`unexpected ${url}`);
  };
  try {
    const result = await torbox.resolveStreams("key", { infohash: hash, name: "Book" });
    assert.equal(result.ready, true);
    assert.deepEqual(
      result.streams.map((s) => [s.behaviorHints.filename, s.behaviorHints.videoSize, s.url]),
      [["01.mp3", 1000, "https://cdn.example/0"], ["02.mp3", 2000, "https://cdn.example/1"]],
    );
  } finally {
    global.fetch = realFetch;
  }
});

test("/app/details serves a synopsis for a book id", async () => {
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).startsWith("https://itunes.apple.com/")) {
      return { ok: true, json: async () => ({ results: [{ collectionName: "Dune (Unabridged)", description: "Spice <i>must</i> flow.", primaryGenreName: "Sci-Fi", releaseDate: "1965-08-01T00:00:00Z", artistName: "Frank Herbert" }] }) };
    }
    return realFetch(url, init);
  };
  try {
    await withServer(async (base) => {
      const cfg = encodeConfig({ apiKey: "k", token: "friend-token" });
      const id = encodeItemId({ infohash: "c".repeat(40), name: "Dune - Frank Herbert [M4B]" });
      const res = await realFetch(`${base}/${cfg}/app/details/${id}`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        title: "Dune - Frank Herbert",
        description: "Spice must flow.", genre: "Sci-Fi", year: 1965, author: "Frank Herbert",
      });
      assert.equal((await realFetch(`${base}/${cfg}/app/details/not-an-id`)).status, 400);
    });
  } finally {
    global.fetch = realFetch;
  }
});

test("/app/search explains an unconfigured server instead of returning nothing", async () => {
  await withServer(async (base) => {
    const cfg = encodeConfig({ apiKey: "k", token: "friend-token" });
    const res = await fetch(`${base}/${cfg}/app/search?q=dune`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.deepEqual(body.results, []);
    assert.match(body.error, /No search source is set up/);
  });
});

test("apps that still have a Comics tab are told comics are gone", async () => {
  await withServer(async (base) => {
    const cfg = encodeConfig({ apiKey: "k", token: "friend-token" });
    const legacy = "tbab:" + Buffer.from(JSON.stringify({ n: "One Piece", p: "m", d: "a" }), "utf8").toString("base64url");
    for (const path of [
      "/app/search?q=one+piece&type=comic&source=series",
      `/app/streams/${legacy}`,
      `/app/chapters/${legacy}`,
      "/app/pages/123e4567-e89b-12d3-a456-426614174000",
    ]) {
      const res = await fetch(`${base}/${cfg}${path}`);
      assert.equal(res.status, 410, path);
      assert.match((await res.json()).error, /Comics were removed/);
    }
    const health = await (await fetch(`${base}/${cfg}/health`)).json();
    assert.equal("comics" in health.sources || "mangadex" in health.sources, false);
  });
});

test("/app/series answers with the series, or null", async () => {
  const series = require("../src/series");
  const original = series.seriesFor;
  await withServer(async (base) => {
    const cfg = encodeConfig({ apiKey: "k", token: "friend-token" });
    const id = encodeItemId({ infohash: "d".repeat(40), name: "Project Hail Mary - Andy Weir" });
    const realFetch = global.fetch;
    global.fetch = async (url, init) => (String(url).startsWith("https://api.audible.com/")
      ? { ok: true, json: async () => ({ products: [] }) }
      : realFetch(url, init));
    try {
      const res = await realFetch(`${base}/${cfg}/app/series/${id}`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { series: null });
      assert.equal((await realFetch(`${base}/${cfg}/app/series/not-an-id`)).status, 400);
    } finally {
      global.fetch = realFetch;
    }
  });
  assert.equal(series.seriesFor, original);
});

test("/app/similar answers with suggestions, or null", async () => {
  await withServer(async (base) => {
    const cfg = encodeConfig({ apiKey: "k", token: "friend-token" });
    const id = encodeItemId({ infohash: "f".repeat(40), name: "Nothing Matches This - Nobody" });
    const realFetch = global.fetch;
    global.fetch = async (url, init) => (String(url).startsWith("https://api.audible.com/")
      ? { ok: true, json: async () => ({ products: [] }) }
      : realFetch(url, init));
    try {
      const res = await realFetch(`${base}/${cfg}/app/similar/${id}`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { similar: null });
    } finally {
      global.fetch = realFetch;
    }
  });
});

// test/torbox.test.js — resolveStreams against a fake TorBox account.
const test = require("node:test");
const assert = require("node:assert/strict");
const torbox = require("../src/torbox");

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const files = [{ id: 7, name: "Book/01.mp3", short_name: "01.mp3", size: 100 }];
const finished = (id, hash, name) => ({ id, hash, name, download_finished: true, download_present: true, progress: 1, files });
const stalled = (id, hash, name, state = "stalled (no seeds)") => ({ id, hash, name, download_finished: false, download_present: false, progress: 0, seeds: 0, download_state: state, files: [] });

function fakeTorBox({ list, cached = [] }) {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace("/v1/api", "");
    calls.push(`${init.method || "GET"} ${path}`);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (path === "/torrents/mylist") {
      const id = u.searchParams.get("id");
      return json({ success: true, data: id ? list.find((t) => String(t.id) === id) || null : list });
    }
    if (path === "/torrents/checkcached") {
      const data = {};
      for (const h of u.searchParams.get("hash").split(",")) if (cached.includes(h)) data[h] = {};
      return json({ success: true, data });
    }
    if (path === "/torrents/createtorrent") {
      list.unshift(stalled(99, H1, "Fresh add", "downloading"));
      return json({ success: true, data: { torrent_id: 99, hash: H1 } });
    }
    if (path === "/torrents/requestdl") return json({ success: true, data: `https://cdn/${u.searchParams.get("torrent_id")}/${u.searchParams.get("file_id")}` });
    return json({ success: false });
  };
  return { calls, restore: () => { global.fetch = realFetch; } };
}

test("a stalled duplicate of a finished torrent doesn't hide it", async () => {
  const tb = fakeTorBox({ list: [stalled(1, H1, "Dune"), finished(2, H1, "Dune")] });
  try {
    const r = await torbox.resolveStreams("k", { infohash: H1, name: "Dune - Frank Herbert" });
    assert.equal(r.ready, true);
    assert.equal(r.streams[0].url, "https://cdn/2/7");
  } finally {
    tb.restore();
  }
});

test("another upload of the same book that's finished is used instead of waiting", async () => {
  const tb = fakeTorBox({ list: [stalled(1, H1, "Dungeon Crawler Carl - Matt Dinniman"), finished(5, H2, "Matt Dinniman - Dungeon Crawler Carl [64kbps]")] });
  try {
    const r = await torbox.resolveStreams("k", { infohash: H1, name: "Dungeon Crawler Carl - Matt Dinniman [M4B]" });
    assert.equal(r.ready, true);
    assert.equal(r.streams[0].url, "https://cdn/5/7");
  } finally {
    tb.restore();
  }
});

test("a finished copy saves starting a slow download — but a cached upload is added as asked", async () => {
  let tb = fakeTorBox({ list: [finished(5, H2, "Dungeon Crawler Carl")] });
  try {
    const r = await torbox.resolveStreams("k", { infohash: H1, name: "Dungeon Crawler Carl - Matt Dinniman" });
    assert.equal(r.streams[0].url, "https://cdn/5/7");
    assert.equal(tb.calls.includes("POST /torrents/createtorrent"), false);
  } finally {
    tb.restore();
  }
  tb = fakeTorBox({ list: [finished(5, H2, "Dungeon Crawler Carl")], cached: [H1] });
  try {
    await torbox.resolveStreams("k", { infohash: H1, name: "Dungeon Crawler Carl - Matt Dinniman" });
    assert.equal(tb.calls.includes("POST /torrents/createtorrent"), true);
  } finally {
    tb.restore();
  }
});

test("a different volume is never taken for this one", async () => {
  const tb = fakeTorBox({ list: [stalled(1, H1, "Dungeon Crawler Carl"), finished(5, H2, "Dungeon Crawler Carl 2 - Carl's Doomsday Scenario")] });
  try {
    const r = await torbox.resolveStreams("k", { infohash: H1, name: "Dungeon Crawler Carl - Matt Dinniman" });
    assert.equal(r.ready, false);
    assert.match(r.status, /Stalled on TorBox \(0%\): nobody is sharing this upload/);
  } finally {
    tb.restore();
  }
});

test("waiting messages follow TorBox's own state", () => {
  assert.match(torbox.waitingStatus({ progress: 0.42, download_state: "downloading" }), /^Downloading on TorBox \(42%\)/);
  assert.match(torbox.waitingStatus({ progress: 0, download_state: "queued" }), /^Queued on TorBox/);
  assert.match(torbox.waitingStatus({ download_state: "metaDL" }), /fetching this torrent's details/);
  assert.match(torbox.waitingStatus({ progress: 0.1, download_state: "paused" }), /Resume it on torbox.app/);
});

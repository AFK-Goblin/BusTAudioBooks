// test/appRelease.test.js — where the app's "New version available" comes from.
const test = require("node:test");
const assert = require("node:assert/strict");
const { appRelease, _releaseCache } = require("../src/appRelease");

function fakeGitHub(reply) {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    return reply === "down" ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, json: async () => reply };
  };
  return { calls, restore: () => { global.fetch = realFetch; } };
}

test.beforeEach(() => _releaseCache.m.clear());

test("the latest GitHub release with an APK, when the environment doesn't say", async () => {
  const gh = fakeGitHub({
    tag_name: "v3.2.0",
    assets: [{ name: "notes.txt", browser_download_url: "https://x/notes" }, { name: "BusTAudioBooks-3.2.0.apk", browser_download_url: "https://github.com/x/BusTAudioBooks-3.2.0.apk" }],
  });
  try {
    assert.deepEqual(await appRelease({}), { latestVersion: "3.2.0", apkUrl: "https://github.com/x/BusTAudioBooks-3.2.0.apk", minVersion: null });
    await appRelease({});
    assert.equal(gh.calls.length, 1); // cached
    assert.match(gh.calls[0], /repos\/AFK-Goblin\/BusTAudioBooks-App\/releases\/latest$/);
  } finally {
    gh.restore();
  }
});

test("the environment wins; 'none' turns GitHub off; no APK or no GitHub means no prompt", async () => {
  let gh = fakeGitHub({ tag_name: "v9.9.9", assets: [{ name: "a.apk", browser_download_url: "https://x/a.apk" }] });
  try {
    assert.deepEqual(await appRelease({ APP_LATEST_VERSION: "3.2.0", APP_APK_URL: "https://mine/app.apk", APP_MIN_VERSION: "3.0.0" }),
      { latestVersion: "3.2.0", apkUrl: "https://mine/app.apk", minVersion: "3.0.0" });
    assert.deepEqual(await appRelease({ APP_RELEASES_REPO: "none" }), { latestVersion: null, apkUrl: null, minVersion: null });
    assert.equal(gh.calls.length, 0);
  } finally {
    gh.restore();
  }
  gh = fakeGitHub({ tag_name: "v3.3.0", assets: [{ name: "source.zip", browser_download_url: "https://x/s.zip" }] });
  try {
    assert.equal((await appRelease({})).apkUrl, null);
  } finally {
    gh.restore();
  }
  _releaseCache.m.clear();
  gh = fakeGitHub("down");
  try {
    assert.deepEqual(await appRelease({}), { latestVersion: null, apkUrl: null, minVersion: null });
  } finally {
    gh.restore();
  }
});

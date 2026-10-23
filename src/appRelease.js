// src/appRelease.js
// The newest app APK, for the app's "New version available" prompt.
// APP_LATEST_VERSION + APP_APK_URL in the environment win; otherwise it's the
// latest release of the app's GitHub repo that has an .apk attached (public
// API, no key; cached an hour — GitHub allows 60 unauthenticated calls an
// hour). APP_RELEASES_REPO picks another repo, or "none" to turn this off.

const { TTLCache, withTimeout } = require("./cache");

const DEFAULT_REPO = "AFK-Goblin/BusTAudioBooks-App";
const releaseCache = new TTLCache(60 * 60 * 1000, 8);

async function latestOnGitHub(repo) {
  const hit = releaseCache.get(repo);
  if (hit !== undefined) return hit;
  let result = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "bustaudio-server" },
    });
    if (res.ok) {
      const release = await res.json();
      const apk = (release.assets || []).find((a) => /\.apk$/i.test(a.name || ""));
      const version = String(release.tag_name || "").replace(/^v/i, "");
      if (apk && apk.browser_download_url && /^\d+(\.\d+)*$/.test(version)) {
        result = { latestVersion: version, apkUrl: apk.browser_download_url };
      }
    }
  } catch (_) {
    /* offline or rate-limited: no prompt */
  }
  releaseCache.set(repo, result, result ? undefined : 10 * 60 * 1000);
  return result;
}

// { latestVersion, apkUrl, minVersion } — fields null when unknown; never throws.
async function appRelease(env = process.env) {
  const minVersion = env.APP_MIN_VERSION || null;
  if (env.APP_LATEST_VERSION && env.APP_APK_URL) {
    return { latestVersion: env.APP_LATEST_VERSION, apkUrl: env.APP_APK_URL, minVersion };
  }
  const repo = (env.APP_RELEASES_REPO || DEFAULT_REPO).trim();
  const found = /^none$/i.test(repo) ? null : await withTimeout(latestOnGitHub(repo), 5000, null);
  return { latestVersion: (found && found.latestVersion) || null, apkUrl: (found && found.apkUrl) || null, minVersion };
}

module.exports = { appRelease, _releaseCache: releaseCache };

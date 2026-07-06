// src/torbox.js
// Thin wrapper around the TorBox API (v1).
// Docs: https://api-docs.torbox.app/   Base: https://api.torbox.app/v1/api
//
// The flow this addon uses:
//   1. checkCached(hash)        -> is it instantly available?
//   2. createTorrent(magnet)    -> add it to the user's account (idempotent-ish)
//   3. getTorrent(id|hash)      -> read back the file list + status
//   4. requestDownloadLink(...) -> get a direct HTTPS link per file
//
// requestdl returns a plain HTTPS URL, so the same link Stremio plays can also
// be pasted into any downloader (browser, curl, aria2, IDM, ...).

const http = require("http");
const https = require("https");

const API_BASE = "https://api.torbox.app/v1/api";

const AUDIO_EXTENSIONS = [
  ".mp3", ".m4a", ".m4b", ".m4p", ".flac", ".ogg", ".opus",
  ".aac", ".wav", ".wma", ".alac", ".aiff", ".ape",
];

// A small public tracker list, only used when we have to build a magnet from a
// bare infohash (some indexers return InfoHash but no MagnetUri).
const FALLBACK_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://exodus.desync.com:6969/announce",
];

function authHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

function isAudioFile(name) {
  const lower = (name || "").toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// Formats the Stremio *web* player can generally handle. Others (m4b, flac, ...)
// get behaviorHints.notWebReady so the app routes them to an external player
// instead of failing silently in the browser.
const WEB_READY_EXTENSIONS = [".mp3", ".m4a", ".aac", ".wav", ".ogg", ".opus"];
function webReadyForFile(name) {
  const lower = (name || "").toLowerCase();
  return WEB_READY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// Pull a lowercase infohash out of a magnet link.
function infohashFromMagnet(magnet) {
  if (!magnet) return null;
  const m = magnet.match(/xt=urn:btih:([0-9a-zA-Z]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function magnetFromInfohash(infohash, name) {
  const dn = name ? `&dn=${encodeURIComponent(name)}` : "";
  const tr = FALLBACK_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
  return `magnet:?xt=urn:btih:${infohash}${dn}${tr}`;
}

async function tbFetch(path, { apiKey, method = "GET", body, query } = {}) {
  const url = new URL(API_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    method,
    headers: apiKey ? authHeaders(apiKey) : undefined,
    body,
  });
  let json;
  try {
    json = await res.json();
  } catch (_) {
    throw new Error(`TorBox returned non-JSON (HTTP ${res.status})`);
  }
  return json; // standard shape: { success, error, detail, data }
}

// Is this hash already cached on TorBox? Returns true/false.
async function checkCached(apiKey, hash) {
  const json = await tbFetch("/torrents/checkcached", {
    apiKey,
    query: { hash: hash.toLowerCase(), format: "object", list_files: "false" },
  });
  if (!json || !json.success || !json.data) return false;
  // data is an object keyed by hash (empty object => not cached).
  return Object.keys(json.data).length > 0;
}

// Batch version: given many hashes, return a Set of the ones cached on TorBox.
// The endpoint accepts comma-separated hashes (~100 max), so we chunk.
async function checkCachedMany(apiKey, hashes) {
  const cached = new Set();
  const uniq = [...new Set((hashes || []).map((h) => String(h).toLowerCase()))];
  const CHUNK = 50;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const part = uniq.slice(i, i + CHUNK);
    try {
      const json = await tbFetch("/torrents/checkcached", {
        apiKey,
        query: { hash: part.join(","), format: "object", list_files: "false" },
      });
      if (json && json.success && json.data && typeof json.data === "object") {
        for (const k of Object.keys(json.data)) cached.add(k.toLowerCase());
      }
    } catch (_) {
      // ignore this chunk; cache status is non-critical
    }
  }
  return cached;
}

// Lightweight credential check for the /health route.
async function validateKey(apiKey) {
  try {
    const json = await tbFetch("/torrents/mylist", {
      apiKey,
      query: { limit: 1, bypass_cache: "false" },
    });
    return !!(json && json.success);
  } catch (_) {
    return false;
  }
}

// Add a magnet to the user's account. Returns { torrent_id, hash } or throws.
async function createTorrent(apiKey, magnet, { addOnlyIfCached = false } = {}) {
  const form = new FormData();
  form.append("magnet", magnet);
  form.append("seed", "1"); // 1 = auto
  if (addOnlyIfCached) form.append("add_only_if_cached", "true");
  const json = await tbFetch("/torrents/createtorrent", {
    apiKey,
    method: "POST",
    body: form,
  });
  if (!json || !json.success) {
    // DUPLICATE_ITEM is fine — it's already in the account.
    if (json && json.error === "DUPLICATE_ITEM" && json.data) return json.data;
    throw new Error(json && json.detail ? json.detail : "createTorrent failed");
  }
  return json.data; // { hash, torrent_id, auth_id }
}

// Fetch a URL following redirects *manually*, so a redirect to a `magnet:` link
// (which Jackett's /dl endpoint commonly returns) can be caught rather than
// making fetch() choke on a non-http scheme. Resolves to { magnet } or { buffer }.
function fetchTorrentSource(url, maxHops = 6) {
  return new Promise((resolve, reject) => {
    const step = (u, hops) => {
      if (hops > maxHops) return reject(new Error("too many redirects"));
      let parsed;
      try {
        parsed = new URL(u);
      } catch (_) {
        return reject(new Error("bad torrent URL"));
      }
      if (parsed.protocol === "magnet:") return resolve({ magnet: u });
      const lib = parsed.protocol === "https:" ? https : http;
      const req = lib.get(u, (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume(); // drain
          const loc = headers.location;
          if (loc.startsWith("magnet:")) return resolve({ magnet: loc });
          return step(new URL(loc, u).toString(), hops + 1);
        }
        if (statusCode >= 400) {
          res.resume();
          return reject(new Error(`torrent download failed (HTTP ${statusCode})`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ buffer: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.setTimeout(20000, () => req.destroy(new Error("torrent download timeout")));
    };
    step(url, 0);
  });
}

// Add a torrent by resolving an indexer download link (e.g. a Jackett /dl/ link).
// The link may redirect to a magnet, or return a .torrent file — we handle both.
async function createTorrentFromUrl(apiKey, url, { addOnlyIfCached = false } = {}) {
  const src = await fetchTorrentSource(url);

  if (src.magnet) {
    return createTorrent(apiKey, src.magnet, { addOnlyIfCached });
  }

  const form = new FormData();
  form.append("file", new Blob([src.buffer], { type: "application/x-bittorrent" }), "t.torrent");
  form.append("seed", "1");
  if (addOnlyIfCached) form.append("add_only_if_cached", "true");
  const json = await tbFetch("/torrents/createtorrent", {
    apiKey,
    method: "POST",
    body: form,
  });
  if (!json || !json.success) {
    if (json && json.error === "DUPLICATE_ITEM" && json.data) return json.data;
    throw new Error(json && json.detail ? json.detail : "createTorrent (file) failed");
  }
  return json.data;
}

// Get the user's torrent list (optionally a single one by id).
async function getMyList(apiKey, { id } = {}) {
  const json = await tbFetch("/torrents/mylist", {
    apiKey,
    query: { bypass_cache: "true", id },
  });
  if (!json || !json.success) return id !== undefined ? null : [];
  return json.data; // array, or single object when id is provided
}

// Find a torrent the user already has by infohash.
async function findTorrentByHash(apiKey, hash) {
  const list = await getMyList(apiKey);
  if (!Array.isArray(list)) return null;
  const target = hash.toLowerCase();
  return list.find((t) => (t.hash || "").toLowerCase() === target) || null;
}

// Get a direct, downloadable link for one file inside a torrent.
// NOTE: requestdl authenticates via the `token` query param (not the Bearer
// header) precisely so the resulting link is usable as a plain URL.
async function requestDownloadLink(apiKey, torrentId, fileId) {
  const json = await tbFetch("/torrents/requestdl", {
    query: { token: apiKey, torrent_id: torrentId, file_id: fileId, redirect: "false" },
  });
  if (!json || !json.success || !json.data) {
    throw new Error(json && json.detail ? json.detail : "requestdl failed");
  }
  return json.data; // the direct HTTPS url
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// High-level: given a magnet (or infohash), make sure it's on TorBox and return
// playable/downloadable streams for each audio file.
//
// Returns { ready: boolean, streams: [...], status: string }
//   ready === false means TorBox is still downloading an uncached torrent; the
//   caller should surface a "preparing" message and let the user retry.
async function resolveStreams(apiKey, { magnet, infohash, name, torrentUrl, instantOnly = false }) {
  let hash = infohash ? infohash.toLowerCase() : infohashFromMagnet(magnet);
  if (!hash && !magnet && !torrentUrl) {
    throw new Error("No infohash, magnet, or torrent link provided");
  }
  if (!magnet && hash) magnet = magnetFromInfohash(hash, name);

  // 1. Is it already in the user's account? (Only checkable if we know the hash.)
  let torrent = hash ? await findTorrentByHash(apiKey, hash) : null;

  // Instant-only mode: never trigger an uncached download. If it isn't already
  // in the account and isn't cached, bail early. (Only possible when we know the
  // hash up front; hashless Jackett items fall through to add_only_if_cached.)
  if (!torrent && instantOnly && hash) {
    const cached = await checkCached(apiKey, hash);
    if (!cached) {
      return { ready: false, streams: [], status: "Not cached on TorBox (instant-only mode)." };
    }
  }

  // 2. If not, add it. Prefer a magnet; otherwise upload the .torrent from the
  //    indexer's download link. (Cached = near-instant; uncached = TorBox pulls it.)
  if (!torrent) {
    let added;
    if (magnet) {
      added = await createTorrent(apiKey, magnet, { addOnlyIfCached: instantOnly });
    } else {
      added = await createTorrentFromUrl(apiKey, torrentUrl, { addOnlyIfCached: instantOnly });
    }
    const id = added && added.torrent_id;
    if (id !== undefined && id !== null) {
      torrent = await getMyList(apiKey, { id });
    }
    // Fall back to a hash lookup using whatever hash we now know.
    const knownHash = hash || (added && added.hash && added.hash.toLowerCase());
    if (!torrent && knownHash) torrent = await findTorrentByHash(apiKey, knownHash);
  }

  if (!torrent) {
    return { ready: false, streams: [], status: "Queued on TorBox. Try again shortly." };
  }

  // We now have the real hash from TorBox (needed for bingeGroup / dedupe).
  hash = (torrent.hash || hash || "").toLowerCase();

  const filesReady =
    torrent.download_present === true ||
    torrent.download_finished === true ||
    (Array.isArray(torrent.files) && torrent.files.length > 0);

  if (!filesReady) {
    const pct = typeof torrent.progress === "number"
      ? ` (${Math.round(torrent.progress * 100)}%)`
      : "";
    return {
      ready: false,
      streams: [],
      status: `Downloading on TorBox${pct}. Try again shortly.`,
    };
  }

  // 3. Build a stream per audio file.
  const audioFiles = (torrent.files || [])
    .filter((f) => isAudioFile(f.name || f.short_name))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));

  const streams = [];
  for (const file of audioFiles) {
    try {
      const url = await requestDownloadLink(apiKey, torrent.id, file.id);
      const shortName = (file.short_name || file.name || "").split("/").pop();
      const size = formatBytes(file.size);
      streams.push({
        name: "TorBox",
        title: size ? `${shortName}\n${size}` : shortName,
        url,
        behaviorHints: {
          bingeGroup: `torbox-${hash}`,
          filename: shortName,
          // Browsers can't play m4b/flac/etc.; hint Stremio to use an external player.
          notWebReady: !webReadyForFile(shortName),
        },
      });
    } catch (err) {
      // Skip files that fail to resolve, keep the rest.
      console.error("requestdl failed for file", file.id, err.message);
    }
  }

  if (streams.length === 0) {
    return { ready: false, streams: [], status: "No audio files found in this torrent." };
  }
  return { ready: true, streams, status: "ok" };
}

module.exports = {
  API_BASE,
  isAudioFile,
  webReadyForFile,
  infohashFromMagnet,
  magnetFromInfohash,
  checkCached,
  checkCachedMany,
  validateKey,
  createTorrent,
  createTorrentFromUrl,
  getMyList,
  findTorrentByHash,
  requestDownloadLink,
  resolveStreams,
  formatBytes,
};

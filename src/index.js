// src/index.js
const express = require("express");
const crypto = require("crypto");
const { manifest } = require("./manifest");
const { decodeConfig } = require("./config");
const { searchAudiobooks, searchComics, qualityScore, comicQualityScore } = require("./sources");
const { enrich } = require("./metadata");
const { encodeItemId, decodeItemId } = require("./itemid");
const { TTLCache, pLimit, withTimeout } = require("./cache");
const { makeAccess } = require("./access");
const torbox = require("./torbox");

const app = express();
const PORT = process.env.PORT || 7000;
const access = makeAccess(); // shared-token gate (off unless ACCESS_TOKENS set)

const searchCache = new TTLCache(5 * 60 * 1000, 200); // resolved catalog results
const streamCache = new TTLCache(30 * 60 * 1000, 500); // resolved playable streams
const limitMeta = pLimit(6); // cap concurrent cover-art lookups

// Cache key for resolved streams: hash the API key so it never lands in a key.
// Includes the content type — the same torrent resolved as "comic" keeps a
// different file set than as "audiobook".
function streamKey(apiKey, type, infohash) {
  const kh = crypto.createHash("sha1").update(apiKey).digest("hex").slice(0, 12);
  return `${kh}:${type}:${infohash}`;
}

// Whitelist the content type; anything unknown falls back to audiobook.
function typeOf(x) {
  return x === "comic" ? "comic" : "audiobook";
}

// Instant-only can be set per-install (config) or globally (env).
function isInstantOnly(cfg) {
  return !!(cfg.instantOnly || process.env.INSTANT_ONLY === "1");
}

// ---- CORS (Stremio fetches these routes from the browser) -------------------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Build a short "Format · Bitrate · Size" line for descriptions/titles.
function detailLine(parts) {
  return parts.filter(Boolean).join(" · ");
}

// Strip "[M4B]"-style tags and "(Unabridged)" noise from a title for display,
// while keeping the readable "Title - Author" part.
function prettyName(raw) {
  return String(raw || "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\((?:un)?abridged\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Read & validate the per-user config from the URL path segment.
function getConfig(req, res) {
  const cfg = decodeConfig(req.params.config);
  if (!cfg || !cfg.apiKey) {
    res.status(400).json({ err: "Missing or invalid configuration. Re-install the addon." });
    return null;
  }
  if (!access.valid(cfg.token)) {
    res.status(403).json({ err: "Invalid or missing access token for this instance." });
    return null;
  }
  return cfg;
}

// ---- Configure page (landing) ----------------------------------------------
const CONFIGURE_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>BusTAudioBooks — Configure</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; background:#15101c; color:#ece8f1;
         max-width:560px; margin:0 auto; padding:32px 20px; line-height:1.5; }
  h1 { font-size:1.5rem; margin-bottom:4px; }
  p.sub { color:#a99fb8; margin-top:0; }
  label { display:block; margin:18px 0 6px; font-weight:600; font-size:.92rem; }
  input { width:100%; padding:11px 12px; border-radius:9px; border:1px solid #3a3147;
          background:#221a2e; color:#fff; font-size:.95rem; box-sizing:border-box; }
  small { color:#8f859e; }
  button { margin-top:24px; width:100%; padding:13px; border:0; border-radius:10px;
           background:#8b5cf6; color:#fff; font-size:1rem; font-weight:600; cursor:pointer; }
  .out { margin-top:24px; display:none; }
  .row { display:flex; gap:8px; }
  .row input { font-size:.8rem; }
  .copy { width:auto; margin-top:0; padding:0 16px; background:#3a3147; }
  a.install { display:block; text-align:center; margin-top:12px; padding:13px;
              border-radius:10px; background:#22c55e; color:#062b14; font-weight:700;
              text-decoration:none; }
</style></head>
<body>
  <h1>BusTAudioBooks</h1>
  <p class="sub">Search &amp; stream audiobooks through your TorBox account.</p>

  <label>TorBox API key <small>(required)</small></label>
  <input id="apiKey" placeholder="from torbox.app → Settings → API"/>

  <div id="tokenCfg" style="display:none">
    <label>Access token <small>(required — ask whoever runs this instance)</small></label>
    <input id="accessToken" placeholder="access token"/>
  </div>

  <p id="serverNote" style="display:none;margin-top:16px;color:#8f859e;font-size:.9rem">
    🔎 Search is provided by this server — just add your TorBox key above and install.
  </p>

  <div id="sourceCfg">
    <label>AudiobookBay domain <small>(enables search, no extra software)</small></label>
    <input id="abbDomain" placeholder="e.g. audiobookbay.lu — current working domain"/>

    <details style="margin-top:18px">
      <summary style="cursor:pointer;color:#a99fb8">Advanced: use Jackett/Prowlarr instead (optional)</summary>
      <label>Jackett / Prowlarr URL</label>
      <input id="jackettUrl" placeholder="http://localhost:9117"/>
      <label>Indexer API key</label>
      <input id="jackettApiKey" placeholder="Jackett/Prowlarr API key"/>
      <p style="margin-top:10px;color:#8f859e;font-size:.85rem">
        📚 Comics search in the mobile app also uses Jackett/Prowlarr
        (Torznab category 7030) — add an indexer that carries comics to enable it.
      </p>
    </details>
  </div>

  <label style="display:flex;align-items:center;gap:10px;margin-top:18px;font-weight:600;font-size:.92rem">
    <input type="checkbox" id="instantOnly" style="width:auto"/>
    Instant-only — only show titles already cached on TorBox
  </label>

  <button onclick="gen()">Generate install link</button>

  <div class="out" id="out">
    <label>Manifest URL</label>
    <div class="row">
      <input id="url" readonly/>
      <button class="copy" onclick="copy()">Copy</button>
    </div>
    <a class="install" id="install">Install in Stremio</a>
  </div>

<script>
function b64url(str){
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
}
function gen(){
  var apiKey=document.getElementById('apiKey').value.trim();
  if(!apiKey){ alert('TorBox API key is required'); return; }
  var cfg={ apiKey:apiKey };
  var abb=document.getElementById('abbDomain').value.trim();
  var ju=document.getElementById('jackettUrl').value.trim();
  var jk=document.getElementById('jackettApiKey').value.trim();
  if(abb) cfg.abbDomain=abb;
  if(ju) cfg.jackettUrl=ju;
  if(jk) cfg.jackettApiKey=jk;
  if(document.getElementById('instantOnly').checked) cfg.instantOnly=true;
  var tok=document.getElementById('accessToken').value.trim();
  if(tok) cfg.token=tok;
  var seg=b64url(JSON.stringify(cfg));
  var base=location.origin+'/'+seg+'/manifest.json';
  document.getElementById('url').value=base;
  document.getElementById('install').href=base.replace(/^https?:/,'stremio:');
  document.getElementById('out').style.display='block';
}
function copy(){
  var f=document.getElementById('url'); f.select();
  navigator.clipboard.writeText(f.value);
}
// When the server already provides search (env vars), hide the source fields
// so users only need their TorBox key.
if (window.__serverSearch) {
  document.getElementById('sourceCfg').style.display='none';
  document.getElementById('serverNote').style.display='block';
}
if (window.__requireToken) {
  document.getElementById('tokenCfg').style.display='block';
}
</script>
</body></html>`;

function sendConfigure(_req, res) {
  const serverSearch =
    (!!process.env.JACKETT_URL && !!process.env.JACKETT_API_KEY) || !!process.env.ABB_DOMAIN;
  const flag =
    `<script>window.__serverSearch=${serverSearch ? "true" : "false"};` +
    `window.__requireToken=${access.required ? "true" : "false"};</script>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(CONFIGURE_HTML.replace("</head>", `${flag}</head>`));
}
app.get("/", (_req, res) => res.redirect("/configure"));
app.get("/configure", sendConfigure);
// Stremio opens /<config>/configure for re-configuration.
app.get("/:config/configure", sendConfigure);

// ---- Manifest ---------------------------------------------------------------
app.get("/:config/manifest.json", (req, res) => {
  const cfg = getConfig(req, res);
  if (!cfg) return;
  // Advertise as already-configured for this install.
  res.json({ ...manifest, behaviorHints: { ...manifest.behaviorHints, configurationRequired: false } });
});

// ---- Shared search (used by both the Stremio catalog and the app API) -------
// Returns enriched result items: the raw source item plus { poster, author,
// cached }. Cached per query/page so both consumers share the heavy work.
async function runSearch(cfg, query, page, type = "audiobook") {
  const instantOnly = isInstantOnly(cfg);
  const effJackett = cfg.jackettUrl || process.env.JACKETT_URL || "";
  const cacheKey = `${type}|${cfg.abbDomain || ""}|${effJackett}|${instantOnly ? "I" : ""}|${query}|${page}`;
  const hit = searchCache.get(cacheKey);
  if (hit) return hit;

  let results = [];
  try {
    results =
      type === "comic"
        ? await searchComics(cfg, query, page)
        : await searchAudiobooks(cfg, query, page);
  } catch (err) {
    console.error("search error:", err.message);
  }
  results = results.slice(0, 40);

  let cachedSet = new Set();
  try {
    const hashes = results.map((r) => r.infohash).filter(Boolean);
    if (hashes.length) cachedSet = await torbox.checkCachedMany(cfg.apiKey, hashes);
  } catch (_) {
    /* non-critical */
  }

  if (instantOnly) results = results.filter((r) => r.infohash && cachedSet.has(r.infohash));

  results.sort((a, b) => {
    const ca = a.infohash && cachedSet.has(a.infohash) ? 1 : 0;
    const cb = b.infohash && cachedSet.has(b.infohash) ? 1 : 0;
    if (ca !== cb) return cb - ca;
    const score = type === "comic" ? comicQualityScore : qualityScore;
    const qa = score(a);
    const qb = score(b);
    if (qa !== qb) return qb - qa;
    return (b.seeders || 0) - (a.seeders || 0);
  });

  const enriched = await Promise.all(
    results.map((r) =>
      limitMeta(async () => {
        const meta = await withTimeout(enrich(r.name, type), 2500, { poster: null, author: null });
        return {
          ...r,
          poster: meta.poster || null,
          author: meta.author || null,
          cached: !!(r.infohash && cachedSet.has(r.infohash)),
        };
      })()
    )
  );

  searchCache.set(cacheKey, enriched);
  return enriched;
}

// ---- Catalog (search only) --------------------------------------------------
async function handleCatalog(req, res, extraRaw) {
  const cfg = getConfig(req, res);
  if (!cfg) return;

  // Parse extras like "search=foo&skip=20"
  const extra = {};
  if (extraRaw) {
    for (const pair of extraRaw.split("&")) {
      const idx = pair.indexOf("=");
      if (idx === -1) continue;
      extra[pair.slice(0, idx)] = decodeURIComponent(pair.slice(idx + 1));
    }
  }
  const query = (extra.search || "").trim();
  if (!query) return res.json({ metas: [] });

  const PAGE_SIZE = 12;
  const skip = parseInt(extra.skip, 10) || 0;
  const page = Math.floor(skip / PAGE_SIZE) + 1;

  const items = await runSearch(cfg, query, page);
  const metas = items.map((r) => ({
    id: encodeItemId(r),
    type: "audiobook",
    name: prettyName(r.name),
    poster: r.poster || undefined,
    posterShape: "square",
    description:
      detailLine([
        r.cached ? "⚡ Instant" : null,
        r.format,
        r.bitrate,
        torbox.formatBytes(r.size),
        r.author,
      ]) || r.tracker,
  }));
  res.json({ metas });
}

app.get("/:config/catalog/:type/:id.json", (req, res) => handleCatalog(req, res, null));
app.get("/:config/catalog/:type/:id/:extra.json", (req, res) =>
  handleCatalog(req, res, req.params.extra)
);

// ---- Meta -------------------------------------------------------------------
app.get("/:config/meta/:type/:id.json", async (req, res) => {
  const cfg = getConfig(req, res);
  if (!cfg) return;
  const item = decodeItemId(req.params.id);
  if (!item) return res.json({ meta: null });

  const [meta, isCached] = await Promise.all([
    withTimeout(enrich(item.name), 2500, { poster: null, author: null, year: null }),
    item.infohash
      ? withTimeout(torbox.checkCached(cfg.apiKey, item.infohash), 4000, false)
      : Promise.resolve(false),
  ]);

  const facts = detailLine([
    item.infohash
      ? (isCached ? "⚡ Instant on TorBox" : "Will download to TorBox on play")
      : "Adds to TorBox on play",
    item.format,
    item.bitrate,
    torbox.formatBytes(item.size),
  ]);
  const description = [meta.author ? `By ${meta.author}` : null, facts]
    .filter(Boolean)
    .join("\n");

  res.json({
    meta: {
      id: req.params.id,
      type: "audiobook",
      name: prettyName(item.name) || "Audiobook",
      poster: meta.poster || undefined,
      background: meta.poster || undefined,
      posterShape: "square",
      description,
    },
  });
});

// ---- Shared stream resolution (Stremio + app) -------------------------------
// Returns { ready, status, streams } where streams are raw {title,url,filename,
// behaviorHints}. Cached per (apiKey, item) so re-opens don't re-hit TorBox.
async function resolveForItem(cfg, item) {
  const type = typeOf(item.type);
  const key = streamKey(cfg.apiKey, type, item.infohash || item.torrentUrl || item.name);
  const cachedStreams = streamCache.get(key);
  if (cachedStreams) return { ready: true, status: "ok", streams: cachedStreams };

  const result = await torbox.resolveStreams(cfg.apiKey, {
    magnet: item.magnet,
    infohash: item.infohash,
    torrentUrl: item.torrentUrl,
    name: item.name,
    instantOnly: isInstantOnly(cfg),
    kind: type === "comic" ? "comic" : "audio",
  });
  if (result.ready) streamCache.set(key, result.streams);
  return result;
}

// ---- Stream -----------------------------------------------------------------
app.get("/:config/stream/:type/:id.json", async (req, res) => {
  const cfg = getConfig(req, res);
  if (!cfg) return;
  const item = decodeItemId(req.params.id);
  if (!item) return res.json({ streams: [] });

  const tag = detailLine([item.format, item.bitrate]);
  const decorate = (streams) =>
    streams.map((s) => ({ ...s, name: tag ? `BusTAudioBooks\n${tag}` : "BusTAudioBooks" }));

  try {
    const result = await resolveForItem(cfg, item);
    if (result.ready) {
      return res.json({ streams: decorate(result.streams) });
    }
    // Not cached yet: surface a non-playable info entry so the user knows to wait.
    return res.json({
      streams: [
        {
          name: "BusTAudioBooks",
          title: `⏳ ${result.status}`,
          externalUrl: "https://torbox.app/",
        },
      ],
    });
  } catch (err) {
    console.error("stream error:", err.message);
    return res.json({
      streams: [{ name: "BusTAudioBooks", title: `⚠️ ${err.message}`, externalUrl: "https://torbox.app/" }],
    });
  }
});

// ---- App JSON API (for the native app) --------------------------------------
// Simple, app-friendly endpoints backed by the same search + TorBox logic.

// GET /:config/app/search?q=...&page=1&type=audiobook|comic
app.get("/:config/app/search", async (req, res) => {
  const cfg = getConfig(req, res);
  if (!cfg) return;
  const query = String(req.query.q || "").trim();
  if (!query) return res.json({ results: [] });
  const page = parseInt(req.query.page, 10) || 1;
  const type = typeOf(req.query.type);

  const items = await runSearch(cfg, query, page, type);
  res.json({
    results: items.map((r) => ({
      id: encodeItemId(r),
      type,
      title: prettyName(r.name),
      author: r.author || null,
      poster: r.poster || null,
      format: r.format || null,
      bitrate: r.bitrate || null,
      size: r.size || 0,
      sizeText: torbox.formatBytes(r.size) || null,
      cached: !!r.cached,
    })),
  });
});

// GET /:config/app/streams/:id  -> playable files for a book
app.get("/:config/app/streams/:id", async (req, res) => {
  const cfg = getConfig(req, res);
  if (!cfg) return;
  const item = decodeItemId(req.params.id);
  if (!item) return res.status(400).json({ ready: false, streams: [], status: "Bad item id" });

  try {
    const result = await resolveForItem(cfg, item);
    return res.json({
      ready: !!result.ready,
      status: result.status || (result.ready ? "ok" : "preparing"),
      title: prettyName(item.name),
      type: typeOf(item.type),
      format: item.format || null,
      bitrate: item.bitrate || null,
      streams: (result.streams || []).map((s) => ({
        title: (s.behaviorHints && s.behaviorHints.filename) || s.title || item.name,
        url: s.url,
        filename: (s.behaviorHints && s.behaviorHints.filename) || null,
      })),
    });
  } catch (err) {
    console.error("app streams error:", err.message);
    return res.status(502).json({ ready: false, streams: [], status: err.message });
  }
});

// GET /:config/app/version  -> latest native APK info (for in-app update prompt)
app.get("/:config/app/version", (req, res) => {
  const cfg = getConfig(req, res);
  if (!cfg) return;
  res.json({
    latestVersion: process.env.APP_LATEST_VERSION || null,
    apkUrl: process.env.APP_APK_URL || null,
    minVersion: process.env.APP_MIN_VERSION || null,
  });
});

async function handleHealth(req, res) {
  const cfg = decodeConfig(req.params.config || "");
  const out = {
    ok: true,
    addon: manifest.name,
    version: manifest.version,
  };
  if (cfg && cfg.apiKey) {
    out.torboxKeyValid = await withTimeout(torbox.validateKey(cfg.apiKey), 5000, false);
    const hasJackett = !!(
      (cfg.jackettUrl || process.env.JACKETT_URL) &&
      (cfg.jackettApiKey || process.env.JACKETT_API_KEY)
    );
    out.sources = {
      audiobookbay: !!(cfg.abbDomain || process.env.ABB_DOMAIN),
      jackett: hasJackett,
      // Comics search rides on Jackett (Torznab category 7030), so its
      // availability IS Jackett's availability.
      comics: hasJackett,
      serverProvided: !!(process.env.JACKETT_URL && process.env.JACKETT_API_KEY) || !!process.env.ABB_DOMAIN,
    };
    out.abbDomain = cfg.abbDomain || process.env.ABB_DOMAIN || null;
    out.instantOnly = isInstantOnly(cfg);
    out.accessGate = access.required;
  } else {
    out.note = "No config in URL — append /<config>/health for a full check.";
  }
  res.json(out);
}
app.get("/health", handleHealth);
app.get("/:config/health", handleHealth);

app.listen(PORT, () => {
  console.log(`BusTAudioBooks addon running on http://127.0.0.1:${PORT}`);
  console.log(`Open http://127.0.0.1:${PORT}/configure to generate your install link.`);
});

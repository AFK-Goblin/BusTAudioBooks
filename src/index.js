// src/index.js
const express = require("express");
const crypto = require("crypto");
const { networkInterfaces } = require("os");
const { manifest } = require("./manifest");
const { decodeConfig } = require("./config");
const { abbDomain, searchAudiobooks, searchComics, qualityScore, comicQualityScore } = require("./sources");
const mangadex = require("./mangadex");
const { enrich, parseNameParts } = require("./metadata");
const { chapterTitle } = require("./presentation");
const { matchesLanguageFilter, preferredLanguage, releaseLanguage, isFrenchTracker, languageScore } = require("./language");
const { encodeItemId, decodeItemId } = require("./itemid");
const { TTLCache, pLimit, withTimeout } = require("./cache");
const { makeAccess } = require("./access");
const torbox = require("./torbox");
const { providerFor } = require("./providers");

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
  if (!cfg || typeof cfg.apiKey !== "string" || !cfg.apiKey || ![undefined, "torbox", "alldebrid"].includes(cfg.provider)) {
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
  section { border-top:1px solid #3a3147; margin-top:24px; padding-top:12px; }
  h2 { font-size:1.15rem; margin-bottom:8px; }
  .toggle { display:flex; align-items:center; gap:10px; }
  .toggle input { width:auto; }
  .tracker { border-left:2px solid #3a3147; padding-left:16px; margin-top:12px; }
  [hidden] { display:none !important; }
  p.sub { color:#a99fb8; margin-top:0; }
  label { display:block; margin:18px 0 6px; font-weight:600; font-size:.92rem; }
  input, select { width:100%; padding:11px 12px; border-radius:9px; border:1px solid #3a3147;
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
  <p class="sub">Connect your audiobook app with AllDebrid or TorBox and your trackers.</p>

  <section aria-labelledby="commonHeading">
  <h2 id="commonHeading">Common settings</h2>
  <label>Debrid provider</label>
  <select id="provider" onchange="providerChanged()"><option value="torbox">TorBox</option><option value="alldebrid">AllDebrid</option></select>
  <label>Service API key <small>(required)</small></label>
  <input id="apiKey" type="password" placeholder="Your selected provider's API key"/>
  <label for="languageFilter">Book language</label>
  <select id="languageFilter" aria-describedby="languageHelp"><option value="">All languages</option><option value="fr">French only</option><option value="en">English only</option></select>
  <p id="languageHelp"><small>C411, Tr4ker and Torr9 default to French unless a release specifies another language. AudiobookBay and other sources need an explicit language field or release tag to appear in French-only or English-only searches.</small></p>
  <label>Preferred audiobook format</label>
  <select id="preferredFormat"><option value="">Any format</option><option value="mp3">Prefer MP3</option><option value="m4b">Prefer M4B</option></select>
  <label>Maximum release size (GB) <small>(optional; unknown sizes remain visible)</small></label><input id="maxSizeGB" type="number" min="0" step="0.1"/>


  <div id="tokenCfg" style="display:none">
    <label>Access token <small>(required — ask whoever runs this instance)</small></label>
    <input id="accessToken" placeholder="access token"/>
  </div>

  <label style="display:flex;align-items:center;gap:10px;margin-top:18px;font-weight:600;font-size:.92rem">
    <input type="checkbox" id="instantOnly" style="width:auto"/>
    <span id="instantLabel">Instant-only — only show titles already cached on TorBox</span>
  </label>

  </section>
  <section aria-labelledby="sourcesHeading">
  <h2 id="sourcesHeading">Search sources</h2>
  <p id="serverNote" style="display:none;margin-top:16px;color:#8f859e;font-size:.9rem">
    🔎 Additional search sources are provided by this server.
  </p>

  <div id="sourceCfg">
    <label for="abbDomain" id="abbLabel">AudiobookBay domain</label>
    <p id="abbHelp"></p>
    <input id="abbDomain" aria-describedby="abbHelp" placeholder="Enter an AudiobookBay domain to enable this source"/>

    <details style="margin-top:18px">
      <summary style="cursor:pointer;color:#a99fb8">Advanced: Jackett (optional)</summary>
      <label>Jackett URL</label>
      <input id="jackettUrl" placeholder="http://localhost:9117"/>
      <label>Indexer API key</label>
      <input id="jackettApiKey" placeholder="Jackett API key"/>
      <p style="margin-top:10px;color:#8f859e;font-size:.85rem">
        📚 Comics search in the mobile app also uses Jackett
        (Torznab category 7030) — add an indexer that carries comics to enable it.
      </p>
    </details>
  </div>

  </section>
  <section aria-label="French trackers">
    <label class="toggle"><input type="checkbox" id="frenchEnabled" onchange="toggleFrench()" aria-controls="frenchSettings" aria-expanded="false"/>Enable French audiobook trackers</label>
    <div id="frenchSettings" hidden>
      <p>Select the trackers you use, then enter their credentials. No Jackett needed.</p>
      <div class="tracker">
        <label class="toggle"><input type="checkbox" id="c411Enabled" onchange="toggleTracker('c411')" aria-controls="c411Settings" aria-expanded="false"/>C411</label>
        <div id="c411Settings" hidden>
          <label for="c411ApiKey">C411 API key</label><input id="c411ApiKey" type="password" disabled/>
          <details><summary>API endpoint (optional override)</summary>
            <label for="c411Url">C411 endpoint</label><input id="c411Url" placeholder="https://c411.org/api/torznab" disabled/>
          </details>
        </div>
      </div>
      <div class="tracker">
        <label class="toggle"><input type="checkbox" id="tr4kerEnabled" onchange="toggleTracker('tr4ker')" aria-controls="tr4kerSettings" aria-expanded="false"/>Tr4ker</label>
        <div id="tr4kerSettings" hidden>
          <label for="tr4kerApiKey">Tr4ker API key</label><input id="tr4kerApiKey" type="password" disabled/>
          <details><summary>API endpoint (optional override)</summary>
            <label for="tr4kerUrl">Tr4ker endpoint</label><input id="tr4kerUrl" placeholder="https://tr4ker.net/api/torznab/all" disabled/>
          </details>
        </div>
      </div>
      <div class="tracker">
        <label class="toggle"><input type="checkbox" id="torr9Enabled" onchange="toggleTracker('torr9')" aria-controls="torr9Settings" aria-expanded="false"/>Torr9</label>
        <div id="torr9Settings" hidden>
          <label for="torr9Passkey">Torr9 Passkey</label><input id="torr9Passkey" type="password" disabled/>
          <details><summary>API endpoint (optional override)</summary>
            <label for="torr9Url">Torr9 endpoint</label><input id="torr9Url" placeholder="https://api.torr9.net/api/v1/torznab" disabled/>
          </details>
          <p><small>Legacy endpoint; availability depends on the tracker.</small></p>
        </div>
      </div>
    </div>
  </section>
  <button onclick="gen()">Generate companion app link</button>

  <div class="out" id="out">
    <label>Companion app install link</label><p>Copy this link into the companion app setup screen. Keep it private: it contains your API keys.</p>
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
function providerChanged(){
  document.getElementById('instantLabel').textContent=document.getElementById('provider').value==='alldebrid'
    ? 'Only show books known ready in my AllDebrid account (not a global cache check)'
    : 'Instant-only — only show titles already cached on TorBox';
}
function toggleTracker(id){
  var box=document.getElementById(id+'Enabled');
  var enabled=document.getElementById('frenchEnabled').checked && box.checked;
  var panel=document.getElementById(id+'Settings');
  panel.hidden=!enabled;
  box.setAttribute('aria-expanded',String(enabled));
  panel.querySelectorAll('input').forEach(function(input){ input.disabled=!enabled; });
}
function toggleFrench(){
  var box=document.getElementById('frenchEnabled');
  document.getElementById('frenchSettings').hidden=!box.checked;
  box.setAttribute('aria-expanded',String(box.checked));
  ['c411','tr4ker','torr9'].forEach(toggleTracker);
}
function gen(){
  var apiKey=document.getElementById('apiKey').value.trim();
  if(!apiKey){ alert('Service API key is required'); return; }
  var cfg={ apiKey:apiKey, provider:document.getElementById('provider').value };
  var format=document.getElementById('preferredFormat').value;
  if(format) cfg.preferredFormat=format;
  var language=document.getElementById('languageFilter').value;
  if(language) cfg.languageFilter=language;
  if(document.getElementById('frenchEnabled').checked){
    var trackers=[['c411','c411ApiKey'],['tr4ker','tr4kerApiKey'],['torr9','torr9Passkey']];
    for(var i=0;i<trackers.length;i++){
      var id=trackers[i][0], key=trackers[i][1];
      if(!document.getElementById(id+'Enabled').checked) continue;
      var value=document.getElementById(key).value.trim();
      if(!value){ alert('Enter the credential for '+id+' or disable that tracker.'); document.getElementById(key).focus(); return; }
      cfg[key]=value;
      var endpoint=document.getElementById(id+'Url').value.trim();
      if(endpoint) cfg[id+'Url']=endpoint;
    }
  }
  var max=Number(document.getElementById('maxSizeGB').value);
  if(max>0) cfg.maxSizeGB=max;
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
var defaultAbb=window.__abbDomain || '';
if(defaultAbb){
  document.getElementById('abbLabel').textContent='AudiobookBay domain override (optional)';
  document.getElementById('abbHelp').textContent='Default domain: '+defaultAbb+'. Leave blank to use it; enter a domain only to change it.';
  document.getElementById('abbDomain').placeholder='Leave blank to use '+defaultAbb;
} else {
  document.getElementById('abbHelp').textContent='This server has no default AudiobookBay domain. Enter one to enable AudiobookBay, or leave blank to use your other sources.';
}
// Keep source overrides available even when the server supplies defaults.
if (window.__serverSearch) {
  document.getElementById('serverNote').style.display='block';
}
if (window.__requireToken) {
  document.getElementById('tokenCfg').style.display='block';
}
</script>
</body></html>`;

function sendConfigure(_req, res) {
  const serverSearch =
    (!!process.env.JACKETT_URL && !!process.env.JACKETT_API_KEY) || !!abbDomain({});
  const flag =
    `<script>window.__serverSearch=${serverSearch ? "true" : "false"};` +
    `window.__requireToken=${access.required ? "true" : "false"};` +
    `window.__abbDomain=${JSON.stringify(abbDomain({})).replace(/</g, "\\u003c")};</script>`;
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
  const preferred = type === "audiobook" ? preferredLanguage(cfg) : null;
  const effJackett = cfg.jackettUrl || process.env.JACKETT_URL || "";
  const cacheKey = crypto.createHash("sha256").update(JSON.stringify([cfg, type, effJackett, instantOnly, query, page])).digest("hex");
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
  if (type === "audiobook") results = results.filter(r => matchesLanguageFilter(r, cfg));
  if (Number(cfg.maxSizeGB) > 0) results = results.filter(r => !r.size || r.size <= Number(cfg.maxSizeGB) * 1024 ** 3);
  // Rank before capping: high-seeder English releases must not crowd out
  // French results before the final sort even runs.
  results.sort((a, b) => languageScore(b, preferred) - languageScore(a, preferred));
  results = results.slice(0, 40);

  let cachedSet = new Set();
  try {
    const hashes = results.map((r) => r.infohash).filter(Boolean);
    if (hashes.length) cachedSet = await withTimeout(providerFor(cfg).checkCachedMany(cfg.apiKey, hashes), 3000, new Set());
  } catch (_) {
    /* non-critical */
  }

  if (instantOnly) results = results.filter((r) => r.infohash && cachedSet.has(r.infohash));

  results.sort((a, b) => {
    const languageOrder = languageScore(b, preferred) - languageScore(a, preferred);
    if (languageOrder) return languageOrder;
    const ca = a.infohash && cachedSet.has(a.infohash) ? 1 : 0;
    const cb = b.infohash && cachedSet.has(b.infohash) ? 1 : 0;
    if (ca !== cb) return cb - ca;
    if (cfg.preferredFormat) {
      const preferred = String(cfg.preferredFormat).toLowerCase();
      const pa = String(a.format || a.name).toLowerCase().includes(preferred) ? 1 : 0;
      const pb = String(b.format || b.name).toLowerCase().includes(preferred) ? 1 : 0;
      if (pa !== pb) return pb - pa;
    }
    const score = type === "comic" ? comicQualityScore : qualityScore;
    const qa = score(a);
    const qb = score(b);
    if (qa !== qb) return qb - qa;
    return (b.seeders || 0) - (a.seeders || 0);
  });

  const enriched = results.map(r => {
    const parsed = parseNameParts(r.name, type);
    return { ...r, displayTitle: parsed.title || prettyName(r.name), author: parsed.author,
      poster: null, cached: !!(r.infohash && cachedSet.has(r.infohash)) };
  });
  const lookups = enriched.map((r, index) => limitMeta(async () => {
    const language = releaseLanguage(r) || (isFrenchTracker(r) ? 'fr' : preferred);
    const meta = await withTimeout(enrich(r.name, type, language), 2500, null);
    if (meta) enriched[index] = { ...r, displayTitle: meta.title || r.displayTitle,
      poster: meta.poster || null, author: meta.author || r.author || null };
  })());
  // Keep successful lookups when another result is slow. Late completions fill
  // the cached array so the next search can pick up the remaining covers.
  await withTimeout(Promise.all(lookups), 3000, null);

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
    name: r.displayTitle || prettyName(r.name),
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
    withTimeout(enrich(item.name, "audiobook", preferredLanguage(cfg)), 2500, { poster: null, author: null, year: null }),
    item.infohash
      ? withTimeout(providerFor(cfg).checkCached(cfg.apiKey, item.infohash), 4000, false)
      : Promise.resolve(false),
  ]);

  const facts = detailLine([
    item.infohash
      ? (isCached ? `⚡ Ready on ${providerFor(cfg).name}` : `Will prepare on ${providerFor(cfg).name} on play`)
      : `Adds to ${providerFor(cfg).name} on play`,
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
      name: meta.title || prettyName(item.name) || "Audiobook",
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
async function resolveForItem(cfg, item, fresh = false, deferUnlock = false) {
  const type = typeOf(item.type);
  const key = streamKey(cfg.apiKey, `${cfg.provider || "torbox"}:${isInstantOnly(cfg)}:${deferUnlock}:${type}`, item.infohash || item.torrentUrl || item.name);
  const cachedStreams = streamCache.get(key);
  if (cachedStreams && !fresh) return { ready: true, status: "ok", streams: cachedStreams };

  const result = await providerFor(cfg).resolveStreams(cfg.apiKey, {
    magnet: item.magnet,
    infohash: item.infohash,
    torrentUrl: item.torrentUrl,
    name: item.name,
    instantOnly: isInstantOnly(cfg),
    kind: type === "comic" ? "comic" : "audio",
    deferUnlock,
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
          externalUrl: providerFor(cfg).url,
        },
      ],
    });
  } catch (err) {
    console.error("stream error:", err.message);
    return res.json({
      streams: [{ name: "BusTAudioBooks", title: `⚠️ ${err.message}`, externalUrl: providerFor(cfg).url }],
    });
  }
});

// ---- App JSON API (for the native app) --------------------------------------
// Simple, app-friendly endpoints backed by the same search + TorBox logic.

// GET /:config/app/search?q=...&page=1&type=audiobook|comic&source=series|torrents
app.get("/:config/app/search", async (req, res) => {
  const cfg = getConfig(req, res);
  if (!cfg) return;
  const query = String(req.query.q || "").trim();
  if (!query) return res.json({ results: [] });
  const page = parseInt(req.query.page, 10) || 1;
  const type = typeOf(req.query.type);

  // "Series" = MangaDex (ongoing manga/webtoons, no torrent/TorBox involved).
  // Default stays "torrents" so pre-2.1 apps get byte-identical behavior.
  if (type === "comic" && req.query.source === "series") {
    if (!mangadexEnabled()) {
      return res.status(503).json({ results: [], error: "Series source disabled on this server" });
    }
    try {
      const series = await mangadex.searchManga(query, page);
      return res.json({
        results: series.map((m) => ({
          id: encodeItemId({ name: m.title, type: "comic", provider: "mangadex", mangaId: m.mangaId }),
          type: "comic",
          provider: "mangadex",
          mangaId: m.mangaId,
          title: m.title,
          author: m.author || null,
          poster: m.poster || null,
          description: m.description || null,
          status: m.status || null,
          year: m.year || null,
          format: "MangaDex",
          bitrate: null,
          size: 0,
          sizeText: null,
          cached: false,
        })),
      });
    } catch (err) {
      console.error("mangadex search error:", err.message);
      return res.status(502).json({ results: [], error: err.message });
    }
  }

  const items = await runSearch(cfg, query, page, type);
  res.json({
    results: items.map((r) => ({
      id: encodeItemId(r),
      type,
      title: r.displayTitle || prettyName(r.name),
      releaseName: r.name,
      language: releaseLanguage(r),
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

// GET /:config/app/chapters/:id?offset=0&limit=100
// Chapter list for a MangaDex series item. The full English feed is fetched,
// filtered and deduped server-side (cached 10 min), then sliced — so counts,
// checkmarks and "next chapter" all see one stable list.
// The operator kill-switch for the Series source — checked by every MD route
// AND reported in /health, so disabling it is visible in the app, not silent.
function mangadexEnabled() {
  return process.env.MANGADEX_DISABLED !== "1";
}

app.get("/:config/app/chapters/:id", async (req, res) => {
  const cfg = getConfig(req, res);
  if (!cfg) return;
  if (!mangadexEnabled()) {
    return res.status(503).json({ chapters: [], error: "Series source disabled on this server" });
  }
  const item = decodeItemId(req.params.id);
  if (!item || item.provider !== "mangadex" || !item.mangaId) {
    return res.status(400).json({ chapters: [], error: "Not a series item" });
  }
  try {
    const all = await mangadex.getChapterFeed(item.mangaId);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    res.json({
      series: { id: req.params.id, mangaId: item.mangaId, title: item.name },
      chapters: all.slice(offset, offset + limit),
      total: all.length,
      offset,
      limit,
      hasMore: offset + limit < all.length,
    });
  } catch (err) {
    console.error("mangadex chapters error:", err.message);
    res.status(502).json({ chapters: [], error: err.message });
  }
});

// GET /:config/app/pages/:chapterId?saver=1&fresh=1
// Page image URLs for one chapter. baseUrls expire (~15 min); the reader's
// self-heal passes fresh=1 to bypass the cache and get a live one.
const MD_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.get("/:config/app/pages/:chapterId", async (req, res) => {
  const cfg = getConfig(req, res);
  if (!cfg) return;
  if (!mangadexEnabled()) {
    return res.status(503).json({ pages: [], error: "Series source disabled on this server" });
  }
  const chapterId = String(req.params.chapterId || "");
  if (!MD_UUID_RE.test(chapterId)) {
    return res.status(400).json({ pages: [], error: "Bad chapter id" });
  }
  try {
    const saver = req.query.saver === "1";
    const { pages, pageCount } = await mangadex.getPages(chapterId, {
      saver,
      fresh: req.query.fresh === "1",
    });
    res.json({ chapterId, pages, pageCount, saver, expiresInSec: 600 });
  } catch (err) {
    console.error("mangadex pages error:", err.message);
    res.status(502).json({ pages: [], error: err.message });
  }
});

// GET /:config/app/streams/:id  -> playable files for a book
app.get("/:config/app/streams/:id", async (req, res) => {
  const cfg = getConfig(req, res);
  if (!cfg) return;
  const item = decodeItemId(req.params.id);
  if (!item) return res.status(400).json({ ready: false, streams: [], status: "Bad item id" });
  // Series items have no torrent to resolve — never send them to TorBox.
  if (item.provider === "mangadex") {
    return res.status(400).json({ ready: false, streams: [], status: "Series item — use /app/chapters" });
  }

  try {
    const result = await resolveForItem(cfg, item, true, cfg.provider === "alldebrid");
    return res.json({
      ready: !!result.ready,
      status: result.status || (result.ready ? "ok" : "preparing"),
      title: parseNameParts(item.name, typeOf(item.type)).title || prettyName(item.name),
      type: typeOf(item.type),
      format: item.format || null,
      bitrate: item.bitrate || null,
      streams: (result.streams || []).map((s) => ({
        title: chapterTitle((s.behaviorHints && s.behaviorHints.filename) || s.title) || item.name,
        url: s.debridLink
          ? `${(process.env.PUBLIC_URL || ((req.get("x-forwarded-proto") === "https" ? "https" : req.protocol) + "://" + req.get("host"))).replace(/\/+$/, "")}/${req.params.config}/app/audio/${Buffer.from(s.debridLink).toString("base64url")}`
          : s.url,
        filename: (s.behaviorHints && s.behaviorHints.filename) || null,
      })),
    });
  } catch (err) {
    console.error("app streams error:", err.message);
    return res.status(502).json({ ready: false, streams: [], status: err.message });
  }
});

// Unlock on demand so large chapter queues return quickly and URLs do not expire
// before later chapters play. The audio bytes are served by AllDebrid, not here.
app.get("/:config/app/audio/:link", async (req, res) => {
  const cfg = getConfig(req, res);
  if (!cfg) return;
  if (cfg.provider !== "alldebrid") return res.status(400).json({ error: "Invalid provider" });
  try {
    const link = Buffer.from(req.params.link, "base64url").toString("utf8");
    const url = await providerFor(cfg).unlockLink(cfg.apiKey, link);
    res.setHeader("Cache-Control", "no-store");
    res.removeHeader("Content-Type");
    res.redirect(302, url);
  } catch (err) {
    res.status(502).json({ error: err.message });
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
  const cfg = req.params.config ? getConfig(req, res) : null;
  if (req.params.config && !cfg) return;
  const out = {
    ok: true,
    addon: manifest.name,
    version: manifest.version,
  };
  if (cfg && cfg.apiKey) {
    const provider = providerFor(cfg);
    out.provider = cfg.provider || "torbox";
    out.providerKeyValid = await withTimeout(provider.validateKey(cfg.apiKey), 5000, false);
    // Compatibility alias: released companion apps use this as their credential gate.
    out.torboxKeyValid = out.providerKeyValid;
    out.cacheScope = provider.cacheScope;
    const hasJackett = !!(
      (cfg.jackettUrl || process.env.JACKETT_URL) &&
      (cfg.jackettApiKey || process.env.JACKETT_API_KEY)
    );
    out.sources = {
      audiobookbay: !!abbDomain(cfg),
      jackett: hasJackett,
      c411: !!cfg.c411ApiKey, torr9: !!cfg.torr9Passkey, tr4ker: !!cfg.tr4kerApiKey,
      // Comics search rides on Jackett (Torznab category 7030), so its
      // availability IS Jackett's availability.
      comics: hasJackett,
      // The Series source (MangaDex) needs no user config; this key's
      // presence is the app's capability probe for the Series chip.
      mangadex: mangadexEnabled(),
      serverProvided: !!(process.env.JACKETT_URL && process.env.JACKETT_API_KEY) || !!abbDomain({}),
    };
    out.abbDomain = abbDomain(cfg);
    out.instantOnly = isInstantOnly(cfg);
    out.accessGate = access.required;
  } else {
    out.note = "No config in URL — append /<config>/health for a full check.";
  }
  res.json(out);
}
app.get("/health", handleHealth);
app.get("/:config/health", handleHealth);

if (require.main === module) app.listen(PORT, "0.0.0.0", () => {
  console.log(`Local: http://localhost:${PORT}/configure`);
  const addresses = new Set(Object.values(networkInterfaces()).flat()
    .filter(address => address && address.family === "IPv4" && !address.internal)
    .map(address => address.address));
  for (const address of addresses) {
    console.log(`LAN:   http://${address}:${PORT}/configure`);
  }
  console.log("For your phone, generate the install link from the LAN URL on the same network.");
});

module.exports = { app, runSearch };

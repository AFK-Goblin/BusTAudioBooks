// AllDebrid API: https://docs.alldebrid.com/
const crypto = require('crypto');
const tb = require('./torbox');
const { TTLCache, pLimit } = require('./cache');
const pending = new TTLCache(24 * 60 * 60 * 1000, 1000);
const inFlight = new Map();
const knownHashes = new TTLCache(24 * 60 * 60 * 1000, 1000);
const accountKey = (key, hash) => crypto.createHash('sha256').update(key + ':' + hash.toLowerCase()).digest('hex');
const limit = pLimit(1);
let lastCall = 0;
async function api(key, path, params, version = 'v4') {
  return limit(async () => {
    await new Promise(r => setTimeout(r, Math.max(0, 110 - (Date.now() - lastCall))));
    lastCall = Date.now();
    const res = await fetch(`https://api.alldebrid.com/${version}/${path}`, {
      method: params ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}` },
      body: params instanceof FormData ? params : params ? new URLSearchParams(params) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    if (!res.ok || json.status !== 'success') throw new Error(`AllDebrid: ${json.error?.code || 'API_ERROR'}`);
    return json.data;
  })();
}
const list = x => x ? Array.isArray(x) ? x : [x] : [];
async function account(key) {
  const data = await api(key, 'magnet/status', {}, 'v4.1');
  return list(data.magnets);
}
const ready = m => m.ready === true || Number(m.statusCode) === 4;
async function checkCachedMany(key, hashes) {
  const wanted = new Set(hashes.map(h => h.toLowerCase()));
  const magnets = await account(key);
  return new Set([...wanted].filter(hash => magnets.some(m => ready(m) &&
    (String(m.hash).toLowerCase() === hash || (knownHashes.get(accountKey(key, hash)) != null && String(m.id) === String(knownHashes.get(accountKey(key, hash))))))));

}
function flatten(nodes, prefix = '') {
  return list(nodes).flatMap(n => {
    const name = prefix + (n.n || n.filename || '');
    if (n.e) return flatten(n.e, name + '/');
    return n.l || n.link ? [{ name, link: n.l || n.link, size: n.s || n.size || 0 }] : [];
  });
}
async function resolve(key, item, cacheKey) {
  const hash = item.infohash || tb.infohashFromMagnet(item.magnet);
  const existing = await account(key);
  let torrent = existing.find(m => hash && String(m.hash).toLowerCase() === hash.toLowerCase());
  let id = torrent?.id || (hash && knownHashes.get(accountKey(key, hash))) || pending.get(cacheKey);
  if (!torrent && id) torrent = existing.find(m => String(m.id) === String(id));
  if (id && !torrent) { pending.m.delete(cacheKey); if (hash) knownHashes.m.delete(accountKey(key, hash)); id = null; }
  if (item.instantOnly && !ready(torrent || {})) return { ready: false, streams: [], status: 'Not ready in your AllDebrid account (account-ready-only mode).' };
  if (!id) {
    let magnet = item.magnet;
    let data;
    if (item.torrentUrl) {
      const source = await tb.fetchTorrentSource(item.torrentUrl);
      if (source.buffer) {
        const form = new FormData();
        form.append('files[]', new Blob([source.buffer], { type: 'application/x-bittorrent' }), 'book.torrent');
        data = await api(key, 'magnet/upload/file', form);
      } else magnet = source.magnet;
    }
    if (!data) {
      if (!magnet && !hash) throw new Error('No torrent source');
      data = await api(key, 'magnet/upload', { 'magnets[]': magnet || `magnet:?xt=urn:btih:${hash}` });
    }
    const uploaded = list(data.magnets || data.files)[0];
    if (!uploaded?.id || uploaded.error) throw new Error(`AllDebrid: ${uploaded?.error?.code || 'UPLOAD_FAILED'}`);
    id = uploaded.id;
    pending.set(cacheKey, id);
    if (hash) knownHashes.set(accountKey(key, hash), id);
  }
  const status = await api(key, 'magnet/status', { id: String(id) }, 'v4.1');
  torrent = list(status.magnets).find(m => String(m.id) === String(id));
  if (!torrent) throw new Error('AllDebrid torrent is no longer available; retry later.');
  if (!ready(torrent)) {
    if (Number(torrent.statusCode) > 4) throw new Error(`AllDebrid download failed (status ${torrent.statusCode})`);
    return { ready: false, streams: [], status: 'Preparing on AllDebrid. Reopen this book shortly.' };
  }
  const data = await api(key, 'magnet/files', { 'id[]': String(id) });
  const entry = list(data.magnets).find(m => String(m.id) === String(id));
  if (entry?.error) throw new Error(`AllDebrid: ${entry.error.code}`);
  const predicate = item.kind === 'comic' ? tb.isComicFile : tb.isAudioFile;
  const files = flatten(entry?.files).filter(f => predicate(f.name)).sort((a,b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
  if (!files.length) return { ready: false, streams: [], status: 'No playable files found in this torrent.' };
  // Do not silently drop a failed chapter from the audiobook queue.
  const streams = await Promise.all(files.map(async f => {
    const url = item.deferUnlock ? undefined : await unlockLink(key, f.link);
    return { name: 'AllDebrid', title: f.name, url, ...(item.deferUnlock ? { debridLink: f.link } : {}), behaviorHints: {
      filename: f.name, bingeGroup: `alldebrid-${hash || id}`, notWebReady: !tb.webReadyForFile(f.name),
    } };
  }));
  return { ready: true, streams, status: 'ok' };
}
async function unlockLink(key, link) {
  const parsed = new URL(link);
  if (parsed.protocol !== 'https:' || !['alldebrid.com', 'www.alldebrid.com'].includes(parsed.hostname) || !parsed.pathname.startsWith('/f/')) {
    throw new Error('Invalid AllDebrid file link');
  }
  const unlocked = await api(key, 'link/unlock', { link });
  if (!unlocked.link || !/^https:\/\//.test(unlocked.link)) throw new Error('AllDebrid did not return a playable link');
  return unlocked.link;
}
function resolveStreams(key, item) {
  const cacheKey = crypto.createHash('sha256').update(JSON.stringify([key, item])).digest('hex');
  if (!inFlight.has(cacheKey)) inFlight.set(cacheKey, resolve(key, item, cacheKey).finally(() => inFlight.delete(cacheKey)));
  return inFlight.get(cacheKey);
}
module.exports = {
  name: 'AllDebrid', url: 'https://alldebrid.com/', cacheScope: 'account',
  validateKey: async key => { try { return !!(await api(key, 'user')).user; } catch { return false; } },
  checkCachedMany, checkCached: async (key, hash) => (await checkCachedMany(key, [hash])).has(hash.toLowerCase()),
  resolveStreams, unlockLink, _flatten: flatten,
};

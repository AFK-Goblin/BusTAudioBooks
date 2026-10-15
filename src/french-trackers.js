// Direct Torznab adapters; no Jackett process required.
const crypto = require('crypto');
const { TTLCache, pLimit } = require('./cache');
const resultsCache = new TTLCache(5 * 60 * 1000, 200);
const pendingSearches = new Map();
const trackerQueues = Object.fromEntries(['c411', 'torr9', 'tr4ker'].map(id => [id, pLimit(1)]));
const lastCall = {};
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const definitions = {
  c411: { name: 'C411', url: 'https://c411.org/api/torznab', key: 'c411ApiKey' },
  torr9: { name: 'Torr9', url: 'https://api.torr9.net/api/v1/torznab', key: 'torr9Passkey' },
  tr4ker: { name: 'Tr4ker', url: 'https://tr4ker.net/api/torznab/all', key: 'tr4kerApiKey' },
};
const array = v => v == null ? [] : Array.isArray(v) ? v : [v];
const scalar = v => typeof v === 'object' ? v?.['#text'] || '' : v;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, processEntities: true });
function parse(text, tracker) {
  let root;
  if (text.trim().startsWith('{')) root = JSON.parse(text);
  else {
    if (/<!DOCTYPE/i.test(text) || XMLValidator.validate(text) !== true) throw new Error('Invalid tracker XML');
    root = parser.parse(text);
  }
  if (root.error) throw new Error('Tracker rejected search; check credentials and endpoint');
  const channel = root.rss?.channel || root.channel;
  if (!channel) throw new Error('Tracker did not return a Torznab feed');
  return array(channel.item).map(item => {
    const attrs = Object.fromEntries(array(item['torznab:attr'] || item['newznab:attr']).map(a => {
      a = a['@attributes'] || a; return [a.name, a.value];
    }));
    const enclosure = item.enclosure?.['@attributes'] || item.enclosure || {};
    const link = String(enclosure.url || scalar(item.link) || '');
    const magnet = attrs.magneturl || (link.startsWith('magnet:') ? link : null);
    const candidate = attrs.infohash || magnet?.match(/btih:([a-f0-9]{40})/i)?.[1] || scalar(item.guid);
    const infohash = /^[a-f0-9]{40}$/i.test(candidate || '') ? candidate.toLowerCase() : null;
    const torrentUrl = /^https?:\/\//i.test(link) ? link : null;
    return { name: String(scalar(item.title) || 'Unknown'), infohash, magnet, torrentUrl,
      size: Number(item.size || attrs.size || enclosure.length) || 0, seeders: Number(attrs.seeders) || 0,
      tracker, language: attrs.language || null, format: null, bitrate: null };
  }).filter(r => r.infohash || r.magnet || r.torrentUrl);
}
async function searchTrackerRaw(id, cfg, query, page = 1, kind = 'audiobook') {
  const def = definitions[id];
  if (!cfg[def.key]) return [];
  const url = new URL(cfg[id + 'Url'] || def.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid tracker endpoint');
  url.searchParams.set('apikey', cfg[def.key]);
  url.searchParams.set('t', 'search');
  url.searchParams.set('q', query);
  url.searchParams.set('cat', kind === 'comic' ? '7030' : '3030');
  url.searchParams.set('limit', '40');
  url.searchParams.set('offset', String((page - 1) * 40));
  await new Promise(r => setTimeout(r, Math.max(0, (id === 'c411' ? 4100 : 1000) - (Date.now() - (lastCall[id] || 0)))));
  lastCall[id] = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { Accept: 'application/rss+xml, application/xml, application/json' } });
  if (!res.ok) throw new Error(`${def.name}: HTTP ${res.status}`);
  return parse(await res.text(), def.name);
}
function searchTracker(id, cfg, query, page = 1, kind = 'audiobook') {
  if (!cfg[definitions[id].key]) return Promise.resolve([]);
  const key = crypto.createHash('sha256').update(JSON.stringify([id, cfg[definitions[id].key], cfg[id + 'Url'], query, page, kind])).digest('hex');
  const hit = resultsCache.get(key);
  if (hit) return Promise.resolve(hit);
  if (!pendingSearches.has(key)) pendingSearches.set(key, trackerQueues[id](async () => {
    try {
      const result = await searchTrackerRaw(id, cfg, query, page, kind);
      resultsCache.set(key, result);
      return result;
    } catch (err) {
      // Do not expose authenticated URLs or response bodies through parser errors.
      throw new Error(`${definitions[id].name}: search failed; check API key, endpoint and tracker availability`);
    }
  })().finally(() => pendingSearches.delete(key)));
  return pendingSearches.get(key);
}
function searches(cfg, query, page, kind) {
  return Object.keys(definitions).map(id => searchTracker(id, cfg, query, page, kind));
}
module.exports = { definitions, searches, searchTracker, _parse: parse };

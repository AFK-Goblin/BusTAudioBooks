// src/itemid.js
// Encode/decode the compact payload carried in catalog/meta/stream ids, so the
// meta and stream handlers can render + resolve an item without re-scraping.
const { ID_PREFIX } = require("./manifest");

function encodeItemId(item) {
  const payload = Buffer.from(
    JSON.stringify({
      h: item.infohash,
      m: item.magnet || undefined,
      u: item.torrentUrl || undefined,
      n: item.name,
      f: item.format || undefined,
      b: item.bitrate || undefined,
      s: item.size || undefined,
      // Content-type discriminator. Absent = audiobook, so ids minted before
      // comics existed keep decoding exactly as they always did.
      t: item.type === "comic" ? "c" : undefined,
      // Provider discriminator + MangaDex manga uuid. Absent = torrent.
      p: item.provider === "mangadex" ? "m" : undefined,
      d: item.mangaId || undefined,
    }),
    "utf8"
  ).toString("base64url");
  return ID_PREFIX + payload;
}

function decodeItemId(id) {
  if (!id || !id.startsWith(ID_PREFIX)) return null;
  try {
    const obj = JSON.parse(
      Buffer.from(id.slice(ID_PREFIX.length), "base64url").toString("utf8")
    );
    return {
      infohash: obj.h,
      magnet: obj.m,
      torrentUrl: obj.u,
      name: obj.n,
      format: obj.f,
      bitrate: obj.b,
      size: obj.s,
      type: obj.t === "c" ? "comic" : "audiobook",
      provider: obj.p === "m" ? "mangadex" : "torrent",
      mangaId: obj.d,
    };
  } catch (_) {
    return null;
  }
}

module.exports = { encodeItemId, decodeItemId };

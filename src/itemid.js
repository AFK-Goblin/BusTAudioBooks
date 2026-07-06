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
    };
  } catch (_) {
    return null;
  }
}

module.exports = { encodeItemId, decodeItemId };

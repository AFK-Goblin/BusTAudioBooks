// src/config.js
// The addon is "configurable": each user installs it with their own TorBox API
// key (and optional indexer settings) encoded into the install URL. We pack that
// config into a single URL-safe base64 path segment, e.g.
//   https://host/<config>/manifest.json
// so no server-side database is needed.

function encodeConfig(configObj) {
  const json = JSON.stringify(configObj);
  return Buffer.from(json, "utf8").toString("base64url");
}

function decodeConfig(segment) {
  try {
    const json = Buffer.from(segment, "base64url").toString("utf8");
    const cfg = JSON.parse(json);
    if (!cfg || typeof cfg !== "object") return null;
    return cfg;
  } catch (_) {
    return null;
  }
}

module.exports = { encodeConfig, decodeConfig };

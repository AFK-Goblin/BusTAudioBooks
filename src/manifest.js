// src/manifest.js

const ID_PREFIX = "tbab:"; // "TorBox AudioBook" — our custom stream/meta ids

const manifest = {
  id: "community.torbox.audiobooks",
  version: "2.0.0",
  name: "BusTAudioBooks",
  description:
    "Search audiobooks and stream or download them through your TorBox account.",
  // "audiobook" is a custom content type. Stremio shows it under Discover and
  // the player handles audio files. (Native types are movie/series/tv/channel.)
  types: ["audiobook"],
  // Only ids we mint get routed to this addon's meta/stream handlers.
  idPrefixes: [ID_PREFIX],
  resources: ["catalog", "meta", "stream"],
  catalogs: [
    {
      type: "audiobook",
      id: "torbox-audiobooks-search",
      name: "TorBox Audiobooks",
      // Search-only catalog: Stremio shows a search box, no "popular" feed needed.
      extra: [
        { name: "search", isRequired: true },
        { name: "skip" },
      ],
    },
  ],
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
  },
};

module.exports = { manifest, ID_PREFIX };

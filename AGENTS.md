# Project direction

- Extend this backend for direct French tracker search and AllDebrid, with the companion app as the primary test client.
- Preserve legacy install URLs (missing `provider` means TorBox), item IDs, and `/app` response shapes.
- Keep existing TorBox, AudiobookBay and optional Jackett behavior available. French trackers must not require Jackett.
- `others/` contains reference repositories, not shipped runtime dependencies. Do not edit them as part of backend changes.
- Never upload/delete torrents during search to simulate cache checks. Preserve authenticated torrent files when resolving private tracker results.
- Keep credentials out of logs and isolate caches by configuration/account/provider.
- Assume unlabelled C411, Tr4ker and Torr9 releases are French. Explicit language declarations override this default; AudiobookBay requires an explicit language field or release tag for exclusive language filtering.
- Run `npm test` and add mocked integration coverage for provider/tracker changes. Live credential tests are separate and must be reported honestly.

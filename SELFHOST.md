# Self-hosting BusTAudioBooks (the easy way)

This runs the whole stack — the backend, the Jackett search indexer, and a
Cloudflare-bypass helper — with **one command**. No Node, no config files to
edit, no server admin. If you can install Docker, you can run this.

## 1. Install Docker

- **Windows / Mac:** install **Docker Desktop** from https://www.docker.com/products/docker-desktop/ and start it.
- **Linux / NAS:** install Docker Engine + the Compose plugin.

## 2. Download & start

Unzip this folder, open a terminal **inside it** (the folder that has
`docker-compose.yml`), and run:

```
docker compose up -d
```

The first run downloads the images and builds the backend — give it a few
minutes. When it's done, three containers are running.

## 3. Add the AudiobookBay indexer (one time, ~30 seconds)

1. Open **http://localhost:9117** in your browser (that's Jackett).
2. Click **+ Add indexer**, type `audiobookbay` in the filter, click the **＋**
   next to it. No login needed.
3. (Optional) Click its search/test button and search "dune" to confirm results.

That's the only manual step — the API key and Cloudflare helper are already wired
up for you.

## 4. Get your app link

1. Open **http://localhost:7000/configure**.
2. Paste your **TorBox API key** (torbox.app → Settings → API).
3. Click **Generate install link**, then copy it.
4. In the **BusTAudioBooks app**, paste that link on the setup screen.

**Using the app on your phone?** Your phone can't reach `localhost` on your
computer, so instead open the configure page at your computer's local network
address — e.g. `http://192.168.1.50:7000/configure` (find your computer's IP in
its network settings). Generate the link from *that* address and it'll work from
any device on your home Wi-Fi.

## Done. Day-to-day commands

- **Stop everything:** `docker compose down`
- **Start again:** `docker compose up -d`
- **See logs:** `docker compose logs -f backend`
- **Update to a newer version:** replace these files with the new ones, then
  `docker compose up -d --build`

Everything auto-restarts on reboot, so once it's up you can forget about it.

## Sharing with a few friends (optional)

Your instance is open by default (fine when it's just you). To let specific
people use it, put a comma-separated list of secret tokens in the environment and
restart:

1. Create a file named `.env` next to `docker-compose.yml` containing:
   ```
   ACCESS_TOKENS=friend1-secret,friend2-secret
   ```
2. `docker compose up -d`

Now the configure page asks for a token, and only people you've given one to can
use your instance. Each person still uses **their own** TorBox key, and your
Jackett key never leaves your machine.

> Reaching it from outside your home network (so friends can use it remotely)
> needs a tunnel or a public address — that's a bigger step; ask if you want it.

## What's running

| Container | What it does |
|-----------|--------------|
| `bustaudio-backend` | Search + TorBox resolution + the app/Stremio API (port 7000) |
| `bustaudio-jackett` | The AudiobookBay indexer (localhost:9117, private) |
| `bustaudio-flaresolverr` | Gets past AudiobookBay's Cloudflare checks |

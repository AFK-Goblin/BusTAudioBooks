# BusTAudioBooks — Getting started

Welcome! This is a quick guide to installing the app and connecting it. It takes
about two minutes.

## What you'll need

- An **Android phone**.
- A **TorBox account** (torbox.app) — this is what actually streams and downloads
  your audiobooks. You'll use your own key, so your listening is on your account.
- An **install link** from whoever runs the server (and an **access token** if
  they gave you one).

## 1. Install the app

1. Open the **APK download link** you were given, on your phone.
2. When it finishes downloading, tap it.
3. Android will warn about "installing from unknown sources" — tap **Settings**,
   allow it for your browser, and go back and tap **Install**. (This is normal for
   apps that don't come from the Play Store.)
4. Open **BusTAudioBooks**.

## 2. Get your TorBox key

1. Go to **torbox.app** and sign in.
2. Open **Settings → API** and copy your **API key**.

Keep this private — it's tied to your TorBox account.

## 3. Connect the app

On the app's setup screen:

1. Paste the **install link** you were given (it looks like
   `https://…/…/manifest.json`).
2. If your server needs one, also enter your **access token**.
3. Tap **Connect**.

Wait — depending on how it's set up, you may enter your TorBox key on a web page
(the "configure" link) that then gives you the install link, or directly in the
app. Whoever set up your server will tell you which. Either way, your TorBox key
is what ties playback to your account.

## 4. Listen

- **Search** for a title, tap a result.
- **Stream now** plays it straight away. **Download for offline** saves it to your
  phone so you can listen with no connection (great for flights, commutes, dead
  zones).
- The **Library** tab holds your downloads and **Continue Listening** — it
  remembers exactly where you left off in every book.
- Playback keeps going with the screen locked, and you get controls on your lock
  screen and notification shade. There's playback speed and a sleep timer on the
  player screen too.

## Good to know

- **Streaming vs. downloading:** streaming uses no phone storage and starts
  instantly; downloading uses storage but works offline afterward. Downloads keep
  going even if you lock the screen or switch apps.
- **"⏳ Downloading on TorBox":** if a book isn't already cached, TorBox needs a
  moment to fetch it. Back out and reopen it shortly and it'll be ready.
- **Your TorBox key is yours.** You're using your own TorBox account and quota;
  the server just helps you find things. Never share your install link with
  others — it contains your key.
- **Something not working?** If search comes up empty or a book won't play, it's
  usually the server side — let whoever runs it know.

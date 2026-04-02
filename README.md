# Spotify Interval Runner

Browser app for interval running workouts with Spotify.

## What it does

- Logs into Spotify with Authorization Code + PKCE.
- Uses Spotify Web Playback SDK in the browser.
- Lets you build a workout template with alternating intense/chill intervals.
- Lets you choose one playlist for intense and one for chill.
- Supports **No Slow** mode using **manual cue points** on intense songs.
- Simulates fades by stepping the Spotify player volume down and back up.

## Constraints

- Requires **Spotify Premium**.
- Best used with the page kept open in Safari on iPhone.
- On iPhone, you must tap **Arm audio on this browser** before starting playback.
- True custom crossfading is not implemented. This app only changes the player volume and track position.

## Spotify setup

1. Go to Spotify Developer Dashboard.
2. Create an app.
3. Add your deployed site URL as the Redirect URI.
   - Example: `https://your-app.onrender.com/`
4. In `index.html`, replace:
   - `PASTE_YOUR_SPOTIFY_CLIENT_ID_HERE`
   with your Spotify app Client ID.
5. Leave `REDIRECT_URI` as the default unless you are hosting on a custom path.

## Render deploy

This project is a static site.

### Simplest route

1. Put these files in a GitHub repo.
2. In Render, create a **Static Site**.
3. Link the repo.
4. Publish the repo root.
5. After the first deploy, copy the Render URL.
6. Add that exact URL to your Spotify app Redirect URI.
7. Redeploy if needed.

### With Blueprint

This repo includes `render.yaml`. You can deploy it as a Render Blueprint.

## Local test

Serve the folder with a local static server.

Examples:

```bash
python -m http.server 8000
```

Then register `http://127.0.0.1:8000/` as a Spotify Redirect URI and open that exact address.

Do not use `localhost` for Spotify Redirect URI registration. Use `127.0.0.1`.

## Notes on No Slow

For each track in the intense playlist, set:

- cue start in seconds
- optional cue end in seconds

If No Slow is on, the app cycles through those cue clips during intense intervals.
Tracks without cue points are skipped in No Slow mode.

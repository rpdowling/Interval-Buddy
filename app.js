const CLIENT_ID = "https://interval-buddy.onrender.com";
const REDIRECT_URI = window.location.origin + "/";

const state = {
  accessToken: null,
  refreshToken: null,
  expiresAt: 0,
  player: null,
  deviceId: null,
  playerReady: false,
  activated: false,
  playlists: [],
  intenseTracks: [],
  chillTracks: [],
  cues: loadJSON("sir_cues", {}),
  template: loadJSON("sir_template", [
    { mode: "intense", minutes: 3 },
    { mode: "chill", minutes: 1 },
    { mode: "intense", minutes: 5 },
    { mode: "chill", minutes: 2 }
  ]),
  selectedIntensePlaylist: localStorage.getItem("sir_intense_playlist") || "",
  selectedChillPlaylist: localStorage.getItem("sir_chill_playlist") || "",
  noSlow: localStorage.getItem("sir_no_slow") === "true",
  workout: null,
  intervalTicker: null,
  clipTimer: null,
  baseVolume: 0.92,
  trackIndices: { intense: 0, chill: 0 }
};

const el = {
  loginBtn: document.getElementById("loginBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  activateBtn: document.getElementById("activateBtn"),
  authStatus: document.getElementById("authStatus"),
  playerStatus: document.getElementById("playerStatus"),
  deviceName: document.getElementById("deviceName"),
  statusMessage: document.getElementById("statusMessage"),
  intervalList: document.getElementById("intervalList"),
  addIntenseBtn: document.getElementById("addIntenseBtn"),
  addChillBtn: document.getElementById("addChillBtn"),
  saveTemplateBtn: document.getElementById("saveTemplateBtn"),
  intensePlaylist: document.getElementById("intensePlaylist"),
  chillPlaylist: document.getElementById("chillPlaylist"),
  noSlowToggle: document.getElementById("noSlowToggle"),
  startBtn: document.getElementById("startBtn"),
  pauseBtn: document.getElementById("pauseBtn"),
  resumeBtn: document.getElementById("resumeBtn"),
  stopBtn: document.getElementById("stopBtn"),
  currentMode: document.getElementById("currentMode"),
  countdown: document.getElementById("countdown"),
  trackLabel: document.getElementById("trackLabel"),
  cueEditor: document.getElementById("cueEditor")
};

boot();

function boot() {
  bindUI();
  renderTemplate();
  renderCountdown(0);
  el.noSlowToggle.checked = state.noSlow;
  hydrateAuthFromUrl();
  hydrateStoredSession();
  updateAuthUI();
  if (window.Spotify) initPlayer();
  else window.onSpotifyWebPlaybackSDKReady = initPlayer;
}

function bindUI() {
  el.loginBtn.addEventListener("click", loginWithSpotify);
  el.logoutBtn.addEventListener("click", logout);
  el.activateBtn.addEventListener("click", activateAudio);
  el.addIntenseBtn.addEventListener("click", () => addInterval("intense"));
  el.addChillBtn.addEventListener("click", () => addInterval("chill"));
  el.saveTemplateBtn.addEventListener("click", saveTemplate);
  el.intensePlaylist.addEventListener("change", async (e) => {
    state.selectedIntensePlaylist = e.target.value;
    localStorage.setItem("sir_intense_playlist", state.selectedIntensePlaylist);
    await loadBucketTracks();
  });
  el.chillPlaylist.addEventListener("change", async (e) => {
    state.selectedChillPlaylist = e.target.value;
    localStorage.setItem("sir_chill_playlist", state.selectedChillPlaylist);
    await loadBucketTracks();
  });
  el.noSlowToggle.addEventListener("change", (e) => {
    state.noSlow = e.target.checked;
    localStorage.setItem("sir_no_slow", String(state.noSlow));
  });
  el.startBtn.addEventListener("click", startWorkout);
  el.pauseBtn.addEventListener("click", pauseWorkout);
  el.resumeBtn.addEventListener("click", resumeWorkout);
  el.stopBtn.addEventListener("click", stopWorkout);
}

function hydrateStoredSession() {
  const stored = loadJSON("sir_session", null);
  if (!stored) return;
  state.accessToken = stored.accessToken;
  state.refreshToken = stored.refreshToken;
  state.expiresAt = stored.expiresAt;
  if (Date.now() > state.expiresAt - 60_000 && state.refreshToken) {
    refreshAccessToken().catch(console.error);
  } else if (state.accessToken) {
    onAuthenticated().catch(console.error);
  }
}

function hydrateAuthFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const error = params.get("error");
  if (error) {
    setStatus(`Spotify login error: ${error}`);
    history.replaceState({}, document.title, window.location.pathname);
    return;
  }
  if (!code) return;
  exchangeCodeForToken(code)
    .then(() => {
      history.replaceState({}, document.title, window.location.pathname);
    })
    .catch((err) => {
      console.error(err);
      setStatus("Could not finish Spotify login.");
    });
}

async function loginWithSpotify() {
  const clientId = window.APP_CONFIG.CLIENT_ID;
  if (!clientId || clientId.includes("PASTE_YOUR_SPOTIFY_CLIENT_ID_HERE")) {
    setStatus("Set APP_CONFIG.CLIENT_ID in index.html first.");
    return;
  }
  const verifier = generateRandomString(64);
  const challenge = await sha256base64url(verifier);
  localStorage.setItem("sir_pkce_verifier", verifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: window.APP_CONFIG.SCOPES.join(" "),
    redirect_uri: window.APP_CONFIG.REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: challenge
  });

  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const verifier = localStorage.getItem("sir_pkce_verifier");
  if (!verifier) throw new Error("Missing PKCE verifier.");

  const body = new URLSearchParams({
    client_id: window.APP_CONFIG.CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: window.APP_CONFIG.REDIRECT_URI,
    code_verifier: verifier
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) throw new Error("Token exchange failed.");
  const data = await res.json();
  persistSession(data);
  await onAuthenticated();
}

async function refreshAccessToken() {
  const body = new URLSearchParams({
    client_id: window.APP_CONFIG.CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: state.refreshToken
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) throw new Error("Refresh token failed.");
  const data = await res.json();
  persistSession({ ...data, refresh_token: data.refresh_token || state.refreshToken });
  return state.accessToken;
}

function persistSession(data) {
  state.accessToken = data.access_token;
  state.refreshToken = data.refresh_token || state.refreshToken;
  state.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  localStorage.setItem("sir_session", JSON.stringify({
    accessToken: state.accessToken,
    refreshToken: state.refreshToken,
    expiresAt: state.expiresAt
  }));
}

async function onAuthenticated() {
  updateAuthUI();
  setStatus("Spotify connected.");
  await loadPlaylists();
  await loadBucketTracks();
  if (state.player) {
    await reconnectPlayer();
  }
}

function logout() {
  stopWorkout();
  localStorage.removeItem("sir_session");
  localStorage.removeItem("sir_pkce_verifier");
  state.accessToken = null;
  state.refreshToken = null;
  state.expiresAt = 0;
  state.playlists = [];
  state.intenseTracks = [];
  state.chillTracks = [];
  populatePlaylistSelects();
  renderCueEditor();
  updateAuthUI();
  setStatus("Signed out.");
}

function updateAuthUI() {
  const authed = !!state.accessToken;
  el.authStatus.textContent = authed ? "Connected" : "Signed out";
  el.loginBtn.classList.toggle("hidden", authed);
  el.logoutBtn.classList.toggle("hidden", !authed);
  el.activateBtn.classList.toggle("hidden", !(authed && state.playerReady));
}

function initPlayer() {
  if (state.player) return;
  state.player = new Spotify.Player({
    name: "Spotify Interval Runner",
    getOAuthToken: async (cb) => {
      try {
        const token = await getAccessToken();
        cb(token);
      } catch (err) {
        console.error(err);
      }
    },
    volume: state.baseVolume
  });

  state.player.addListener("ready", ({ device_id }) => {
    state.playerReady = true;
    state.deviceId = device_id;
    el.playerStatus.textContent = "Ready";
    el.deviceName.textContent = `Spotify Interval Runner (${device_id.slice(0, 8)}...)`;
    updateAuthUI();
    setStatus("Browser player ready. Tap 'Arm audio on this browser' before starting on iPhone.");
  });

  state.player.addListener("not_ready", () => {
    state.playerReady = false;
    el.playerStatus.textContent = "Offline";
    updateAuthUI();
  });

  state.player.addListener("autoplay_failed", () => {
    setStatus("Browser blocked autoplay. Tap 'Arm audio on this browser' and try again.");
  });

  ["initialization_error", "authentication_error", "account_error", "playback_error"].forEach((eventName) => {
    state.player.addListener(eventName, ({ message }) => {
      console.error(eventName, message);
      setStatus(`${eventName.replaceAll("_", " ")}: ${message}`);
    });
  });

  reconnectPlayer().catch(console.error);
}

async function reconnectPlayer() {
  if (!state.player || !state.accessToken) return;
  const ok = await state.player.connect();
  if (!ok) setStatus("Spotify browser player could not connect.");
}

async function activateAudio() {
  try {
    await state.player.activateElement();
    state.activated = true;
    await transferPlayback(false);
    setStatus("Audio armed on this browser.");
  } catch (err) {
    console.error(err);
    setStatus("Could not arm browser audio.");
  }
}

async function loadPlaylists() {
  const all = [];
  let url = "https://api.spotify.com/v1/me/playlists?limit=50";
  while (url) {
    const data = await spotifyFetch(url);
    all.push(...data.items);
    url = data.next;
  }
  state.playlists = all.filter(Boolean);
  populatePlaylistSelects();
}

function populatePlaylistSelects() {
  const options = [`<option value="">Select a playlist</option>`]
    .concat(state.playlists.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`))
    .join("");

  el.intensePlaylist.innerHTML = options;
  el.chillPlaylist.innerHTML = options;
  el.intensePlaylist.value = state.selectedIntensePlaylist;
  el.chillPlaylist.value = state.selectedChillPlaylist;
}

async function loadBucketTracks() {
  state.intenseTracks = state.selectedIntensePlaylist ? await loadPlaylistTracks(state.selectedIntensePlaylist) : [];
  state.chillTracks = state.selectedChillPlaylist ? await loadPlaylistTracks(state.selectedChillPlaylist) : [];
  renderCueEditor();
}

async function loadPlaylistTracks(playlistId) {
  const tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;
  while (url) {
    const data = await spotifyFetch(url);
    for (const item of data.items || []) {
      if (item.track && item.track.type === "track") tracks.push(item.track);
    }
    url = data.next;
  }
  return tracks;
}

function renderTemplate() {
  el.intervalList.innerHTML = "";
  state.template.forEach((interval, index) => {
    const row = document.createElement("div");
    row.className = "interval-row";
    row.innerHTML = `
      <div>
        <div class="interval-type ${interval.mode}">${capitalize(interval.mode)}</div>
        <div class="muted small">Interval ${index + 1}</div>
      </div>
      <label>
        <span class="small muted">Minutes</span>
        <input type="number" min="0.25" step="0.25" value="${interval.minutes}" data-minutes-index="${index}" />
      </label>
      <button class="icon-btn" data-remove-index="${index}">✕</button>
    `;
    el.intervalList.appendChild(row);
  });

  el.intervalList.querySelectorAll("[data-minutes-index]").forEach((input) => {
    input.addEventListener("input", (e) => {
      const index = Number(e.target.dataset.minutesIndex);
      state.template[index].minutes = Math.max(0.25, Number(e.target.value) || 0.25);
    });
  });

  el.intervalList.querySelectorAll("[data-remove-index]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const index = Number(e.target.dataset.removeIndex);
      state.template.splice(index, 1);
      renderTemplate();
    });
  });
}

function addInterval(mode) {
  state.template.push({ mode, minutes: 1 });
  renderTemplate();
}

function saveTemplate() {
  localStorage.setItem("sir_template", JSON.stringify(state.template));
  setStatus("Workout template saved locally.");
}

function renderCueEditor() {
  const tracks = state.intenseTracks;
  if (!tracks.length) {
    el.cueEditor.innerHTML = `<div class="status">Select an intense playlist to edit cue points.</div>`;
    return;
  }

  el.cueEditor.innerHTML = "";
  for (const track of tracks) {
    const cue = state.cues[track.id] || {};
    const row = document.createElement("div");
    row.className = "cue-row";
    row.innerHTML = `
      <div class="cue-title">
        <strong>${escapeHtml(track.name)}</strong>
        <span>${escapeHtml((track.artists || []).map((a) => a.name).join(", "))}</span>
      </div>
      <label>
        <span class="small muted">Start</span>
        <input type="number" min="0" step="0.1" value="${cue.startSec ?? ""}" data-track-id="${track.id}" data-field="startSec" />
      </label>
      <label>
        <span class="small muted">End</span>
        <input type="number" min="0" step="0.1" value="${cue.endSec ?? ""}" data-track-id="${track.id}" data-field="endSec" />
      </label>
      <button class="secondary" data-preview-id="${track.id}">Preview</button>
    `;
    el.cueEditor.appendChild(row);
  }

  el.cueEditor.querySelectorAll("input[data-track-id]").forEach((input) => {
    input.addEventListener("change", (e) => {
      const { trackId, field } = e.target.dataset;
      const current = state.cues[trackId] || {};
      const value = e.target.value === "" ? null : Number(e.target.value);
      state.cues[trackId] = { ...current, [field]: value };
      localStorage.setItem("sir_cues", JSON.stringify(state.cues));
    });
  });

  el.cueEditor.querySelectorAll("[data-preview-id]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const trackId = e.target.dataset.previewId;
      const track = tracks.find((t) => t.id === trackId);
      if (!track) return;
      const cue = state.cues[trackId] || {};
      await previewTrack(track, cue.startSec ? cue.startSec * 1000 : 0);
    });
  });
}

async function startWorkout() {
  try {
    if (!state.accessToken) throw new Error("Log in first.");
    if (!state.playerReady || !state.deviceId) throw new Error("Browser player is not ready.");
    if (!state.activated) throw new Error("Tap 'Arm audio on this browser' first on iPhone.");
    if (!state.template.length) throw new Error("Add at least one interval.");
    if (!state.selectedIntensePlaylist || !state.selectedChillPlaylist) throw new Error("Choose both playlists.");
    if (!state.intenseTracks.length || !state.chillTracks.length) throw new Error("Selected playlists are empty.");

    stopWorkout(false);
    state.trackIndices = { intense: 0, chill: 0 };
    state.workout = {
      index: 0,
      paused: false,
      intervalEndsAt: 0,
      boundaryTimer: null
    };
    await transferPlayback(false);
    await startCurrentInterval(true);
    setStatus("Workout started.");
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Could not start workout.");
  }
}

async function startCurrentInterval(isFirst = false) {
  clearTimeout(state.workout?.boundaryTimer);
  clearTimeout(state.clipTimer);
  const interval = state.template[state.workout.index];
  const durationMs = Math.round(interval.minutes * 60_000);
  state.workout.intervalEndsAt = Date.now() + durationMs;
  renderCurrentMode(interval.mode);
  renderCountdown(durationMs);
  startIntervalTicker();

  state.workout.boundaryTimer = setTimeout(async () => {
    await advanceInterval();
  }, durationMs);

  if (interval.mode === "intense") {
    await playModeForDuration("intense", durationMs, state.noSlow);
  } else {
    await playModeForDuration("chill", durationMs, false);
  }
}

async function playModeForDuration(mode, remainingMs, useCue) {
  if (!state.workout || state.workout.paused) return;
  if (remainingMs <= 200) return;

  const track = nextTrack(mode, useCue);
  if (!track) {
    setStatus(`No usable ${mode} tracks available.`);
    return;
  }

  const cue = useCue ? state.cues[track.id] || {} : {};
  const startMs = useCue && cue.startSec != null ? Math.max(0, Math.round(cue.startSec * 1000)) : 0;
  const rawEndMs = useCue && cue.endSec != null ? Math.round(cue.endSec * 1000) : track.duration_ms;
  const endMs = Math.min(track.duration_ms, Math.max(startMs + 500, rawEndMs));
  const clipLengthMs = Math.min(remainingMs, Math.max(1000, endMs - startMs));

  await fadeOutThen(async () => {
    await playTrack(track.uri, startMs);
    await fadeIn();
  });

  el.trackLabel.textContent = `${track.name} — ${(track.artists || []).map((a) => a.name).join(", ")}`;

  const fadeLeadMs = Math.min(700, Math.floor(clipLengthMs / 3));
  const nextDelay = Math.max(200, clipLengthMs - fadeLeadMs);
  state.clipTimer = setTimeout(async () => {
    if (!state.workout || state.workout.paused) return;
    const intervalRemaining = Math.max(0, state.workout.intervalEndsAt - Date.now());
    if (intervalRemaining <= 200) return;
    await fadeOut();
    await playModeForDuration(mode, intervalRemaining, useCue);
  }, nextDelay);
}

function nextTrack(mode, requireCue) {
  const list = mode === "intense" ? state.intenseTracks : state.chillTracks;
  if (!list.length) return null;
  const originalIndex = state.trackIndices[mode] % list.length;
  for (let step = 0; step < list.length; step++) {
    const idx = (originalIndex + step) % list.length;
    const track = list[idx];
    const cue = state.cues[track.id] || {};
    const hasCue = cue.startSec != null;
    if (!requireCue || hasCue) {
      state.trackIndices[mode] = idx + 1;
      return track;
    }
  }
  return null;
}

async function advanceInterval() {
  if (!state.workout) return;
  clearTimeout(state.clipTimer);
  await fadeOut();
  state.workout.index += 1;
  if (state.workout.index >= state.template.length) {
    stopWorkout(false);
    setStatus("Workout complete.");
    return;
  }
  await startCurrentInterval();
}

async function pauseWorkout() {
  if (!state.workout || state.workout.paused) return;
  state.workout.paused = true;
  clearInterval(state.intervalTicker);
  clearTimeout(state.workout.boundaryTimer);
  clearTimeout(state.clipTimer);
  state.workout.remainingMs = Math.max(0, state.workout.intervalEndsAt - Date.now());
  try {
    await state.player.pause();
    setStatus("Workout paused.");
  } catch (err) {
    console.error(err);
  }
}

async function resumeWorkout() {
  if (!state.workout || !state.workout.paused) return;
  state.workout.paused = false;
  state.workout.intervalEndsAt = Date.now() + state.workout.remainingMs;
  state.workout.boundaryTimer = setTimeout(async () => {
    await advanceInterval();
  }, state.workout.remainingMs);
  startIntervalTicker();
  const mode = state.template[state.workout.index].mode;
  await playModeForDuration(mode, state.workout.remainingMs, mode === "intense" && state.noSlow);
  setStatus("Workout resumed.");
}

function stopWorkout(showMessage = true) {
  clearInterval(state.intervalTicker);
  clearTimeout(state.clipTimer);
  if (state.workout?.boundaryTimer) clearTimeout(state.workout.boundaryTimer);
  state.workout = null;
  renderCurrentMode("idle");
  renderCountdown(0);
  el.trackLabel.textContent = "No track loaded";
  if (state.player) state.player.pause().catch(() => {});
  if (showMessage) setStatus("Workout stopped.");
}

function startIntervalTicker() {
  clearInterval(state.intervalTicker);
  state.intervalTicker = setInterval(() => {
    if (!state.workout || state.workout.paused) return;
    const remaining = Math.max(0, state.workout.intervalEndsAt - Date.now());
    renderCountdown(remaining);
  }, 200);
}

async function playTrack(trackUri, positionMs = 0) {
  await spotifyFetch(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(state.deviceId)}`, {
    method: "PUT",
    body: JSON.stringify({ uris: [trackUri], position_ms: Math.max(0, Math.round(positionMs)) })
  }, true);
}

async function previewTrack(track, positionMs = 0) {
  try {
    if (!state.deviceId || !state.activated) {
      setStatus("Arm audio on this browser before previewing.");
      return;
    }
    await playTrack(track.uri, positionMs);
    await fadeIn();
    el.trackLabel.textContent = `Preview: ${track.name} — ${(track.artists || []).map((a) => a.name).join(", ")}`;
  } catch (err) {
    console.error(err);
    setStatus("Could not preview track.");
  }
}

async function transferPlayback(play = false) {
  await spotifyFetch("https://api.spotify.com/v1/me/player", {
    method: "PUT",
    body: JSON.stringify({ device_ids: [state.deviceId], play })
  }, true);
}

async function fadeOutThen(fn) {
  await fadeOut();
  await fn();
}

async function fadeOut() {
  if (!state.player) return;
  const from = await safeVolume();
  const steps = 5;
  for (let i = steps - 1; i >= 0; i--) {
    const value = Math.max(0.08, from * (i / steps));
    await state.player.setVolume(value);
    await sleep(70);
  }
}

async function fadeIn() {
  if (!state.player) return;
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    const value = Math.max(0.08, state.baseVolume * (i / steps));
    await state.player.setVolume(value);
    await sleep(70);
  }
}

async function safeVolume() {
  try {
    return await state.player.getVolume();
  } catch {
    return state.baseVolume;
  }
}

async function spotifyFetch(url, options = {}, allowNoContent = false) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (res.status === 204 && allowNoContent) return null;
  if (res.status === 401 && state.refreshToken) {
    await refreshAccessToken();
    return spotifyFetch(url, options, allowNoContent);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function getAccessToken() {
  if (!state.accessToken) throw new Error("Not logged in.");
  if (Date.now() > state.expiresAt - 60_000) {
    await refreshAccessToken();
  }
  return state.accessToken;
}

function renderCurrentMode(mode) {
  el.currentMode.className = "mode";
  if (mode === "intense") {
    el.currentMode.classList.add("mode-intense");
    el.currentMode.textContent = "Intense";
  } else if (mode === "chill") {
    el.currentMode.classList.add("mode-chill");
    el.currentMode.textContent = "Chill";
  } else {
    el.currentMode.classList.add("mode-idle");
    el.currentMode.textContent = "Idle";
  }
}

function renderCountdown(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const min = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const sec = String(totalSec % 60).padStart(2, "0");
  el.countdown.textContent = `${min}:${sec}`;
}

function setStatus(message) {
  el.statusMessage.textContent = message;
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function generateRandomString(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const arr = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(arr, (x) => chars[x % chars.length]).join("");
}

async function sha256base64url(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

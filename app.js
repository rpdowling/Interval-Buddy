const DEFAULT_TEMPLATE = [
  { mode: "intense", minutes: 3 },
  { mode: "chill", minutes: 1 },
  { mode: "intense", minutes: 5 },
  { mode: "chill", minutes: 2 }
];

const savedState = loadJSON("sir_saved_state", {});

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
  trackLookup: {},
  trims: loadJSON("sir_track_trims", {}),
  template: normalizeTemplate(savedState.template || loadJSON("sir_template", DEFAULT_TEMPLATE)),
  intervalAssignments: [],
  selectedIntensePlaylist: savedState.selectedIntensePlaylist || localStorage.getItem("sir_intense_playlist") || "",
  selectedChillPlaylist: savedState.selectedChillPlaylist || localStorage.getItem("sir_chill_playlist") || "",
  noSlow: savedState.noSlow ?? (localStorage.getItem("sir_no_slow") === "true"),
  savedWorkouts: loadJSON("sir_saved_workouts", []),
  workout: null,
  intervalTicker: null,
  clipTimer: null,
  baseVolume: 0.92,
  trackIndices: { intense: 0, chill: 0 },
  shuffleBags: { intense: [], chill: [] },
  beepContext: null,
  dragPayload: null
};

state.intervalAssignments = normalizeAssignments(
  savedState.intervalAssignments || loadJSON("sir_interval_assignments", []),
  state.template.length
);

const el = {
  loginBtn: document.getElementById("loginBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  activateBtn: document.getElementById("activateBtn"),
  authStatus: document.getElementById("authStatus"),
  playerStatus: document.getElementById("playerStatus"),
  deviceName: document.getElementById("deviceName"),
  statusMessage: document.getElementById("statusMessage"),
  workoutNameInput: document.getElementById("workoutNameInput"),
  saveWorkoutBtn: document.getElementById("saveWorkoutBtn"),
  loadWorkoutBtn: document.getElementById("loadWorkoutBtn"),
  deleteWorkoutBtn: document.getElementById("deleteWorkoutBtn"),
  exportWorkoutBtn: document.getElementById("exportWorkoutBtn"),
  importWorkoutBtn: document.getElementById("importWorkoutBtn"),
  importWorkoutInput: document.getElementById("importWorkoutInput"),
  savedWorkoutSelect: document.getElementById("savedWorkoutSelect"),
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
  nextBtn: document.getElementById("nextBtn"),
  stopBtn: document.getElementById("stopBtn"),
  currentMode: document.getElementById("currentMode"),
  countdown: document.getElementById("countdown"),
  totalRemaining: document.getElementById("totalRemaining"),
  trackLabel: document.getElementById("trackLabel"),
  intervalPlanner: document.getElementById("intervalPlanner"),
  intenseTrackList: document.getElementById("intenseTrackList"),
  chillTrackList: document.getElementById("chillTrackList")
};

boot();

function boot() {
  bindUI();
  renderSavedWorkouts();
  renderTemplate();
  renderPlanner();
  renderTrackLists();
  renderCountdown(0);
  renderTotalRemaining(0);
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
  el.saveWorkoutBtn.addEventListener("click", saveCurrentWorkout);
  el.loadWorkoutBtn.addEventListener("click", loadSelectedWorkout);
  el.deleteWorkoutBtn.addEventListener("click", deleteSelectedWorkout);
  el.exportWorkoutBtn.addEventListener("click", exportWorkoutBundle);
  el.importWorkoutBtn.addEventListener("click", () => el.importWorkoutInput.click());
  el.importWorkoutInput.addEventListener("change", importWorkoutBundle);
  el.addIntenseBtn.addEventListener("click", () => addInterval("intense"));
  el.addChillBtn.addEventListener("click", () => addInterval("chill"));
  el.saveTemplateBtn.addEventListener("click", saveTemplateOnly);

  el.intensePlaylist.addEventListener("change", async (e) => {
    state.selectedIntensePlaylist = e.target.value;
    persistCoreSettings();
    await loadBucketTracks();
  });

  el.chillPlaylist.addEventListener("change", async (e) => {
    state.selectedChillPlaylist = e.target.value;
    persistCoreSettings();
    await loadBucketTracks();
  });

  el.noSlowToggle.addEventListener("change", (e) => {
    state.noSlow = e.target.checked;
    persistCoreSettings();
  });

  el.startBtn.addEventListener("click", startWorkout);
  el.pauseBtn.addEventListener("click", pauseWorkout);
  el.resumeBtn.addEventListener("click", resumeWorkout);
  el.nextBtn.addEventListener("click", skipToNextPeriod);
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
  const clientId = window.APP_CONFIG?.CLIENT_ID;
  if (!clientId) {
    setStatus("Missing APP_CONFIG.CLIENT_ID in index.html.");
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

  localStorage.setItem(
    "sir_session",
    JSON.stringify({
      accessToken: state.accessToken,
      refreshToken: state.refreshToken,
      expiresAt: state.expiresAt
    })
  );
}

async function onAuthenticated() {
  updateAuthUI();
  setStatus("Spotify connected.");
  await loadPlaylists();
  await loadBucketTracks();
  if (state.player) await reconnectPlayer();
}

function logout() {
  stopWorkout(false);
  localStorage.removeItem("sir_session");
  localStorage.removeItem("sir_pkce_verifier");

  state.accessToken = null;
  state.refreshToken = null;
  state.expiresAt = 0;
  state.playlists = [];
  state.intenseTracks = [];
  state.chillTracks = [];
  state.trackLookup = {};

  populatePlaylistSelects();
  renderPlanner();
  renderTrackLists();
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
        cb(await getAccessToken());
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
    await ensureBeepAudio();
    await state.player.activateElement();
    state.activated = true;
    await transferPlayback(false);
    setStatus("Audio armed on this browser.");
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Could not arm browser audio.");
  }
}

async function loadPlaylists() {
  const all = [];
  let url = "https://api.spotify.com/v1/me/playlists?limit=50";

  while (url) {
    const data = await spotifyFetch(url);
    all.push(...(data.items || []));
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
  try {
    const intense = state.selectedIntensePlaylist
      ? await loadPlaylistTracks(state.selectedIntensePlaylist, "intense")
      : { usable: [], total: 0, skipped: 0 };

    const chill = state.selectedChillPlaylist
      ? await loadPlaylistTracks(state.selectedChillPlaylist, "chill")
      : { usable: [], total: 0, skipped: 0 };

    state.intenseTracks = intense.usable;
    state.chillTracks = chill.usable;
    rebuildTrackLookup();
    resetShuffleBags();

    renderPlanner();
    renderTrackLists();
    setStatus(
      `Intense: ${intense.usable.length}/${intense.total} usable. Chill: ${chill.usable.length}/${chill.total} usable.`
    );
  } catch (err) {
    console.error(err);
    state.intenseTracks = [];
    state.chillTracks = [];
    state.trackLookup = {};
    renderPlanner();
    renderTrackLists();
    setStatus(err.message || "Could not load playlist tracks.");
  }
}

async function loadPlaylistTracks(playlistId, label = "playlist") {
  const usable = [];
  let total = 0;
  let skipped = 0;
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100`;

  while (url) {
    const data = await spotifyFetch(url);

    for (const row of data.items || []) {
      total += 1;
      const playable = row.item;
      if (!playable) {
        skipped += 1;
        continue;
      }
      if (row.is_local || playable.is_local) {
        skipped += 1;
        continue;
      }
      if (playable.type !== "track") {
        skipped += 1;
        continue;
      }
      usable.push(playable);
    }

    url = data.next;
  }

  console.log(`${label} playlist scan`, { playlistId, total, usable: usable.length, skipped });
  return { usable, total, skipped };
}

function rebuildTrackLookup() {
  state.trackLookup = {};
  for (const track of [...state.intenseTracks, ...state.chillTracks]) {
    state.trackLookup[track.id] = track;
  }
}

function renderSavedWorkouts() {
  const options = [`<option value="">Select a saved workout</option>`]
    .concat(state.savedWorkouts.map((item, index) => `<option value="${index}">${escapeHtml(item.name)}</option>`))
    .join("");
  el.savedWorkoutSelect.innerHTML = options;
}

function renderTemplate() {
  el.intervalList.innerHTML = "";
  syncAssignmentsLength();

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
      renderPlanner();
      renderTrackLists();
      persistCoreSettings();
    });
  });

  el.intervalList.querySelectorAll("[data-remove-index]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const index = Number(e.target.dataset.removeIndex);
      state.template.splice(index, 1);
      state.intervalAssignments.splice(index, 1);
      renderTemplate();
      renderPlanner();
      renderTrackLists();
      persistCoreSettings();
    });
  });
}

function renderPlanner() {
  syncAssignmentsLength();
  el.intervalPlanner.innerHTML = "";

  state.template.forEach((interval, index) => {
    const card = document.createElement("div");
    card.className = "interval-card";
    card.dataset.intervalIndex = index;

    const queue = getIntervalQueue(index);
    const queueHtml = queue.length
      ? queue
          .map((item, queueIndex) => {
            const track = state.trackLookup[item.trackId];
            const label = track ? escapeHtml(track.name) : escapeHtml(item.trackId);
            return `
              <div class="assignment-chip" data-track-id="${item.trackId}">
                <div class="assignment-chip-title">
                  <strong>${label}</strong>
                  <span class="small muted">#${queueIndex + 1}</span>
                </div>
                <div class="assignment-chip-controls">
                  <button class="small-btn secondary" data-move-up="${index}:${queueIndex}">↑</button>
                  <button class="small-btn secondary" data-move-down="${index}:${queueIndex}">↓</button>
                  <button class="small-btn danger" data-remove-assignment="${index}:${item.trackId}">✕</button>
                </div>
              </div>
            `;
          })
          .join("")
      : `<div class="empty-dropzone">Drop ${interval.mode} songs here</div>`;

    card.innerHTML = `
      <div class="interval-card-header">
        <div>
          <div class="interval-type ${interval.mode}">${capitalize(interval.mode)}</div>
          <div class="small muted">Interval ${index + 1} · ${interval.minutes} min</div>
        </div>
      </div>
      <div class="interval-chip-list">${queueHtml}</div>
    `;

    attachIntervalDropHandlers(card, index);
    el.intervalPlanner.appendChild(card);
  });

  el.intervalPlanner.querySelectorAll("[data-remove-assignment]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const [intervalIndex, trackId] = e.currentTarget.dataset.removeAssignment.split(":");
      removeTrackFromInterval(Number(intervalIndex), trackId);
    });
  });

  el.intervalPlanner.querySelectorAll("[data-move-up]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const [intervalIndex, queueIndex] = e.currentTarget.dataset.moveUp.split(":").map(Number);
      moveAssignment(intervalIndex, queueIndex, -1);
    });
  });

  el.intervalPlanner.querySelectorAll("[data-move-down]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const [intervalIndex, queueIndex] = e.currentTarget.dataset.moveDown.split(":").map(Number);
      moveAssignment(intervalIndex, queueIndex, 1);
    });
  });
}

function attachIntervalDropHandlers(card, intervalIndex) {
  card.addEventListener("dragover", (e) => {
    e.preventDefault();
    card.classList.add("drop-over");
  });
  card.addEventListener("dragleave", () => {
    card.classList.remove("drop-over");
  });
  card.addEventListener("drop", (e) => {
    e.preventDefault();
    card.classList.remove("drop-over");
    const payload = parseDragPayload(e.dataTransfer?.getData("text/plain")) || state.dragPayload;
    if (!payload) return;
    addTrackToInterval(intervalIndex, payload.trackId, payload.mode);
  });
}

function renderTrackLists() {
  el.intenseTrackList.innerHTML = renderTrackRows(state.intenseTracks, "intense");
  el.chillTrackList.innerHTML = renderTrackRows(state.chillTracks, "chill");
  bindTrackRowUI("intense");
  bindTrackRowUI("chill");
}

function renderTrackRows(tracks, mode) {
  if (!tracks.length) {
    return `<div class="status">Select a ${mode} playlist to view songs.</div>`;
  }

  return tracks.map((track) => {
    const trim = getTrim(track.id, track.duration_ms);
    const durationSec = Math.max(1, Math.round(track.duration_ms / 1000));
    const boxes = state.template
      .map((interval, index) => {
        const assignedIndex = getAssignmentOrder(index, track.id);
        const matching = interval.mode === mode;
        const classes = ["interval-box"];
        if (matching) classes.push("matching");
        else classes.push("disabled");
        if (assignedIndex >= 0) classes.push("assigned");
        return `<button class="${classes.join(" ")}" type="button" data-toggle-interval="${track.id}:${mode}:${index}">${assignedIndex >= 0 ? assignedIndex + 1 : index + 1}</button>`;
      })
      .join("");

    return `
      <div class="track-row" draggable="true" data-track-id="${track.id}" data-mode="${mode}">
        <div class="track-main">
          <div class="track-meta">
            <span class="drag-label">⋮⋮ drag to interval</span>
            <strong>${escapeHtml(track.name)}</strong>
            <span class="small muted">${escapeHtml((track.artists || []).map((a) => a.name).join(", "))}</span>
            <span class="small muted">${formatClock(track.duration_ms)}</span>
          </div>
          <div class="track-actions">
            <button class="secondary small-btn" data-preview-track="${track.id}">Preview</button>
            <button class="secondary small-btn" data-reset-trim="${track.id}">Reset trim</button>
          </div>
        </div>
        <div class="trim-panel">
          <div class="trim-header">
            <span>Trim start ${formatSeconds(trim.startSec)}</span>
            <span>Trim end ${formatSeconds(trim.endSec)}</span>
          </div>
          <div class="trim-slider-group">
            <div class="trim-slider-row">
              <span class="small muted">Start</span>
              <input type="range" min="0" max="${durationSec}" step="1" value="${Math.round(trim.startSec)}" data-trim-slider="start:${track.id}" />
              <span class="small muted">${formatSeconds(trim.startSec)}</span>
            </div>
            <div class="trim-slider-row">
              <span class="small muted">End</span>
              <input type="range" min="1" max="${durationSec}" step="1" value="${Math.round(trim.endSec)}" data-trim-slider="end:${track.id}" />
              <span class="small muted">${formatSeconds(trim.endSec)}</span>
            </div>
          </div>
        </div>
        <div class="interval-boxes">${boxes}</div>
      </div>
    `;
  }).join("");
}

function bindTrackRowUI(mode) {
  const listEl = mode === "intense" ? el.intenseTrackList : el.chillTrackList;

  listEl.querySelectorAll(".track-row").forEach((row) => {
    row.addEventListener("dragstart", (e) => {
      const payload = { trackId: row.dataset.trackId, mode: row.dataset.mode };
      state.dragPayload = payload;
      row.classList.add("dragging");
      e.dataTransfer.setData("text/plain", JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "copy";
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      state.dragPayload = null;
    });
  });

  listEl.querySelectorAll("[data-preview-track]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const trackId = e.currentTarget.dataset.previewTrack;
      const track = state.trackLookup[trackId];
      if (!track) return;
      const trim = getTrim(track.id, track.duration_ms);
      await previewTrack(track, Math.round(trim.startSec * 1000));
    });
  });

  listEl.querySelectorAll("[data-reset-trim]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const trackId = e.currentTarget.dataset.resetTrim;
      const track = state.trackLookup[trackId];
      if (!track) return;
      state.trims[trackId] = { startSec: 0, endSec: Math.round(track.duration_ms / 1000) };
      persistCoreSettings();
      renderTrackLists();
    });
  });

  listEl.querySelectorAll("[data-trim-slider]").forEach((input) => {
    input.addEventListener("input", (e) => {
      const [kind, trackId] = e.currentTarget.dataset.trimSlider.split(":");
      const track = state.trackLookup[trackId];
      if (!track) return;
      const maxSec = Math.max(1, Math.round(track.duration_ms / 1000));
      const trim = getTrim(trackId, track.duration_ms);
      let startSec = Math.round(trim.startSec);
      let endSec = Math.round(trim.endSec);
      const nextValue = Math.max(0, Math.min(maxSec, Number(e.currentTarget.value) || 0));

      if (kind === "start") {
        startSec = Math.min(nextValue, endSec - 1);
      } else {
        endSec = Math.max(nextValue, startSec + 1);
      }

      state.trims[trackId] = { startSec, endSec };
      persistCoreSettings();
      renderTrackLists();
    });
  });

  listEl.querySelectorAll("[data-toggle-interval]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const [trackId, rowMode, intervalIndexRaw] = e.currentTarget.dataset.toggleInterval.split(":");
      const intervalIndex = Number(intervalIndexRaw);
      toggleTrackInInterval(intervalIndex, trackId, rowMode);
    });
  });
}

function saveTemplateOnly() {
  persistCoreSettings();
  setStatus("Template saved locally.");
}

function saveCurrentWorkout() {
  const name = el.workoutNameInput.value.trim();
  if (!name) {
    setStatus("Enter a workout name first.");
    return;
  }

  const payload = {
    name,
    template: deepCopy(state.template),
    intervalAssignments: deepCopy(state.intervalAssignments),
    trims: deepCopy(state.trims),
    selectedIntensePlaylist: state.selectedIntensePlaylist,
    selectedChillPlaylist: state.selectedChillPlaylist,
    noSlow: state.noSlow
  };

  const existingIndex = state.savedWorkouts.findIndex((item) => item.name.toLowerCase() === name.toLowerCase());
  let selectedIndex = existingIndex;
  if (existingIndex >= 0) state.savedWorkouts[existingIndex] = payload;
  else {
    state.savedWorkouts.push(payload);
    selectedIndex = state.savedWorkouts.length - 1;
  }

  persistSavedWorkouts();
  renderSavedWorkouts();
  el.savedWorkoutSelect.value = String(selectedIndex);
  setStatus("Workout saved locally.");
}

function buildWorkoutBundle() {
  return {
    app: "spotify-interval-runner",
    version: 1,
    exportedAt: new Date().toISOString(),
    currentWorkoutName: el.workoutNameInput.value.trim() || "",
    current: {
      template: deepCopy(state.template),
      intervalAssignments: deepCopy(state.intervalAssignments),
      trims: deepCopy(state.trims),
      selectedIntensePlaylist: state.selectedIntensePlaylist,
      selectedChillPlaylist: state.selectedChillPlaylist,
      noSlow: state.noSlow
    },
    savedWorkouts: deepCopy(state.savedWorkouts)
  };
}

function exportWorkoutBundle() {
  try {
    const bundle = buildWorkoutBundle();
    const nameBase = slugify(el.workoutNameInput.value.trim() || "interval-buddy-workout");
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${nameBase}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStatus("Workout file downloaded.");
  } catch (err) {
    console.error(err);
    setStatus("Could not export workout file.");
  }
}

async function importWorkoutBundle(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const raw = await file.text();
    const parsed = JSON.parse(raw);
    applyImportedBundle(parsed);
    setStatus("Workout file loaded.");
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Could not load workout file.");
  } finally {
    event.target.value = "";
  }
}

function applyImportedBundle(bundle) {
  if (!bundle || typeof bundle !== "object") {
    throw new Error("Invalid workout file.");
  }

  const current = bundle.current || bundle;
  const nextTemplate = normalizeTemplate(current.template || DEFAULT_TEMPLATE);
  const nextAssignments = normalizeAssignments(current.intervalAssignments || [], nextTemplate.length);
  const nextTrims = current.trims && typeof current.trims === "object" ? current.trims : {};
  const nextSaved = Array.isArray(bundle.savedWorkouts)
    ? bundle.savedWorkouts.map((item) => ({
        name: String(item.name || "Imported Workout"),
        template: normalizeTemplate(item.template || DEFAULT_TEMPLATE),
        intervalAssignments: normalizeAssignments(item.intervalAssignments || [], normalizeTemplate(item.template || DEFAULT_TEMPLATE).length),
        trims: item.trims && typeof item.trims === "object" ? item.trims : {},
        selectedIntensePlaylist: item.selectedIntensePlaylist || "",
        selectedChillPlaylist: item.selectedChillPlaylist || "",
        noSlow: !!item.noSlow
      }))
    : state.savedWorkouts;

  state.template = nextTemplate;
  state.intervalAssignments = nextAssignments;
  state.trims = nextTrims;
  state.selectedIntensePlaylist = current.selectedIntensePlaylist || "";
  state.selectedChillPlaylist = current.selectedChillPlaylist || "";
  state.noSlow = !!current.noSlow;
  state.savedWorkouts = nextSaved;

  el.workoutNameInput.value = bundle.currentWorkoutName || current.name || "";
  el.noSlowToggle.checked = state.noSlow;

  renderSavedWorkouts();
  renderTemplate();
  persistSavedWorkouts();
  persistCoreSettings();

  if (state.accessToken) {
    populatePlaylistSelects();
    el.intensePlaylist.value = state.selectedIntensePlaylist;
    el.chillPlaylist.value = state.selectedChillPlaylist;
    loadBucketTracks().catch(console.error);
  } else {
    renderPlanner();
    renderTrackLists();
  }
}

async function loadSelectedWorkout() {
  const index = Number(el.savedWorkoutSelect.value);
  if (Number.isNaN(index) || !state.savedWorkouts[index]) {
    setStatus("Select a saved workout first.");
    return;
  }

  const saved = state.savedWorkouts[index];
  state.template = normalizeTemplate(saved.template || DEFAULT_TEMPLATE);
  state.intervalAssignments = normalizeAssignments(saved.intervalAssignments || [], state.template.length);
  state.trims = saved.trims || {};
  state.selectedIntensePlaylist = saved.selectedIntensePlaylist || "";
  state.selectedChillPlaylist = saved.selectedChillPlaylist || "";
  state.noSlow = !!saved.noSlow;

  el.workoutNameInput.value = saved.name;
  el.noSlowToggle.checked = state.noSlow;
  el.intensePlaylist.value = state.selectedIntensePlaylist;
  el.chillPlaylist.value = state.selectedChillPlaylist;

  renderTemplate();
  persistCoreSettings();

  if (state.accessToken) {
    await loadBucketTracks();
  } else {
    renderPlanner();
    renderTrackLists();
  }

  setStatus("Workout loaded.");
}

function deleteSelectedWorkout() {
  const index = Number(el.savedWorkoutSelect.value);
  if (Number.isNaN(index) || !state.savedWorkouts[index]) {
    setStatus("Select a saved workout first.");
    return;
  }
  state.savedWorkouts.splice(index, 1);
  persistSavedWorkouts();
  renderSavedWorkouts();
  setStatus("Workout deleted.");
}

function persistSavedWorkouts() {
  localStorage.setItem("sir_saved_workouts", JSON.stringify(state.savedWorkouts));
}

function persistCoreSettings() {
  localStorage.setItem("sir_template", JSON.stringify(state.template));
  localStorage.setItem("sir_interval_assignments", JSON.stringify(state.intervalAssignments));
  localStorage.setItem("sir_track_trims", JSON.stringify(state.trims));
  localStorage.setItem("sir_intense_playlist", state.selectedIntensePlaylist);
  localStorage.setItem("sir_chill_playlist", state.selectedChillPlaylist);
  localStorage.setItem("sir_no_slow", String(state.noSlow));
  localStorage.setItem(
    "sir_saved_state",
    JSON.stringify({
      template: state.template,
      intervalAssignments: state.intervalAssignments,
      selectedIntensePlaylist: state.selectedIntensePlaylist,
      selectedChillPlaylist: state.selectedChillPlaylist,
      noSlow: state.noSlow
    })
  );
}

function addInterval(mode) {
  state.template.push({ mode, minutes: 1 });
  state.intervalAssignments.push([]);
  renderTemplate();
  renderPlanner();
  renderTrackLists();
  persistCoreSettings();
}

function syncAssignmentsLength() {
  state.intervalAssignments = normalizeAssignments(state.intervalAssignments, state.template.length);
}

function getIntervalQueue(intervalIndex) {
  const raw = state.intervalAssignments[intervalIndex] || [];
  return raw.filter((item) => !!state.trackLookup[item.trackId] || !state.accessToken);
}

function addTrackToInterval(intervalIndex, trackId, trackMode) {
  const interval = state.template[intervalIndex];
  if (!interval || interval.mode !== trackMode) return;
  const queue = state.intervalAssignments[intervalIndex];
  if (queue.some((item) => item.trackId === trackId)) return;
  queue.push({ trackId });
  renderPlanner();
  renderTrackLists();
  persistCoreSettings();
}

function removeTrackFromInterval(intervalIndex, trackId) {
  state.intervalAssignments[intervalIndex] = (state.intervalAssignments[intervalIndex] || []).filter((item) => item.trackId !== trackId);
  renderPlanner();
  renderTrackLists();
  persistCoreSettings();
}

function toggleTrackInInterval(intervalIndex, trackId, trackMode) {
  const interval = state.template[intervalIndex];
  if (!interval || interval.mode !== trackMode) return;
  const exists = getAssignmentOrder(intervalIndex, trackId) >= 0;
  if (exists) removeTrackFromInterval(intervalIndex, trackId);
  else addTrackToInterval(intervalIndex, trackId, trackMode);
}

function moveAssignment(intervalIndex, queueIndex, delta) {
  const queue = state.intervalAssignments[intervalIndex] || [];
  const newIndex = queueIndex + delta;
  if (newIndex < 0 || newIndex >= queue.length) return;
  const [item] = queue.splice(queueIndex, 1);
  queue.splice(newIndex, 0, item);
  renderPlanner();
  renderTrackLists();
  persistCoreSettings();
}

function getAssignmentOrder(intervalIndex, trackId) {
  const queue = state.intervalAssignments[intervalIndex] || [];
  return queue.findIndex((item) => item.trackId === trackId);
}

async function startWorkout() {
  try {
    if (!state.accessToken) throw new Error("Log in first.");
    if (!state.playerReady || !state.deviceId) throw new Error("Browser player is not ready.");
    if (!state.activated) throw new Error("Tap 'Arm audio on this browser' first on iPhone.");
    if (!state.template.length) throw new Error("Add at least one interval.");
    if (!state.selectedIntensePlaylist || !state.selectedChillPlaylist) throw new Error("Choose both playlists.");
    if (!state.intenseTracks.length) throw new Error("Intense playlist has no usable tracks loaded.");
    if (!state.chillTracks.length) throw new Error("Chill playlist has no usable tracks loaded.");

    await ensureBeepAudio();
    stopWorkout(false);
    resetShuffleBags();
    state.trackIndices = { intense: 0, chill: 0 };
    state.workout = {
      index: 0,
      paused: false,
      intervalEndsAt: 0,
      boundaryTimer: null,
      remainingMs: 0,
      intervalQueue: [],
      intervalQueueCursor: 0
    };

    await transferPlayback(false);
    await startCurrentInterval();
    setStatus("Workout started.");
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Could not start workout.");
  }
}

async function startCurrentInterval() {
  clearTimeout(state.workout?.boundaryTimer);
  clearTimeout(state.clipTimer);

  const interval = state.template[state.workout.index];
  const durationMs = Math.round(interval.minutes * 60_000);

  state.workout.intervalEndsAt = Date.now() + durationMs;
  state.workout.remainingMs = durationMs;
  state.workout.intervalQueue = resolveIntervalTracks(state.workout.index);
  state.workout.intervalQueueCursor = 0;

  renderCurrentMode(interval.mode);
  renderCountdown(durationMs);
  renderTotalRemaining(computeTotalRemainingMs());
  startIntervalTicker();

  state.workout.boundaryTimer = setTimeout(async () => {
    await advanceInterval();
  }, durationMs);

  await playModeForDuration(interval.mode, durationMs);
}

function resolveIntervalTracks(intervalIndex) {
  const queue = getIntervalQueue(intervalIndex);
  return queue
    .map((item) => state.trackLookup[item.trackId])
    .filter(Boolean);
}

async function playModeForDuration(mode, remainingMs) {
  if (!state.workout || state.workout.paused) return;
  if (remainingMs <= 200) return;

  const track = nextTrackForCurrentInterval(mode);
  if (!track) {
    setStatus(`No usable ${mode} tracks available.`);
    return;
  }

  const { startMs, endMs } = getTrackWindow(track, mode);
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
    await playModeForDuration(mode, intervalRemaining);
  }, nextDelay);
}

function nextTrackForCurrentInterval(mode) {
  const intervalQueue = state.workout?.intervalQueue || [];
  if (intervalQueue.length) {
    const index = state.workout.intervalQueueCursor % intervalQueue.length;
    state.workout.intervalQueueCursor += 1;
    return intervalQueue[index];
  }
  return nextFallbackTrack(mode);
}

function nextFallbackTrack(mode) {
  const pool = getFallbackPool(mode);
  if (!pool.length) return null;

  if (!state.shuffleBags[mode].length) {
    state.shuffleBags[mode] = shuffleArray(pool.map((track) => track.id));
  }

  const trackId = state.shuffleBags[mode].shift();
  return state.trackLookup[trackId] || pool[0] || null;
}

function getFallbackPool(mode) {
  const base = mode === "intense" ? state.intenseTracks : state.chillTracks;
  if (mode === "intense" && state.noSlow) {
    const trimmedOnly = base.filter((track) => hasCustomTrim(track.id, track.duration_ms));
    return trimmedOnly.length ? trimmedOnly : base;
  }
  return base;
}

function getTrackWindow(track, mode) {
  const trim = getTrim(track.id, track.duration_ms);
  const hasCustom = hasCustomTrim(track.id, track.duration_ms);
  const shouldUseTrim = hasCustom || (mode === "intense" && state.noSlow);
  const startMs = shouldUseTrim ? Math.max(0, Math.round(trim.startSec * 1000)) : 0;
  const endMs = shouldUseTrim
    ? Math.min(track.duration_ms, Math.max(startMs + 1000, Math.round(trim.endSec * 1000)))
    : track.duration_ms;
  return { startMs, endMs };
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

  await playPeriodBeep();
  await startCurrentInterval();
}

async function skipToNextPeriod() {
  if (!state.workout) {
    setStatus("No workout running.");
    return;
  }

  const wasPaused = !!state.workout.paused;
  clearInterval(state.intervalTicker);
  clearTimeout(state.clipTimer);
  clearTimeout(state.workout?.boundaryTimer);

  try {
    await fadeOut();
  } catch (err) {
    console.warn(err);
  }

  state.workout.index += 1;
  if (state.workout.index >= state.template.length) {
    stopWorkout(false);
    setStatus("Workout complete.");
    return;
  }

  await playPeriodBeep();

  if (wasPaused) {
    const interval = state.template[state.workout.index];
    const durationMs = Math.round(interval.minutes * 60_000);
    state.workout.paused = true;
    state.workout.remainingMs = durationMs;
    state.workout.intervalQueue = resolveIntervalTracks(state.workout.index);
    state.workout.intervalQueueCursor = 0;
    renderCurrentMode(interval.mode);
    renderCountdown(durationMs);
    renderTotalRemaining(computeTotalRemainingMs());
    el.trackLabel.textContent = "No track loaded";
    setStatus("Skipped to next period.");
    return;
  }

  state.workout.paused = false;
  await startCurrentInterval();
  setStatus("Skipped to next period.");
}

async function pauseWorkout() {
  if (!state.workout || state.workout.paused) return;

  state.workout.paused = true;
  clearInterval(state.intervalTicker);
  clearTimeout(state.workout.boundaryTimer);
  clearTimeout(state.clipTimer);
  state.workout.remainingMs = Math.max(0, state.workout.intervalEndsAt - Date.now());
  renderCountdown(state.workout.remainingMs);
  renderTotalRemaining(computeTotalRemainingMs());

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

  renderCountdown(state.workout.remainingMs);
  renderTotalRemaining(computeTotalRemainingMs());
  startIntervalTicker();

  const mode = state.template[state.workout.index].mode;
  await playModeForDuration(mode, state.workout.remainingMs);
  setStatus("Workout resumed.");
}

function stopWorkout(showMessage = true) {
  clearInterval(state.intervalTicker);
  clearTimeout(state.clipTimer);
  if (state.workout?.boundaryTimer) clearTimeout(state.workout.boundaryTimer);

  state.workout = null;
  renderCurrentMode("idle");
  renderCountdown(0);
  renderTotalRemaining(0);
  el.trackLabel.textContent = "No track loaded";

  if (state.player) state.player.pause().catch(() => {});
  if (showMessage) setStatus("Workout stopped.");
}

function startIntervalTicker() {
  clearInterval(state.intervalTicker);
  state.intervalTicker = setInterval(() => {
    if (!state.workout || state.workout.paused) return;
    const remaining = Math.max(0, state.workout.intervalEndsAt - Date.now());
    state.workout.remainingMs = remaining;
    renderCountdown(remaining);
    renderTotalRemaining(computeTotalRemainingMs());
  }, 200);
}

async function playTrack(trackUri, positionMs = 0) {
  await spotifyFetch(
    `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(state.deviceId)}`,
    {
      method: "PUT",
      body: JSON.stringify({ uris: [trackUri], position_ms: Math.max(0, Math.round(positionMs)) })
    },
    true
  );

  try {
    await state.player.resume();
  } catch (err) {
    console.warn("Local resume fallback failed:", err);
  }
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
  await spotifyFetch(
    "https://api.spotify.com/v1/me/player",
    {
      method: "PUT",
      body: JSON.stringify({ device_ids: [state.deviceId], play })
    },
    true
  );
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
  el.countdown.textContent = formatClock(ms);
}

function renderTotalRemaining(ms) {
  el.totalRemaining.textContent = `Total left: ${formatClock(ms)}`;
}

function computeTotalRemainingMs() {
  if (!state.workout) return 0;
  const currentMs = state.workout.paused
    ? Math.max(0, state.workout.remainingMs || 0)
    : Math.max(0, state.workout.intervalEndsAt - Date.now());
  let futureMs = 0;
  for (let i = state.workout.index + 1; i < state.template.length; i++) {
    futureMs += Math.round(state.template[i].minutes * 60_000);
  }
  return currentMs + futureMs;
}

function getTrim(trackId, durationMs) {
  const durationSec = Math.max(1, Math.round(durationMs / 1000));
  const saved = state.trims[trackId] || {};
  const startSec = clamp(Math.round(saved.startSec ?? 0), 0, durationSec - 1);
  const endSec = clamp(Math.round(saved.endSec ?? durationSec), startSec + 1, durationSec);
  return { startSec, endSec };
}

function hasCustomTrim(trackId, durationMs) {
  const trim = getTrim(trackId, durationMs);
  const durationSec = Math.max(1, Math.round(durationMs / 1000));
  return trim.startSec > 0 || trim.endSec < durationSec;
}

function ensureBeepAudio() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return Promise.resolve(null);
  if (!state.beepContext) state.beepContext = new AudioCtx();
  if (state.beepContext.state === "suspended") return state.beepContext.resume().then(() => state.beepContext);
  return Promise.resolve(state.beepContext);
}

async function playPeriodBeep() {
  const ctx = await ensureBeepAudio();
  if (!ctx) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const now = ctx.currentTime;

  osc.type = "sine";
  osc.frequency.setValueAtTime(880, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.04, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.13);
  await sleep(140);
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

function normalizeTemplate(template) {
  return (template || DEFAULT_TEMPLATE).map((interval) => ({
    mode: interval.mode === "chill" ? "chill" : "intense",
    minutes: Math.max(0.25, Number(interval.minutes) || 1)
  }));
}

function normalizeAssignments(assignments, length) {
  const source = Array.isArray(assignments) ? assignments : [];
  const output = [];
  for (let i = 0; i < length; i++) {
    const current = Array.isArray(source[i]) ? source[i] : [];
    output.push(
      current
        .map((item) => (typeof item === "string" ? { trackId: item } : { trackId: item.trackId }))
        .filter((item) => !!item.trackId)
    );
  }
  return output;
}

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

function slugify(value) {
  return String(value || "workout")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workout";
}

function shuffleArray(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function resetShuffleBags() {
  state.shuffleBags.intense = [];
  state.shuffleBags.chill = [];
}

function parseDragPayload(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && parsed.trackId && parsed.mode ? parsed : null;
  } catch {
    return null;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatClock(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const min = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const sec = String(totalSec % 60).padStart(2, "0");
  return `${min}:${sec}`;
}

function formatSeconds(sec) {
  const safe = Math.max(0, Math.round(sec));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
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

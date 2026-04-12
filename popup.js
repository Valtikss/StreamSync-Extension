// ─── Thème dark/light ─────────────────────────────────────────────────────────

chrome.storage.local.get(['theme'], ({ theme }) => {
  const isLight = theme === 'light';
  document.body.classList.toggle('light', isLight);
  document.getElementById('toggle-theme').checked = isLight;
});

document.getElementById('toggle-theme').addEventListener('change', e => {
  const theme = e.target.checked ? 'light' : 'dark';
  chrome.storage.local.set({ theme });
  document.body.classList.toggle('light', e.target.checked);
});

// ─── Tabs ─────────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
  });
});

// ─── Chargement initial ────────────────────────────────────────────────────────

chrome.storage.local.get(
  ['spotifyClientId', 'spotify_access_token', 'selectedDeviceId', 'autoPlay', 'playerChoice', 'audioOffset'],
  result => {
    document.getElementById('clientId').value = result.spotifyClientId || '';
    // autoPlay activé par défaut si jamais défini
    document.getElementById('toggle-autoplay').checked = result.autoPlay !== false;
    // Décalage audio : 3000ms par défaut
    const offset = typeof result.audioOffset === 'number' ? result.audioOffset : 3000;
    document.getElementById('offset-slider').value = offset;
    document.getElementById('offset-value').textContent = formatOffset(offset);
    const connected = !!result.spotify_access_token;
    setSpotifyStatus(connected);
    // Applique le choix de lecteur (Spotify par défaut)
    applyPlayerChoice(result.playerChoice || 'spotify', connected);
  }
);

// ─── Sélecteur de lecteur (Spotify / YouTube) ─────────────────────────────────

document.querySelectorAll('.player-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    const choice = btn.dataset.player;
    chrome.storage.local.set({ playerChoice: choice }, () => {
      chrome.storage.local.get(['spotify_access_token'], ({ spotify_access_token }) => {
        applyPlayerChoice(choice, !!spotify_access_token);
      });
    });
  });
});

// Met à jour l'UI en fonction du lecteur sélectionné.
// `spotifyConnected` sert à savoir si on doit afficher la liste des devices.
function applyPlayerChoice(choice, spotifyConnected) {
  // Bascule visuelle du segmented control
  document.querySelectorAll('.player-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.player === choice);
  });

  const isYoutube = choice === 'youtube';

  // YouTube info + devices uniquement selon le lecteur choisi
  document.getElementById('yt-info-section').style.display = isYoutube ? 'block' : 'none';

  if (isYoutube) {
    showDevicesSection(false);
  } else if (spotifyConnected) {
    loadDevices();
  }
}

// ─── Toggle lecture auto ───────────────────────────────────────────────────────

document.getElementById('toggle-autoplay').addEventListener('change', e => {
  chrome.storage.local.set({ autoPlay: e.target.checked });
});

// ─── Décalage audio (offset stream) ──────────────────────────────────────────

document.getElementById('offset-slider').addEventListener('input', e => {
  const ms = parseInt(e.target.value, 10);
  document.getElementById('offset-value').textContent = formatOffset(ms);
  chrome.storage.local.set({ audioOffset: ms });
});

function formatOffset(ms) {
  const s = ms / 1000;
  const sign = s >= 0 ? '+' : '';
  return `${sign}${s.toFixed(1)}s`;
}

const redirectUri = chrome.identity.getRedirectURL();
const uriEl = document.getElementById('redirect-uri');
uriEl.textContent = redirectUri;
uriEl.addEventListener('click', () => {
  navigator.clipboard.writeText(redirectUri).then(() => {
    uriEl.textContent = '✓ Copié !';
    setTimeout(() => { uriEl.textContent = redirectUri; }, 1500);
  });
});

// ─── Now Playing ──────────────────────────────────────────────────────────────

let nowPlayingInterval = null;

function startNowPlayingPolling() {
  renderNowPlaying();
  nowPlayingInterval = setInterval(renderNowPlaying, 1000);
}

const NP_CIRC = 2 * Math.PI * 46; // ~289.03 — circumference of progress ring

function buildNowPlayingHTML() {
  return `
    <div class="np-status">
      <div class="np-eq" id="np-eq"><span></span><span></span><span></span></div>
      <span class="np-status-text" id="np-status-text">À l'écoute</span>
    </div>
    <div class="np-vinyl-wrap">
      <svg class="np-ring" viewBox="0 0 100 100">
        <circle class="np-ring-bg" cx="50" cy="50" r="46" fill="none" stroke-width="1.5" />
        <circle class="np-ring-fill" id="np-ring-fill" cx="50" cy="50" r="46" fill="none"
          stroke-width="1.5" stroke-dasharray="${NP_CIRC}" stroke-dashoffset="${NP_CIRC}" stroke-linecap="round" />
      </svg>
      <div class="np-disc paused" id="np-disc">
        <img class="np-disc-art" id="np-disc-art" style="display:none" />
        <div class="np-disc-inner" id="np-disc-grooves"></div>
        <div class="np-disc-hole"></div>
        <div class="np-disc-pin"></div>
      </div>
    </div>
    <div class="np-track-info">
      <div class="np-name" id="np-name"></div>
      <div class="np-artist" id="np-artist"></div>
    </div>
    <div class="np-times"><span id="np-time"></span></div>
    <div class="np-next" id="np-next" style="display:none">
      <span class="np-next-label">Suivant</span>
      <span class="np-next-name" id="np-next-name"></span>
    </div>
  `;
}

function updateNowPlaying(track) {
  const pct = track.pct ?? 0;
  const playing = track.isPlaying;

  // EQ + status
  document.getElementById('np-eq').className = `np-eq${playing ? '' : ' paused'}`;
  document.getElementById('np-status-text').textContent = playing ? 'À l\'écoute' : 'En pause';

  // Disc
  document.getElementById('np-disc').classList.toggle('paused', !playing);

  // Progress ring
  const ring = document.getElementById('np-ring-fill');
  ring.style.strokeDashoffset = NP_CIRC - (pct / 100) * NP_CIRC;
  ring.style.filter = playing ? 'drop-shadow(0 0 3px rgba(255,107,74,0.6))' : 'none';

  // Album art
  const artEl = document.getElementById('np-disc-art');
  const groovesEl = document.getElementById('np-disc-grooves');
  if (track.albumArt) {
    if (artEl.src !== track.albumArt) artEl.src = track.albumArt;
    artEl.style.display = 'block';
    groovesEl.style.display = 'none';
  } else {
    artEl.style.display = 'none';
    groovesEl.style.display = '';
  }

  // Track info
  document.getElementById('np-name').textContent = track.track_name || '';
  document.getElementById('np-artist').textContent = track.artist_name || '';
  document.getElementById('np-time').textContent = formatMs(track.offset_ms);

  // Next
  const nextEl = document.getElementById('np-next');
  if (track.next) {
    nextEl.style.display = '';
    document.getElementById('np-next-name').textContent =
      `${track.next.track_name} · ${track.next.artist_name}`;
  } else {
    nextEl.style.display = 'none';
  }
}

function renderNowPlaying() {
  chrome.storage.local.get(['ss_now_playing'], ({ ss_now_playing: track }) => {
    const container = document.getElementById('now-playing');

    if (!track) {
      if (!container.querySelector('.np-idle')) {
        container.innerHTML = '<div class="np-idle">Ouvre une VOD Twitch pour commencer</div>';
      }
      return;
    }

    // Build vinyl structure once, then only update data
    if (!container.querySelector('.np-vinyl-wrap')) {
      container.innerHTML = buildNowPlayingHTML();
    }

    updateNowPlaying(track);
  });
}

window.addEventListener('unload', () => {
  if (nowPlayingInterval) clearInterval(nowPlayingInterval);
});

startNowPlayingPolling();

// ─── Connexion Spotify ─────────────────────────────────────────────────────────

document.getElementById('btn-connect').addEventListener('click', async () => {
  const clientId = document.getElementById('clientId').value.trim();

  if (!clientId) { showError('Entre ton Spotify Client ID d\'abord'); return; }

  await new Promise(resolve => chrome.storage.local.set({ spotifyClientId: clientId }, resolve));

  const btn = document.getElementById('btn-connect');
  btn.textContent = 'Connexion…';
  btn.disabled = true;

  chrome.runtime.sendMessage({ type: 'SPOTIFY_CONNECT' }, res => {
    btn.disabled = false;
    if (res?.ok) {
      setSpotifyStatus(true);
      hideError();
      loadDevices();
    } else {
      btn.textContent = 'Connecter Spotify';
      showError(res?.error || 'Connexion échouée');
    }
  });
});

// ─── Déconnexion ──────────────────────────────────────────────────────────────

document.getElementById('btn-disconnect').addEventListener('click', () => {
  chrome.storage.local.remove(
    ['spotify_access_token', 'spotify_refresh_token', 'spotify_token_expires_at', 'pkce_verifier', 'selectedDeviceId'],
    () => {
      setSpotifyStatus(false);
      showDevicesSection(false);
    }
  );
});

// ─── Sauvegarde config ────────────────────────────────────────────────────────

document.getElementById('btn-save').addEventListener('click', () => {
  const clientId = document.getElementById('clientId').value.trim();
  chrome.storage.local.set({ spotifyClientId: clientId }, () => {
    const msg = document.getElementById('saved-msg');
    msg.style.display = 'block';
    setTimeout(() => { msg.style.display = 'none'; }, 2000);
  });
});

// ─── Appareils Spotify ────────────────────────────────────────────────────────

document.getElementById('btn-refresh-devices').addEventListener('click', loadDevices);

function loadDevices() {
  const list = document.getElementById('device-list');
  list.innerHTML = '<div class="devices-empty">Chargement…</div>';
  showDevicesSection(true);

  chrome.runtime.sendMessage({ type: 'SPOTIFY_GET_DEVICES' }, res => {
    if (!res?.ok || !res.devices?.length) {
      list.innerHTML = '<div class="devices-empty">Ouvre Spotify sur un appareil</div>';
      return;
    }
    chrome.storage.local.get(['selectedDeviceId'], ({ selectedDeviceId }) => {
      renderDevices(res.devices, selectedDeviceId);
    });
  });
}

function renderDevices(devices, selectedDeviceId) {
  const list = document.getElementById('device-list');
  list.innerHTML = '';
  devices.forEach(device => {
    const isSelected = device.id === selectedDeviceId;
    const item = document.createElement('div');
    item.className = `device-item${isSelected ? ' selected' : ''}`;
    item.innerHTML = `
      <span class="device-icon">${deviceIcon(device.type)}</span>
      <span class="device-name" title="${esc(device.name)}">${esc(device.name)}</span>
      <span class="device-check">✓</span>
    `;
    item.addEventListener('click', () => {
      chrome.storage.local.set({ selectedDeviceId: device.id }, () => {
        document.querySelectorAll('.device-item').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
      });
    });
    list.appendChild(item);
  });
}

function deviceIcon(type) {
  switch ((type || '').toLowerCase()) {
    case 'computer':     return '💻';
    case 'smartphone':   return '📱';
    case 'speaker':      return '🔊';
    case 'tv':           return '📺';
    case 'gameconsole':  return '🎮';
    default:             return '🎵';
  }
}

function showDevicesSection(visible) {
  document.getElementById('devices-section').style.display = visible ? 'block' : 'none';
  document.getElementById('devices-sep').style.display = visible ? 'block' : 'none';
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function setSpotifyStatus(connected) {
  const badge = document.getElementById('spotify-badge');
  const btnConnect = document.getElementById('btn-connect');
  const btnDisconnect = document.getElementById('btn-disconnect');

  // Masque la section de config Spotify une fois connecté
  document.getElementById('spotify-config-section').style.display = connected ? 'none' : 'block';
  document.getElementById('spotify-config-sep').style.display = connected ? 'none' : 'block';

  if (connected) {
    badge.textContent = 'Connecté';
    badge.className = 'badge-connected';
    btnConnect.style.display = 'none';
    btnDisconnect.style.display = 'block';
  } else {
    badge.textContent = 'Non connecté';
    badge.className = 'badge-disconnected';
    btnConnect.style.display = 'flex';
    btnConnect.innerHTML = `
      <img src="spotify-logo.svg" width="12" height="12" alt="" />
      Connecter Spotify`;
    btnDisconnect.style.display = 'none';
  }
}

function showError(msg) {
  const el = document.getElementById('connect-error');
  el.textContent = msg;
  el.style.display = 'block';
}

function hideError() {
  document.getElementById('connect-error').style.display = 'none';
}

function formatMs(ms) {
  if (!ms || ms < 0) return '0:00';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

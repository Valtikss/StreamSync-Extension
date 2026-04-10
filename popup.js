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

chrome.storage.local.get(['spotifyClientId', 'spotify_access_token', 'selectedDeviceId', 'autoPlay'], result => {
  document.getElementById('clientId').value = result.spotifyClientId || '';
  // autoPlay activé par défaut si jamais défini
  document.getElementById('toggle-autoplay').checked = result.autoPlay !== false;
  const connected = !!result.spotify_access_token;
  setSpotifyStatus(connected);
  if (connected) loadDevices();
});

// ─── Toggle lecture auto ───────────────────────────────────────────────────────

document.getElementById('toggle-autoplay').addEventListener('change', e => {
  chrome.storage.local.set({ autoPlay: e.target.checked });
});

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

function renderNowPlaying() {
  chrome.storage.local.get(['ss_now_playing'], ({ ss_now_playing: track }) => {
    const container = document.getElementById('now-playing');
    const idle = document.getElementById('np-idle');

    if (!track) {
      container.innerHTML = '<div class="np-idle" id="np-idle">Ouvre une VOD Twitch pour commencer</div>';
      return;
    }

    const pct = track.pct ?? 0;
    const eqClass = track.isPlaying ? '' : 'paused';
    const nextHtml = track.next
      ? `<div class="np-next">
           <span class="np-next-label">Suivant</span>
           <span class="np-next-name">${esc(track.next.track_name)} · ${esc(track.next.artist_name)}</span>
         </div>`
      : '';

    container.innerHTML = `
      <div class="np-track">
        <div class="np-eq ${eqClass}">
          <span></span><span></span><span></span>
        </div>
        <div class="np-info">
          <div class="np-name" title="${esc(track.track_name)}">${esc(track.track_name)}</div>
          <div class="np-artist">${esc(track.artist_name)}</div>
        </div>
        <button class="np-open" id="np-btn-open">
          <img src="spotify-logo.svg" width="9" height="9" alt="" />
          Ouvrir
        </button>
      </div>
      <div class="np-progress">
        <div class="np-bar"><div class="np-fill" style="width:${pct}%"></div></div>
        <div class="np-times"><span>${formatMs(track.offset_ms)}</span><span></span></div>
      </div>
      ${nextHtml}
    `;

    document.getElementById('np-btn-open')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'SPOTIFY_OPEN_TRACK', trackUri: track.track_uri });
    });
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

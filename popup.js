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
  ['spotifyClientId', 'spotify_access_token', 'selectedDeviceId', 'autoPlay', 'playerChoice', 'audioOffset', 'notificationsEnabled'],
  result => {
    document.getElementById('clientId').value = result.spotifyClientId || '';
    // autoPlay activé par défaut si jamais défini
    document.getElementById('toggle-autoplay').checked = result.autoPlay !== false;
    // Notifications désactivées par défaut (opt-in)
    document.getElementById('toggle-notifications').checked = result.notificationsEnabled === true;
    // Décalage audio : 3000ms par défaut
    const offset = typeof result.audioOffset === 'number' ? result.audioOffset : 3000;
    document.getElementById('offset-slider').value = offset;
    document.getElementById('offset-value').textContent = formatOffset(offset);
    const connected = !!result.spotify_access_token;
    setSpotifyStatus(connected);
    // Force YouTube si le choix sauvegardé est Spotify mais qu'on n'est pas connecté
    let initialChoice = result.playerChoice || 'spotify';
    if (initialChoice === 'spotify' && !connected) initialChoice = 'youtube';
    applyPlayerChoice(initialChoice, connected);
  }
);

// ─── Sélecteur de lecteur (Spotify / YouTube) ─────────────────────────────────

document.querySelectorAll('.player-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    const choice = btn.dataset.player;
    chrome.storage.local.set({ playerChoice: choice }, () => {
      chrome.storage.local.get(['spotify_access_token'], ({ spotify_access_token }) => {
        applyPlayerChoice(choice, !!spotify_access_token);
      });
    });
  });
});

// Désactive visuellement le bouton Spotify quand pas connecté
function updatePlayerSwitchAvailability(spotifyConnected) {
  const spotifyBtn = document.querySelector('.player-opt[data-player="spotify"]');
  if (!spotifyBtn) return;
  spotifyBtn.disabled = !spotifyConnected;
  spotifyBtn.title = spotifyConnected ? '' : 'Connecte Spotify dans Paramètres pour l\'utiliser';
}

// Met à jour l'UI en fonction du lecteur sélectionné.
// `spotifyConnected` sert à savoir si on doit afficher la liste des devices.
function applyPlayerChoice(choice, spotifyConnected) {
  // Bascule visuelle du segmented control
  document.querySelectorAll('.player-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.player === choice);
  });
  updatePlayerSwitchAvailability(spotifyConnected);

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

document.getElementById('toggle-notifications').addEventListener('change', e => {
  chrome.storage.local.set({ notificationsEnabled: e.target.checked });
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
  const tick = () => {
    renderNowPlaying();
    renderTracklist();
    updateSyncDrift();
  };
  tick();
  nowPlayingInterval = setInterval(tick, 1000);
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
    <div class="np-actions">
      <button class="np-action-btn" id="np-prev" title="Morceau précédent">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
      </button>
      <button class="np-action-btn np-action-spotify" id="np-spotify" title="Ouvrir dans Spotify">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.42 1.56-.299.421-1.02.599-1.559.3z"/></svg>
      </button>
      <button class="np-action-btn" id="np-next-btn" title="Morceau suivant">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
      </button>
    </div>
    <div class="np-drift" id="np-drift" style="display:none"></div>
    <div class="np-next" id="np-next" style="display:none">
      <span class="np-next-label">Suivant</span>
      <span class="np-next-name" id="np-next-name"></span>
    </div>
  `;
}

// Helpers communication content script (seek VOD, drift, etc.)
function sendToVodTab(msg, cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs?.[0];
    if (!tab?.url || !VOD_URL_RE.test(tab.url)) {
      // Fallback : cherche un onglet VOD ailleurs
      chrome.tabs.query({ url: 'https://www.twitch.tv/videos/*' }, otherTabs => {
        const fallback = otherTabs?.[0];
        if (!fallback) { cb?.({ ok: false, error: 'no_vod_tab' }); return; }
        chrome.tabs.sendMessage(fallback.id, msg, res => cb?.(res));
      });
      return;
    }
    chrome.tabs.sendMessage(tab.id, msg, res => cb?.(res));
  });
}

// Wire les actions du now-playing une seule fois, après build
function wireNowPlayingActions() {
  const prev = document.getElementById('np-prev');
  const next = document.getElementById('np-next-btn');
  const spotifyBtn = document.getElementById('np-spotify');
  if (prev && !prev.dataset.wired) {
    prev.dataset.wired = '1';
    prev.addEventListener('click', () => sendToVodTab({ type: 'SEEK_RELATIVE', direction: 'prev' }));
  }
  if (next && !next.dataset.wired) {
    next.dataset.wired = '1';
    next.addEventListener('click', () => sendToVodTab({ type: 'SEEK_RELATIVE', direction: 'next' }));
  }
  if (spotifyBtn && !spotifyBtn.dataset.wired) {
    spotifyBtn.dataset.wired = '1';
    spotifyBtn.addEventListener('click', () => {
      const uri = spotifyBtn.dataset.trackUri;
      if (!uri) return;
      const id = uri.replace('spotify:track:', '');
      chrome.tabs.create({ url: `https://open.spotify.com/track/${id}` });
    });
  }
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

  // Bouton Spotify : stocke l'URI sur le bouton
  const spotifyBtn = document.getElementById('np-spotify');
  if (spotifyBtn) {
    spotifyBtn.dataset.trackUri = track.track_uri || '';
    spotifyBtn.disabled = !track.track_uri;
  }
}

const VOD_URL_RE = /^https:\/\/www\.twitch\.tv\/videos\/\d+/;

// Vérifie si l'onglet actif est sur une VOD Twitch
function isOnVodTab(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const url = tabs?.[0]?.url || '';
    cb(VOD_URL_RE.test(url));
  });
}

// Cherche un onglet VOD Twitch ouvert ailleurs (toutes fenêtres confondues).
// Retourne le premier trouvé ou null.
function findOtherVodTab(cb) {
  chrome.tabs.query({ url: 'https://www.twitch.tv/videos/*' }, tabs => {
    cb(tabs?.[0] || null);
  });
}

// Bannière au-dessus du now-playing pour signaler l'onglet actif
function renderActiveTabBanner(container, tab) {
  // Streamer = segment de path après /videos/xxx — pas dispo direct, on prend
  // le titre de l'onglet (ex: "Twitch") ou un fallback générique
  const label = tab.title?.replace(/ - Twitch$/, '') || 'un onglet VOD';
  let banner = container.querySelector('.np-active-tab');
  const html = `
    <div class="np-active-tab" data-tab-id="${tab.id}">
      <span class="np-active-dot"></span>
      <span class="np-active-text">Actif sur <strong>${escapeHtml(label)}</strong></span>
    </div>
  `;
  if (!banner) {
    container.insertAdjacentHTML('afterbegin', html);
    banner = container.querySelector('.np-active-tab');
  } else if (banner.dataset.tabId !== String(tab.id)) {
    banner.outerHTML = html;
    banner = container.querySelector('.np-active-tab');
  }
  banner.onclick = () => {
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });
    window.close();
  };
}

function removeActiveTabBanner(container) {
  const banner = container.querySelector('.np-active-tab');
  if (banner) banner.remove();
}

function renderNowPlaying() {
  isOnVodTab(onVod => {
    chrome.storage.local.get(['ss_now_playing', 'ss_vod_error'], ({ ss_now_playing: track, ss_vod_error: vodError }) => {
      const container = document.getElementById('now-playing');

      // Onglet courant n'est pas une VOD : on cherche s'il y en a une ailleurs.
      if (!onVod) {
        findOtherVodTab(otherTab => {
          if (otherTab) {
            // Une VOD tourne ailleurs : on garde l'affichage track/error et
            // on ajoute une bannière cliquable pour focus l'onglet
            renderTrackOrError(container, track, vodError);
            renderActiveTabBanner(container, otherTab);
          } else {
            // Aucune VOD ouverte nulle part : on nettoie le storage stale
            if (track || vodError) chrome.storage.local.set({ ss_now_playing: null, ss_vod_error: null, ss_timeline: null });
            removeActiveTabBanner(container);
            if (!container.querySelector('.np-idle') || container.querySelector('.np-error')) {
              container.innerHTML = '<div class="np-idle">Ouvre une VOD Twitch pour commencer</div>';
            }
          }
        });
        return;
      }

      removeActiveTabBanner(container);
      renderTrackOrError(container, track, vodError);
    });
  });
}

function renderTrackOrError(container, track, vodError) {
  if (!track) {
    if (vodError && vodError.code) {
      const msg = vodErrorMessage(vodError);
      const html = `<div class="np-idle np-error">${escapeHtml(msg)}</div>`;
      if (!container.querySelector('.np-error') || container.querySelector('.np-error').textContent !== msg) {
        const banner = container.querySelector('.np-active-tab');
        container.innerHTML = (banner ? banner.outerHTML : '') + html;
      }
      return;
    }
    if (!container.querySelector('.np-idle') || container.querySelector('.np-error')) {
      const banner = container.querySelector('.np-active-tab');
      container.innerHTML = (banner ? banner.outerHTML : '') + '<div class="np-idle">Ouvre une VOD Twitch pour commencer</div>';
    }
    return;
  }

  if (!container.querySelector('.np-vinyl-wrap')) {
    const banner = container.querySelector('.np-active-tab');
    container.innerHTML = (banner ? banner.outerHTML : '') + buildNowPlayingHTML();
    wireNowPlayingActions();
  }

  updateNowPlaying(track);
}

// ─── Tracklist ───────────────────────────────────────────────────────────────
function formatStreamPos(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

let lastTracklistVodId = null;
let lastCurrentUri = null;

function renderTracklist() {
  chrome.storage.local.get(['ss_timeline', 'ss_now_playing'], ({ ss_timeline, ss_now_playing }) => {
    const section = document.getElementById('tracklist-section');
    const sep = document.getElementById('tracklist-sep');
    const list = document.getElementById('tracklist');
    const count = document.getElementById('tracklist-count');

    if (!ss_timeline?.tracks?.length) {
      section.style.display = 'none';
      sep.style.display = 'none';
      lastTracklistVodId = null;
      return;
    }

    section.style.display = '';
    sep.style.display = '';
    count.textContent = `${ss_timeline.tracks.length} morceaux`;

    const currentUri = ss_now_playing?.track_uri || null;

    // Rebuild la liste seulement si VOD a changé. Sinon on toggle juste la classe .current.
    if (ss_timeline.vodId !== lastTracklistVodId) {
      lastTracklistVodId = ss_timeline.vodId;
      list.innerHTML = ss_timeline.tracks.map(t => `
        <div class="tracklist-item" data-uri="${escapeHtml(t.track_uri)}" data-pos="${t.stream_position_ms}">
          <span class="tracklist-time">${formatStreamPos(t.stream_position_ms)}</span>
          <div class="tracklist-info">
            <div class="tracklist-name">${escapeHtml(t.track_name || '')}</div>
            <div class="tracklist-artist">${escapeHtml(t.artist_name || '')}</div>
          </div>
        </div>
      `).join('');
      list.querySelectorAll('.tracklist-item').forEach(item => {
        item.addEventListener('click', () => {
          const pos = Number(item.dataset.pos);
          sendToVodTab({ type: 'SEEK_TO_STREAM_POSITION', streamPositionMs: pos });
        });
      });
      lastCurrentUri = null;
    }

    if (currentUri !== lastCurrentUri) {
      lastCurrentUri = currentUri;
      let currentEl = null;
      list.querySelectorAll('.tracklist-item').forEach(item => {
        const isCurrent = item.dataset.uri === currentUri;
        item.classList.toggle('current', isCurrent);
        if (isCurrent) currentEl = item;
      });
      // Scroll en vue (sans animation pour pas distraire)
      if (currentEl) currentEl.scrollIntoView({ block: 'nearest' });
    }
  });
}

// ─── Sync drift (Spotify uniquement pour l'instant) ──────────────────────────
let lastDriftCheck = 0;
function updateSyncDrift() {
  const driftEl = document.getElementById('np-drift');
  if (!driftEl) return;
  // Throttle : check toutes les 4s max (évite de spammer l'API Spotify)
  const now = Date.now();
  if (now - lastDriftCheck < 4000) return;
  lastDriftCheck = now;

  chrome.storage.local.get(['ss_now_playing', 'playerChoice', 'spotify_access_token'], async ({ ss_now_playing, playerChoice, spotify_access_token }) => {
    if (!ss_now_playing?.isPlaying || playerChoice !== 'spotify' || !spotify_access_token) {
      driftEl.style.display = 'none';
      return;
    }
    chrome.runtime.sendMessage({ type: 'SPOTIFY_PLAYBACK_STATE' }, res => {
      if (!res?.ok || !res.state?.is_playing) {
        driftEl.style.display = 'none';
        return;
      }
      const expectedMs = ss_now_playing.offset_ms || 0;
      const actualMs = res.state.progress_ms || 0;
      // Si Spotify joue un autre morceau, on l'indique
      if (res.state.item?.uri && res.state.item.uri !== ss_now_playing.track_uri) {
        driftEl.style.display = '';
        driftEl.className = 'np-drift bad';
        driftEl.textContent = '⚠ Spotify joue un autre morceau';
        return;
      }
      const driftMs = actualMs - expectedMs;
      const absDrift = Math.abs(driftMs);
      driftEl.style.display = '';
      if (absDrift < 800) {
        driftEl.className = 'np-drift';
        driftEl.textContent = `Sync ✓ ${driftMs >= 0 ? '+' : ''}${(driftMs / 1000).toFixed(1)}s`;
      } else if (absDrift < 2500) {
        driftEl.className = 'np-drift warn';
        driftEl.textContent = `Drift ${driftMs >= 0 ? '+' : ''}${(driftMs / 1000).toFixed(1)}s`;
      } else {
        driftEl.className = 'np-drift bad';
        driftEl.textContent = `Drift élevé ${driftMs >= 0 ? '+' : ''}${(driftMs / 1000).toFixed(1)}s`;
      }
    });
  });
}

function vodErrorMessage(err) {
  const username = err.data?.streamer_username;
  switch (err.code) {
    case 'free_plan_limit': {
      const limit = err.data?.limit || 3;
      return username
        ? `VOD non synchronisable. @${username} est sur le plan gratuit (limité aux ${limit} dernières sessions).`
        : `VOD non synchronisable (plan gratuit du streamer, limité aux ${limit} dernières sessions).`;
    }
    case 'sub_only':
      return username
        ? `VOD réservée aux abonnés de @${username}.`
        : 'VOD réservée aux abonnés du streamer.';
    case 'vod_not_found':
      return 'VOD introuvable côté Twitch.';
    default:
      return err.data?.message || 'Cette VOD n\'est pas synchronisable par StreamSync.';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

  updatePlayerSwitchAvailability(connected);
  // Si on perd la connexion alors que Spotify était sélectionné, bascule sur YouTube
  if (!connected) {
    const spotifyBtn = document.querySelector('.player-opt[data-player="spotify"]');
    if (spotifyBtn?.classList.contains('active')) {
      chrome.storage.local.set({ playerChoice: 'youtube' });
      applyPlayerChoice('youtube', false);
    }
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

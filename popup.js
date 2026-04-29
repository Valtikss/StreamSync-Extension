// ─── Version (lue depuis manifest.json) ───────────────────────────────────────

document.getElementById('ext-version').textContent = `v${chrome.runtime.getManifest().version}`;

// ─── DOM helpers (évite innerHTML pour passer la lint AMO no-unsanitized) ─────
// DOMParser parse en document inerte (pas d'exécution de scripts ni de handlers
// inline) avant adoption dans le live document. Toutes les valeurs interpolées
// dans les templates passent déjà par escapeHtml/esc côté appelants.
function htmlToFragment(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const frag = document.createDocumentFragment();
  while (doc.body.firstChild) frag.appendChild(doc.body.firstChild);
  return frag;
}
function setHTML(el, html) { el.replaceChildren(htmlToFragment(html)); }
function prependHTML(el, html) { el.insertBefore(htmlToFragment(html), el.firstChild); }
function replaceOuterHTML(el, html) { el.replaceWith(htmlToFragment(html)); }

// ─── i18n : charge la langue et applique les traductions statiques ────────────

const i18n = self.SS_I18N;
const t = (...args) => i18n.t(...args);

// Applique les traductions dès que possible, puis post-paint aussi (au cas où
// un élément serait ajouté après). On n'attend pas la promesse pour ne pas
// bloquer le reste du script, mais on ré-applique quand elle résout.
i18n.loadLang().then(lang => {
  i18n.applyI18n();
  applyYoutubeInfo();
  applyLangSelect(lang);
});

// L'info "Clique sur Activer le son..." contient un strong → on la construit
// en JS pour que le placeholder varie avec la langue.
function applyYoutubeInfo() {
  const el = document.getElementById('yt-info2-placeholder');
  if (!el) return;
  setHTML(el, t('yt.info2', { btn: `<strong>${t('yt.info.activate')}</strong>` }));
}

function applyLangSelect(lang) {
  const sel = document.getElementById('lang-select');
  if (!sel) return;
  sel.value = lang;
  sel.addEventListener('change', e => {
    const newLang = e.target.value;
    chrome.storage.local.set({ lang: newLang }, () => {
      // storage.onChanged met à jour currentLang côté i18n, on re-render tout
      i18n.applyI18n();
      applyYoutubeInfo();
      // Re-render des sections dynamiques (elles reconstruisent leur innerHTML
      // avec t() donc les strings sont retraduites)
      renderNowPlaying();
      renderTracklist();
      chrome.storage.local.get(['spotify_access_token'], ({ spotify_access_token }) => {
        setSpotifyStatus(!!spotify_access_token);
      });
      if (document.getElementById('devices-section').style.display !== 'none') {
        loadDevices();
      }
    });
  });
}

// ─── Thème dark/light ─────────────────────────────────────────────────────────

chrome.storage.local.get(['theme'], ({ theme }) => {
  // Light par défaut : si l'user n'a jamais touché au toggle, on part en light.
  // Seul theme === 'dark' explicite active le dark mode.
  const isLight = theme !== 'dark';
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
  ['spotifyClientId', 'spotify_access_token', 'selectedDeviceId', 'autoPlay', 'playerChoice', 'audioOffset', 'notificationsEnabled', 'tracklistEnabled'],
  result => {
    document.getElementById('clientId').value = result.spotifyClientId || '';
    // autoPlay activé par défaut si jamais défini
    document.getElementById('toggle-autoplay').checked = result.autoPlay !== false;
    // Notifications désactivées par défaut (opt-in)
    document.getElementById('toggle-notifications').checked = result.notificationsEnabled === true;
    // Tracklist désactivée par défaut (opt-in, section jugée encombrante)
    document.getElementById('toggle-tracklist').checked = result.tracklistEnabled === true;
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

// ─── Bouton "Ré-afficher le lecteur" (fallback si le container YT a disparu) ──
// Le patch auto-remount dans content.js couvre les cas courants, mais ce bouton
// reste un échappatoire si Twitch trouve un nouveau moyen d'arracher le node.

document.getElementById('btn-yt-remount').addEventListener('click', () => {
  const statusEl = document.getElementById('yt-remount-status');
  statusEl.classList.remove('err');
  statusEl.textContent = t('yt.remount.sending');
  statusEl.classList.add('shown');
  sendToVodTab({ type: 'FORCE_YT_REMOUNT' }, res => {
    if (res?.ok) {
      statusEl.textContent = t('yt.remount.ok');
    } else {
      statusEl.classList.add('err');
      statusEl.textContent = res?.error === 'no_vod_tab' ? t('yt.remount.err.noVod') : t('yt.remount.err.generic');
    }
    setTimeout(() => { statusEl.classList.remove('shown'); }, 2500);
  });
});

// ─── Toggle lecture auto ───────────────────────────────────────────────────────

document.getElementById('toggle-autoplay').addEventListener('change', e => {
  chrome.storage.local.set({ autoPlay: e.target.checked });
});

document.getElementById('toggle-notifications').addEventListener('change', e => {
  chrome.storage.local.set({ notificationsEnabled: e.target.checked });
});

document.getElementById('toggle-tracklist').addEventListener('change', e => {
  chrome.storage.local.set({ tracklistEnabled: e.target.checked }, () => {
    renderTracklist();
  });
});

// ─── Décalage audio (offset stream) ──────────────────────────────────────────

const offsetSliderEl = document.getElementById('offset-slider');
const offsetValueEl = document.getElementById('offset-value');
const offsetInputEl = document.getElementById('offset-input');
const OFFSET_MIN = parseInt(offsetSliderEl.min, 10);
const OFFSET_MAX = parseInt(offsetSliderEl.max, 10);

offsetSliderEl.addEventListener('input', e => {
  const ms = parseInt(e.target.value, 10);
  offsetValueEl.textContent = formatOffset(ms);
  chrome.storage.local.set({ audioOffset: ms });
});

function formatOffset(ms) {
  const s = ms / 1000;
  const sign = s >= 0 ? '+' : '';
  return `${sign}${s.toFixed(1)}s`;
}

// Saisie manuelle du décalage
let cancelOffsetEdit = false;

offsetValueEl.addEventListener('click', () => {
  const currentS = parseInt(offsetSliderEl.value, 10) / 1000;
  offsetInputEl.value = currentS.toFixed(1);
  offsetValueEl.hidden = true;
  offsetInputEl.hidden = false;
  offsetInputEl.focus();
  offsetInputEl.select();
});

function commitOffsetInput() {
  if (!cancelOffsetEdit) {
    const raw = offsetInputEl.value.trim().replace(',', '.').replace(/s$/i, '');
    const s = parseFloat(raw);
    if (!isNaN(s)) {
      let ms = Math.round(s * 10) * 100; // snap 0.1s
      ms = Math.min(OFFSET_MAX, Math.max(OFFSET_MIN, ms));
      offsetSliderEl.value = ms;
      offsetValueEl.textContent = formatOffset(ms);
      chrome.storage.local.set({ audioOffset: ms });
    }
  }
  cancelOffsetEdit = false;
  offsetInputEl.hidden = true;
  offsetValueEl.hidden = false;
}

offsetInputEl.addEventListener('blur', commitOffsetInput);
offsetInputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); offsetInputEl.blur(); }
  else if (e.key === 'Escape') { cancelOffsetEdit = true; offsetInputEl.blur(); }
});

const redirectUri = chrome.identity.getRedirectURL();
const uriEl = document.getElementById('redirect-uri');
uriEl.textContent = redirectUri;
uriEl.addEventListener('click', () => {
  navigator.clipboard.writeText(redirectUri).then(() => {
    uriEl.textContent = t('spotify.copied');
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
      chrome.tabs.query({ url: VOD_TAB_PATTERNS }, otherTabs => {
        const fallback = (otherTabs || []).find(t => VOD_URL_RE.test(t.url || ''));
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

// VOD classique OU player popout (https://player.twitch.tv/?...&video=12345)
const VOD_URL_RE = /^https:\/\/(?:www\.twitch\.tv\/videos\/\d+|player\.twitch\.tv\/[^#]*[?&]video=\d+)/;
const VOD_TAB_PATTERNS = ['https://www.twitch.tv/videos/*', 'https://player.twitch.tv/*'];

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
  chrome.tabs.query({ url: VOD_TAB_PATTERNS }, tabs => {
    // Filtre client : le pattern player.twitch.tv/* peut matcher des pages
    // live aussi, on garde uniquement celles qui ressemblent à une VOD.
    const vod = (tabs || []).find(t => VOD_URL_RE.test(t.url || ''));
    cb(vod || null);
  });
}

// Bannière au-dessus du now-playing pour signaler l'onglet actif
function renderActiveTabBanner(container, tab) {
  // Streamer = segment de path après /videos/xxx — pas dispo direct, on prend
  // le titre de l'onglet (ex: "Twitch") ou un fallback générique
  const label = tab.title?.replace(/ - Twitch$/, '') || t('np.other.fallback');
  let banner = container.querySelector('.np-active-tab');
  const html = `
    <div class="np-active-tab" data-tab-id="${tab.id}">
      <span class="np-active-dot"></span>
      <span class="np-active-text">${t('np.other', { label: `<strong>${escapeHtml(label)}</strong>` })}</span>
    </div>
  `;
  if (!banner) {
    prependHTML(container, html);
    banner = container.querySelector('.np-active-tab');
  } else if (banner.dataset.tabId !== String(tab.id)) {
    replaceOuterHTML(banner, html);
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

// Cache du dernier état ping par tabId pour éviter le flash F5→normal
// quand le content script répond entre deux ticks
const pingCache = new Map();

function pingContentScript(tab, cb) {
  // Si la page n'est pas encore complètement chargée, on ne conclut rien :
  // le content script s'injecte au document_idle, il peut arriver après
  if (!tab || tab.status !== 'complete') { cb(true); return; }

  const cached = pingCache.get(tab.id);
  if (cached && Date.now() - cached.ts < 3000) { cb(cached.ok); return; }

  try {
    chrome.tabs.sendMessage(tab.id, { type: 'PING' }, resp => {
      const ok = !chrome.runtime.lastError && !!resp?.ok;
      pingCache.set(tab.id, { ok, ts: Date.now() });
      cb(ok);
    });
  } catch (e) {
    pingCache.set(tab.id, { ok: false, ts: Date.now() });
    cb(false);
  }
}

function renderF5Hint(container) {
  removeActiveTabBanner(container);
  if (container.querySelector('.np-f5-hint')) return;
  setHTML(container, `
    <div class="np-f5-hint">
      <span class="np-f5-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10"></polyline>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
        </svg>
      </span>
      <span>${t('np.f5hint.msg', { kbd: `<kbd>${t('np.f5hint.key')}</kbd>` })}</span>
    </div>
  `);
}

// Injection programmée du content script quand le PING échoue. Évite à
// l'utilisateur d'avoir à F5 la page (onglet VOD ouvert avant installation,
// extension rechargée, course au document_idle, etc.).
// Les scripts eux-mêmes sont idempotents (cf. guards dans content.js et
// i18n.js) donc une seconde injection sur un onglet déjà sain est sans effet.
const injectingTabs = new Set();
function tryInjectContentScript(tabId, cb) {
  if (!chrome.scripting?.executeScript || !tabId) { cb(false); return; }
  if (injectingTabs.has(tabId)) { cb(true); return; }
  injectingTabs.add(tabId);
  chrome.scripting.executeScript({
    target: { tabId },
    files: ['i18n/locales.js', 'i18n/i18n.js', 'content.js'],
  }, () => {
    injectingTabs.delete(tabId);
    const err = chrome.runtime.lastError;
    if (err) { cb(false); return; }
    // Invalide le cache pour que le prochain poll re-ping sans utiliser la
    // réponse négative précédente (sinon le hint F5 clignoterait 3s).
    pingCache.delete(tabId);
    cb(true);
  });
}

function renderNowPlaying() {
  isOnVodTab(onVod => {
    chrome.storage.local.get(['ss_now_playing', 'ss_vod_error'], ({ ss_now_playing: track, ss_vod_error: vodError }) => {
      const container = document.getElementById('now-playing');

      // Onglet courant n'est pas une VOD : on cherche s'il y en a une ailleurs.
      if (!onVod) {
        findOtherVodTab(otherTab => {
          if (otherTab) {
            // Une VOD tourne ailleurs : ping + bannière cliquable
            pingContentScript(otherTab, scriptOk => {
              if (!scriptOk) {
                // Tente d'injecter le content script dans l'onglet distant.
                // Si ça passe, on affiche quand même la bannière : le prochain
                // tick de polling (<1s) verra le script vivant.
                tryInjectContentScript(otherTab.id, injected => {
                  if (!injected) { renderF5Hint(container); return; }
                  renderTrackOrError(container, track, vodError);
                  renderActiveTabBanner(container, otherTab);
                });
                return;
              }
              renderTrackOrError(container, track, vodError);
              renderActiveTabBanner(container, otherTab);
            });
          } else {
            // Aucune VOD ouverte nulle part : on nettoie le storage stale
            if (track || vodError) chrome.storage.local.set({ ss_now_playing: null, ss_vod_error: null, ss_timeline: null });
            removeActiveTabBanner(container);
            if (!container.querySelector('.np-idle') || container.querySelector('.np-error')) {
              setHTML(container, `<div class="np-idle">${t('np.idle')}</div>`);
            }
          }
        });
        return;
      }

      // Onglet courant = VOD : ping le content script pour savoir s'il est injecté.
      // Pas injecté = extension installée/rechargée alors que la VOD était déjà
      // ouverte, ou course au document_idle. On tente d'injecter via
      // chrome.scripting avant de rabattre sur le hint F5 en dernier recours.
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        const activeTab = tabs?.[0];
        pingContentScript(activeTab, scriptOk => {
          if (!scriptOk) {
            tryInjectContentScript(activeTab?.id, injected => {
              if (!injected) { renderF5Hint(container); return; }
              removeActiveTabBanner(container);
              renderTrackOrError(container, track, vodError);
            });
            return;
          }
          removeActiveTabBanner(container);
          renderTrackOrError(container, track, vodError);
        });
      });
    });
  });
}

function renderTrackOrError(container, track, vodError) {
  if (!track) {
    if (vodError && vodError.code) {
      const { msg, cta, hint } = vodErrorMessage(vodError);
      const ctaHtml = cta
        ? `<a class="np-error-cta" href="${cta.href}" target="_blank" rel="noopener">${escapeHtml(cta.label)} →</a>`
        : '';
      const hintHtml = hint
        ? `<div class="np-error-hint">${escapeHtml(hint)}</div>`
        : '';
      const html = `<div class="np-idle np-error">${escapeHtml(msg)}${ctaHtml ? '<br>' + ctaHtml : ''}${hintHtml}</div>`;
      const existingError = container.querySelector('.np-error');
      if (!existingError || existingError.dataset.msg !== msg) {
        const banner = container.querySelector('.np-active-tab');
        container.replaceChildren();
        if (banner) container.appendChild(banner);
        container.appendChild(htmlToFragment(html));
        const newErr = container.querySelector('.np-error');
        if (newErr) newErr.dataset.msg = msg;
      }
      return;
    }
    if (!container.querySelector('.np-idle') || container.querySelector('.np-error')) {
      const banner = container.querySelector('.np-active-tab');
      container.replaceChildren();
      if (banner) container.appendChild(banner);
      container.appendChild(htmlToFragment(`<div class="np-idle">${t('np.idle')}</div>`));
    }
    return;
  }

  if (!container.querySelector('.np-vinyl-wrap')) {
    const banner = container.querySelector('.np-active-tab');
    container.replaceChildren();
    if (banner) container.appendChild(banner);
    container.appendChild(htmlToFragment(buildNowPlayingHTML()));
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
  chrome.storage.local.get(['ss_timeline', 'ss_now_playing', 'tracklistEnabled'], ({ ss_timeline, ss_now_playing, tracklistEnabled }) => {
    const section = document.getElementById('tracklist-section');
    const sep = document.getElementById('tracklist-sep');
    const list = document.getElementById('tracklist');
    const count = document.getElementById('tracklist-count');

    // Opt-in : par défaut la section est masquée, elle ne s'affiche que si
    // l'user a coché le toggle dans les paramètres.
    if (tracklistEnabled !== true || !ss_timeline?.tracks?.length) {
      section.style.display = 'none';
      sep.style.display = 'none';
      lastTracklistVodId = null;
      return;
    }

    section.style.display = '';
    sep.style.display = '';
    const nTracks = ss_timeline.tracks.length;
    count.textContent = t(nTracks === 1 ? 'tracklist.count.one' : 'tracklist.count.many', { n: nTracks });

    const currentUri = ss_now_playing?.track_uri || null;

    // Rebuild la liste seulement si VOD a changé. Sinon on toggle juste la classe .current.
    if (ss_timeline.vodId !== lastTracklistVodId) {
      lastTracklistVodId = ss_timeline.vodId;
      setHTML(list, ss_timeline.tracks.map(t => `
        <div class="tracklist-item" data-uri="${escapeHtml(t.track_uri)}" data-pos="${t.stream_position_ms}">
          <span class="tracklist-time">${formatStreamPos(t.stream_position_ms)}</span>
          <div class="tracklist-info">
            <div class="tracklist-name">${escapeHtml(t.track_name || '')}</div>
            <div class="tracklist-artist">${escapeHtml(t.artist_name || '')}</div>
          </div>
        </div>
      `).join(''));
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
      return {
        msg: t('np.error.freePlanLimit', { limit }),
        cta: { href: 'https://streamsync.fr/pricing', label: t('account.upgrade') },
        hint: t('np.error.refreshHint'),
      };
    }
    case 'sub_only':
      return {
        msg: username
          ? t('np.error.subOnlyNamed', { username })
          : t('np.error.subOnly'),
      };
    case 'vod_not_found':
      return { msg: t('np.error.vodNotFound') };
    default:
      return { msg: err.data?.message || t('np.error.generic') };
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

document.getElementById('btn-refresh-devices').addEventListener('click', () => loadDevices());

// Auto-retry tant que la liste est vide (l'app Spotify peut ne pas apparaître
// tout de suite après l'ouverture : il faut souvent une interaction play/pause)
let devicesRetryTimer = null;
function scheduleDevicesRetry() {
  if (devicesRetryTimer) clearTimeout(devicesRetryTimer);
  devicesRetryTimer = setTimeout(() => loadDevices(), 6000);
}
function cancelDevicesRetry() {
  if (devicesRetryTimer) { clearTimeout(devicesRetryTimer); devicesRetryTimer = null; }
}

function loadDevices() {
  const list = document.getElementById('device-list');
  setHTML(list, `<div class="devices-empty">${t('devices.loading')}</div>`);
  showDevicesSection(true);

  chrome.runtime.sendMessage({ type: 'SPOTIFY_GET_DEVICES' }, res => {
    // Compte Spotify non-Premium : inutile d'essayer de lister les devices,
    // l'API Connect ne fonctionne qu'avec Premium. On prévient l'user direct.
    if (res?.ok && res.product && res.product !== 'premium') {
      cancelDevicesRetry();
      setHTML(list, `
        <div class="devices-free-warn">
          <div class="devices-free-warn-icon">⚠</div>
          <div class="devices-free-warn-body">
            <div class="devices-free-warn-title">${t('devices.free.title')}</div>
            <div class="devices-free-warn-desc">
              ${t('devices.free.desc.html')}
            </div>
            <a href="https://www.spotify.com/premium" target="_blank" rel="noopener" class="devices-free-warn-cta">
              ${t('devices.free.cta')}
            </a>
          </div>
        </div>
      `);
      return;
    }

    if (!res?.ok || !res.devices?.length) {
      setHTML(list, `
        <div class="devices-empty">
          <div>${t('devices.empty.title')}</div>
          <div class="devices-empty-hint">${t('devices.empty.hint')}</div>
          <button type="button" class="btn-retry-devices" id="btn-retry-devices">
            <span style="font-size:13px;line-height:1">↻</span>
            <span>${t('devices.refresh')}</span>
          </button>
        </div>
      `);
      const retryBtn = document.getElementById('btn-retry-devices');
      retryBtn?.addEventListener('click', () => loadDevices());
      scheduleDevicesRetry();
      return;
    }
    cancelDevicesRetry();
    chrome.storage.local.get(['selectedDeviceId'], ({ selectedDeviceId }) => {
      renderDevices(res.devices, selectedDeviceId);
    });
  });
}

function renderDevices(devices, selectedDeviceId) {
  const list = document.getElementById('device-list');
  list.replaceChildren();
  devices.forEach(device => {
    const isSelected = device.id === selectedDeviceId;
    const item = document.createElement('div');
    item.className = `device-item${isSelected ? ' selected' : ''}`;
    setHTML(item, `
      <span class="device-icon">${deviceIcon(device.type)}</span>
      <span class="device-name" title="${esc(device.name)}">${esc(device.name)}</span>
      <span class="device-check">✓</span>
    `);
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
  // Si on cache la section (ex: switch vers YouTube), on stoppe le retry
  if (!visible) cancelDevicesRetry();
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
    badge.setAttribute('data-i18n', 'spotify.connected');
    badge.textContent = t('spotify.connected');
    badge.className = 'badge-connected';
    btnConnect.style.display = 'none';
    btnDisconnect.style.display = 'block';
  } else {
    badge.setAttribute('data-i18n', 'spotify.disconnected');
    badge.textContent = t('spotify.disconnected');
    badge.className = 'badge-disconnected';
    btnConnect.style.display = 'flex';
    setHTML(btnConnect, `
      <img src="spotify-logo.svg" width="12" height="12" alt="" />
      ${t('spotify.connect')}`);
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

// ─── Compte StreamSync ───────────────────────────────────────────────────────
// Auth Twitch → JWT côté service-worker, UI synchronisée via chrome.storage.

const SS_PRICING_URL = 'https://streamsync.fr/pricing';

function renderAccount(state) {
  // Login gate : visible dès que l'user n'est pas connecté. Le reste du popup
  // est masqué via CSS (body.ss-logged-out).
  if (!state || !state.user) {
    document.body.classList.add('ss-logged-out');
    const v = document.getElementById('gate-version');
    if (v) v.textContent = `v${chrome.runtime.getManifest().version}`;
    return;
  }

  document.body.classList.remove('ss-logged-out');

  const { user, me } = state;
  const avatar = document.getElementById('account-avatar');
  const name = document.getElementById('account-name');
  const badge = document.getElementById('account-plan-badge');
  const upgradeBtn = document.getElementById('btn-ss-upgrade');

  if (avatar) avatar.src = user.twitch_avatar_url || 'icons/icon48.png';
  if (name) name.textContent = `@${user.twitch_username || '—'}`;

  // Plan & badge : me peut être null si le fetch a échoué (offline, etc.) —
  // on retombe sur un affichage neutre basé sur user uniquement.
  const plan = me?.plan_type || 'free';
  const hasUnlimited = !!me?.has_unlimited_vod;

  if (badge) {
    if (hasUnlimited) {
      badge.className = 'badge-connected';
      badge.textContent = planLabel(plan);
    } else {
      badge.className = 'badge-disconnected';
      badge.textContent = t('account.plan.free');
    }
  }

  // Si déjà Pro (Streamer ou Viewer), on cache le bouton upgrade
  if (upgradeBtn) upgradeBtn.style.display = hasUnlimited ? 'none' : '';
}

function planLabel(plan) {
  switch (plan) {
    case 'monthly':
    case 'annual':
    case 'lifetime':
      return t('account.plan.proStreamer');
    case 'viewer_monthly':
    case 'viewer_annual':
      return t('account.plan.proViewer');
    default:
      return t('account.plan.free');
  }
}

// Dernier état d'accès illimité connu (pour détecter la transition free → pro
// et demander au content script de refetch la VOD courante).
let lastHasUnlimited = null;

async function refreshAccount() {
  const { ss_user: user } = await new Promise(r =>
    chrome.storage.local.get(['ss_user'], r)
  );
  if (!user) {
    renderAccount(null);
    lastHasUnlimited = null;
    return;
  }

  // Tente de récupérer le statut d'abo frais. Si le JWT a expiré, le service-worker
  // le purge lui-même et retourne une erreur, on repasse en logged out.
  chrome.runtime.sendMessage({ type: 'SS_ME' }, res => {
    if (res?.ok) {
      renderAccount({ user, me: res.me });

      // Toute transition d'accès (free↔pro) déclenche un retry côté content
      // script pour re-synchroniser l'état VOD :
      //   - free → pro : purge le banner "Passe Pro Viewer" et recharge la timeline.
      //   - pro → free : purge la timeline stale et fait apparaître le banner si
      //     la VOD est au-delà des 3 dernières sessions.
      const nowUnlimited = !!res.me.has_unlimited_vod;
      if (lastHasUnlimited !== null && nowUnlimited !== lastHasUnlimited) {
        chrome.storage.local.set({ ss_vod_error: null });
        sendToVodTab({ type: 'RETRY_VOD_FETCH' });
      }
      lastHasUnlimited = nowUnlimited;
    } else if (res?.errorCode === 'jwt_invalid' || res?.errorCode === 'not_authenticated') {
      renderAccount(null);
      lastHasUnlimited = null;
    } else {
      // Échec réseau ou autre : on affiche quand même l'user, sans plan à jour
      renderAccount({ user, me: null });
    }
  });
}

function handleSsLoginClick(btn) {
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = t('account.loggingIn');

  chrome.runtime.sendMessage({ type: 'SS_LOGIN' }, res => {
    btn.disabled = false;
    btn.textContent = originalText;
    if (res?.ok) {
      refreshAccount();
    } else if (res?.error && !/cancel/i.test(res.error)) {
      // User n'a pas annulé : erreur réelle, on la remonte
      console.error('[StreamSync] Login failed:', res.error);
    }
  });
}

document.getElementById('btn-ss-login-gate')?.addEventListener('click', e => {
  handleSsLoginClick(e.currentTarget);
});

document.getElementById('btn-ss-logout')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'SS_LOGOUT' }, () => {
    renderAccount(null);
  });
});

document.getElementById('btn-ss-upgrade')?.addEventListener('click', () => {
  chrome.tabs.create({ url: SS_PRICING_URL });
});

// Re-render le compte quand le storage change (logout depuis un autre popup, JWT purgé sur 401, etc.)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('ss_user' in changes || 'ss_jwt' in changes) refreshAccount();
});

refreshAccount();

// Polling pour catcher un upgrade Stripe sans avoir à rouvrir le popup. Le webhook
// met quelques secondes à propager le changement de plan en DB — on refetch
// discrètement tant que le popup est ouvert.
let accountPollTimer = null;
function startAccountPolling() {
  if (accountPollTimer) return;
  accountPollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refreshAccount();
  }, 10_000);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshAccount();
});
window.addEventListener('unload', () => {
  if (accountPollTimer) { clearInterval(accountPollTimer); accountPollTimer = null; }
});
startAccountPolling();

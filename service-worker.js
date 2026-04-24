// StreamSync - Service Worker MV3
// Gère : appels API backend, OAuth Spotify PKCE, contrôle Spotify Connect

importScripts('i18n/locales.js', 'i18n/i18n.js');
self.SS_I18N.loadLang();
const _t = (key, vars) => self.SS_I18N.t(key, vars);

// ─── Config ──────────────────────────────────────────────────────────────────

const API_URL_PROD = 'https://streamsync.fr';
const API_URL_DEV = 'http://localhost:3000';
// Timeout court pour ne pas pénaliser la prod : une connexion refusée localhost
// échoue en ~1ms, on garde 500ms de marge pour un backend qui démarre à peine.
const DEV_DETECT_TIMEOUT_MS = 500;

// Résolu une fois par vie de service-worker (Chrome peut le tuer après 30s
// d'idle → auto-détection refait au prochain wake-up, pratique quand on
// démarre le backend local après avoir ouvert le popup).
let apiUrlPromise = null;

function detectApiUrl() {
  return (async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), DEV_DETECT_TIMEOUT_MS);
      // Peu importe la réponse (index.html, 404, 200…) : le fait que la
      // connexion TCP aboutisse prouve qu'un backend tourne en local.
      await fetch(API_URL_DEV, { method: 'HEAD', signal: ctrl.signal });
      clearTimeout(t);
      console.log('[StreamSync] API locale détectée → localhost:3000');
      return API_URL_DEV;
    } catch {
      return API_URL_PROD;
    }
  })();
}

function getApiUrl() {
  if (!apiUrlPromise) apiUrlPromise = detectApiUrl();
  return apiUrlPromise;
}

async function getConfig() {
  const [apiUrl, stored] = await Promise.all([
    getApiUrl(),
    new Promise(resolve => chrome.storage.local.get(['spotifyClientId'], resolve)),
  ]);
  return {
    apiUrl,
    clientId: stored.spotifyClientId || '',
  };
}

// ─── Messages depuis le content script ───────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'FETCH_VOD_TIMELINE':
      handleFetchTimeline(message.videoId)
        .then(data => sendResponse({ ok: true, data }))
        .catch(err => sendResponse({
          ok: false,
          error: err.message,
          errorCode: err.code || null,
          errorData: err.data || null,
        }));
      return true;

    case 'SS_LOGIN':
      loginStreamSync()
        .then(user => sendResponse({ ok: true, user }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'SS_LOGOUT':
      logoutStreamSync()
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'SS_ME':
      fetchStreamSyncMe()
        .then(me => sendResponse({ ok: true, me }))
        .catch(err => sendResponse({ ok: false, error: err.message, errorCode: err.code || null }));
      return true;

    case 'SPOTIFY_CONNECT':
      connectSpotify()
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'SPOTIFY_STATUS':
      getSpotifyStatus()
        .then(status => sendResponse({ ok: true, ...status }))
        .catch(() => sendResponse({ ok: false, connected: false }));
      return true;

    case 'SPOTIFY_GET_DEVICES':
      getAccessToken()
        .then(async token => {
          // Devices + profil en parallèle pour pouvoir détecter un compte Free
          // (Premium requis pour le contrôle de lecture via Spotify Connect)
          const [devices, profile] = await Promise.all([getDevices(token), getProfile(token)]);
          return { devices, product: profile?.product || null };
        })
        .then(data => sendResponse({ ok: true, ...data }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'SPOTIFY_PLAY':
      spotifyPlay(message.trackUri, message.offsetMs)
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'SPOTIFY_PAUSE':
      spotifyPause()
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'SPOTIFY_SEEK':
      spotifyPlay(message.trackUri, message.offsetMs)
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'SPOTIFY_OPEN_TRACK':
      openSpotifyTrack(message.trackUri);
      sendResponse({ ok: true });
      return true;

    case 'SPOTIFY_PLAYBACK_STATE':
      getAccessToken()
        .then(token => getPlaybackState(token))
        .then(state => sendResponse({ ok: true, state }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'NOTIFY_TRACK_CHANGE':
      maybeShowTrackNotification(message.track, sender.tab?.id);
      sendResponse({ ok: true });
      return false;

    case 'YOUTUBE_RESOLVE':
      handleYoutubeResolve(message.trackUri, message.title, message.artist)
        .then(videoId => sendResponse({ ok: true, videoId }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'FETCH_ALBUM_ART':
      handleFetchAlbumArt(message.trackUri)
        .then(url => sendResponse({ ok: true, url }))
        .catch(() => sendResponse({ ok: false }));
      return true;
  }
});

// ─── Résolution YouTube (proxy vers backend) ─────────────────────────────────
// Le viewer a choisi YouTube comme lecteur : on demande au backend de trouver
// le videoId correspondant au track Spotify (résolution + cache côté serveur).

async function handleYoutubeResolve(trackUri, title, artist) {
  if (!trackUri) throw new Error('trackUri manquant');

  const { apiUrl } = await getConfig();
  const params = new URLSearchParams({
    track_uri: trackUri,
    title: title || '',
    artist: artist || '',
  });

  const res = await fetch(`${apiUrl}/api/youtube/resolve?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.videoId;
}

// ─── Album art (Spotify oEmbed, pas d'auth requise) ──────────────────────────

async function handleFetchAlbumArt(trackUri) {
  const trackId = trackUri.replace('spotify:track:', '');
  const res = await fetch(
    `https://open.spotify.com/oembed?url=https://open.spotify.com/track/${trackId}`
  );
  if (!res.ok) throw new Error('oEmbed failed');
  const data = await res.json();
  return data.thumbnail_url;
}

// ─── Timeline VOD ─────────────────────────────────────────────────────────────

async function handleFetchTimeline(videoId) {
  const { apiUrl } = await getConfig();

  // Envoie le JWT s'il y en a un : le backend bypass la limite free si le viewer
  // est connecté avec un plan Pro Viewer. Absent → fallback gating streamer.
  const headers = {};
  const jwt = await getSsJwt();
  if (jwt) headers.Authorization = `Bearer ${jwt}`;

  const res = await fetch(`${apiUrl}/api/vod/${videoId}`, { headers });
  if (!res.ok) {
    // 401 sur la route VOD : le JWT est invalide/expiré → on le purge pour que le
    // popup repasse en mode "non connecté" au prochain refresh.
    if (res.status === 401 && jwt) await clearSsAuth();
    const body = await res.json().catch(() => ({}));
    // Enrichit l'erreur pour que le content script puisse distinguer free_plan_limit, sub_only, etc.
    const err = new Error(body.message || body.error || `HTTP ${res.status}`);
    err.code = body.error || null;
    err.data = body;
    throw err;
  }
  return res.json();
}

// ─── StreamSync auth (JWT Twitch via chrome.identity) ─────────────────────────
// Le viewer s'authentifie via son compte Twitch. Le backend échange le code OAuth
// contre un JWT signé (HS256) qu'on stocke dans chrome.storage.local. Ce JWT est
// envoyé dans Authorization: Bearer sur les routes qui gatent un contenu.

const SS_JWT_KEY = 'ss_jwt';
const SS_USER_KEY = 'ss_user';
const SS_EXPIRES_KEY = 'ss_jwt_expires_at';

async function getSsJwt() {
  const { [SS_JWT_KEY]: jwt, [SS_EXPIRES_KEY]: expiresAt } = await chrome.storage.local.get([SS_JWT_KEY, SS_EXPIRES_KEY]);
  if (!jwt) return null;
  // Expiré → on purge pour éviter d'envoyer un token mort à chaque appel
  if (expiresAt && Date.now() > new Date(expiresAt).getTime()) {
    await clearSsAuth();
    return null;
  }
  return jwt;
}

async function clearSsAuth() {
  await chrome.storage.local.remove([SS_JWT_KEY, SS_USER_KEY, SS_EXPIRES_KEY]);
}

async function loginStreamSync() {
  const { apiUrl } = await getConfig();
  const redirectUri = chrome.identity.getRedirectURL();

  // 1. Demande l'URL d'autorisation Twitch au backend (client_id baked-in)
  const urlRes = await fetch(`${apiUrl}/api/auth/extension/authorize-url?redirect_uri=${encodeURIComponent(redirectUri)}`);
  if (!urlRes.ok) {
    const body = await urlRes.json().catch(() => ({}));
    throw new Error(body.error || 'authorize_url_failed');
  }
  const { url: authUrl } = await urlRes.json();

  // 2. Ouvre la popup OAuth, Chrome capture le redirect final
  const redirectUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, finalUrl => {
      if (chrome.runtime.lastError || !finalUrl) {
        return reject(new Error(chrome.runtime.lastError?.message || _t('err.authCancelled')));
      }
      resolve(finalUrl);
    });
  });

  // 3. Extrait le code
  const parsed = new URL(redirectUrl);
  const oauthError = parsed.searchParams.get('error');
  if (oauthError) {
    throw new Error(parsed.searchParams.get('error_description') || oauthError);
  }
  const code = parsed.searchParams.get('code');
  if (!code) throw new Error(_t('err.noCode'));

  // 4. Échange code → JWT côté backend
  const exchangeRes = await fetch(`${apiUrl}/api/auth/extension/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirect_uri: redirectUri }),
  });
  if (!exchangeRes.ok) {
    const body = await exchangeRes.json().catch(() => ({}));
    throw new Error(body.error || 'exchange_failed');
  }
  const data = await exchangeRes.json();

  await chrome.storage.local.set({
    [SS_JWT_KEY]: data.jwt,
    [SS_USER_KEY]: data.user,
    [SS_EXPIRES_KEY]: data.expires_at,
  });

  console.log(`[StreamSync] Connecté en tant que @${data.user?.twitch_username}`);
  return data.user;
}

async function logoutStreamSync() {
  await clearSsAuth();
  console.log('[StreamSync] Déconnecté');
}

async function fetchStreamSyncMe() {
  const { apiUrl } = await getConfig();
  const jwt = await getSsJwt();
  if (!jwt) {
    const err = new Error('not_authenticated');
    err.code = 'not_authenticated';
    throw err;
  }
  const res = await fetch(`${apiUrl}/api/auth/extension/me`, {
    headers: { Authorization: `Bearer ${jwt}` },
    // Important : empêche le cache HTTP de servir un ancien plan après un upgrade Stripe.
    cache: 'no-store',
  });
  if (res.status === 401) {
    await clearSsAuth();
    const err = new Error('jwt_invalid');
    err.code = 'jwt_invalid';
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const me = await res.json();
  // On refresh l'avatar/pseudo stocké (au cas où l'user aurait changé côté Twitch)
  const { [SS_USER_KEY]: existing } = await chrome.storage.local.get([SS_USER_KEY]);
  if (existing) {
    await chrome.storage.local.set({
      [SS_USER_KEY]: { ...existing, twitch_username: me.twitch_username, twitch_user_id: me.twitch_user_id },
    });
  }
  return me;
}

// ─── OAuth Spotify PKCE ───────────────────────────────────────────────────────

async function connectSpotify() {
  const { clientId } = await getConfig();
  if (!clientId) throw new Error(_t('err.clientIdMissing'));

  const { verifier, challenge } = await generatePKCE();
  const redirectUri = chrome.identity.getRedirectURL();

  await chrome.storage.local.set({ pkce_verifier: verifier });

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'user-modify-playback-state user-read-playback-state',
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });

  const authUrl = `https://accounts.spotify.com/authorize?${params}`;

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async redirectUrl => {
      if (chrome.runtime.lastError || !redirectUrl) {
        return reject(new Error(chrome.runtime.lastError?.message || _t('err.authCancelled')));
      }

      try {
        const url = new URL(redirectUrl);
        const code = url.searchParams.get('code');
        // Spotify renvoie ?error=... quand quelque chose cloche : redirect URI
        // mismatch, scope refusé, app mal configurée, etc.
        const oauthError = url.searchParams.get('error');
        if (oauthError) {
          const desc = url.searchParams.get('error_description');
          const messages = {
            'invalid_redirect_uri': _t('err.redirectUri'),
            'access_denied': _t('err.accessDenied'),
            'invalid_client': _t('err.invalidClient'),
            'invalid_scope': _t('err.invalidScope'),
          };
          const friendly = messages[oauthError] || `${oauthError}${desc ? ` (${desc})` : ''}`;
          return reject(new Error(friendly));
        }
        if (!code) return reject(new Error(_t('err.noCode')));

        const { pkce_verifier } = await chrome.storage.local.get(['pkce_verifier']);

        const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: pkce_verifier,
          }),
        });

        if (!tokenRes.ok) {
          const err = await tokenRes.json();
          return reject(new Error(err.error_description || _t('err.tokenExchange')));
        }

        const tokens = await tokenRes.json();

        await chrome.storage.local.set({
          spotify_access_token: tokens.access_token,
          spotify_refresh_token: tokens.refresh_token,
          spotify_token_expires_at: Date.now() + tokens.expires_in * 1000,
        });

        console.log('[StreamSync] Spotify connecté');
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

async function generatePKCE() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(64)))
    .map(b => chars[b % chars.length]).join('');

  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  return { verifier, challenge };
}

// ─── Token Spotify (avec auto-refresh) ────────────────────────────────────────

async function getAccessToken() {
  const stored = await chrome.storage.local.get([
    'spotify_access_token',
    'spotify_refresh_token',
    'spotify_token_expires_at',
  ]);

  if (!stored.spotify_access_token) throw new Error(_t('err.notConnected'));

  // Refresh si expiré dans moins de 60s
  if (Date.now() > stored.spotify_token_expires_at - 60_000) {
    return refreshToken(stored.spotify_refresh_token);
  }

  return stored.spotify_access_token;
}

async function refreshToken(refreshToken) {
  const { clientId } = await getConfig();

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });

  if (!res.ok) throw new Error(_t('err.refreshFailed'));

  const tokens = await res.json();
  await chrome.storage.local.set({
    spotify_access_token: tokens.access_token,
    spotify_token_expires_at: Date.now() + tokens.expires_in * 1000,
    ...(tokens.refresh_token && { spotify_refresh_token: tokens.refresh_token }),
  });

  return tokens.access_token;
}

async function getSpotifyStatus() {
  const { spotify_access_token } = await chrome.storage.local.get(['spotify_access_token']);
  return { connected: !!spotify_access_token };
}

// ─── Contrôle Spotify Connect API ─────────────────────────────────────────────

// Récupère la liste des appareils Spotify disponibles
async function getDevices(token) {
  const res = await fetch('https://api.spotify.com/v1/me/player/devices', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const { devices } = await res.json();
  return devices || [];
}

// Récupère le profil Spotify (surtout pour le champ "product" : premium|free|open).
// Résilient : retourne null en cas d'erreur plutôt que de bloquer le devices loader.
async function getProfile(token) {
  try {
    const res = await fetch('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// État de lecture Spotify (pour calcul drift sync depuis le popup)
async function getPlaybackState(token) {
  const res = await fetch('https://api.spotify.com/v1/me/player', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 204 || !res.ok) return null;
  return res.json();
}

// ─── Notifications desktop ───────────────────────────────────────────────────
const notifTabMap = {}; // notification_id → tab_id (pour focus au clic)

async function maybeShowTrackNotification(track, tabId) {
  if (!track?.track_name) return;
  const { notificationsEnabled } = await chrome.storage.local.get(['notificationsEnabled']);
  if (!notificationsEnabled) return;

  const id = `streamsync-track-${Date.now()}`;
  const opts = {
    type: 'basic',
    iconUrl: track.albumArt || 'icons/icon128.png',
    title: track.track_name,
    message: track.artist_name || '',
    silent: true,
    requireInteraction: false,
    priority: 0,
  };
  try {
    chrome.notifications.create(id, opts, () => {
      if (chrome.runtime.lastError) return;
      if (tabId) notifTabMap[id] = tabId;
      // Auto-dismiss après 5s pour pas que ça s'empile
      setTimeout(() => chrome.notifications.clear(id), 5000);
    });
  } catch (e) { /* notification API indisponible */ }
}

// Click sur la notification → focus l'onglet VOD source
chrome.notifications.onClicked.addListener(notifId => {
  const tabId = notifTabMap[notifId];
  if (!tabId) return;
  chrome.tabs.update(tabId, { active: true });
  chrome.tabs.get(tabId, tab => {
    if (tab?.windowId) chrome.windows.update(tab.windowId, { focused: true });
  });
  chrome.notifications.clear(notifId);
});

chrome.notifications.onClosed.addListener(notifId => {
  delete notifTabMap[notifId];
});

// Résout le device à utiliser : celui sélectionné manuellement, ou l'actif, ou le premier
async function getActiveDeviceId(token) {
  const { selectedDeviceId } = await chrome.storage.local.get(['selectedDeviceId']);
  const devices = await getDevices(token);
  if (!devices.length) return null;

  if (selectedDeviceId) {
    const found = devices.find(d => d.id === selectedDeviceId);
    if (found) return found.id;
  }

  // Fallback : actif puis premier
  return (devices.find(d => d.is_active) || devices[0]).id;
}

async function spotifyPlay(trackUri, offsetMs) {
  const token = await getAccessToken();

  // Récupère un device_id - évite l'erreur NO_ACTIVE_DEVICE
  const deviceId = await getActiveDeviceId(token);

  if (!deviceId) {
    console.warn('[StreamSync] Aucun appareil Spotify actif - ouvre Spotify d\'abord');
    throw new Error(_t('err.openSpotifyFirst'));
  }

  const url = `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      uris: [trackUri],
      position_ms: Math.max(0, Math.floor(offsetMs)),
    }),
  });

  if (!res.ok && res.status !== 204 && res.status !== 202) {
    const body = await res.json().catch(() => ({}));
    console.warn('[StreamSync] Spotify play error:', res.status, body);
    throw new Error(body.error?.message || `Spotify error ${res.status}`);
  }
}

async function spotifyPause() {
  const token = await getAccessToken();
  const deviceId = await getActiveDeviceId(token);

  const url = deviceId
    ? `https://api.spotify.com/v1/me/player/pause?device_id=${deviceId}`
    : 'https://api.spotify.com/v1/me/player/pause';

  await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
  });
}

function openSpotifyTrack(trackUri) {
  const trackId = trackUri.replace('spotify:track:', '');
  chrome.tabs.create({ url: `https://open.spotify.com/track/${trackId}`, active: false });
}

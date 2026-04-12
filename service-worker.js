// StreamSync - Service Worker MV3
// Gère : appels API backend, OAuth Spotify PKCE, contrôle Spotify Connect

// ─── Config ──────────────────────────────────────────────────────────────────

const API_URL = 'https://streamsync.fr';

async function getConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get(['spotifyClientId'], result => {
      resolve({
        apiUrl: API_URL,
        clientId: result.spotifyClientId || '',
      });
    });
  });
}

// ─── Messages depuis le content script ───────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'FETCH_VOD_TIMELINE':
      handleFetchTimeline(message.videoId)
        .then(data => sendResponse({ ok: true, data }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
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
        .then(token => getDevices(token))
        .then(devices => sendResponse({ ok: true, devices }))
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
  const res = await fetch(`${apiUrl}/api/vod/${videoId}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── OAuth Spotify PKCE ───────────────────────────────────────────────────────

async function connectSpotify() {
  const { clientId } = await getConfig();
  if (!clientId) throw new Error('Spotify Client ID non configuré dans le popup');

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
        return reject(new Error(chrome.runtime.lastError?.message || 'Auth annulée'));
      }

      try {
        const url = new URL(redirectUrl);
        const code = url.searchParams.get('code');
        if (!code) return reject(new Error('Code manquant dans la réponse'));

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
          return reject(new Error(err.error_description || 'Échange de token échoué'));
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

  if (!stored.spotify_access_token) throw new Error('Spotify non connecté');

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

  if (!res.ok) throw new Error('Refresh token Spotify échoué');

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
    throw new Error('Ouvre Spotify sur ton PC ou téléphone d\'abord');
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

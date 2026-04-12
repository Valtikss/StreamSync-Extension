// StreamSync - Content Script
// Injecté sur https://www.twitch.tv/videos/*
// Le viewer choisit son lecteur (Spotify ou YouTube) dans le popup, ce script
// orchestre la timeline VOD et envoie les commandes au lecteur sélectionné.

(function () {
  'use strict';

  // ─── État ────────────────────────────────────────────────────────────────────
  let timeline = [];
  let videoEl = null;
  let loopId = null;
  let player = null; // adapter actif (spotify ou youtube)

  let lastPlayedTrackUri = null;
  let lastPlayedOffsetBucket = -1;
  let audioOffsetMs = 3000; // Délai stream par défaut (3s)
  const albumArtCache = {}; // trackUri → imageUrl | null

  function ctxOk() {
    try { return !!chrome.runtime?.id; } catch (e) { return false; }
  }

  // ─── Helpers de messaging ─────────────────────────────────────────────────────

  function safeSend(msg, cb) {
    if (!ctxOk()) { stopExtension(); return; }
    try {
      chrome.runtime.sendMessage(msg, response => {
        if (chrome.runtime.lastError) return;
        cb?.(response);
      });
    } catch (e) {
      stopExtension();
    }
  }

  function sendMessageAsync(msg) {
    return new Promise(resolve => safeSend(msg, response => resolve(response)));
  }

  function storageGet(keys) {
    return new Promise(resolve => {
      try { chrome.storage.local.get(keys, result => resolve(result || {})); }
      catch (e) { resolve({}); }
    });
  }

  // Charge le décalage audio initial
  storageGet(['audioOffset']).then(({ audioOffset }) => {
    if (typeof audioOffset === 'number') audioOffsetMs = audioOffset;
  });

  // Résout l'album art via oEmbed Spotify (fire-and-forget, cache local)
  function fetchAlbumArt(trackUri) {
    if (albumArtCache.hasOwnProperty(trackUri)) return;
    albumArtCache[trackUri] = null; // marque "en cours"
    sendMessageAsync({ type: 'FETCH_ALBUM_ART', trackUri }).then(res => {
      if (res?.ok && res.url) albumArtCache[trackUri] = res.url;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PLAYER ADAPTERS
  // Interface : { name, init(), isReady(), play(track, offsetMs), pause(), destroy() }
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── Spotify (lecteur historique, contrôle Spotify Connect) ─────────────────

  function createSpotifyPlayer() {
    let connected = false;

    function pause() {
      if (!connected) return;
      safeSend({ type: 'SPOTIFY_PAUSE' });
    }

    return {
      name: 'spotify',
      async init() {
        const res = await sendMessageAsync({ type: 'SPOTIFY_STATUS' });
        connected = res?.connected || false;
      },
      isReady() { return connected; },
      play(track, offsetMs) {
        if (!connected) return;
        safeSend({ type: 'SPOTIFY_PLAY', trackUri: track.track_uri, offsetMs });
      },
      pause,
      // Au swap de lecteur on coupe Spotify Connect, sinon il continue à jouer
      // en parallèle de YouTube côté viewer
      destroy: pause,
    };
  }

  // ─── YouTube (iframe + IFrame Player API via postMessage) ───────────────────
  // Création paresseuse de l'iframe au premier play. Le viewer doit cliquer une
  // fois sur "Activer le son" car Chrome bloque l'audio auto dans les iframes.

  function createYoutubePlayer() {
    const CONTAINER_ID = 'streamsync-yt-container';
    let iframe = null;
    let iframeReady = false;
    let currentVideoId = null;
    let pendingCmd = null; // { videoId, startSec } en attente du load
    const localCache = {}; // mémoire process : trackUri → videoId

    function buildIframeUI() {
      const container = document.createElement('div');
      container.id = CONTAINER_ID;
      container.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 280px;
        background: #07080e;
        border: 1px solid rgba(255,107,74,0.3);
        border-radius: 12px;
        overflow: hidden;
        z-index: 2147483647;
        box-shadow: 0 16px 48px rgba(0,0,0,0.7);
        font-family: 'Outfit', system-ui, -apple-system, sans-serif;
      `;

      // Header avec label StreamSync
      const header = document.createElement('div');
      header.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background: rgba(255,107,74,0.08);
        border-bottom: 1px solid rgba(255,255,255,0.04);
        color: #eaedf6;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: -0.01em;
      `;
      header.innerHTML = `
        <span style="display:flex;align-items:center;gap:6px">
          <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#ff6b4a;box-shadow:0 0 8px #ff6b4a"></span>
          StreamSync · YouTube
        </span>
      `;

      // Iframe vide → on charge le premier morceau via postMessage(loadVideoById)
      iframe = document.createElement('iframe');
      iframe.id = 'streamsync-yt-iframe';
      iframe.src = 'https://www.youtube.com/embed/?enablejsapi=1&autoplay=1&mute=1&controls=1&modestbranding=1&rel=0&playsinline=1';
      iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
      iframe.style.cssText = `
        display: block;
        width: 100%;
        aspect-ratio: 16 / 9;
        border: 0;
      `;

      // Bouton "Activer le son" (Chrome bloque l'audio auto en iframe)
      const unmuteBtn = document.createElement('button');
      unmuteBtn.id = 'streamsync-yt-unmute';
      unmuteBtn.textContent = '🔊 Activer le son';
      unmuteBtn.style.cssText = `
        display: block;
        width: 100%;
        padding: 10px 12px;
        background: linear-gradient(135deg, #ff6b4a 0%, #ff9a76 100%);
        color: #fff;
        border: 0;
        font-family: inherit;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
        transition: filter 0.15s;
      `;
      unmuteBtn.addEventListener('mouseenter', () => { unmuteBtn.style.filter = 'brightness(1.1)'; });
      unmuteBtn.addEventListener('mouseleave', () => { unmuteBtn.style.filter = ''; });
      unmuteBtn.addEventListener('click', () => {
        postCmd('unMute');
        postCmd('setVolume', [80]);
        unmuteBtn.remove();
      });

      container.appendChild(header);
      container.appendChild(iframe);
      container.appendChild(unmuteBtn);
      document.body.appendChild(container);

      iframe.addEventListener('load', () => {
        iframeReady = true;
        // Si une commande de play est en attente, on la flushe maintenant
        if (pendingCmd) {
          const { videoId, startSec } = pendingCmd;
          pendingCmd = null;
          loadVideo(videoId, startSec);
        }
      });
    }

    function ensureIframe() {
      if (!iframe) buildIframeUI();
    }

    // Envoie une commande à l'iframe via le protocole postMessage YouTube
    function postCmd(func, args = []) {
      if (!iframe?.contentWindow) return;
      iframe.contentWindow.postMessage(JSON.stringify({
        event: 'command',
        func,
        args,
      }), '*');
    }

    function loadVideo(videoId, startSec) {
      postCmd('loadVideoById', [{
        videoId,
        startSeconds: Math.max(0, startSec),
        suggestedQuality: 'small',
      }]);
      currentVideoId = videoId;
    }

    // Cherche le videoId pour un track : mémoire → storage local → backend
    async function resolveVideoId(track) {
      if (localCache[track.track_uri]) return localCache[track.track_uri];

      // Cache persistant côté extension (survit aux navigations)
      const { ss_yt_cache } = await storageGet(['ss_yt_cache']);
      if (ss_yt_cache?.[track.track_uri]) {
        localCache[track.track_uri] = ss_yt_cache[track.track_uri];
        return ss_yt_cache[track.track_uri];
      }

      // Sinon on demande au backend (qui a sa propre couche de cache)
      const res = await sendMessageAsync({
        type: 'YOUTUBE_RESOLVE',
        trackUri: track.track_uri,
        title: track.track_name,
        artist: track.artist_name,
      });

      if (!res?.ok || !res.videoId) {
        console.warn('[StreamSync] Pas de résolution YouTube pour', track.track_name);
        return null;
      }

      localCache[track.track_uri] = res.videoId;
      // Persiste pour les sessions futures (navigations VOD, redémarrages)
      const updated = { ...(ss_yt_cache || {}), [track.track_uri]: res.videoId };
      try { chrome.storage.local.set({ ss_yt_cache: updated }); } catch (e) {}

      return res.videoId;
    }

    return {
      name: 'youtube',
      async init() {},
      isReady() { return true; },
      async play(track, offsetMs) {
        ensureIframe();
        const videoId = await resolveVideoId(track);
        if (!videoId) return;

        const startSec = Math.floor(offsetMs / 1000);

        // Iframe pas encore loadée : on diffère la commande
        if (!iframeReady) {
          pendingCmd = { videoId, startSec };
          return;
        }

        if (videoId !== currentVideoId) {
          loadVideo(videoId, startSec);
        } else {
          // Même morceau → simple seek + play
          postCmd('seekTo', [startSec, true]);
          postCmd('playVideo');
        }
      },
      pause() {
        postCmd('pauseVideo');
      },
      destroy() {
        document.getElementById(CONTAINER_ID)?.remove();
        iframe = null;
        iframeReady = false;
        currentVideoId = null;
        pendingCmd = null;
      },
    };
  }

  // ─── Sélection du player selon la préférence stockée ─────────────────────────

  async function loadPlayer() {
    const { playerChoice } = await storageGet(['playerChoice']);
    const choice = playerChoice || 'spotify';

    if (player) player.destroy();
    player = choice === 'youtube' ? createYoutubePlayer() : createSpotifyPlayer();
    await player.init();
    console.log(`[StreamSync] Player actif : ${player.name}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ORCHESTRATION VOD
  // ═══════════════════════════════════════════════════════════════════════════

  function init() {
    const videoId = extractVideoId(location.href);
    if (!videoId) return;

    console.log('[StreamSync] VOD détectée, id =', videoId);

    loadPlayer();

    safeSend({ type: 'FETCH_VOD_TIMELINE', videoId }, response => {
      if (!response?.ok) {
        console.warn('[StreamSync]', response?.error);
        writeStorage(null);
        return;
      }

      timeline = response.data.timeline;
      if (!timeline.length) { writeStorage(null); return; }

      console.log(`[StreamSync] ${timeline.length} morceaux chargés`);

      waitForVideo().then(video => {
        videoEl = video;
        attachVideoListeners();
        startLoop();
      });
    });
  }

  // ─── Extraction du video ID ───────────────────────────────────────────────────
  function extractVideoId(url) {
    const m = url.match(/twitch\.tv\/videos\/(\d+)/);
    return m ? m[1] : null;
  }

  // ─── Attente du <video> ───────────────────────────────────────────────────────
  function waitForVideo() {
    return new Promise(resolve => {
      const check = () => {
        const v = document.querySelector('video');
        if (v && v.readyState >= 1) return resolve(v);
        setTimeout(check, 500);
      };
      check();
    });
  }

  // ─── Listeners vidéo ─────────────────────────────────────────────────────────
  let pauseTimer = null;

  function cancelPause() {
    if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
  }

  function attachVideoListeners() {
    videoEl.addEventListener('play', () => {
      cancelPause();
      if (!player?.isReady()) return;
      const track = getCurrentTrack(videoEl.currentTime * 1000);
      if (track) playTrack(track, true);
    });

    videoEl.addEventListener('pause', () => {
      if (!player?.isReady()) return;
      // Débounce : attend 400ms avant de pauser le lecteur
      // (annulé si play/seeked arrive entre-temps, ex: clic sur un timecode)
      cancelPause();
      pauseTimer = setTimeout(() => {
        if (videoEl.paused) player?.pause();
      }, 400);
    });

    videoEl.addEventListener('seeked', () => {
      cancelPause();
      if (!player?.isReady()) return;
      const track = getCurrentTrack(videoEl.currentTime * 1000);
      // force=true : bypasse le bucket, le seek doit toujours être transmis
      if (track && !videoEl.paused) playTrack(track, true);
    });
  }

  // force=true : ignore la déduplication bucket (seek/play explicite)
  // force=false (défaut) : déduplique via bucket 3s (boucle RAF, changement de piste auto)
  function playTrack(track, force = false) {
    const bucket = Math.floor(track.offset_ms / 3000);
    if (!force && track.track_uri === lastPlayedTrackUri && bucket === lastPlayedOffsetBucket) return;
    chrome.storage.local.get(['autoPlay'], ({ autoPlay }) => {
      if (autoPlay === false) return;
      if (!player?.isReady()) return;
      lastPlayedTrackUri = track.track_uri;
      lastPlayedOffsetBucket = bucket;
      player.play(track, track.offset_ms);
    });
  }

  // ─── Boucle principale (setInterval pour tourner même quand l'onglet est en arrière-plan) ──
  function startLoop() {
    if (loopId) clearInterval(loopId);

    loopId = setInterval(() => {
      if (!ctxOk()) { stopExtension(); return; }

      if (videoEl) {
        const posMs = videoEl.currentTime * 1000;
        const track = getCurrentTrack(posMs);
        const isPlaying = !videoEl.paused && !videoEl.ended;

        // Synchro lecteur - uniquement si la piste change
        if (track && isPlaying && player?.isReady() && track.track_uri !== lastPlayedTrackUri) {
          playTrack(track);
        }

        // Résout l'album art en arrière-plan (apparaît au tick suivant)
        if (track && !albumArtCache.hasOwnProperty(track.track_uri)) {
          fetchAlbumArt(track.track_uri);
        }

        // Écrit dans le storage (le popup lit de là)
        writeStorage(track ? { ...track, isPlaying, posMs, albumArt: albumArtCache[track.track_uri] || null } : null);
      }
    }, 1000);
  }

  // ─── Storage → popup ─────────────────────────────────────────────────────────
  function writeStorage(track) {
    if (!ctxOk()) return;
    try {
      chrome.storage.local.set({ ss_now_playing: track || null });
    } catch (e) { /* contexte invalidé */ }
  }

  // ─── Calcul du track courant ──────────────────────────────────────────────────
  function getCurrentTrack(posMs) {
    const adjustedMs = posMs + audioOffsetMs;
    let current = null;
    for (const entry of timeline) {
      if (entry.track_started_at_stream_ms <= adjustedMs) current = entry;
      else break;
    }
    if (!current) return null;
    const next = getNextTrack(adjustedMs);
    const duration = next
      ? next.track_started_at_stream_ms - current.track_started_at_stream_ms
      : 4 * 60 * 1000;
    const offset_ms = adjustedMs - current.track_started_at_stream_ms;
    return {
      ...current,
      offset_ms,
      pct: Math.min(100, (offset_ms / duration) * 100),
      next: next ? { track_name: next.track_name, artist_name: next.artist_name } : null,
    };
  }

  function getNextTrack(posMs) {
    for (const entry of timeline) {
      if (entry.track_started_at_stream_ms > posMs) return entry;
    }
    return null;
  }

  // ─── Écoute des changements de préférence (toggle Spotify/YouTube depuis popup) ──
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.audioOffset) {
      audioOffsetMs = changes.audioOffset.newValue ?? 3000;
    }
    if (changes.playerChoice && changes.playerChoice.newValue !== player?.name) {
      loadPlayer().then(() => {
        // Si une vidéo joue, on force la reprise sur le nouveau lecteur
        if (videoEl && !videoEl.paused) {
          const track = getCurrentTrack(videoEl.currentTime * 1000);
          if (track) {
            lastPlayedTrackUri = null; // bypass dedup
            playTrack(track, true);
          }
        }
      });
    }
  });

  function stopExtension() {
    if (loopId) { clearInterval(loopId); loopId = null; }
    if (player) { player.destroy(); player = null; }
    writeStorage(null);
  }

  // ─── Navigation SPA ───────────────────────────────────────────────────────────
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url === lastUrl) return;
    lastUrl = url;
    if (loopId) { clearInterval(loopId); loopId = null; }
    if (player) { player.destroy(); player = null; }
    timeline = [];
    lastPlayedTrackUri = null;
    writeStorage(null);
    if (extractVideoId(url)) setTimeout(init, 1000);
  }).observe(document, { subtree: true, childList: true });

  // ─── Lancement ────────────────────────────────────────────────────────────────
  init();
})();

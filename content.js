// StreamSync — Content Script
// Injecté sur https://www.twitch.tv/videos/*

(function () {
  'use strict';

  // ─── État ────────────────────────────────────────────────────────────────────
  let timeline = [];
  let videoEl = null;
  let loopId = null;
  let spotifyConnected = false;

  let lastPlayedTrackUri = null;
  let lastPlayedOffsetBucket = -1;
  let lastStorageWriteMs = 0;

  function ctxOk() {
    try { return !!chrome.runtime?.id; } catch (e) { return false; }
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  function init() {
    const videoId = extractVideoId(location.href);
    if (!videoId) return;

    console.log('[StreamSync] VOD détectée, id =', videoId);

    safeSend({ type: 'SPOTIFY_STATUS' }, res => {
      spotifyConnected = res?.connected || false;
    });

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
      if (!spotifyConnected) return;
      const track = getCurrentTrack(videoEl.currentTime * 1000);
      if (track) sendSpotifyPlay(track, true);
    });

    videoEl.addEventListener('pause', () => {
      if (!spotifyConnected) return;
      // Débounce : attend 400ms avant de pauser Spotify
      // (annulé si play/seeked arrive entre-temps, ex: clic sur un timecode)
      cancelPause();
      pauseTimer = setTimeout(() => {
        if (videoEl.paused) safeSend({ type: 'SPOTIFY_PAUSE' });
      }, 400);
    });

    videoEl.addEventListener('seeked', () => {
      cancelPause();
      if (!spotifyConnected) return;
      const track = getCurrentTrack(videoEl.currentTime * 1000);
      // force=true : bypasse le bucket, le seek doit toujours être transmis
      if (track && !videoEl.paused) sendSpotifyPlay(track, true);
    });
  }

  // force=true : ignore la déduplication bucket (seek/play explicite)
  // force=false (défaut) : déduplique via bucket 3s (boucle RAF, changement de piste auto)
  function sendSpotifyPlay(track, force = false) {
    const bucket = Math.floor(track.offset_ms / 3000);
    if (!force && track.track_uri === lastPlayedTrackUri && bucket === lastPlayedOffsetBucket) return;
    chrome.storage.local.get(['autoPlay'], ({ autoPlay }) => {
      if (autoPlay === false) return;
      lastPlayedTrackUri = track.track_uri;
      lastPlayedOffsetBucket = bucket;
      safeSend({ type: 'SPOTIFY_PLAY', trackUri: track.track_uri, offsetMs: track.offset_ms });
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

        // Synchro Spotify — uniquement si la piste change
        if (track && isPlaying && spotifyConnected && track.track_uri !== lastPlayedTrackUri) {
          sendSpotifyPlay(track);
        }

        // Écrit dans le storage (le popup lit de là)
        writeStorage(track ? { ...track, isPlaying, posMs } : null);
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
    let current = null;
    for (const entry of timeline) {
      if (entry.track_started_at_stream_ms <= posMs) current = entry;
      else break;
    }
    if (!current) return null;
    const next = getNextTrack(posMs);
    const duration = next
      ? next.track_started_at_stream_ms - current.track_started_at_stream_ms
      : 4 * 60 * 1000;
    const offset_ms = posMs - current.track_started_at_stream_ms;
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

  // ─── Helpers ─────────────────────────────────────────────────────────────────
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

  function stopExtension() {
    if (loopId) { clearInterval(loopId); loopId = null; }
    writeStorage(null);
  }

  // ─── Navigation SPA ───────────────────────────────────────────────────────────
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url === lastUrl) return;
    lastUrl = url;
    if (loopId) { clearInterval(loopId); loopId = null; }
    timeline = [];
    lastPlayedTrackUri = null;
    writeStorage(null);
    if (extractVideoId(url)) setTimeout(init, 1000);
  }).observe(document, { subtree: true, childList: true });

  // ─── Lancement ────────────────────────────────────────────────────────────────
  init();
})();

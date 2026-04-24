// StreamSync - Content Script
// Injecté sur https://www.twitch.tv/videos/* et https://player.twitch.tv/?...&video=...
// Le viewer choisit son lecteur (Spotify ou YouTube) dans le popup, ce script
// orchestre la timeline VOD et envoie les commandes au lecteur sélectionné.

(function () {
  'use strict';

  // Guard d'idempotence : le popup peut re-injecter ce script via
  // chrome.scripting.executeScript quand le PING précédent a échoué (onglet
  // VOD ouvert avant installation, extension rechargée, etc.). Sans guard, on
  // dupliquerait MutationObserver, onMessage listener, setInterval et events
  // vidéo à chaque tentative d'injection.
  if (self.__streamsync_content_loaded) return;
  self.__streamsync_content_loaded = true;

  // ─── i18n (helper court pour les labels UI du lecteur YT) ────────────────────
  const i18n = self.SS_I18N;
  i18n?.loadLang();
  const _t = (key, vars) => (i18n ? i18n.t(key, vars) : key);

  // ─── État ────────────────────────────────────────────────────────────────────
  let timeline = [];
  let videoEl = null;
  let loopId = null;
  let player = null; // adapter actif (spotify ou youtube)

  let lastPlayedTrackUri = null;
  let lastPlayedOffsetBucket = -1;
  let audioOffsetMs = 3000; // Délai stream par défaut (3s)
  const albumArtCache = {}; // trackUri → imageUrl | null

  // URI spéciale insérée par le tracker backend quand le streamer met Spotify
  // en pause pendant le live. Signifie "pas de musique pendant ce segment".
  const PAUSE_TRACK_URI = 'streamsync:pause';

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
      // destroy ne doit pas réutiliser pause() : si on arrive ici via
      // stopExtension (contexte invalidé), safeSend rappellerait stopExtension
      // et créerait une boucle infinie. On tente le pause si le contexte est
      // encore valide, sinon on laisse Spotify Connect continuer (rare cas).
      destroy() {
        if (!connected) return;
        if (ctxOk()) safeSend({ type: 'SPOTIFY_PAUSE' });
        connected = false;
      },
    };
  }

  // ─── YouTube (iframe + IFrame Player API via postMessage) ───────────────────
  // Création paresseuse de l'iframe au premier play. Le viewer doit cliquer une
  // fois sur "Activer le son" car Chrome bloque l'audio auto dans les iframes.

  function createYoutubePlayer({ onRefresh } = {}) {
    const CONTAINER_ID = 'streamsync-yt-container';
    let iframe = null;
    let iframeReady = false;
    let currentVideoId = null;
    let pendingCmd = null; // { videoId, startSec } en attente du load
    let building = false; // évite double-build pendant le await storage
    const localCache = {}; // mémoire process : trackUri → videoId
    // Refs pour cleanup propre (destroy → loadPlayer rebuild ne doit pas leak)
    const windowListeners = []; // { type, fn }
    let volumeRafId = null;
    let pendingVolume = null;

    // Position/taille par défaut + clamp pour rester dans la viewport
    const DEFAULT_LAYOUT = { left: null, top: null, width: 280 }; // null = bottom-right
    const MIN_W = 200;
    const MAX_W = 720;

    function clampLayout(layout) {
      const w = Math.max(MIN_W, Math.min(MAX_W, layout.width || DEFAULT_LAYOUT.width));
      // Hauteur estimée : header seul en collapsed, sinon header + iframe + unmute btn
      const h = collapsed ? 36 : Math.round(w * 9 / 16) + 32 + 36;
      const vw = window.innerWidth, vh = window.innerHeight;
      let left = layout.left;
      let top = layout.top;
      if (left !== null) left = Math.max(0, Math.min(vw - w, left));
      if (top !== null) top = Math.max(0, Math.min(vh - h, top));
      return { left, top, width: w };
    }

    function applyLayout(container, layout) {
      const { left, top, width } = clampLayout(layout);
      container.style.width = `${width}px`;
      if (left !== null && top !== null) {
        container.style.left = `${left}px`;
        container.style.top = `${top}px`;
        container.style.right = 'auto';
        container.style.bottom = 'auto';
      } else {
        container.style.left = 'auto';
        container.style.top = 'auto';
        container.style.right = '20px';
        container.style.bottom = '20px';
      }
    }

    function saveLayout(layout) {
      try { chrome.storage.local.set({ ss_yt_layout: layout }); } catch (e) {}
    }

    function buildIframeUI() {
      const container = document.createElement('div');
      container.id = CONTAINER_ID;
      container.style.cssText = `
        position: fixed;
        background: #07080e;
        border: 1px solid rgba(255,107,74,0.3);
        border-radius: 12px;
        overflow: hidden;
        z-index: 2147483647;
        box-shadow: 0 16px 48px rgba(0,0,0,0.7);
        font-family: 'Outfit', system-ui, -apple-system, sans-serif;
      `;

      // Layout initial : on lit le storage en sync via la closure (déjà restauré
      // par l'appelant via initialLayout), sinon défaut bottom-right
      applyLayout(container, currentLayout);

      // Header avec label StreamSync (sert aussi de poignée de drag)
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
        cursor: grab;
        user-select: none;
      `;
      header.innerHTML = `
        <span style="display:flex;align-items:center;gap:6px;flex-shrink:0">
          <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#ff6b4a;box-shadow:0 0 8px #ff6b4a"></span>
          <span style="white-space:nowrap">StreamSync</span>
        </span>
        <div id="streamsync-yt-vol" style="display:flex;align-items:center;gap:6px;flex:1;justify-content:flex-end;cursor:default" data-no-drag="1">
          <button id="streamsync-yt-mute" type="button" title="${_t('yt.mute')}" style="background:transparent;border:0;color:#eaedf6;cursor:pointer;padding:2px;display:flex;align-items:center;opacity:0.85;transition:opacity 0.15s">
            <svg id="streamsync-yt-vol-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
          </button>
          <input id="streamsync-yt-vol-slider" type="range" min="0" max="100" value="80" style="width:80px;height:3px;-webkit-appearance:none;appearance:none;background:rgba(255,255,255,0.15);border-radius:2px;outline:none;cursor:pointer" />
          <button id="streamsync-yt-refresh" type="button" title="${_t('yt.refresh')}" style="background:transparent;border:0;color:#eaedf6;cursor:pointer;padding:2px;display:flex;align-items:center;opacity:0.6;transition:opacity 0.15s;margin-left:2px">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
          </button>
          <button id="streamsync-yt-collapse" type="button" title="${_t('yt.collapse')}" style="background:transparent;border:0;color:#eaedf6;cursor:pointer;padding:2px;display:flex;align-items:center;opacity:0.6;transition:opacity 0.15s;margin-left:2px">
            <svg id="streamsync-yt-collapse-icon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13H5v-2h14v2z"/></svg>
          </button>
        </div>
        <style>
          #streamsync-yt-vol-slider::-webkit-slider-thumb {
            -webkit-appearance: none; appearance: none;
            width: 11px; height: 11px; border-radius: 50%;
            background: #ff6b4a; cursor: pointer; border: 0;
            box-shadow: 0 0 4px rgba(255,107,74,0.6);
          }
          #streamsync-yt-vol-slider::-moz-range-thumb {
            width: 11px; height: 11px; border-radius: 50%;
            background: #ff6b4a; cursor: pointer; border: 0;
          }
          #streamsync-yt-mute:hover { opacity: 1 !important; }
        </style>
      `;

      // Iframe vide → on charge le premier morceau via postMessage(loadVideoById).
      // Factorisé pour permettre au bouton "refresh" de la recréer sans toucher
      // au container (garde layout, volume, collapsed state).
      function makeIframeEl() {
        const ifr = document.createElement('iframe');
        ifr.id = 'streamsync-yt-iframe';
        ifr.src = 'https://www.youtube.com/embed/?enablejsapi=1&autoplay=1&mute=1&controls=1&modestbranding=1&rel=0&playsinline=1';
        // Pas de picture-in-picture : certaines extensions tierces (PiP boutons
        // pour Twitch) énumèrent les iframes éligibles au PiP et ciblent la
        // nôtre avant la vidéo Twitch, ce qui casse notre iframe (la video
        // interne est déplacée par Chrome et ne revient pas proprement).
        // On ne perd rien, on ne veut que l'audio ; le PiP n'a jamais été exposé.
        ifr.allow = 'autoplay; encrypted-media';
        ifr.disablePictureInPicture = true;
        ifr.style.cssText = `
          display: ${collapsed ? 'none' : 'block'};
          width: 100%;
          aspect-ratio: 16 / 9;
          border: 0;
        `;
        ifr.addEventListener('load', () => {
          iframeReady = true;
          if (pendingCmd) {
            const { videoId, startSec } = pendingCmd;
            pendingCmd = null;
            loadVideo(videoId, startSec);
          }
        });
        return ifr;
      }
      iframe = makeIframeEl();

      // Bouton "Activer le son" (Chrome bloque l'audio auto en iframe)
      const unmuteBtn = document.createElement('button');
      unmuteBtn.id = 'streamsync-yt-unmute';
      unmuteBtn.textContent = `🔊 ${_t('yt.unmute.btn')}`;
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
      unmuteBtn.addEventListener('click', () => activateAudio());

      // ─── Contrôle volume custom ────────────────────────────────────────────
      const slider = header.querySelector('#streamsync-yt-vol-slider');
      const muteBtn = header.querySelector('#streamsync-yt-mute');
      const volIcon = header.querySelector('#streamsync-yt-vol-icon');
      slider.value = String(currentVolume);

      function updateVolIcon() {
        // 3 états : muet, bas, normal
        const v = muted ? 0 : currentVolume;
        let path;
        if (v === 0) {
          // Muet
          path = 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z';
        } else if (v < 50) {
          // Bas
          path = 'M7 9v6h4l5 5V4l-5 5H7zm9.5 3a4.5 4.5 0 0 0-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z';
        } else {
          // Normal
          path = 'M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z';
        }
        volIcon.innerHTML = `<path d="${path}"/>`;
      }

      // Courbe perceptuelle : l'oreille humaine perçoit le volume de manière
      // logarithmique, un slider linéaire "sonne" trop fort dès les petites
      // valeurs. Quadratique donne une progression bien plus naturelle (un
      // slider à 10 sort vraiment faible, 50 est un volume moyen, 100 max).
      // Floor à 1 quand slider > 0 : sans ça, Math.round(slider²/100) = 0 pour
      // slider ∈ [1, 7] → zone morte silencieuse et l'user qui baisse à fond
      // n'entend plus rien, doit remonter et tombe directement sur le 1er
      // niveau audible (trop fort de son point de vue).
      function toYtVolume(slider) {
        if (slider <= 0) return 0;
        return Math.max(1, Math.round((slider * slider) / 100));
      }

      // Helper unmute : utilisé par le bouton overlay, le slider, et le mute btn.
      // Tout interaction avec ces 3 contrôles compte comme user gesture pour
      // Chrome → on peut activer le son et virer l'overlay "Activer le son"
      function activateAudio() {
        muted = false;
        postCmd('unMute');
        postCmd('setVolume', [toYtVolume(currentVolume)]);
        updateVolIcon();
        unmuteBtn?.remove();
      }

      // Throttle rAF : sur un drag rapide, le slider 'input' peut tirer 60+/s.
      // Chaque postCmd = JSON.stringify + postMessage cross-origin → on
      // coalesce sur la dernière valeur via requestAnimationFrame.
      function flushVolume() {
        volumeRafId = null;
        if (pendingVolume === null) return;
        postCmd('setVolume', [pendingVolume]);
        pendingVolume = null;
      }
      slider.addEventListener('input', e => {
        currentVolume = Number(e.target.value);
        if (currentVolume > 0 && muted) activateAudio();
        else {
          pendingVolume = toYtVolume(currentVolume);
          if (volumeRafId === null) volumeRafId = requestAnimationFrame(flushVolume);
        }
        updateVolIcon();
      });
      slider.addEventListener('change', () => {
        try { chrome.storage.local.set({ ss_yt_volume: currentVolume }); } catch (e) {}
      });

      muteBtn.addEventListener('click', () => {
        if (muted) {
          activateAudio();
        } else {
          muted = true;
          postCmd('mute');
          updateVolIcon();
        }
      });

      updateVolIcon();

      // ─── Collapse / expand (mini-mode) ─────────────────────────────────────
      const collapseBtn = header.querySelector('#streamsync-yt-collapse');
      const collapseIcon = header.querySelector('#streamsync-yt-collapse-icon');
      // Icônes : collapse = trait horizontal (-), expand = chevron carré
      const ICON_COLLAPSE = '<path d="M19 13H5v-2h14v2z"/>';
      const ICON_EXPAND = '<path d="M4 8l8 8 8-8H4z" transform="rotate(180 12 12)"/>';

      function applyCollapsed(state) {
        collapsed = !!state;
        const visible = collapsed ? 'none' : '';
        iframe.style.display = collapsed ? 'none' : 'block';
        if (unmuteBtn?.parentNode) unmuteBtn.style.display = visible;
        unavailable.style.display = collapsed ? 'none' : (unavailable.dataset.shown === '1' ? 'flex' : 'none');
        resizeHandle.style.display = visible;
        collapseIcon.innerHTML = collapsed ? ICON_EXPAND : ICON_COLLAPSE;
        collapseBtn.title = collapsed ? _t('yt.expand') : _t('yt.collapse');
      }

      collapseBtn.addEventListener('click', () => {
        applyCollapsed(!collapsed);
        try { chrome.storage.local.set({ ss_yt_collapsed: collapsed }); } catch (e) {}
      });

      // Overlay "track non dispo sur YouTube" — affiché par-dessus l'iframe
      // quand resolveVideoId retourne null. Hidden par défaut.
      const unavailable = document.createElement('div');
      unavailable.id = 'streamsync-yt-unavailable';
      unavailable.style.cssText = `
        position: absolute;
        top: 32px; left: 0; right: 0;
        aspect-ratio: 16 / 9;
        display: none;
        flex-direction: column;
        align-items: center; justify-content: center; gap: 8px;
        padding: 16px;
        background: rgba(7,8,14,0.92);
        color: #eaedf6;
        font-family: inherit;
        text-align: center;
        z-index: 1;
        backdrop-filter: blur(4px);
      `;
      unavailable.innerHTML = `
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgba(255,107,74,0.7)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
        </svg>
        <div style="font-size:11px;font-weight:700;color:#ff9a76;letter-spacing:0.04em;text-transform:uppercase">${_t('yt.unavailable')}</div>
        <div id="streamsync-yt-unavailable-track" style="font-size:11px;color:#7a82a6;line-height:1.4;max-width:280px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical"></div>
      `;
      container.appendChild(unavailable);

      // Poignée de resize en bas-droite (largeur uniquement, height suit l'aspect ratio)
      const resizeHandle = document.createElement('div');
      resizeHandle.style.cssText = `
        position: absolute;
        right: 0; bottom: 0;
        width: 16px; height: 16px;
        cursor: nwse-resize;
        z-index: 2;
        background: linear-gradient(135deg, transparent 50%, rgba(255,107,74,0.6) 50%, rgba(255,107,74,0.6) 65%, transparent 65%, transparent 75%, rgba(255,107,74,0.6) 75%, rgba(255,107,74,0.6) 90%, transparent 90%);
      `;

      // Restaure l'état au mount (currentCollapsed est setté par ensureIframe).
      // Doit rester APRÈS les déclarations de `unavailable` et `resizeHandle`
      // car applyCollapsed() les référence — sinon TDZ ReferenceError.
      if (currentCollapsed) applyCollapsed(true);

      container.appendChild(header);
      container.appendChild(iframe);
      container.appendChild(unmuteBtn);
      container.appendChild(resizeHandle);
      document.body.appendChild(container);

      // L'iframe YouTube capture les events souris : on la rend transparente
      // aux clics pendant le drag/resize pour ne pas perdre le mouseup
      const setIframePassthrough = on => { iframe.style.pointerEvents = on ? 'none' : ''; };

      // ─── Drag du modal via le header ───────────────────────────────────────
      let dragOffset = null;
      header.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        // Ignore les clics sur le contrôle volume (slider, bouton mute)
        if (e.target.closest('[data-no-drag]')) return;
        const rect = container.getBoundingClientRect();
        dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        header.style.cursor = 'grabbing';
        setIframePassthrough(true);
        e.preventDefault();
      });
      const onDragMove = e => {
        if (!dragOffset) return;
        currentLayout = clampLayout({
          left: e.clientX - dragOffset.x,
          top: e.clientY - dragOffset.y,
          width: currentLayout.width,
        });
        applyLayout(container, currentLayout);
      };
      const onDragEnd = () => {
        if (!dragOffset) return;
        dragOffset = null;
        header.style.cursor = 'grab';
        setIframePassthrough(false);
        saveLayout(currentLayout);
      };
      window.addEventListener('mousemove', onDragMove);
      window.addEventListener('mouseup', onDragEnd);
      windowListeners.push({ type: 'mousemove', fn: onDragMove }, { type: 'mouseup', fn: onDragEnd });

      // ─── Resize du modal via la poignée bas-droite ─────────────────────────
      let resizeStart = null;
      resizeHandle.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        const rect = container.getBoundingClientRect();
        // Si on était en bottom-right (left/top null), on fige la position courante
        if (currentLayout.left === null) {
          currentLayout = { left: rect.left, top: rect.top, width: currentLayout.width };
        }
        resizeStart = { x: e.clientX, w: currentLayout.width };
        setIframePassthrough(true);
        e.preventDefault();
        e.stopPropagation();
      });
      const onResizeMove = e => {
        if (!resizeStart) return;
        currentLayout = clampLayout({
          left: currentLayout.left,
          top: currentLayout.top,
          width: resizeStart.w + (e.clientX - resizeStart.x),
        });
        applyLayout(container, currentLayout);
      };
      const onResizeEnd = () => {
        if (!resizeStart) return;
        resizeStart = null;
        setIframePassthrough(false);
        saveLayout(currentLayout);
      };
      window.addEventListener('mousemove', onResizeMove);
      window.addEventListener('mouseup', onResizeEnd);
      windowListeners.push({ type: 'mousemove', fn: onResizeMove }, { type: 'mouseup', fn: onResizeEnd });

      // ─── Bouton refresh ────────────────────────────────────────────────────
      // Recrée l'iframe dans le même container (layout/volume/collapsed
      // préservés) et notifie l'orchestrateur pour resync la piste courante.
      const refreshBtn = header.querySelector('#streamsync-yt-refresh');
      refreshBtn.addEventListener('mouseenter', () => { refreshBtn.style.opacity = '1'; });
      refreshBtn.addEventListener('mouseleave', () => { refreshBtn.style.opacity = '0.6'; });
      refreshBtn.addEventListener('click', () => {
        // Petite rotation visuelle pour feedback
        refreshBtn.firstElementChild?.animate(
          [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
          { duration: 500, easing: 'ease-out' }
        );
        const wasUnmuted = !muted;
        const next = iframe.nextSibling;
        const parent = iframe.parentNode;
        iframe.remove();
        iframe = null;
        iframeReady = false;
        currentVideoId = null;
        pendingCmd = null;
        iframe = makeIframeEl();
        if (next) parent.insertBefore(iframe, next);
        else parent.appendChild(iframe);
        // Nouvelle iframe = src avec mute=1, donc démarre muette.
        // Si l'user avait activé l'audio avant refresh, on le restaure au load.
        if (wasUnmuted) {
          iframe.addEventListener('load', () => {
            postCmd('unMute');
            postCmd('setVolume', [toYtVolume(currentVolume)]);
          }, { once: true });
        }
        if (typeof onRefresh === 'function') onRefresh();
      });
    }

    // Layout courant (mis à jour par drag/resize, persisté sur mouseup)
    let currentLayout = { ...DEFAULT_LAYOUT };
    let currentVolume = 80;
    let muted = true; // démarre muté à cause du autoplay policy
    let currentCollapsed = false;
    let collapsed = false;

    function ensureIframe() {
      // Twitch peut ré-render son DOM (changement de qualité, ad break, toggle
      // theatre, navigation SPA sans URL change) et arracher notre container
      // sans qu'on soit notifié. Sans ce check, la closure garde iframe!=null
      // et l'early-return ci-dessous empêche toute reconstruction → lecteur
      // fantôme. On détecte aussi le cas où une extension tierce (PiP, etc.)
      // déplace notre iframe hors de son container → on reset et rebuild.
      const ctn = document.getElementById(CONTAINER_ID);
      if (iframe && (!document.body.contains(iframe) || !ctn || !ctn.contains(iframe))) {
        windowListeners.forEach(({ type, fn }) => window.removeEventListener(type, fn));
        windowListeners.length = 0;
        if (loadSeekTimer) { clearTimeout(loadSeekTimer); loadSeekTimer = null; }
        if (volumeRafId !== null) { cancelAnimationFrame(volumeRafId); volumeRafId = null; }
        pendingVolume = null;
        iframe = null;
        iframeReady = false;
        currentVideoId = null;
        pendingCmd = null;
        // Nettoie un éventuel container orphelin (ex: iframe déplacée ailleurs
        // par une extension tierce mais container resté en place) pour éviter
        // un doublon après rebuild.
        ctn?.remove();
      }
      if (iframe || building) return;
      building = true;
      // storageGet wrappe déjà try/catch et retourne {} si le contexte est mort
      storageGet(['ss_yt_layout', 'ss_yt_volume', 'ss_yt_collapsed']).then(({ ss_yt_layout, ss_yt_volume, ss_yt_collapsed }) => {
        if (ss_yt_layout) currentLayout = { ...DEFAULT_LAYOUT, ...ss_yt_layout };
        if (typeof ss_yt_volume === 'number') currentVolume = Math.max(0, Math.min(100, ss_yt_volume));
        currentCollapsed = !!ss_yt_collapsed;
        buildIframeUI();
        building = false;
      });
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

    let loadSeekTimer = null;
    function loadVideo(videoId, startSec) {
      const start = Math.max(0, startSec);
      postCmd('loadVideoById', [{
        videoId,
        startSeconds: start,
        suggestedQuality: 'small',
      }]);
      currentVideoId = videoId;
      // Backup : startSeconds dans loadVideoById est souvent ignoré quand on
      // switch de vidéo en vol via postMessage. On enforce la position via
      // seekTo après que la vidéo ait eu le temps de se charger.
      if (loadSeekTimer) clearTimeout(loadSeekTimer);
      loadSeekTimer = setTimeout(() => {
        if (currentVideoId === videoId) {
          postCmd('seekTo', [start, true]);
          postCmd('playVideo');
        }
      }, 700);
    }

    function showUnavailable(track) {
      const el = document.getElementById('streamsync-yt-unavailable');
      if (!el) return;
      const trackEl = document.getElementById('streamsync-yt-unavailable-track');
      if (trackEl) trackEl.textContent = `${track.track_name || ''} · ${track.artist_name || ''}`;
      el.dataset.shown = '1';
      // Pas d'affichage si le modal est en mini-mode
      if (!collapsed) el.style.display = 'flex';
    }

    function hideUnavailable() {
      const el = document.getElementById('streamsync-yt-unavailable');
      if (el) { el.dataset.shown = '0'; el.style.display = 'none'; }
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
        // Pas une vraie erreur : l'overlay "Pas de version YouTube" sur le
        // modal informe déjà le viewer. Log en info pour éviter le triangle
        // jaune dans la console.
        console.info('[StreamSync] Pas de résolution YouTube pour', track.track_name);
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
      async init() {
        // Build l'iframe tout de suite pour que le lecteur soit visible
        // même avant le premier play (ex: viewer qui arrive sur un timecode
        // pré-intro sans musique). Évite le cas "j'ai rafraîchi la page et
        // le lecteur a disparu".
        ensureIframe();
      },
      // Appelé par la boucle principale pour détecter un arrachage du container
      // par un re-render Twitch et le remonter automatiquement.
      ensureMounted() { ensureIframe(); },
      isReady() { return true; },
      async play(track, offsetMs) {
        ensureIframe();
        const videoId = await resolveVideoId(track);

        if (!videoId) {
          // Pas de match YouTube : on coupe la lecture précédente et on
          // affiche un overlay sur l'iframe pour informer le viewer
          showUnavailable(track);
          postCmd('pauseVideo');
          currentVideoId = null;
          return;
        }

        hideUnavailable();
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
        // Cleanup propre : la destroy peut être suivie d'un nouveau
        // createYoutubePlayer (toggle player, change de langue) → sans ça, les
        // mousemove/mouseup window s'empilent à chaque cycle.
        windowListeners.forEach(({ type, fn }) => window.removeEventListener(type, fn));
        windowListeners.length = 0;
        if (loadSeekTimer) { clearTimeout(loadSeekTimer); loadSeekTimer = null; }
        if (volumeRafId !== null) { cancelAnimationFrame(volumeRafId); volumeRafId = null; }
        pendingVolume = null;
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
    if (choice === 'youtube') {
      // onRefresh : le bouton refresh du lecteur YT demande à l'orchestrateur
      // de relancer la piste courante après rebuild de l'iframe.
      // Si la VOD est en pause, on ne joue rien : le play redémarrerait le son
      // sans que l'user ait cliqué play. L'iframe reste vide jusqu'à la reprise.
      player = createYoutubePlayer({
        onRefresh: () => {
          if (!videoEl || videoEl.paused) return;
          const track = getCurrentTrack(videoEl.currentTime * 1000);
          if (!track) return;
          lastPlayedTrackUri = null; // bypass dedup
          playTrack(track, true);
        },
      });
    } else {
      player = createSpotifyPlayer();
    }
    await player.init();
    console.log(`[StreamSync] Player actif : ${player.name}`);
  }

  // Quand l'user change la langue depuis le popup, on rebuilde le lecteur YT
  // pour que tous les labels (tooltips, overlay "Pas de version YouTube", etc.)
  // repassent par _t() avec la nouvelle langue.
  i18n?.onLangChange?.(() => {
    if (player?.name !== 'youtube') return;
    loadPlayer().then(() => {
      if (videoEl && !videoEl.paused) {
        const track = getCurrentTrack(videoEl.currentTime * 1000);
        if (track) { lastPlayedTrackUri = null; playTrack(track, true); }
      }
    });
  });

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
        // Pas une vraie erreur dans la majorité des cas (404 = VOD non trackée
        // par le streamer, sub_only, free_plan_limit, etc.). Le popup affiche
        // déjà le détail via writeVodError → on log en info, pas en warn.
        console.info('[StreamSync]', response?.error);
        writeStorage(null);
        clearTimeline();
        writeVodError(response?.errorCode || response?.error || 'unknown', response?.errorData || null);
        return;
      }

      clearVodError();
      timeline = response.data.timeline;
      if (!timeline.length) { writeStorage(null); return; }

      // Expose la timeline au popup (pour la tracklist + boutons next/prev).
      // Champs nécessaires : track_started_at_stream_ms, track_uri, track_name, artist_name.
      writeTimeline(videoId, timeline);

      console.log(`[StreamSync] ${timeline.length} morceaux chargés`);

      waitForVideo().then(video => {
        videoEl = video;
        attachVideoListeners();
        startLoop();
      });
    });
  }

  // ─── Extraction du video ID ───────────────────────────────────────────────────
  // Supporte deux formats :
  //   - VOD classique : https://www.twitch.tv/videos/2748835554
  //   - Player popout : https://player.twitch.tv/?...&video=2748835554&...
  function extractVideoId(url) {
    const m = url.match(/twitch\.tv\/videos\/(\d+)/);
    if (m) return m[1];
    const pm = url.match(/player\.twitch\.tv\/[^#]*[?&]video=(\d+)/);
    return pm ? pm[1] : null;
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
      const isNewTrack = track.track_uri !== lastPlayedTrackUri;
      lastPlayedTrackUri = track.track_uri;
      lastPlayedOffsetBucket = bucket;
      player.play(track, track.offset_ms);
      // Notification au changement naturel uniquement (pas sur seek manuel)
      if (!force && isNewTrack) maybeNotifyTrackChange(track);
    });
  }

  // Notification desktop au changement de morceau (opt-in via toggle Paramètres)
  let lastNotifiedTrackUri = null;
  let lastNotifiedAt = 0;
  function maybeNotifyTrackChange(track) {
    if (!ctxOk()) return;
    const now = Date.now();
    // Cooldown 4s : évite le spam sur DJ sets ou changements rapides
    if (track.track_uri === lastNotifiedTrackUri) return;
    if (now - lastNotifiedAt < 4000) return;
    lastNotifiedTrackUri = track.track_uri;
    lastNotifiedAt = now;
    safeSend({
      type: 'NOTIFY_TRACK_CHANGE',
      track: {
        track_name: track.track_name,
        artist_name: track.artist_name,
        track_uri: track.track_uri,
        albumArt: albumArtCache[track.track_uri] || null,
      },
    });
  }

  // ─── Boucle principale (setInterval pour tourner même quand l'onglet est en arrière-plan) ──
  // Filet de sécurité pause/play : certaines navigations SPA Twitch recréent
  // le <video>, les events pause/play peuvent rater. Le loop détecte la
  // transition et envoie la commande au lecteur.
  let lastLoopPaused = null;
  function startLoop() {
    if (loopId) clearInterval(loopId);
    lastLoopPaused = null;

    loopId = setInterval(() => {
      if (!ctxOk()) { stopExtension(); return; }

      // Twitch peut recréer <video> (changement de qualité, ad, navigation SPA).
      // On re-attache les listeners sur le nouvel élément sinon play/pause ratent.
      const currentVideo = document.querySelector('video');
      if (currentVideo && currentVideo !== videoEl) {
        videoEl = currentVideo;
        attachVideoListeners();
        lastLoopPaused = null; // reset pour éviter une commande fantôme
      }

      if (videoEl) {
        // Remount le lecteur YT si Twitch a arraché le container via un
        // re-render SPA sans URL change (ad break, toggle theatre, etc.)
        player?.ensureMounted?.();

        const posMs = videoEl.currentTime * 1000;
        const track = getCurrentTrack(posMs);
        const isPlaying = !videoEl.paused && !videoEl.ended;

        // Synchro lecteur - uniquement si la piste change
        if (track && isPlaying && player?.isReady() && track.track_uri !== lastPlayedTrackUri) {
          playTrack(track);
        }

        // Segment de pause streamer : la timeline ne renvoie plus de track.
        // On coupe le lecteur côté viewer pour refléter le silence du live.
        if (!track && player?.isReady() && lastPlayedTrackUri) {
          player.pause();
          lastPlayedTrackUri = null;
          lastPlayedOffsetBucket = -1;
        }

        // Fallback pause : si le loop voit la transition play→pause, on envoie
        // la commande même si le listener 'pause' a raté. La reprise est gérée
        // par l'event 'play' et la re-synchro automatique plus haut.
        if (player?.isReady() && lastLoopPaused === false && !isPlaying) {
          player.pause();
        }
        lastLoopPaused = !isPlaying;

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

  // Expose la timeline VOD au popup (lecture seule). On filtre les marqueurs
  // de pause : la tracklist ne montre que les morceaux réellement joués.
  function writeTimeline(vodId, entries) {
    if (!ctxOk()) return;
    try {
      const tracks = entries
        .filter(e => e.track_uri !== PAUSE_TRACK_URI)
        .map(e => ({
          stream_position_ms: e.track_started_at_stream_ms,
          track_uri: e.track_uri,
          track_name: e.track_name,
          artist_name: e.artist_name,
        }));
      chrome.storage.local.set({ ss_timeline: { vodId, tracks, audioOffsetMs } });
    } catch (e) {}
  }

  function clearTimeline() {
    if (!ctxOk()) return;
    try { chrome.storage.local.set({ ss_timeline: null }); } catch (e) {}
  }

  // ─── Messages venant du popup (seek, next, prev) ──────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // PING : permet au popup de vérifier que le content script est bien injecté
    // (cas "extension installée/rechargée alors que la VOD était déjà ouverte"
    // → on invite l'user à F5 depuis le popup)
    if (msg?.type === 'PING') {
      sendResponse?.({ ok: true });
      return;
    }

    // Force-remount du lecteur YT (bouton debug popup). On destroy le player
    // courant et on rebuilde via loadPlayer ; si une piste est en cours on la
    // relance pour que le viewer retrouve immédiatement son son.
    if (msg?.type === 'FORCE_YT_REMOUNT') {
      loadPlayer().then(() => {
        if (videoEl && !videoEl.paused) {
          const track = getCurrentTrack(videoEl.currentTime * 1000);
          if (track) { lastPlayedTrackUri = null; playTrack(track, true); }
        }
        sendResponse?.({ ok: true });
      }).catch(err => {
        sendResponse?.({ ok: false, error: String(err?.message || err) });
      });
      return true; // réponse asynchrone
    }

    // Re-fetch de la timeline VOD après un upgrade de plan côté popup.
    // Sans ça, l'ancien ss_vod_error (ex: free_plan_limit) resterait en storage
    // et le popup garderait l'ancien message jusqu'à un F5 manuel.
    if (msg?.type === 'RETRY_VOD_FETCH') {
      const videoId = extractVideoId(location.href);
      if (!videoId) { sendResponse?.({ ok: false, error: 'no_vod' }); return; }
      safeSend({ type: 'FETCH_VOD_TIMELINE', videoId }, response => {
        if (!response?.ok) {
          writeStorage(null);
          clearTimeline();
          writeVodError(response?.errorCode || response?.error || 'unknown', response?.errorData || null);
          sendResponse?.({ ok: false, error: response?.error });
          return;
        }
        clearVodError();
        timeline = response.data.timeline;
        if (!timeline.length) { writeStorage(null); sendResponse?.({ ok: true, empty: true }); return; }
        writeTimeline(videoId, timeline);
        sendResponse?.({ ok: true });
      });
      return true;
    }

    if (!videoEl) { sendResponse?.({ ok: false, error: 'no_video' }); return; }

    if (msg?.type === 'SEEK_TO_STREAM_POSITION') {
      // stream_position_ms → vod time = (stream_position_ms - audioOffsetMs) / 1000
      const targetSec = Math.max(0, (msg.streamPositionMs - audioOffsetMs) / 1000);
      videoEl.currentTime = targetSec;
      if (videoEl.paused) videoEl.play().catch(() => {});
      sendResponse?.({ ok: true });
      return;
    }

    if (msg?.type === 'SEEK_RELATIVE') {
      // direction: 'next' | 'prev'
      // Les marqueurs de pause ne sont pas des cibles de navigation
      const realTracks = timeline.filter(t => t.track_uri !== PAUSE_TRACK_URI);
      const adjustedMs = videoEl.currentTime * 1000 + audioOffsetMs;
      let target = null;
      if (msg.direction === 'next') {
        target = realTracks.find(t => t.track_started_at_stream_ms > adjustedMs + 1000);
      } else {
        // Précédent : si on est à <3s du début du track courant, on remonte 2 morceaux ;
        // sinon on revient au début du track courant
        let current = null, prev = null;
        for (const t of realTracks) {
          if (t.track_started_at_stream_ms <= adjustedMs) { prev = current; current = t; }
          else break;
        }
        const elapsed = current ? adjustedMs - current.track_started_at_stream_ms : 0;
        target = (elapsed < 3000 && prev) ? prev : current;
      }
      if (!target) { sendResponse?.({ ok: false, error: 'no_target' }); return; }
      videoEl.currentTime = Math.max(0, (target.track_started_at_stream_ms - audioOffsetMs) / 1000);
      if (videoEl.paused) videoEl.play().catch(() => {});
      sendResponse?.({ ok: true });
      return;
    }
  });

  // Erreur de chargement VOD (ex: free_plan_limit) pour le popup
  function writeVodError(code, data) {
    if (!ctxOk()) return;
    try {
      chrome.storage.local.set({ ss_vod_error: { code, data } });
    } catch (e) { /* contexte invalidé */ }
  }

  function clearVodError() {
    if (!ctxOk()) return;
    try {
      chrome.storage.local.set({ ss_vod_error: null });
    } catch (e) { /* contexte invalidé */ }
  }

  // ─── Calcul du track courant ──────────────────────────────────────────────────
  // Sélection de l'entry "actif" à une position VOD donnée.
  // Subtilité : après une pause, l'entry de reprise peut avoir un
  // track_started_at_stream_ms < pause.stream_position_ms (ex: Song A pausée à
  // 60s de progrès puis reprise 1min plus tard → started_at "remonte" avant
  // la pause). On force donc une gate stricte sur stream_position_ms pour les
  // entries qui suivent un marqueur de pause.
  function pickCurrentEntry(adjustedMs) {
    let current = null;
    let hadPauseSince = false;
    for (const entry of timeline) {
      if (entry.track_uri === PAUSE_TRACK_URI) {
        if (entry.stream_position_ms > adjustedMs) break;
        current = entry;
        hadPauseSince = true;
        continue;
      }
      if (hadPauseSince) {
        // Post-pause : l'entry doit avoir été réellement observée par le
        // tracker avant le VOD time courant, pas juste "inférée via progrès"
        if (entry.stream_position_ms > adjustedMs) continue;
        current = entry;
        hadPauseSince = false;
      } else {
        // Comportement historique : inférence backwards via started_at
        if (entry.track_started_at_stream_ms <= adjustedMs) current = entry;
        else break;
      }
    }
    return current;
  }

  function getCurrentTrack(posMs) {
    const adjustedMs = posMs + audioOffsetMs;
    const current = pickCurrentEntry(adjustedMs);
    if (!current) return null;
    // Marqueur de pause : on remonte "pas de track actif" au lieu du marqueur
    if (current.track_uri === PAUSE_TRACK_URI) return null;
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
      // Les marqueurs de pause ne sont pas des "tracks" à afficher
      if (entry.track_uri === PAUSE_TRACK_URI) continue;
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

  let stopped = false;
  function stopExtension() {
    // Idempotent : stopExtension peut être appelé en cascade depuis safeSend
    // quand le contexte est invalidé. Sans ce guard → stack overflow.
    if (stopped) return;
    stopped = true;
    if (loopId) { clearInterval(loopId); loopId = null; }
    if (player) { try { player.destroy(); } catch (e) {} player = null; }
    if (ctxOk()) writeStorage(null);
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
    clearTimeline();
    clearVodError();
    if (extractVideoId(url)) setTimeout(init, 1000);
  }).observe(document, { subtree: true, childList: true });

  // ─── Lancement ────────────────────────────────────────────────────────────────
  init();
})();

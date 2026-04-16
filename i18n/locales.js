// Traductions centralisées pour popup, content script et service worker.
// Chargé via <script> dans popup.html, via manifest.content_scripts.js pour
// le content script, via importScripts() dans le service worker.
// FR = langue par défaut. EN dispo via un toggle dans les paramètres.

(function (g) {
  g.SS_LOCALES = {
    fr: {
      // Header / Tabs
      'tabs.home': 'Accueil',
      'tabs.settings': 'Paramètres',

      // Home panel
      'np.idle': 'Ouvre une rediffusion Twitch pour commencer',
      'np.f5hint.msg': 'Extension activée. Appuie sur {kbd} pour synchroniser la rediffusion.',
      'np.f5hint.key': 'F5',
      'np.other': 'Actif sur {label}',
      'np.other.fallback': 'un onglet de rediffusion',

      // Tracklist
      'tracklist.title': 'Morceaux de la rediffusion',
      'tracklist.count.one': '{n} morceau',
      'tracklist.count.many': '{n} morceaux',

      // Lecteur audio
      'player.label': 'Lecteur audio',
      'yt.label': 'YouTube',
      'yt.info1': "Le lecteur YouTube s'affiche en bas à droite de la rediffusion.",
      'yt.info2': 'Clique sur {btn} à la première lecture (Chrome bloque l\'audio auto).',
      'yt.info.activate': 'Activer le son',

      // Devices
      'devices.label': 'Appareil de lecture',
      'devices.refresh': 'Actualiser',
      'devices.loading': 'Chargement…',
      'devices.empty.title': 'Aucun appareil Spotify détecté',
      'devices.empty.hint': 'Ouvre l\'app Spotify et lance (ou mets en pause) une musique pour qu\'elle apparaisse ici.',
      'devices.free.title': 'Compte Spotify Free détecté',
      'devices.free.desc.html': 'StreamSync a besoin d\'un abonnement <strong>Premium</strong> pour piloter la lecture en sync avec la rediffusion.',
      'devices.free.cta': 'S\'abonner à Premium →',

      // Settings panel
      'settings.playback': 'Lecture',
      'settings.autoplay.name': 'Lecture automatique',
      'settings.autoplay.desc': 'Lance le lecteur automatiquement en regardant une rediffusion',
      'settings.offset.name': 'Décalage audio',
      'settings.offset.desc': 'Compense le délai du stream',
      'settings.offset.tooltip': 'Cliquer pour saisir une valeur',
      'settings.notifs.name': 'Notifications de morceau',
      'settings.notifs.desc': 'Affiche une notification desktop à chaque changement de track',
      'settings.tracklist.name': 'Tracklist de la rediffusion',
      'settings.tracklist.desc': 'Affiche la liste des morceaux joués pendant le live dans le popup',
      'settings.appearance': 'Apparence',
      'settings.theme.name': 'Thème clair',
      'settings.theme.desc': 'Bascule entre le mode sombre et le mode clair',
      'settings.lang.name': 'Langue',
      'settings.lang.desc': 'Change la langue de l\'extension',

      // Spotify status / config
      'spotify.label': 'Spotify',
      'spotify.status': 'Statut',
      'spotify.connected': 'Connecté',
      'spotify.disconnected': 'Non connecté',
      'spotify.disconnect': 'Déconnecter',
      'spotify.configTitle': 'Configuration Spotify',
      'spotify.step1.title': 'Copie cette Redirect URI',
      'spotify.step1.hint': '↑ Clique pour copier',
      'spotify.step1.tooltip': 'Cliquer pour copier',
      'spotify.step2.title.part1': 'Crée une app sur',
      'spotify.step2.sub.html': '→ Clique <strong>Create app</strong><br>→ Nom : StreamSync (ou autre)<br>→ Redirect URI : colle l\'URI du dessus<br>→ Coche <strong>Web API</strong> → <strong>Save</strong>',
      'spotify.step3.title': 'Entre ton Client ID',
      'spotify.step3.sub.html': 'Sur la page de l\'app que tu viens de créer (<a href="https://developer.spotify.com/dashboard" target="_blank" class="link">Dashboard</a>) → <strong>Settings</strong> → copie le <strong>Client ID</strong>',
      'spotify.step3.warn': 'Pas dans l\'appli de musique Spotify : il s\'agit de l\'app dev créée à l\'étape 2.',
      'spotify.clientId.placeholder': 'Client ID Spotify',
      'spotify.connect': 'Connecter Spotify',
      'spotify.copied': '✓ Copié !',

      // Footer
      'footer.madeBy': 'Fait par',
      'footer.feedback': 'Feedback',

      // YouTube overlay (content script)
      'yt.mute': 'Muet',
      'yt.unmute.btn': 'Activer le son',
      'yt.refresh': 'Actualiser le lecteur',
      'yt.collapse': 'Réduire',
      'yt.expand': 'Agrandir',
      'yt.unavailable': 'Pas de version YouTube',

      // Erreurs remontées depuis le service worker
      'err.clientIdMissing': 'Spotify Client ID non configuré dans le popup',
      'err.authCancelled': 'Auth annulée',
      'err.redirectUri': 'Redirect URI incorrect. Vérifie qu\'elle est bien copiée à l\'identique dans ton app Spotify Developer Dashboard.',
      'err.accessDenied': 'Tu as refusé l\'autorisation Spotify.',
      'err.invalidClient': 'Client ID invalide. Vérifie que tu as bien copié le Client ID de ton app Spotify.',
      'err.invalidScope': 'Scope invalide. L\'app Spotify doit avoir la Web API activée.',
      'err.noCode': 'Réponse Spotify invalide (pas de code). Vérifie ton Redirect URI dans le dashboard Spotify.',
      'err.tokenExchange': 'Échange de token échoué',
      'err.notConnected': 'Spotify non connecté',
      'err.refreshFailed': 'Refresh token Spotify échoué',
      'err.openSpotifyFirst': 'Ouvre Spotify sur ton PC ou téléphone d\'abord',
    },
    en: {
      'tabs.home': 'Home',
      'tabs.settings': 'Settings',

      'np.idle': 'Open a Twitch VOD to get started',
      'np.f5hint.msg': 'Extension enabled. Press {kbd} to sync the VOD.',
      'np.f5hint.key': 'F5',
      'np.other': 'Active on {label}',
      'np.other.fallback': 'a Twitch replay tab',

      'tracklist.title': 'VOD tracklist',
      'tracklist.count.one': '{n} track',
      'tracklist.count.many': '{n} tracks',

      'player.label': 'Audio player',
      'yt.label': 'YouTube',
      'yt.info1': 'The YouTube player appears at the bottom right of the VOD.',
      'yt.info2': 'Click {btn} on the first play (Chrome blocks auto-audio).',
      'yt.info.activate': 'Enable sound',

      'devices.label': 'Playback device',
      'devices.refresh': 'Refresh',
      'devices.loading': 'Loading…',
      'devices.empty.title': 'No Spotify device detected',
      'devices.empty.hint': 'Open the Spotify app and play (or pause) a song so it appears here.',
      'devices.free.title': 'Spotify Free account detected',
      'devices.free.desc.html': 'StreamSync needs a <strong>Premium</strong> subscription to drive playback in sync with the VOD.',
      'devices.free.cta': 'Subscribe to Premium →',

      'settings.playback': 'Playback',
      'settings.autoplay.name': 'Autoplay',
      'settings.autoplay.desc': 'Automatically starts the player when watching a VOD',
      'settings.offset.name': 'Audio offset',
      'settings.offset.desc': 'Compensates for stream delay',
      'settings.offset.tooltip': 'Click to enter a value',
      'settings.notifs.name': 'Track notifications',
      'settings.notifs.desc': 'Shows a desktop notification on each track change',
      'settings.tracklist.name': 'VOD tracklist',
      'settings.tracklist.desc': 'Shows the list of tracks played during the live inside the popup',
      'settings.appearance': 'Appearance',
      'settings.theme.name': 'Light theme',
      'settings.theme.desc': 'Toggle between dark and light mode',
      'settings.lang.name': 'Language',
      'settings.lang.desc': 'Change the extension language',

      'spotify.label': 'Spotify',
      'spotify.status': 'Status',
      'spotify.connected': 'Connected',
      'spotify.disconnected': 'Not connected',
      'spotify.disconnect': 'Disconnect',
      'spotify.configTitle': 'Spotify configuration',
      'spotify.step1.title': 'Copy this Redirect URI',
      'spotify.step1.hint': '↑ Click to copy',
      'spotify.step1.tooltip': 'Click to copy',
      'spotify.step2.title.part1': 'Create an app on',
      'spotify.step2.sub.html': '→ Click <strong>Create app</strong><br>→ Name: StreamSync (or anything)<br>→ Redirect URI: paste the URI above<br>→ Tick <strong>Web API</strong> → <strong>Save</strong>',
      'spotify.step3.title': 'Enter your Client ID',
      'spotify.step3.sub.html': 'On the page of the app you just created (<a href="https://developer.spotify.com/dashboard" target="_blank" class="link">Dashboard</a>) → <strong>Settings</strong> → copy the <strong>Client ID</strong>',
      'spotify.step3.warn': 'Not in the Spotify music app: this is the dev app created in step 2.',
      'spotify.clientId.placeholder': 'Spotify Client ID',
      'spotify.connect': 'Connect Spotify',
      'spotify.copied': '✓ Copied!',

      'footer.madeBy': 'Made by',
      'footer.feedback': 'Feedback',

      'yt.mute': 'Mute',
      'yt.unmute.btn': 'Enable sound',
      'yt.refresh': 'Refresh player',
      'yt.collapse': 'Minimize',
      'yt.expand': 'Expand',
      'yt.unavailable': 'No YouTube version',

      'err.clientIdMissing': 'Spotify Client ID not set in the popup',
      'err.authCancelled': 'Auth cancelled',
      'err.redirectUri': 'Redirect URI incorrect. Check that it matches exactly the one in your Spotify Developer Dashboard app.',
      'err.accessDenied': 'You denied Spotify authorization.',
      'err.invalidClient': 'Invalid Client ID. Check that you copied the Client ID from your Spotify app.',
      'err.invalidScope': 'Invalid scope. The Spotify app must have Web API enabled.',
      'err.noCode': 'Invalid Spotify response (no code). Check your Redirect URI in the Spotify dashboard.',
      'err.tokenExchange': 'Token exchange failed',
      'err.notConnected': 'Spotify not connected',
      'err.refreshFailed': 'Spotify token refresh failed',
      'err.openSpotifyFirst': 'Open Spotify on your PC or phone first',
    },
  };

  // t(lang, key, vars?) : cherche dans la langue demandée puis fallback FR.
  // vars : { name: value } → remplace les tokens {name} dans la string.
  g.SS_T = function (lang, key, vars) {
    const locales = g.SS_LOCALES;
    const table = locales[lang] || locales.fr;
    let str = table[key];
    if (str == null) str = locales.fr[key];
    if (str == null) return key;
    if (vars) {
      for (const k in vars) {
        str = str.split('{' + k + '}').join(vars[k]);
      }
    }
    return str;
  };

  g.SS_SUPPORTED_LANGS = ['fr', 'en'];
  g.SS_DEFAULT_LANG = 'fr';
})(typeof self !== 'undefined' ? self : this);

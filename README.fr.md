🇬🇧 [English version](README.md)

# 🎵 StreamSync - Extension navigateur (Chrome & Firefox)

**Entends exactement ce que le streamer écoutait, au bon moment.**

Twitch mute la musique des VODs pour le copyright. StreamSync la ramène - l'extension synchronise ta lecture Spotify sur la timeline musicale originale quand tu regardes la VOD d'un [streamer enregistré sur StreamSync](https://streamsync.fr).

Pendant le live, le serveur StreamSync enregistre ce que le streamer écoute sur Spotify. Plus tard, quand tu regardes la VOD, l'extension récupère cette timeline et contrôle ton Spotify en temps réel : play, pause, seek - tout parfaitement synchronisé avec la vidéo.

---

## ✨ Fonctionnalités

- **Sync automatique** - Spotify joue, pause et seek automatiquement pendant la VOD
- **Now Playing** - affiche le morceau en cours, l'artiste, la barre de progression et le prochain titre
- **Sélection d'appareil** - choisis sur quel appareil Spotify jouer (PC, téléphone, enceinte…)
- **Toggle autoplay** - active ou désactive la lecture automatique
- **Thème clair & sombre** - selon ta préférence
- **Ouvrir dans Spotify** - accède directement au morceau en cours sur Spotify

---

## 📋 Prérequis

- **Google Chrome** (ou tout navigateur basé sur Chromium) **ou Firefox 140+**
- Un compte **Spotify Premium** (requis pour le contrôle de lecture via l'API Spotify)
- Une **app Spotify Developer** (gratuit - guide ci-dessous)
- **Node.js 18+** (uniquement pour générer le build de l'extension)

---

## 🚀 Installation

1. Télécharge ou clone ce dépôt :
   ```bash
   git clone https://github.com/Valtikss/streamsync-extension.git
   cd streamsync-extension
   ```
2. Génère le build de l'extension :
   ```bash
   npm run build           # build Chrome ET Firefox
   npm run build:chrome    # Chrome seul → dist/chrome/
   npm run build:firefox   # Firefox seul → dist/firefox/
   npm run pack            # build + zip → dist/streamsync-chrome-X.Y.zip + streamsync-firefox-X.Y.zip
   ```
3. Charge l'extension dans ton navigateur :
   - **Chrome / Chromium / Edge :** ouvre `chrome://extensions/`, active le **Mode développeur** (toggle en haut à droite), clique sur **Charger l'extension non empaquetée**, sélectionne le dossier `dist/chrome/`.
   - **Firefox :** ouvre `about:debugging#/runtime/this-firefox`, clique sur **Charger un module complémentaire temporaire…**, sélectionne `dist/firefox/manifest.json`.
4. L'icône StreamSync devrait apparaître dans ta barre d'outils - épingle-la pour y accéder facilement.

> Le dossier `dist/` est git-ignored. Relance `npm run build` après chaque modif de code.
> Les zips pré-buildés sont publiés sur la [page Releases](../../releases) — télécharge-les et charge l'extension non empaquetée (Chrome) ou via `about:debugging` (Firefox, temporaire).

---

## 🔧 Configuration Spotify

Tu as besoin de ton propre Client ID Spotify. Voici comment l'obtenir :

### Étape 1 - Créer une app Spotify

1. Va sur le [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Connecte-toi avec ton compte Spotify
3. Clique sur **Create app**
4. Remplis les infos :
   - **App name :** `StreamSync` (ou ce que tu veux)
   - **App description :** ce que tu veux
   - **Redirect URI :** voir Étape 2
   - Coche **Web API**
5. Clique sur **Save**

### Étape 2 - Configurer la Redirect URI

1. Ouvre le popup de l'extension StreamSync
2. Va dans l'onglet **Paramètres**
3. Sous "Configuration Spotify", tu verras une **Redirect URI** - clique dessus pour la copier
4. Retourne dans les settings de ton app Spotify, colle cette URI comme **Redirect URI** et sauvegarde

> ⚠️ La Redirect URI est **différente sur Chrome et Firefox** (Chrome utilise `https://<id>.chromiumapp.org/`, Firefox utilise `https://<id>.extensions.allizom.org/`). Si tu utilises les deux navigateurs, enregistre **les deux URIs** dans les paramètres de ton app Spotify.

### Étape 3 - Copier ton Client ID

1. Dans ton app Spotify sur le dashboard, va dans **Settings**
2. Copie le **Client ID**
3. Colle-le dans le popup de l'extension StreamSync (onglet Paramètres → champ Client ID)
4. Clique sur **Sauvegarder**

### Étape 4 - Connexion

1. Retourne dans l'onglet **Accueil** du popup
2. Clique sur **Connecter Spotify**
3. Autorise l'app dans la fenêtre Spotify qui s'ouvre
4. C'est bon - le badge devrait afficher "Connecté"

---

## 🎧 Comment ça marche

1. Un streamer enregistré sur [streamsync.fr](https://streamsync.fr) lance son live - le serveur enregistre son historique d'écoute Spotify en temps réel
2. Tu ouvres une de ses VODs Twitch (`twitch.tv/videos/...`)
3. L'extension récupère la timeline musicale depuis l'API StreamSync
4. Pendant que tu regardes la VOD, Spotify joue exactement le bon morceau à la bonne position - play, pause et seek restent synchronisés

> L'extension utilise uniquement les scopes Spotify `user-modify-playback-state` et `user-read-playback-state`. Elle ne lit jamais ta bibliothèque ni tes données personnelles.

---

## 🗂 Structure du projet

```
├── manifest.chrome.json  # Manifest V3 pour Chrome / Chromium
├── manifest.firefox.json # Manifest V3 pour Firefox (browser_specific_settings.gecko)
├── build.mjs             # Script de build - assemble dist/chrome/ et dist/firefox/
├── package.json          # Scripts npm (build, build:chrome, build:firefox, clean)
├── content.js            # Injecté sur les pages VOD Twitch - logique de sync
├── service-worker.js     # Worker background - OAuth PKCE, appels API Spotify
├── popup.html / popup.js # UI du popup de l'extension
├── overlay.css           # Styles overlay in-page (optionnel)
├── i18n/                 # Locales et helpers de traduction
├── icons/                # Icônes de l'extension (16, 48, 128)
├── spotify-logo.svg      # Logo Spotify utilisé dans le popup
└── dist/                 # Généré par `npm run build` (git-ignored)
    ├── chrome/           # Build Chrome non empaqueté
    └── firefox/          # Build Firefox non empaqueté
```

Les deux manifests partagent exactement le même code source ; seul le manifest diffère :
- Chrome conserve le champ `key` (extension ID stable en dev) et utilise `background.service_worker`.
- Firefox utilise `browser_specific_settings.gecko` (id + `strict_min_version: "140.0"`, `data_collection_permissions`) et `background.scripts` (Firefox MV3 ne supporte pas `service_worker` hors flag).

---

## 🔗 Liens

- **Site StreamSync :** [streamsync.fr](https://streamsync.fr)
- **Fait par Valtiks :** [twitch.tv/valtiks_](https://twitch.tv/valtiks_)

---

## 📄 Licence

Ce projet est sous licence [MIT](LICENSE).

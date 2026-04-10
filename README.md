🇫🇷 [Version française](README.fr.md)

# 🎵 StreamSync - Chrome Extension

**Hear exactly what the streamer was playing, at the right moment.**

Twitch mutes music in VODs due to copyright. StreamSync brings it back - it syncs your Spotify playback to the original music timeline when you watch a VOD from a [StreamSync-enabled streamer](https://streamsync.fr).

During a live stream, the StreamSync server records what the streamer listens to on Spotify. Later, when you watch the VOD, this extension fetches that timeline and controls your Spotify in real time: play, pause, and seek - all perfectly synced to the video.

---

## ✨ Features

- **Auto sync** - Spotify plays, pauses, and seeks automatically as you watch the VOD
- **Now Playing** - see the current track, artist, progress bar, and what's coming next
- **Device picker** - choose which Spotify device to play on (PC, phone, speaker…)
- **Autoplay toggle** - enable or disable automatic playback
- **Light & Dark theme** - matches your preference
- **Open in Spotify** - quickly jump to the current track on Spotify

---

## 📋 Prerequisites

- **Google Chrome** (or any Chromium-based browser)
- **Spotify Premium** account (required for playback control via the Spotify API)
- A **Spotify Developer App** (free - setup guide below)

---

## 🚀 Installation

1. Download or clone this repository:
   ```bash
   git clone https://github.com/Valtikss/streamsync-extension.git
   ```
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `streamsync-extension` folder
5. The StreamSync icon should appear in your toolbar - pin it for easy access

---

## 🔧 Spotify Configuration

You need your own Spotify Client ID. Here's how to get one:

### Step 1 - Create a Spotify App

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Log in with your Spotify account
3. Click **Create app**
4. Fill in the details:
   - **App name:** `StreamSync` (or anything you like)
   - **App description:** anything
   - **Redirect URI:** see Step 2 below
   - Check **Web API**
5. Click **Save**

### Step 2 - Set the Redirect URI

1. Open the StreamSync extension popup in Chrome
2. Go to the **Settings** tab
3. Under "Configuration Spotify", you'll see a **Redirect URI** - click it to copy
4. Back in your Spotify app settings, paste this URI as the **Redirect URI** and save

### Step 3 - Copy your Client ID

1. In your Spotify app on the dashboard, go to **Settings**
2. Copy the **Client ID**
3. Paste it into the StreamSync extension popup (Settings tab → Client ID field)
4. Click **Save**

### Step 4 - Connect

1. Go back to the **Home** tab in the popup
2. Click **Connect Spotify**
3. Authorize the app in the Spotify window that opens
4. You're all set - the badge should show "Connected"

---

## 🎧 How It Works

1. A streamer registered on [streamsync.fr](https://streamsync.fr) goes live - the server records their Spotify listening history in real time
2. You open one of their Twitch VODs (`twitch.tv/videos/...`)
3. The extension fetches the music timeline from the StreamSync API
4. As you watch the VOD, Spotify plays the exact song at the exact position the streamer was hearing - play, pause, and seek are all kept in sync

> The extension only needs the `user-modify-playback-state` and `user-read-playback-state` Spotify scopes. It never reads your library or personal data.

---

## 🗂 Project Structure

```
├── manifest.json        # Chrome Extension Manifest V3
├── content.js           # Injected on Twitch VOD pages - sync logic
├── service-worker.js    # Background worker - OAuth PKCE, Spotify API calls
├── popup.html / popup.js # Extension popup UI
├── overlay.css          # Optional in-page overlay styles
├── icons/               # Extension icons (16, 48, 128)
└── spotify-logo.svg     # Spotify logo used in the popup
```

---

## 🔗 Links

- **StreamSync website:** [streamsync.fr](https://streamsync.fr)
- **Made by Valtiks:** [twitch.tv/valtiks_](https://twitch.tv/valtiks_)

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).

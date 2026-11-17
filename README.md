![Spider Man](spider/assets/spider-man.jpg)

# SPIDER-MAN MD

[![PAIR CODE](https://img.shields.io/badge/PAIR%20CODE-7C3AED?style=for-the-badge&logo=whatsapp&logoColor=white)](https://lilgabriel-session.onrender.com/pair)
[![SCAN QR](https://img.shields.io/badge/SCAN%20QR-111827?style=for-the-badge&logo=qrcode&logoColor=white)](https://lilgabriel-session.onrender.com/qr)
[![DEPLOY SPIDER MAN](https://img.shields.io/badge/DEPLOY%20SPIDER%20MAN-C9A227?style=for-the-badge&logo=rocket&logoColor=black)](https://spider-man-fork-verifier-flax.vercel.app)
[![KATABUMP PANEL](https://img.shields.io/badge/Deploy%20on-Katabump-D6B7D6?style=for-the-badge&logo=server&logoColor=black)](https://dashboard.katabump.com/auth/login#d6b7d6)
[![DOWNLOAD ZIP](https://img.shields.io/badge/DOWNLOAD%20ZIP-5B21B6?style=for-the-badge&logo=github&logoColor=white)](https://github.com/LilGabrielDev/Spider-Man/archive/refs/heads/main.zip)
[![FORK REPOSITORY](https://img.shields.io/badge/FORK%20REPOSITORY-374151?style=for-the-badge&logo=github&logoColor=white)](https://github.com/LilGabrielDev/Spider-Man/fork)

A Node.js WhatsApp Multi-Device bot powered by `@whiskeysockets/baileys` and Express.

Pair your device, then add the `SESSION` or `SESSION_ID` sent to your WhatsApp as a private environment variable. Never post or commit your session credentials.

---

## Features

- **Multi-Device WhatsApp Client**: Connects using `SESSION` (base64 `creds.json`) or `SESSION_ID` (`LIL~` gzipped base64 or plain base64).
- **Modular Commands & Legacy Compatibility**: Loads native commands from `Spider/commands/` alongside compatible legacy plugins via `Spider/utils/legacyPlugins.js`.
- **Group & Security Controls**: Admin protection (`ADMIN_PROTECTION`), owner-only command enforcement, rate limiting, and emergency lockdown state (`spider/utils/securityStore.js`).
- **Automations**: Anti-delete, anti-edit, anti-call, auto-read, auto-react, status auto-view/like, chat presence, and view-once auto-save.
- **HTTP Status Server**: Built-in Express server on `PORT` (default `3000`) with `/` and `/health` endpoints.

---

## Manual Launch

```bash
git clone https://github.com/LilGabrielDev/Spider-Man.git
cd Spider-Man
npm install
cp .env-sample .env
npm start
```

## Katabump Panel Deployment

Open the [Katabump panel](https://dashboard.katabump.com/auth/login#d6b7d6) and configure a Node.js server for this repository. Use a Node.js version supported by the project (20–24), with these commands:

- **Install:** `npm run install:panel`
- **Startup:** `npm start` (runs `index.js`)

Add `SESSION_ID` or `SESSION` as a private server variable before starting the bot. Use `.env-sample` as a reference for other optional settings, and keep session and API credentials in the panel rather than committing them to the repository.

---

## Configuration

Copy `.env-sample` to `.env` and set your variables:

| Variable | Description | Default |
| --- | --- | --- |
| `SESSION_ID` / `SESSION` | WhatsApp multi-device session string | — |
| `MODE` | Bot mode (`private` or `public`) | `private` |
| `PREFIXES` | Comma-separated command prefixes | `.` |
| `PORT` | HTTP server port | `3000` |
| `OWNER_NAME` | Owner display name | `Spider Man` |
| `BOT_NAME` | Bot display name | `Spider Man` |
| `BOT_PIC` | Bot avatar image URL | — |
| `TZ` | Timezone | `Africa/Nairobi` |
| `ADMIN_PROTECTION` | Block destructive actions against group admins (`on`/`off`) | `on` |

See `.env-sample` and `app.json` for the full list of optional API keys and automation toggles.

---

## Scripts

- `npm start` — Start the bot supervisor and Express HTTP server (`node index.js`)
- `npm run dev` — Start in development mode (`node index.js`)
- `npm run install:panel` — Install dependencies for panel hosting
- `npm test` — Run the Node test suite (`node --test Spider/test/*.test.js`)
- `npm run lint` — Syntax-check core entry files

---

## HTTP Endpoints

- `GET /` — Returns `Spider Man is Running`
- `GET /health` — Returns `{ "bot": "Spider Man", "whatsapp": "connected" | "disconnected" }`

---

## Links & License

- [GitHub Repository](https://github.com/LilGabrielDev/Spider-Man)
- [WhatsApp Channel](https://whatsapp.com/channel/0029VbDh88NCMY0Fartkxm1g)
- Licensed under the [MIT License](LICENSE).

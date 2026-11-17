<div align="center">

<img src="spider/assets/spider-man.jpg" alt="SPIDER-MAN MD" width="100%" />

# 🕸️ SPIDER-MAN MD

**Fast, modular WhatsApp Multi-Device bot powered by `@whiskeysockets/baileys` & Express.**

[![PAIR CODE](https://img.shields.io/badge/PAIR%20CODE-7C3AED?style=for-the-badge&logo=whatsapp&logoColor=white)](https://lilgabriel-session.onrender.com/pair)
[![SCAN QR](https://img.shields.io/badge/SCAN%20QR-111827?style=for-the-badge&logo=qrcode&logoColor=white)](https://lilgabriel-session.onrender.com/qr)
[![FORK REPO](https://img.shields.io/badge/FORK%20REPO-374151?style=for-the-badge&logo=github&logoColor=white)](https://github.com/LilGabrielDev/Spider-Man/fork)
[![DOWNLOAD ZIP](https://img.shields.io/badge/DOWNLOAD%20ZIP-5B21B6?style=for-the-badge&logo=github&logoColor=white)](https://github.com/LilGabrielDev/Spider-Man/archive/refs/heads/main.zip)
[![WHATSAPP CHANNEL](https://img.shields.io/badge/CHANNEL-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)](https://whatsapp.com/channel/0029VbDh88NCMY0Fartkxm1g)

</div>

> **Quick Note:** Pair your device first, then add the `SESSION_ID` or `SESSION` sent to your WhatsApp as a **private environment variable**. Never commit session credentials.

---

## 🚀 Deploy on Any Host

<div align="center">

[![DEPLOY SPIDER MAN](https://img.shields.io/badge/Deploy%20Portal-C9A227?style=for-the-badge&logo=rocket&logoColor=black)](https://spider-man-fork-verifier-flax.vercel.app)
[![HEROKU](https://img.shields.io/badge/Heroku-430098?style=for-the-badge&logo=heroku&logoColor=white)](https://heroku.com/deploy?template=https://github.com/LilGabrielDev/Spider-Man)
[![KOYEB](https://img.shields.io/badge/Koyeb-121212?style=for-the-badge&logo=koyeb&logoColor=white)](https://app.koyeb.com/deploy?type=git&repository=github.com/LilGabrielDev/Spider-Man&branch=main&name=spider-man-md&ports=3000;http;/&env[MODE]=private&env[TZ]=Africa/Nairobi&env[OWNER_NAME]=Spider%20Man&env[BOT_NAME]=Spider%20Man&env[ADMIN_PROTECTION]=on&env[AUTO_READ]=off&env[SESSION_ID]=)
[![RENDER](https://img.shields.io/badge/Render-46E3B7?style=for-the-badge&logo=render&logoColor=black)](https://render.com/deploy?repo=https://github.com/LilGabrielDev/Spider-Man)
[![RAILWAY](https://img.shields.io/badge/Railway-0B0D0E?style=for-the-badge&logo=railway&logoColor=white)](https://railway.com/new/github?repo=https://github.com/LilGabrielDev/Spider-Man)

[![KATABUMP](https://img.shields.io/badge/Katabump-D6B7D6?style=for-the-badge&logo=server&logoColor=black)](https://dashboard.katabump.com/auth/login#d6b7d6)
[![BOT-HOSTING](https://img.shields.io/badge/Bot--Hosting-2563EB?style=for-the-badge&logo=cloudflare&logoColor=white)](https://cheap.bothosting.lilgabrieltech.top)
[![REPLIT](https://img.shields.io/badge/Replit-F26207?style=for-the-badge&logo=replit&logoColor=white)](https://replit.com/github/LilGabrielDev/Spider-Man)
[![GLITCH](https://img.shields.io/badge/Glitch-3333FF?style=for-the-badge&logo=glitch&logoColor=white)](https://glitch.com/edit/#!/import/github/LilGabrielDev/Spider-Man)
[![FLY.IO](https://img.shields.io/badge/Fly.io-7B3FE4?style=for-the-badge&logo=flydotio&logoColor=white)](https://fly.io)
[![DOCKER](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)](#local--docker)

</div>

### Supported Hosting Matrix

| Category | Supported Hosts | Config / Setup |
| --- | --- | --- |
| **Cloud PaaS** | **Heroku**, **Koyeb**, **Render**, **Railway**, **Fly.io**, **Replit**, **Glitch**, **Vercel** (Deploy Portal) | `app.json` · `koyeb.yaml` · `render.yaml` · `railway.json` · `nixpacks.toml` · `Procfile` |
| **Bot & Game Panels** | **Katabump**, **Bot-Hosting**, **Optiklink**, **Pella**, **Cybrancee**, **SolarHosting**, **WitherHosting**, **BisectHosting**, **FalixNodes**, **Pterodactyl Panel** | Node.js `20–24` · Install: `npm run install:panel` · Start: `npm start` |
| **Cloud & Containers** | **Docker**, **Google Cloud Run**, **AWS (ECS / EC2)**, **Azure**, **DigitalOcean**, **Oracle Cloud** | `Dockerfile` · Port `3000` (or injected `PORT`) · Health check `GET /` |
| **VPS & Self-Hosted** | **Hetzner**, **OVHcloud**, **Contabo**, **Vultr**, **Linode**, **GitHub Codespaces**, **Linux VPS**, **Termux**, **Windows / macOS** | `git clone` → `npm install` → `npm start` |

> **Auto-Detection:** Run `.host` in WhatsApp to view the detected host, uptime, and container memory stats (optional override via `HOSTING_PROVIDER`).

---

## Koyeb Deployment

Deploy directly via the **[Koyeb button](https://app.koyeb.com/deploy?type=git&repository=github.com/LilGabrielDev/Spider-Man&branch=main&name=spider-man-md&ports=3000;http;/&env[MODE]=private&env[TZ]=Africa/Nairobi&env[OWNER_NAME]=Spider%20Man&env[BOT_NAME]=Spider%20Man&env[ADMIN_PROTECTION]=on&env[AUTO_READ]=off&env[SESSION_ID]=)** or `koyeb.yaml`:

- **Builder:** Buildpack (`npm start`) or `Dockerfile`
- **Port & Health Check:** Port `3000` (or Koyeb's injected `PORT`) with HTTP check on `/`
- **Secret:** Set `SESSION_ID` or `SESSION` before deploying

---

## ⚡ Features

- **Multi-Device Auth** — Supports `SESSION_ID` (`LIL~` gzipped/base64) and `SESSION` (base64 `creds.json`).
- **Modular Commands** — Native plugins in `Spider/commands/` plus full legacy command compatibility.
- **Group Protection** — Anti-link, anti-spam, anti-flood, anti-scam, 24h anti-duplicate, anti-bot, anti-badword, admin protection, and lockdown mode.
- **Automations** — Anti-delete, anti-edit, anti-call, auto-read, auto-react, status auto-view/like, auto-bio, and view-once auto-save.
- **Health Server** — Built-in Express server exposing `GET /` and `GET /health`.

---

## 🛠️ Local & Docker

```bash
# Local / VPS / Termux
git clone https://github.com/LilGabrielDev/Spider-Man.git && cd Spider-Man
npm install && cp .env-sample .env && npm start

# Docker
docker build -t spider-man-md .
docker run -d -p 3000:3000 -e SESSION_ID="your_session" spider-man-md
```

---

## ⚙️ Core Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `SESSION_ID` / `SESSION` | WhatsApp multi-device session string | *(required)* |
| `MODE` | Bot access mode (`private` / `public`) | `private` |
| `PREFIXES` | Command prefixes (comma-separated) | `.` |
| `OWNER_NAME` / `BOT_NAME` | Owner & bot display names | `Spider Man` |
| `TZ` | Timezone | `Africa/Nairobi` |
| `ADMIN_PROTECTION` | Protect group admins from destructive actions | `on` |
| `PORT` | HTTP server port *(leave unset on managed hosts)* | `3000` |

See `.env-sample` and `app.json` for optional API keys and automation toggles.

---

<div align="center">

**Scripts:** `npm start` · `npm run dev` · `npm run install:panel` · `npm test` · `npm run lint`  
**Endpoints:** `GET /` (`Spider Man is Running`) · `GET /health` (`{ bot, whatsapp }`)

[GitHub](https://github.com/LilGabrielDev/Spider-Man) · [WhatsApp Channel](https://whatsapp.com/channel/0029VbDh88NCMY0Fartkxm1g) · [MIT License](LICENSE)

</div>

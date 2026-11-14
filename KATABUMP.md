# Katabump deployment

Spider-Man is designed to run as a Node.js worker with a lightweight HTTP health server. In Katabump, use the repository's native commands:

- **Node.js:** 22 (the repository includes `.nvmrc`)
- **Install command:** `npm ci --legacy-peer-deps --no-audit --no-fund`
- **Start command:** `npm start`
- **Port:** use the `PORT` value provided by Katabump; the bot binds to `0.0.0.0`
- **Health check:** `GET /` or `GET /health`

Set the session and bot settings as environment variables in the Katabump panel. Do not commit `.env`, `auth/`, or session credentials.

Minimum production variables:

```text
SESSION_ID=<your encoded WhatsApp session>
# or SESSION=<your encoded WhatsApp credentials>
MODE=private
OWNER_NUMBER=<owner number with country code>
TZ=Africa/Nairobi
```

The command dispatcher does not wait for non-essential reactions, read receipts, presence updates, or duplicate group metadata requests. This keeps command latency low while preserving error handling and command execution order.

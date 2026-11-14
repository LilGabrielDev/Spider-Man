# Render and Railway Deployment Checklist

This checklist is for `LilGabrielDev/Spider-Man`, a Node.js ESM WhatsApp bot with an Express status server.

## 1. Pre-deployment checks

- [ ] Deploy the intended branch, normally `main`.
- [ ] Confirm `package.json`, `package-lock.json`, `Procfile`, `spider/index.js`, and `spider/config.js` are committed.
- [ ] Use Node.js 20 or newer. The repository declares `engines.node: >=20`.
- [ ] Run the local checks before deployment:

  ```bash
  npm install --legacy-peer-deps --no-audit --no-fund
  npm run lint
  npm test
  ```

- [ ] Do not commit `.env`, `SESSION`, `SESSION_ID`, API keys, or generated `spider/auth/` credentials.
- [ ] Confirm the repository can install the pinned Baileys archive dependency from Bitbucket without SSH credentials.

## 2. Required runtime variables

Set these as private environment variables in the platform dashboard. Do not put real values in `render.yaml`, `railway.json`, GitHub, or the repository.

- [ ] Set exactly one WhatsApp credential variable:
  - `SESSION_ID` for the `LIL~` gzip/base64 session format.
  - `SESSION` for a base64-encoded `creds.json`.
- [ ] Verify the complete session value is copied without wrapping quotes, truncation, extra characters, or line breaks. The current parser accepts `LIL~` and common spacing/case variants, but the encoded payload still must be valid gzip/base64 credentials.
- [ ] Set `MODE=private` unless public command access is intentional.
- [ ] Set `OWNER_NUMBER` to digits only when owner authorization should be tied to a specific number.
- [ ] Set `OWNER_NAME` and `BOT_NAME` as desired.
- [ ] Set `TZ`, for example `Africa/Nairobi`.
- [ ] Keep `ADMIN_PROTECTION=on` unless destructive group-admin actions are intentionally permitted.
- [ ] Configure optional automation variables only when needed: `ANTICALL`, `ANTIDELETE`, `ANTIEDIT`, `AUTO_READ`, `AUTO_REACT`, `AUTO_VIEW`, `AUTO_LIKE`, `STATUS_LIKE_EMOJI`, `DM_PRESENCE`, and `GRP_PRESENCE`.
- [ ] Add optional provider credentials only when the corresponding feature is used: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `GH_TOKEN`, `HEROKU_API_KEY`, and the other variables listed in `.env-sample`.

## 3. Render configuration

Render web services must bind to `0.0.0.0` and the platform-provided `PORT`. This repository already does both through `PORT` and the Express listener.

- [ ] Create a **Web Service**, not a static site.
- [ ] Connect the GitHub repository `LilGabrielDev/Spider-Man`.
- [ ] Select the `main` branch.
- [ ] Set the runtime to Node.
- [ ] Set the build command to:

  ```bash
  npm install --legacy-peer-deps --no-audit --no-fund
  ```

- [ ] Set the start command to:

  ```bash
  npm start
  ```

- [ ] Do not hard-code a Render port. Let Render provide `PORT`.
- [ ] Set the health check path to `/`, not `/health`, for the initial deployment. The repository's `/health` endpoint intentionally returns `503` while WhatsApp is disconnected, which can make a platform health check fail before the session connects. `/` returns a simple `200` readiness response.
- [ ] After the first successful deployment, confirm the service log contains `HTTP server listening on 0.0.0.0:<PORT>`.
- [ ] Confirm `https://<service>.onrender.com/` returns `Spider Man is Running`.
- [ ] Use `https://<service>.onrender.com/health` for operational status only. It should report `whatsapp: connected` after the bot connects.
- [ ] If filesystem state must survive restarts, evaluate a Render persistent disk for the directories written by the app, especially `spider/auth/` and `data/`. Keep the session variable configured even when using a disk so the bot can recover after a fresh instance.
- [ ] Review Render plan limits and sleeping/restart behavior before using the service for an always-on WhatsApp connection.

## 4. Railway configuration

Railway injects a `PORT` variable and uses it for deployment health checks. The repository already reads `PORT` and binds the HTTP server to `0.0.0.0`.

- [ ] Create a Railway project and deploy the GitHub repository as a service.
- [ ] Confirm the service root is the repository root.
- [ ] Use the detected Node build, or set the install/build command to:

  ```bash
  npm install --legacy-peer-deps --no-audit --no-fund
  ```

- [ ] Set the start command to:

  ```bash
  npm start
  ```

- [ ] Add `SESSION_ID` or `SESSION` in the service's Variables tab. Seal the session variable if it should not be retrievable from the Railway UI or CLI.
- [ ] Do not replace Railway's injected `PORT` with a fixed application port.
- [ ] Set the Railway healthcheck path to `/`, not `/health`, for the initial deployment for the same reason described in the Render section.
- [ ] Deploy staged variable changes after reviewing them. Railway variables do not take effect until the staged changes are deployed.
- [ ] Confirm the deployment log contains `HTTP server listening on 0.0.0.0:<PORT>`.
- [ ] Confirm the public URL's `/` endpoint returns HTTP 200.
- [ ] Use `/health` after WhatsApp authentication to confirm the connection state.
- [ ] If using a Railway volume, plan for the small deployment interruption associated with attached volumes and ensure the mount path covers any state that must persist.

## 5. Post-deployment verification

- [ ] Check the root endpoint:

  ```bash
  curl -i https://<public-domain>/
  ```

  Expected result: HTTP 200 and `Spider Man is Running`.

- [ ] Check application status:

  ```bash
  curl -i https://<public-domain>/health
  ```

  Expected result after WhatsApp connects: HTTP 200 with `"whatsapp":"connected"`.

- [ ] Check logs for a successful WhatsApp connection and absence of `ERR_MODULE_NOT_FOUND`, `ReferenceError`, `SyntaxError`, and `SESSION_ID` decoding errors.
- [ ] Send a controlled test message from an authorized owner account and verify command handling.
- [ ] Verify the owner-only and group-admin protection behavior before enabling public mode.
- [ ] Confirm only one production instance is running. Multiple active bot instances using the same WhatsApp session can cause disconnects or session conflicts.
- [ ] Confirm the session value is masked in platform logs and is not present in build output.
- [ ] Record the platform service URL, deployment branch, variable names, and recovery procedure in the operator's private notes.

## 6. Troubleshooting quick reference

- **`SESSION_ID` prefix error:** recopy the complete value. It must be a valid `LIL~` prefix followed by the full gzip/base64 payload.
- **Health check failure:** use `/` during deployment. `/health` can return `503` until WhatsApp is connected.
- **Application failed to respond:** verify the service is using the platform's `PORT` and that the log shows a listener on `0.0.0.0`.
- **Install failure:** use the repository's legacy-peer-dependency install command and confirm the Bitbucket Baileys archive is reachable.
- **Repeated WhatsApp disconnects:** stop duplicate deployments, verify the session belongs to only one running instance, and inspect the provider's restart events.
- **Lost state after restart:** configure an appropriate persistent volume or rely on the private `SESSION_ID`/`SESSION` variable to recreate authentication state.

## References

[1]: https://render.com/docs/web-services "Render Web Services"
[2]: https://render.com/docs/health-checks "Render Health Checks"
[3]: https://docs.railway.com/deployments/healthchecks "Railway Healthchecks"
[4]: https://docs.railway.com/variables "Railway Using Variables"

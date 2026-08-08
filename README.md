# Leokuo API v4.1

Cloudflare Worker backend for `api.leokuo.com`.

## Endpoints

- `GET /cpbl/health`
- `GET /cpbl/debug`
- `GET /cpbl/games`
- `GET /cpbl/game`
- `GET /cpbl/reminders`
- `POST /cpbl/reminders`
- `POST /cpbl/reminders/delete`
- `POST /cpbl/reminders/sent`

## v4 changes

- Removed every direct `203.66.x.x` fallback.
- Removed `resolveOverride`.
- Removed `Host` override.
- CPBL traffic uses the official apex host `https://cpbl.com.tw` to avoid the
  `www` CDN loop that returns 404 for Worker-originated POST requests.
- Keeps browser-like headers, verification token flow, cookie handling, retries, reminders, and optional proxy fallback.
- `/cpbl/debug` reports upstream status and Cloudflare-related headers without exposing the actual verification token.

## Deploy

Upload these files to the root of the `leokuo-api` GitHub repository.

Cloudflare Workers Git integration:
- Root directory: blank
- Build command: blank
- Deploy command: `npx wrangler deploy`

After deploy:

1. `https://api.leokuo.com/cpbl/health`
2. `https://api.leokuo.com/cpbl/debug`
3. `https://api.leokuo.com/cpbl/games`

If debug still reports `error code: 1003`, v4 has already removed the old IP fallback path, so that result points to an upstream restriction rather than the previous resolve/IP logic.

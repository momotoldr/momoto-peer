# momoto-peer

Self-hosted **PeerJS broker** — the WebRTC signaling id-broker for Momoto.

Two browsers in a room use this to exchange peer ids, offers/answers and ICE
candidates. Once they've agreed, **media flows directly peer-to-peer and never touches
this process**, so it stays tiny and cheap. It is deployed separately because the public
PeerJS cloud broker rate-limits under real load.

This is not where room logic lives — room codes, session sync and TURN credentials are
all `momoto-realtime`. This service holds no state worth persisting and no user data.

## Run locally

```bash
npm install
cp .env.example .env
npm start          # or: npm run dev  (restarts on change)
```

Verify:

```bash
curl http://localhost:9000/healthz    # → {"status":"ok","uptime":…}
curl http://localhost:9000/peerjs/id  # → a freshly minted peer id
```

Then point the frontend at it (`momoto/.env`):

```
VITE_PEERJS_HOST=localhost
VITE_PEERJS_PORT=9000
VITE_PEERJS_PATH=/
VITE_PEERJS_SECURE=false
```

## Environment

| Var | Default | Notes |
| :--- | :--- | :--- |
| `PORT` | `9000` | Render injects this. |
| `PEER_PATH` | `/` | Mount path. **Must match the frontend's `VITE_PEERJS_PATH`.** |
| `PEER_KEY` | `peerjs` | The PeerJS client's own default — change only if the frontend passes a matching `key`. |
| `CORS_ORIGINS` | *(unset)* | Comma-separated frontend origins. **Set in production**; unset rejects all cross-origin broker calls. |

### Platform variables (Railway)

| Variable | Value | Why |
| :--- | :--- | :--- |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `30` | **Defaults to `0`** — SIGKILL immediately behind SIGTERM, so the shutdown path below never runs and every client is cut off mid-frame instead of being told to come back. |

Also confirm the service's **health check path is `/healthz`** in the dashboard, so a new
deployment isn't sent traffic (and the old one isn't stopped) before the broker is up.

## Deploy (Render Web Service)

- **Build:** `npm ci` · **Start:** `npm start`
- **Health check path:** `/healthz`
- **Instance:** Starter or larger — **not Free.** A spun-down broker means peers can't
  find each other and video never connects.
- **Env:** `CORS_ORIGINS=https://app.example.com`
- Map to `peer.example.com` (HTTPS), then set the frontend's `VITE_PEERJS_HOST` to that
  host, `VITE_PEERJS_PORT=443`, `VITE_PEERJS_SECURE=true`.

WebSocket upgrades pass through Render's proxy automatically. `trust proxy` is set so
the real client IP is visible in logs rather than the proxy's.

## Notes

- **`allow_discovery` is off** — the peer list isn't exposed. Peers find each other via
  the room code from `momoto-realtime`, so discovery would be needless attack surface.
- **A restart no longer drops calls.** On SIGTERM the broker closes each client socket
  with code **1001 "going away"** instead of waiting on connections that never end. Media
  is peer-to-peer and keeps flowing regardless; what the close buys is the browser seeing
  `disconnected` and re-registering with the new process (`usePeerConnection` reconnects
  on a throttle, keeping its peer id), so the *next* negotiation — a newcomer, a retry —
  works. Without it the page stays silently unregistered until it reloads.
  The one thing that still needs care: this depends on
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` being set (above). A drain that can't finish in
  10 s gives up and exits `1`.
- Logs are structured JSON with no PII (peer ids are random per-connection).

See the platform runbook at `../DEPLOYMENT.md` for how this fits the whole deployment.

/**
 * Momoto PeerJS broker.
 *
 * A thin wrapper around `peer`'s ExpressPeerServer. Its only job is to broker WebRTC
 * connection setup between the two browsers in a room: they exchange peer ids, offers,
 * answers and ICE candidates through here, then the media flows directly peer-to-peer.
 * No audio or video ever passes through this process — so it stays cheap and small.
 *
 * Deliberately plain JavaScript: at this size a TypeScript build step would cost more
 * than it protects. The real signaling/sync logic lives in `momoto-realtime` (TypeScript).
 *
 * Deployed as its own always-on service because the public PeerJS cloud rate-limits.
 */
import cors from 'cors'
import express from 'express'
import { ExpressPeerServer } from 'peer'

/** Reads a comma-separated env var into a trimmed, non-empty list. */
function readList(value) {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

const port = Number(process.env.PORT ?? 9000)

// Mount path for the broker. Must match the frontend's VITE_PEERJS_PATH.
const peerPath = process.env.PEER_PATH ?? '/'

// The `key` a client must present. The PeerJS client defaults to "peerjs", so this
// only changes if the frontend passes a matching `key` option.
const peerKey = process.env.PEER_KEY ?? 'peerjs'

// Allowlist of frontend origins. The broker's HTTP surface (e.g. `GET /:key/id`) is
// called cross-origin by the browser, so it needs CORS just like the backend does.
// Empty means "same-origin only" — set this in production.
const corsOrigins = readList(process.env.CORS_ORIGINS)

if (corsOrigins.length === 0) {
  console.warn(
    JSON.stringify({
      level: 'warn',
      msg: 'CORS_ORIGINS is unset — cross-origin broker requests will be rejected. Set it to your frontend origin(s).',
    }),
  )
}

const app = express()

// Behind Render/Cloudflare, so the real client IP arrives in `X-Forwarded-For`.
app.set('trust proxy', 1)

app.use(cors({ origin: corsOrigins.length > 0 ? corsOrigins : false, credentials: true }))

// Registered before the broker so it wins the route when PEER_PATH is "/".
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() })
})

const server = app.listen(port, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'peer broker listening',
      port,
      path: peerPath,
      corsOrigins,
    }),
  )
})

const peerServer = ExpressPeerServer(server, {
  path: peerPath,
  key: peerKey,
  // How often to ping connected clients (ms). Keeps the WebSocket alive through
  // proxies that drop idle connections.
  alive_timeout: 60_000,
  // Don't expose the list of connected peer ids — a room's peers find each other via
  // the room code from `momoto-realtime`, so discovery is unnecessary attack surface.
  allow_discovery: false,
})

app.use('/', peerServer)

/**
 * Every client currently holding a broker socket, so a redeploy can close them
 * deliberately (see `shutdown`). The broker keeps its own registry internally, but
 * doesn't expose it; this is the only handle we get on the live sockets.
 */
const clients = new Set()

// Structured, PII-free logs — matches the backend's logging shape.
peerServer.on('connection', (client) => {
  clients.add(client)
  console.log(JSON.stringify({ level: 'info', msg: 'peer connected', peerId: client.getId() }))
})

peerServer.on('disconnect', (client) => {
  clients.delete(client)
  console.log(JSON.stringify({ level: 'info', msg: 'peer disconnected', peerId: client.getId() }))
})

peerServer.on('error', (error) => {
  console.error(JSON.stringify({ level: 'error', msg: 'peer broker error', error: error.message }))
})

/** Last resort: stop waiting for the listener to drain and go. */
const SHUTDOWN_TIMEOUT_MS = 10_000

let shuttingDown = false

/**
 * Redeploy (Railway sends SIGTERM) — hand the sockets back before we go.
 *
 * `server.close()` on its own never finishes here. It stops accepting new connections
 * and then waits for the open ones to end, and a broker WebSocket held by a browser
 * sitting in a booth never ends on its own: the process would sit in that wait until
 * the platform SIGKILLed it, and each client would discover the broker was gone only
 * when its next call failed.
 *
 * Closing them ourselves is what makes a restart recoverable. The browser's PeerJS
 * socket sees `onclose`, emits `disconnected`, and `usePeerConnection` asks for a
 * throttled `reconnect()` — which keeps the same peer id, because the process that had
 * claimed it is the one going away. Calls already up are peer-to-peer and never notice;
 * what this buys is that the *next* negotiation works.
 *
 * Note this only runs at all if the platform gives us the time:
 * `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` defaults to **0**, which is SIGKILL right
 * behind SIGTERM. See the deploy notes in `README.md`.
 */
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal, peers: clients.size }))

  // Not awaited: its callback fires once the sockets below are gone.
  server.close(() => process.exit(0))

  for (const client of clients) {
    try {
      // 1001 "going away" says precisely what is happening: this endpoint is
      // disappearing, so don't treat it as an error — come back.
      client.getSocket()?.close(1001, 'broker restarting')
    } catch {
      // A socket that's already gone is the outcome we were after anyway.
    }
  }
  clients.clear()

  // A non-zero code so an incomplete drain is visible in the logs rather than looking
  // like a clean stop.
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref()
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => shutdown(signal))
}

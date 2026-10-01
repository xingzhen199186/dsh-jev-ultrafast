/**
 * The one DevTools connection this host keeps holding.
 *
 * Chrome/Edge 144+ put 「允许远程调试？」 on screen once per connection, and everything that used to
 * reach the reader's own browser opened one per act: a task, the login probe, the copy. That is one
 * box per act, and the reader has to be looking at the screen for every one of them. So a connection
 * to a browser is opened here, kept, and handed to whoever needs it next — a task attaches to a tab
 * over the connection that is already allowed, and no box appears.
 *
 * What is held is at most one connection per route. The two routes are not a detail: for the
 * reader's daily browser the connection is only ever opened by the reader's own press, and once it
 * is gone the host waits rather than opening another one — a reconnect raises that box again, and it
 * could raise it while nobody is at the screen. The plugin's own browser is the opposite case: it is
 * this host's browser, nobody has to allow anything, and it may perfectly well be restarted and
 * reconnected without asking. That difference is the `daily` branch in `holdConnection` and nowhere
 * else.
 *
 * Everything here is memory. It reads no file, writes none, starts no process, and logs nothing:
 * the address and the state are what the settings page is shown, and a cookie's name or value never
 * comes near this module.
 */
import type { BrowserHeldState } from '../protocol'
import { noteAttached } from './attached'
import { CdpConnection } from './cdp'
import {
  dailyFailure,
  discoverBrowser,
  type BrowserConnection,
  type BrowserKind,
  type DiscoverOptions,
} from './discover'

/**
 * How often a held connection is asked whether it is still there.
 *
 * Long enough that the asking is free, short enough that a socket which died quietly is noticed
 * while the reader is still around to do something about it.
 */
export const HELD_PING_MS = 30_000

/**
 * The part of a connection this module needs.
 *
 * `CdpConnection` is the real one; a test supplies a stand-in. Only `send` is used for work, so a
 * session can hold one of these without knowing where it came from.
 */
export interface HeldSocket {
  send<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>
  /** Be told once when the socket goes away, and why. */
  onClose(listener: (reason: Error) => void): () => void
  close(): void
  /** Optional: ask the browser periodically whether this socket is still there. */
  keepalive?(intervalMs: number): () => void
}

/**
 * How a connection is opened.
 *
 * `timeoutMs` of 0 means "wait as long as it takes", which is what the reader's own browser needs:
 * the permission box is on screen and a timer would close the very connection it is about. The
 * plugin's own browser is never asked anything, so it keeps the ordinary deadline.
 */
export type HeldConnector = (wsUrl: string, timeoutMs?: number) => Promise<HeldSocket>

/** What is held for one route, as the page is told it. */
export interface HeldStatus {
  state: BrowserHeldState
  /** The WebSocket address the connection was opened at. */
  endpoint?: string
  connectedAt?: number
  reason?: string
}

/** One connection to open, and which route it belongs to. */
export interface HoldOptions {
  route: BrowserConnection
  /** Which browser this is, for the sentence a broken daily connection needs. */
  kind?: BrowserKind
  /** A connector for this call only; without one the module's own is used. */
  connect?: HeldConnector
}

/** One held connection, or the memory of one that went away. */
interface Held {
  route: BrowserConnection
  /** The address it was opened at. */
  wsUrl: string
  /** `host:port` of that address: what "the same browser" means here. */
  key: string
  kind: BrowserKind
  state: BrowserHeldState
  socket: HeldSocket | null
  /** A connect in flight, so two tasks starting together share one connection rather than racing. */
  pending?: Promise<HeldSocket>
  connectedAt: number
  reason: string
  /** The keepalive's off switch, while this connection is the one being held. */
  stopPing?: () => void
}

/** One entry per route, and never more than one: the whole point is one permission per boot. */
const held = new Map<BrowserConnection, Held>()

/**
 * The real connector, and the seam a test replaces.
 *
 * A test that let this through would open a real socket to a real browser, so it must be replaceable
 * without touching the callers; production never sets it.
 */
let custom: HeldConnector | null = null

export function setHeldConnector(connector: HeldConnector | null): void {
  custom = connector
}

const realConnector: HeldConnector = (wsUrl, timeoutMs) => CdpConnection.connect(wsUrl, timeoutMs)

/** What the page is told about one route right now. Reads memory only; connects to nothing. */
export function heldStatus(route: BrowserConnection): HeldStatus {
  const entry = held.get(route)
  if (entry === undefined) return { state: 'idle' }
  return {
    state: entry.state,
    endpoint: entry.wsUrl,
    ...(entry.state === 'connected' ? { connectedAt: entry.connectedAt } : {}),
    ...(entry.reason === '' ? {} : { reason: entry.reason }),
  }
}

/**
 * The connection for this address, opening one only if there is not a live one already.
 *
 * The reader's own browser: a connection that has gone is *not* replaced here. Rethrowing what the
 * host knows — in the words `dailyFailure` already uses for it — is the whole behaviour, because
 * opening another one would raise 「允许远程调试？」 again, possibly with nobody at the screen. The
 * reader's press is what reconnects (see `reconnectConnection`).
 *
 * The plugin's own browser: a connection that has gone is replaced, because there is nobody to ask
 * and nothing to pop up. This is also what a restart of that browser looks like from here: a new
 * address for the same route, which releases the dead entry and opens the new one.
 */
export async function holdConnection(wsUrl: string, options: HoldOptions): Promise<HeldSocket> {
  const { route } = options
  const key = addressKey(wsUrl)
  const existing = held.get(route)
  if (existing !== undefined && existing.key === key) {
    if (existing.state === 'connected' && existing.socket !== null) return existing.socket
    // An answer is on its way for exactly this address: join it rather than open a second one.
    if (existing.pending !== undefined) return await existing.pending
    if (existing.state === 'disconnected') {
      if (route === 'daily') throw dailyFailure(existing.kind, 'disconnected')
      held.delete(route)
    }
  } else if (existing !== undefined) {
    // A different address for the same route: this is a different browser (or a restarted one), and
    // holding both would be the second connection this module exists to prevent.
    releaseConnection(route)
  }

  const entry: Held = {
    route,
    wsUrl,
    key,
    kind: options.kind ?? 'edge',
    state: 'idle',
    socket: null,
    connectedAt: 0,
    reason: '',
  }
  const pending = openConnection(entry, options)
  entry.pending = pending
  held.set(route, entry)
  try {
    return await pending
  } catch (error) {
    // Nothing was opened, so nothing is remembered: the page keeps saying "not connected yet", which
    // is true, and a refused permission box is not a connection that broke.
    if (held.get(route) === entry) held.delete(route)
    throw error
  } finally {
    entry.pending = undefined
  }
}

/**
 * The reader's own decision to try again, which is the only thing that may replace a broken daily
 * connection.
 *
 * Whatever was remembered — broken or not — is forgotten first, so this may be used on a state that
 * `holdConnection` would refuse to move past. A press that arrives while a live connection is already
 * there for this address does nothing at all: the page may not have redrawn yet, and opening a second
 * connection would put a second 「允许远程调试？」 on screen for something the reader already allowed.
 */
export async function reconnectConnection(wsUrl: string, options: HoldOptions): Promise<HeldSocket> {
  const existing = held.get(options.route)
  const same = existing !== undefined && existing.key === addressKey(wsUrl)
  if (same && existing.state === 'connected' && existing.socket !== null) return existing.socket
  releaseConnection(options.route)
  return await holdConnection(wsUrl, options)
}

/** Let go of what is held for a route, if anything. The reader's browser is left exactly as it is. */
export function releaseConnection(route: BrowserConnection): void {
  const entry = held.get(route)
  if (entry === undefined) return
  held.delete(route)
  if (entry.socket !== null) {
    if (entry.stopPing !== undefined) entry.stopPing()
    entry.socket.close()
  }
}

/** Forget every route, closing what was open. For a test that needs a host which has held nothing. */
export function clearHeld(): void {
  releaseConnection('daily')
  releaseConnection('plugin')
}

/**
 * The connection a task should use, and the browser it found.
 *
 * One place, so a task and the help routes cannot hold different connections to the same browser:
 * the address is resolved the way the caller asked for it, and the holder decides whether that
 * means a new connection or the one that is already there.
 */
export interface AcquiredConnection {
  connection: HeldSocket
  /** The address the connection is at, as it was resolved. */
  wsUrl: string
}

export async function acquireConnection(options: DiscoverOptions = {}): Promise<AcquiredConnection> {
  const endpoint = await discoverBrowser(options)
  const connection = await holdConnection(endpoint.wsUrl, {
    route: options.connection === 'daily' ? 'daily' : 'plugin',
    kind: options.preferredKind ?? 'edge',
  })
  return { connection, wsUrl: endpoint.wsUrl }
}

/** Open one connection and remember how it ends. */
async function openConnection(entry: Held, options: HoldOptions): Promise<HeldSocket> {
  const connector = options.connect ?? custom ?? realConnector
  const socket = await connector(entry.wsUrl, entry.route === 'daily' ? 0 : undefined)
  entry.socket = socket
  entry.state = 'connected'
  entry.connectedAt = Date.now()
  entry.reason = ''
  // The browser's own `close`/`error` is the only moment a dead held socket can be noticed while
  // nobody is asking it anything, so this is where the state changes — never from a failed command,
  // which a task reports as its own failure.
  const stop = socket.onClose((reason) => {
    if (held.get(entry.route) !== entry) return
    if (entry.socket !== socket) return
    entry.socket = null
    entry.state = 'disconnected'
    entry.reason = reason.message
    if (entry.stopPing !== undefined) {
      entry.stopPing()
      entry.stopPing = undefined
    }
  })
  // The listener stays for the life of the socket: the guard above is what keeps a replacement from
  // being told about the old socket's death, so there is nothing to unsubscribe.
  void stop
  // A connection held across tasks is idle for most of its life; the asking keeps a quiet socket
  // honest and costs one small command every `HELD_PING_MS`.
  entry.stopPing = socket.keepalive?.(HELD_PING_MS)
  noteAttached({ connection: entry.route, endpoint: entry.wsUrl, at: entry.connectedAt })
  return socket
}

/**
 * What "the same browser" means for a WebSocket address: its host and port.
 *
 * A new connection to the same browser has the same host and port and a different request path, and
 * comparing whole URLs would treat that as a different browser — which is exactly the second
 * connection (and second permission box) this module is here to avoid.
 */
export function addressKey(wsUrl: string): string {
  try {
    const url = new URL(wsUrl)
    const port = url.port !== '' ? url.port : url.protocol === 'wss:' ? '443' : '80'
    return `${url.hostname}:${port}`
  } catch {
    return wsUrl
  }
}

/**
 * The browsers this host has really connected to, noted at the moment it happened.
 *
 * The settings page used to learn its state by connecting on open, which made Chrome/Edge 144+ ask
 * 「允许远程调试？」 every single time the page was drawn. The state it actually needs is two
 * different facts: what the profile files say (see `localBrowserStatus`) and whether this host has
 * already been through a connection during this run of DSH. The first is on disk; the second is only
 * known when it happens, so it is noted here and read back later.
 *
 * Nothing in this file touches a browser, opens a socket or writes a file. It is the page's memory
 * of connections other parts of the plugin made — a note left behind, not a connection.
 */
import type { BrowserConnection } from './discover'

/** The last connection this host made to one of the two routes, if it made one. */
export interface AttachedBrowser {
  connection: BrowserConnection
  /** The address that was reached: the browser-level socket, or the HTTP endpoint behind it. */
  endpoint: string
  /** Milliseconds since the epoch, so the page can say how long ago. */
  at: number
}

/**
 * One note per route, and the newest wins.
 *
 * Per route rather than per address, because the page asks a question about the route it is set to:
 * "has this host connected to the browser I am looking at?" — and the answer for the reader's own
 * browser is not the answer for the plugin's own.
 */
const notes = new Map<BrowserConnection, AttachedBrowser>()

/** Note that a connection to this route's browser just happened. */
export function noteAttached(record: AttachedBrowser): void {
  notes.set(record.connection, record)
}

/** The last connection noted for a route, or nothing when this host has not connected at all. */
export function lastAttached(connection: BrowserConnection): AttachedBrowser | undefined {
  return notes.get(connection)
}

/** Forget every note. For a test that needs a host which has connected to nothing. */
export function clearAttached(): void {
  notes.clear()
}

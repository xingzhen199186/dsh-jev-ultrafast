/**
 * How much login the reader's own browser is holding — a survey, not a copy.
 *
 * The reader presses one button and this counts what is in the browser they are already using:
 * how many cookies, over how many sites, and how many of those a closed browser may drop. The
 * numbers go back to the page; the cookies themselves never leave the browser, and nothing here
 * is written down — no trace, no log, no file. That is the whole point of doing this as a read of
 * the browser level rather than as a page session: `Storage.getCookies` on the browser socket
 * takes no target, so no tab is created in front of the reader, and closing the socket at the end
 * leaves the browser exactly as it was.
 *
 * The three files this route reads are the ones `discoverDailyBrowser` already reads, and the four
 * ways it can fail are that route's four — same class, same sentences. Only the last step differs:
 * that route resolves `/json/version` and drives a page, while this one opens the browser socket
 * the profile's own `DevToolsActivePort` names and sends one command.
 */
import { CdpConnection } from './cdp'
import {
  dailyFailure,
  dailyProfileDir,
  isPortListening,
  readActivePort,
  remoteDebuggingEnabled,
  wsUrlFromActivePort,
  type BrowserKind,
} from './discover'

/** The only three things this probe reads off a cookie: where it is, and whether it outlives the browser. */
export interface ProbeCookie {
  /** The domain the browser filed it under. */
  domain?: unknown
  /** Unix seconds, or -1 for a cookie with no expiry. */
  expires?: unknown
  /** The browser's own statement that it has no expiry. */
  session?: unknown
}

/** One site in the answer: a domain name and how many cookies sit under it. */
export interface LoginProbeSite {
  domain: string
  count: number
}

/** What the probe found: counts and domain names, and nothing a cookie is. */
export interface LoginProbeSummary {
  total: number
  /** How many distinct domains the cookies span. */
  sites: number
  /** How many are session cookies — the ones a closed browser may drop. */
  sessionCookies: number
  /** One entry per domain, longest list first. */
  bySite: LoginProbeSite[]
}

/** The name a cookie with no domain is counted under; it is still one cookie. */
export const NO_DOMAIN = '（没有域名）'

/**
 * Fold a browser's cookie list into the four numbers the page shows.
 *
 * Pure, and the only place a cookie is looked at: the count, the site it belongs to, and whether
 * it has an expiry. Everything else on a cookie — its name, its value, its flags — is never read
 * here, which is what makes it impossible for one to reach the answer.
 */
export function summarizeLoginProbe(cookies: readonly ProbeCookie[]): LoginProbeSummary {
  const counts = new Map<string, number>()
  let sessionCookies = 0
  for (const cookie of cookies) {
    const domain =
      typeof cookie.domain === 'string' && cookie.domain.trim() !== '' ? cookie.domain.trim() : NO_DOMAIN
    counts.set(domain, (counts.get(domain) ?? 0) + 1)
    if (isSessionCookie(cookie)) sessionCookies += 1
  }
  const bySite = [...counts].map(([domain, count]) => ({ domain, count }))
  // Most cookies first; the name breaks a tie so the same cookies always produce the same list.
  bySite.sort((left, right) => right.count - left.count || left.domain.localeCompare(right.domain))
  return { total: cookies.length, sites: bySite.length, sessionCookies, bySite }
}

/**
 * Whether a closed browser may drop this cookie.
 *
 * A session cookie is one with no expiry, and the protocol says so twice: `session: true`, or an
 * `expires` of -1. Either statement is enough, and a cookie that carries neither — nothing parsed
 * out of the answer — counts as one too, because "no expiry recorded" is the fact being asked for.
 */
function isSessionCookie(cookie: ProbeCookie): boolean {
  if (cookie.session === true) return true
  const expires = typeof cookie.expires === 'number' ? cookie.expires : 0
  return !(expires > 0)
}

/** The cookies out of one `Storage.getCookies` answer; anything else is no cookies at all. */
export function cookiesFrom(answer: unknown): ProbeCookie[] {
  const cookies = (answer as { cookies?: unknown } | null | undefined)?.cookies
  return Array.isArray(cookies) ? (cookies as ProbeCookie[]) : []
}

/** One browser-level DevTools socket, narrowed to what this probe does with it. */
export interface ProbeConnection {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  close(): void
}

/** How a socket is opened. Injectable, because a test must never touch a real browser. */
export type ProbeConnector = (wsUrl: string) => Promise<ProbeConnection>

/**
 * The real connector: one browser-level WebSocket, with no timeout at all.
 *
 * Waiting is the behaviour rather than a fallback, for the same reason the daily route waits:
 * Chrome/Edge 144+ ask 「允许远程调试？」 on every connection, and a timer that fired while that box
 * was on screen would close the very connection the box is about. A retry would only raise a
 * second box.
 */
export const openProbeSocket: ProbeConnector = async (wsUrl) => {
  const connection = await CdpConnection.connect(wsUrl, 0)
  return {
    send: (method, params) => connection.send(method, params ?? {}),
    close: () => connection.close(),
  }
}

/** What this probe reads off the machine, and how it reaches the browser. */
export interface LoginProbeOptions {
  /** Which browser's profile to read. */
  kind: BrowserKind
  /** The profile root, when 数据目录 names one. Defaults to the standard location. */
  profileDir?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  home?: string
  /** The socket to use. Defaults to the real one; a test supplies its own. */
  connect?: ProbeConnector
}

/**
 * Count what the reader's own browser is holding, and take nothing away from it.
 *
 * The four failures are `discoverDailyBrowser`'s four, in the same words: the profile's switch,
 * the port it wrote down, whether that port still answers, and whether this connection was
 * allowed. A socket that cannot be opened at all is the last of those — refusing the box, or
 * closing the browser before it was answered, arrives here the same way.
 */
export async function probeDailyLogins(options: LoginProbeOptions): Promise<LoginProbeSummary> {
  const { kind } = options
  const dir = options.profileDir ?? dailyProfileDir(kind, options)
  if ((await remoteDebuggingEnabled(dir)) !== true) throw dailyFailure(kind, 'switch-off')

  const active = await readActivePort(dir)
  if (active === null) throw dailyFailure(kind, 'no-port')
  // A port with no socket path is not an address; it is the same nothing as no port at all.
  const wsUrl = wsUrlFromActivePort(active)
  if (wsUrl === null) throw dailyFailure(kind, 'no-port')

  // A file a closed browser left behind is not an instance: the port has to answer, or the next
  // step would be waiting on a permission box that cannot exist.
  if (!(await isPortListening(active.port))) throw dailyFailure(kind, 'not-running')

  let connection: ProbeConnection
  try {
    connection = await (options.connect ?? openProbeSocket)(wsUrl)
  } catch {
    throw dailyFailure(kind, 'not-authorized')
  }

  try {
    // No `browserContextId`: with none, the command means the whole browser. It is a read, and it
    // is the only command sent — nothing here creates a target, and no tab may appear.
    return summarizeLoginProbe(cookiesFrom(await connection.send('Storage.getCookies', {})))
  } finally {
    // Whether the read worked or not, the socket goes away with the request that opened it. That
    // is also what takes the permission box off the reader's screen.
    connection.close()
  }
}

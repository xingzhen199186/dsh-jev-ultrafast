/**
 * The login probe: how much login the reader's own browser is holding.
 *
 * Nothing here touches a browser. What is worth testing is what the counts add up to, that the one
 * command sent is a read, that the socket is always put away, and that the four ways this can fail
 * say exactly what the daily route already says. Everything runs on a temporary profile, a local
 * socket standing in for the browser's debugging port, and an injected connection — so a passing
 * run leaves this machine exactly as it was and nothing is opened in front of anybody.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DailyBrowserError, discoverDailyBrowser } from '../src/browser/discover'
import {
  NO_DOMAIN,
  probeDailyLogins,
  summarizeLoginProbe,
  type LoginProbeSummary,
  type ProbeConnection,
  type ProbeConnector,
  type ProbeCookie,
} from '../src/browser/login-probe'

/** A profile directory holding the two files this route reads, and nothing else. */
function profile(files: { enabled?: boolean; port?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'jev-probe-'))
  if (files.enabled !== undefined) {
    writeFileSync(
      join(dir, 'Local State'),
      JSON.stringify({ devtools: { remote_debugging: { 'user-enabled': files.enabled } } }),
    )
  }
  if (files.port !== undefined) writeFileSync(join(dir, 'DevToolsActivePort'), files.port)
  return dir
}

/** A port something is listening on, and the way to stop it again. */
async function listeningPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** A port nobody is listening on: opened, read, and closed again. */
async function closedPort(): Promise<number> {
  const server = await listeningPort()
  await server.close()
  return server.port
}

/** A local stand-in for a browser's HTTP DevTools door, for the wording the daily route uses. */
async function fakeDoor(status: number): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'Forbidden' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** A profile whose port file points at a port that really is listening. */
async function liveProfile(): Promise<{ dir: string; stop: () => Promise<void> }> {
  const socket = await listeningPort()
  return {
    dir: profile({ enabled: true, port: `${socket.port}\n/devtools/browser/live-uuid` }),
    stop: socket.close,
  }
}

interface Call {
  method: string
  params?: Record<string, unknown>
}

/** A socket that answers every command with the same thing, and remembers what it was asked. */
function fakeConnection(answer: unknown): { connect: ProbeConnector; calls: Call[]; closed: () => boolean } {
  const calls: Call[] = []
  let closed = false
  return {
    calls,
    closed: () => closed,
    connect: async (): Promise<ProbeConnection> => ({
      send: async (method, params) => {
        calls.push(params === undefined ? { method } : { method, params })
        return answer
      },
      close: () => {
        closed = true
      },
    }),
  }
}

/** The refusal a call produced, as itself rather than as a string. */
async function refusal(promise: Promise<unknown>): Promise<DailyBrowserError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof DailyBrowserError) return error
    throw error
  }
  throw new Error('这一次本该连不上，却连上了')
}

/** Everything about the profile directory, so a write to it cannot go unnoticed. */
function snapshot(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .map((name) => {
      const stat = statSync(join(dir, name))
      return `${name}:${stat.size}:${stat.mtimeMs}`
    })
}

describe('what the cookies add up to', () => {
  it('groups by domain, counts each site, and puts the longest list first', () => {
    const cookies: ProbeCookie[] = [
      { domain: '.a.example' },
      { domain: '.a.example' },
      { domain: '.a.example' },
      { domain: 'b.example', expires: 1_900_000_000 },
      { domain: 'c.example', expires: 1_900_000_000 },
      { domain: 'c.example' },
    ]
    expect(summarizeLoginProbe(cookies)).toEqual({
      total: 6,
      sites: 3,
      sessionCookies: 4,
      bySite: [
        { domain: '.a.example', count: 3 },
        { domain: 'c.example', count: 2 },
        { domain: 'b.example', count: 1 },
      ],
    })
  })

  it('counts a cookie as session when either field says it has no expiry', () => {
    expect(
      summarizeLoginProbe([
        // Both statements the protocol has for the same fact, and each one alone is enough.
        { domain: 'a.example', session: true, expires: 1_900_000_000 },
        { domain: 'a.example', expires: -1 },
        { domain: 'a.example', expires: 1_900_000_000 },
        // Nothing parsed out of the answer: "no expiry recorded" is the fact being asked for.
        { domain: 'a.example' },
      ]),
    ).toMatchObject({ total: 4, sessionCookies: 3 })
  })

  it('breaks a tie by name, so the same cookies always produce the same list', () => {
    const cookies = [{ domain: 'b.example' }, { domain: 'a.example' }]
    expect(summarizeLoginProbe(cookies).bySite.map((site) => site.domain)).toEqual([
      'a.example',
      'b.example',
    ])
  })

  it('keeps a cookie the browser filed under no domain, rather than dropping it', () => {
    expect(summarizeLoginProbe([{ domain: '   ' }, {}])).toEqual({
      total: 2,
      sites: 1,
      sessionCookies: 2,
      bySite: [{ domain: NO_DOMAIN, count: 2 }],
    })
  })
})

describe('reading the reader’s own browser', () => {
  it('reads the whole browser over one connection, and puts the socket away', async () => {
    const live = await liveProfile()
    try {
      const fake = fakeConnection({
        cookies: [
          { name: 'SESSION', value: 'x', domain: '.example.com', expires: -1, session: true },
          { name: 'TOKEN', value: 'y', domain: '.example.com', expires: 1_900_000_000 },
          { name: 'CART', value: 'z', domain: 'shop.example', expires: -1, session: true },
        ],
      })
      const summary: LoginProbeSummary = await probeDailyLogins({
        kind: 'edge',
        profileDir: live.dir,
        connect: fake.connect,
      })
      expect(summary).toEqual({
        total: 3,
        sites: 2,
        sessionCookies: 2,
        bySite: [
          { domain: '.example.com', count: 2 },
          { domain: 'shop.example', count: 1 },
        ],
      })
      // No `browserContextId`: with none, the command means the whole browser rather than one
      // profile of it — which is the count the reader asked for.
      expect(fake.calls).toEqual([{ method: 'Storage.getCookies', params: {} }])
      expect(fake.closed()).toBe(true)
    } finally {
      await live.stop()
    }
  })

  it('opens no tab: the only command it sends is the read', async () => {
    const live = await liveProfile()
    try {
      const fake = fakeConnection({ cookies: [] })
      await probeDailyLogins({ kind: 'edge', profileDir: live.dir, connect: fake.connect })
      // The reader is using this browser right now. `Target.createTarget` is what would put a tab
      // in front of them, so nothing in the `Target` domain may be sent at all.
      expect(fake.calls.map((call) => call.method)).toEqual(['Storage.getCookies'])
      expect(fake.calls.some((call) => call.method.startsWith('Target.'))).toBe(false)
    } finally {
      await live.stop()
    }
  })

  it('answers with counts and domain names, and never with a cookie value', async () => {
    const live = await liveProfile()
    const secret = 'UNIQUE-VALUE-8f3c9a'
    try {
      const fake = fakeConnection({
        cookies: [
          { name: 'SESSION', value: secret, domain: 'a.example', expires: -1, session: true },
          { name: 'TOKEN', value: secret, domain: 'z.example', expires: 1_900_000_000 },
        ],
      })
      const summary = await probeDailyLogins({ kind: 'edge', profileDir: live.dir, connect: fake.connect })
      const answer = JSON.stringify(summary)
      // The whole answer, as the page receives it: the value is not in it, and neither is a field
      // one could hide it in.
      expect(answer).not.toContain(secret)
      expect(answer).not.toContain('"value"')
      expect(summary.total).toBe(2)
    } finally {
      await live.stop()
    }
  })

  it('puts the socket away even when the browser refuses the read', async () => {
    const live = await liveProfile()
    try {
      let closed = false
      await expect(
        probeDailyLogins({
          kind: 'edge',
          profileDir: live.dir,
          connect: async (): Promise<ProbeConnection> => ({
            send: async () => {
              throw new Error('浏览器拒绝了 Storage.getCookies')
            },
            close: () => {
              closed = true
            },
          }),
        }),
      ).rejects.toThrow('浏览器拒绝了 Storage.getCookies')
      // A failed read is the one case where a socket left open would keep the permission box on the
      // reader's screen with nothing left to answer it.
      expect(closed).toBe(true)
    } finally {
      await live.stop()
    }
  })

  it('leaves the profile it read exactly as it was, and has no filesystem to write a trace into', async () => {
    const live = await liveProfile()
    try {
      const before = snapshot(live.dir)
      const fake = fakeConnection({
        cookies: [{ name: 'TOKEN', value: 'x', domain: 'a.example', expires: 1_900_000_000 }],
      })
      await probeDailyLogins({ kind: 'edge', profileDir: live.dir, connect: fake.connect })
      // The reader's own profile is not this plugin's to change, and a probe is not a run: it leaves
      // no trace.jsonl, no frame, no log and no file behind it.
      expect(snapshot(live.dir)).toEqual(before)
      // Structural guard for the same claim: with no filesystem imported here, there is nowhere for
      // a trace to go. The connection above is this module's only outside contact.
      const source = readFileSync(new URL('../src/browser/login-probe.ts', import.meta.url), 'utf8')
      expect(source).not.toMatch(/node:fs/)
    } finally {
      await live.stop()
    }
  })
})

describe('the four ways the reader’s own browser cannot be reached', () => {
  it('says the switch is off, in the words the daily route already uses', async () => {
    const dir = profile({ enabled: false })
    const mine = await refusal(probeDailyLogins({ kind: 'edge', profileDir: dir }))
    const theirs = await refusal(discoverDailyBrowser('edge', { profileDir: dir }))
    expect(mine.problem).toBe('switch-off')
    expect(mine.message).toBe(theirs.message)
    expect(mine.message).toContain('允许远程调试')
  })

  it('says no port was ever written, in the same words', async () => {
    const dir = profile({ enabled: true })
    const mine = await refusal(probeDailyLogins({ kind: 'edge', profileDir: dir }))
    const theirs = await refusal(discoverDailyBrowser('edge', { profileDir: dir }))
    expect(mine.problem).toBe('no-port')
    expect(mine.message).toBe(theirs.message)
  })

  it('says the browser is not running, in the same words', async () => {
    const port = await closedPort()
    const dir = profile({ enabled: true, port: `${port}\n/devtools/browser/stale` })
    const mine = await refusal(probeDailyLogins({ kind: 'edge', profileDir: dir }))
    const theirs = await refusal(discoverDailyBrowser('edge', { profileDir: dir }))
    expect(mine.problem).toBe('not-running')
    expect(mine.message).toBe(theirs.message)
  })

  it('says the connection was not allowed, in the same words', async () => {
    // 403 is what an unaccepted 「允许远程调试？」 box answers. The probe reaches the same conclusion
    // from the socket side: the port answers, and the connection that carries the box does not open.
    const door = await fakeDoor(403)
    try {
      const dir = profile({ enabled: true, port: `${door.port}\n/devtools/browser/uuid` })
      const mine = await refusal(
        probeDailyLogins({
          kind: 'edge',
          profileDir: dir,
          connect: async () => {
            throw new Error('这个连接没被允许')
          },
        }),
      )
      const theirs = await refusal(discoverDailyBrowser('edge', { profileDir: dir }))
      expect(mine.problem).toBe('not-authorized')
      expect(mine.message).toBe(theirs.message)
      expect(mine.message).toContain('允许')
    } finally {
      await door.close()
    }
  })
})

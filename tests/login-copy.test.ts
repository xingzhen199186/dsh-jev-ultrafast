/**
 * The copy: the logins of the reader's own browser, put into the plugin's own browser.
 *
 * Nothing here touches a browser. What is worth testing is what a cookie becomes on the way over and
 * what is deliberately left behind, how the list is cut into calls, what the answer says when a
 * domain comes up short, and that the whole flow uses browser-level commands only and puts both
 * sockets away. Everything runs on a temporary profile, a local socket standing in for the daily
 * browser's debugging port, and injected connections — so a passing run starts nothing and writes
 * nothing anywhere but the fakes.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DailyBrowserError, discoverDailyBrowser, type BrowserEndpoint } from '../src/browser/discover'
import type { EnsureOptions, EnsuredBrowser } from '../src/browser/launch'
import {
  BATCH_SIZE,
  CopyTargetError,
  batchCookies,
  copyDailyLoginsIntoPluginBrowser,
  planCookieCopy,
  summarizeCopy,
  toCookieParam,
  type CookieParam,
  type CopyPlan,
  type SourceCookie,
} from '../src/browser/login-copy'
import type { ProbeConnector } from '../src/browser/login-probe'

/** A fixed clock, so an expiry test never depends on when it runs. */
const NOW = 1_800_000_000
const FUTURE = NOW + 86_400
const PAST = NOW - 86_400

/** A profile directory holding the two files the daily route reads, and nothing else. */
function profile(files: { enabled?: boolean; port?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'jev-copy-'))
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
async function liveProfile(): Promise<{ dir: string; stop: () => Promise<void>; wsUrl: string }> {
  const socket = await listeningPort()
  return {
    dir: profile({ enabled: true, port: `${socket.port}\n/devtools/browser/live-uuid` }),
    stop: socket.close,
    wsUrl: `ws://127.0.0.1:${socket.port}/devtools/browser/live-uuid`,
  }
}

interface Call {
  method: string
  params?: Record<string, unknown>
}

interface FakeSocket {
  connect: ProbeConnector
  calls: Call[]
  urls: string[]
  closed: () => boolean
}

/** A socket that answers by method and remembers the address, every command, and its own end. */
function fakeSocket(answers: Record<string, unknown>): FakeSocket {
  const calls: Call[] = []
  const urls: string[] = []
  let closed = false
  return {
    calls,
    urls,
    closed: () => closed,
    connect: async (wsUrl: string) => {
      urls.push(wsUrl)
      return {
        send: async (method, params) => {
          calls.push(params === undefined ? { method } : { method, params })
          return answers[method]
        },
        close: () => {
          closed = true
        },
      }
    },
  }
}

/** The plugin's own browser, found already running: no process is started by any test here. */
function pluginTarget(wsUrl = 'ws://127.0.0.1:9001/devtools/browser/plugin'): {
  ensure: (options: EnsureOptions) => Promise<EnsuredBrowser>
  asked: EnsureOptions[]
} {
  const asked: EnsureOptions[] = []
  const endpoint: BrowserEndpoint = {
    wsUrl,
    httpUrl: 'http://127.0.0.1:9001',
    browser: 'Edge/140.0.7339.128',
    source: '插件启动的 Edge',
  }
  return {
    asked,
    ensure: async (options: EnsureOptions) => {
      asked.push(options)
      return { endpoint, launched: null }
    },
  }
}

/** The set-cookie payload of one `Storage.setCookies` call, typed for the assertions below. */
function payloadOf(call: Call): CookieParam[] {
  return (call.params as { cookies: CookieParam[] }).cookies
}

/** The refusal a call produced, as itself rather than as a string. */
async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('这一次本该失败，却成功了')
}

describe('one cookie on its way over', () => {
  it('carries the fields the protocol takes, and only those', () => {
    // Everything a real answer holds: the fields that make a cookie, and the ones the browser says
    // about one it already has. Only the first group may survive the trip.
    const verdict = toCookieParam(
      {
        name: 'TOKEN',
        value: 'v',
        domain: '.example.com',
        path: '/app',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
        expires: FUTURE,
        size: 42,
        priority: 'Medium',
        sourceScheme: 'Secure',
        sourcePort: 443,
        session: false,
      },
      NOW,
    )
    expect(verdict).toEqual({
      kind: 'write',
      param: {
        name: 'TOKEN',
        value: 'v',
        domain: '.example.com',
        path: '/app',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
        expires: FUTURE,
        // Carried over as they arrived: `CookieParam` takes both, and a cookie written without them
        // is a cookie a secure origin may refuse — which shows up later as a per-domain difference.
        sourceScheme: 'Secure',
        sourcePort: 443,
      },
    })
  })

  it('derives the source scheme from secure when the answer named none, and passes the port on as it is', () => {
    const paramOf = (cookie: SourceCookie): CookieParam => {
      const verdict = toCookieParam({ name: 'S', value: 'v', domain: 'a.example', ...cookie }, NOW)
      if (verdict.kind !== 'write') throw new Error('这一个本该写下去')
      return verdict.param
    }
    // A secure cookie came from a secure origin; one that makes no claim is written as the
    // ordinary one, which is what the protocol's own default is.
    expect(paramOf({ secure: true }).sourceScheme).toBe('Secure')
    expect(paramOf({ secure: false }).sourceScheme).toBe('NonSecure')
    expect(paramOf({}).sourceScheme).toBe('NonSecure')
    // A scheme the answer did name is not second-guessed, even the third value it has.
    expect(paramOf({ sourceScheme: 'Unset', secure: true }).sourceScheme).toBe('Unset')
    // The port is only there when the answer held one.
    expect(paramOf({ sourcePort: 8080 }).sourcePort).toBe(8080)
    expect(paramOf({})).not.toHaveProperty('sourcePort')
    expect(paramOf({ sourcePort: null })).not.toHaveProperty('sourcePort')
  })

  it('writes a session cookie without an expiry, because that is what it is', () => {
    for (const sessionish of [
      { expires: -1, session: true },
      { expires: 0 },
      // No expiry at all: the protocol has each of these for the same thing.
      {},
    ]) {
      const verdict = toCookieParam({ name: 'S', value: 'v', domain: 'a.example', path: '/', ...sessionish }, NOW)
      expect(verdict.kind).toBe('write')
      if (verdict.kind === 'write') expect(verdict.param).not.toHaveProperty('expires')
    }
  })

  it('leaves an expired cookie behind, and keeps one that still has time', () => {
    expect(toCookieParam({ name: 'S', value: 'v', domain: 'a.example', expires: PAST }, NOW)).toEqual({
      kind: 'skip',
      reason: 'expired',
    })
    // The boundary: a cookie that expires this very second has expired.
    expect(toCookieParam({ name: 'S', value: 'v', domain: 'a.example', expires: NOW }, NOW)).toEqual({
      kind: 'skip',
      reason: 'expired',
    })
    expect(toCookieParam({ name: 'S', value: 'v', domain: 'a.example', expires: NOW + 1 }, NOW)).toMatchObject({
      kind: 'write',
    })
  })

  it('leaves a partitioned cookie behind rather than flattening it into the whole browser', () => {
    expect(
      toCookieParam(
        { name: 'S', value: 'v', domain: 'a.example', partitionKey: { topLevelSite: 'https://other.example' } },
        NOW,
      ),
    ).toEqual({ kind: 'skip', reason: 'partitioned' })
  })

  it('leaves a cookie with no domain behind, since there is nowhere to put it', () => {
    expect(toCookieParam({ name: 'S', value: 'v', domain: '  ' }, NOW)).toEqual({ kind: 'skip', reason: 'noDomain' })
    expect(toCookieParam({ name: 'S', value: 'v' }, NOW)).toEqual({ kind: 'skip', reason: 'noDomain' })
  })

  it('counts every cookie exactly once, under what it is written as or why it is not', () => {
    const cookies: SourceCookie[] = [
      { name: 'a', value: '1', domain: 'a.example', expires: FUTURE },
      { name: 'b', value: '2', domain: 'a.example', expires: -1 },
      { name: 'c', value: '3', domain: 'b.example', expires: PAST },
      { name: 'd', value: '4', domain: 'c.example', partitionKey: {} },
      { name: 'e', value: '5', domain: '' },
    ]
    const plan = planCookieCopy(cookies, NOW)
    expect(plan.params.map((param) => param.name)).toEqual(['a', 'b'])
    expect(plan.skipped).toEqual({ expired: 1, partitioned: 1, noDomain: 1 })
    expect(plan.params.length + plan.skipped.expired + plan.skipped.partitioned + plan.skipped.noDomain).toBe(
      cookies.length,
    )
  })
})

describe('cutting the list into calls', () => {
  it('makes 15 batches of 2891 cookies, losing none and repeating none', () => {
    const params: CookieParam[] = Array.from({ length: 2891 }, (_value, index) => ({
      name: `c${index}`,
      value: 'v',
      domain: 'a.example',
      path: '/',
    }))
    const batches = batchCookies(params)
    expect(batches).toHaveLength(15)
    expect(batches.slice(0, -1).every((batch) => batch.length === BATCH_SIZE)).toBe(true)
    expect(batches.at(-1)).toHaveLength(2891 - 14 * BATCH_SIZE)
    const back = batches.flat()
    expect(back).toHaveLength(params.length)
    expect(new Set(back.map((param) => param.name)).size).toBe(params.length)
    // Order too: the cookies go over in the order they came out of the reader's browser.
    expect(back.map((param) => param.name)).toEqual(params.map((param) => param.name))
  })

  it('makes one batch for a list that fits, and none for an empty one', () => {
    const one: CookieParam[] = [{ name: 'a', value: 'v', domain: 'a.example', path: '/' }]
    expect(batchCookies(one)).toEqual([one])
    expect(batchCookies([])).toEqual([])
  })
})

describe('what the answer says about the domains', () => {
  const plan: CopyPlan = planCookieCopy(
    [
      { name: 'a1', value: 'v', domain: 'a.example' },
      { name: 'a2', value: 'v', domain: 'a.example' },
      { name: 'a3', value: 'v', domain: 'a.example' },
      { name: 'b1', value: 'v', domain: 'b.example' },
      { name: 'c1', value: 'v', domain: 'c.example' },
      { name: 'c2', value: 'v', domain: 'c.example' },
      { name: 'gone', value: 'v', domain: 'd.example', expires: PAST },
    ],
    NOW,
  )

  it('lists only the domains that came up short, with what was expected and what landed', () => {
    const landed: SourceCookie[] = [
      { domain: 'a.example' },
      { domain: 'a.example' },
      { domain: 'a.example' },
      // c.example landed one more than expected; b.example landed none.
      { domain: 'c.example' },
      { domain: 'c.example' },
      { domain: 'c.example' },
      // A domain the plugin's browser held of its own: not a difference in this copy, and not listed.
      { domain: 'z.example' },
    ]
    const summary = summarizeCopy(plan, landed)
    expect(summary.mismatched).toEqual([
      { domain: 'b.example', expected: 1, landed: 0 },
      { domain: 'c.example', expected: 2, landed: 3 },
    ])
    expect(summary.domains).toEqual({ expected: 3, landed: 1 })
    // Only the expected domains are counted: z.example belongs to the destination, not to the copy.
    expect(summary.cookiesLanded).toBe(6)
    expect(summary.skipped).toEqual({ expired: 1, partitioned: 0, noDomain: 0 })
  })

  it('says everything matched when every domain has exactly what was expected', () => {
    const summary = summarizeCopy(plan, [
      { domain: 'a.example' },
      { domain: 'a.example' },
      { domain: 'a.example' },
      { domain: 'b.example' },
      { domain: 'c.example' },
      { domain: 'c.example' },
    ])
    expect(summary.mismatched).toEqual([])
    expect(summary.domains).toEqual({ expected: 3, landed: 3 })
    expect(summary.cookiesLanded).toBe(6)
  })

  it('counts a domain that expected nothing as matched, because nothing is what landed', () => {
    const empty: CopyPlan = { params: [], skipped: { expired: 0, partitioned: 0, noDomain: 0 } }
    expect(summarizeCopy(empty, [{ domain: 'a.example' }])).toEqual({
      domains: { expected: 0, landed: 0 },
      cookiesLanded: 0,
      skipped: { expired: 0, partitioned: 0, noDomain: 0 },
      mismatched: [],
    })
  })
})

describe('the whole copy', () => {
  const cookies: SourceCookie[] = [
    { name: 'S1', value: 'V1', domain: '.a.example', path: '/', expires: -1, session: true, size: 20 },
    {
      name: 'S2',
      value: 'V2',
      domain: '.a.example',
      path: '/',
      expires: FUTURE,
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      priority: 'Medium',
    },
    { name: 'S3', value: 'V3', domain: 'b.example', path: '/', expires: PAST },
    { name: 'S4', value: 'V4', domain: 'b.example', path: '/', partitionKey: { topLevelSite: 'https://x' } },
    { name: 'S5', value: 'V5', domain: '' },
  ]

  it('reads the reader’s browser, writes the plugin’s, and closes both sockets', async () => {
    const live = await liveProfile()
    try {
      const daily = fakeSocket({ 'Storage.getCookies': { cookies } })
      const plugin = fakeSocket({
        'Storage.setCookies': {},
        'Storage.getCookies': { cookies: [{ name: 'S1', value: 'V1', domain: '.a.example' }, { name: 'S2', value: 'V2', domain: '.a.example' }] },
      })
      const target = pluginTarget()
      const summary = await copyDailyLoginsIntoPluginBrowser({
        kind: 'edge',
        profileDir: live.dir,
        now: NOW,
        connectDaily: daily.connect,
        connectPlugin: plugin.connect,
        ensure: target.ensure,
      })

      expect(summary).toEqual({
        domains: { expected: 1, landed: 1 },
        cookiesLanded: 2,
        skipped: { expired: 1, partitioned: 1, noDomain: 1 },
        mismatched: [],
      })

      // The reader's browser: one read, at the browser level, at the address its own file names.
      expect(daily.calls).toEqual([{ method: 'Storage.getCookies', params: {} }])
      expect(daily.urls).toEqual([live.wsUrl])
      expect(daily.calls.some((call) => call.method.startsWith('Target.'))).toBe(false)
      expect(daily.closed()).toBe(true)

      // The plugin's browser: the write, then the read-back. Nothing else, and nothing in the
      // `Target` domain either — this route never opens a tab in anybody's browser.
      expect(plugin.calls.map((call) => call.method)).toEqual(['Storage.setCookies', 'Storage.getCookies'])
      expect(plugin.calls.some((call) => call.method.startsWith('Target.'))).toBe(false)
      expect(plugin.urls).toEqual(['ws://127.0.0.1:9001/devtools/browser/plugin'])
      expect(plugin.closed()).toBe(true)

      // What was actually put on the wire: the two cookies that could be carried, in the reduced
      // shape, with the session one still a session one.
      expect(payloadOf(plugin.calls[0]!)).toEqual([
        { name: 'S1', value: 'V1', domain: '.a.example', path: '/', sourceScheme: 'NonSecure' },
        {
          name: 'S2',
          value: 'V2',
          domain: '.a.example',
          path: '/',
          sourceScheme: 'Secure',
          secure: true,
          httpOnly: true,
          sameSite: 'Lax',
          expires: FUTURE,
        },
      ])

      // The plugin's own browser, reached through the route that starts one — and not through the
      // reader's address, which is never handed over as a destination.
      expect(target.asked).toHaveLength(1)
      expect(target.asked[0]).toMatchObject({ preferredKind: 'edge', connection: 'plugin' })
      expect(target.asked[0]?.cdpUrl).toBeUndefined()
      expect(target.asked[0]?.userDataDir).toBeUndefined()
    } finally {
      await live.stop()
    }
  })

  it('sends 2891 cookies as 15 calls of at most 200, and one read-back', async () => {
    const live = await liveProfile()
    try {
      const many: SourceCookie[] = Array.from({ length: 2891 }, (_value, index) => ({
        name: `c${index}`,
        value: 'v',
        domain: index % 2 === 0 ? '.a.example' : 'b.example',
        path: '/',
        expires: FUTURE,
      }))
      const daily = fakeSocket({ 'Storage.getCookies': { cookies: many } })
      const plugin = fakeSocket({ 'Storage.setCookies': {}, 'Storage.getCookies': { cookies: many } })
      const summary = await copyDailyLoginsIntoPluginBrowser({
        kind: 'edge',
        profileDir: live.dir,
        now: NOW,
        connectDaily: daily.connect,
        connectPlugin: plugin.connect,
        ensure: pluginTarget().ensure,
      })

      const writes = plugin.calls.filter((call) => call.method === 'Storage.setCookies')
      expect(writes).toHaveLength(15)
      expect(writes.map((call) => payloadOf(call).length)).toEqual([...Array(14).fill(200), 91])
      expect(writes.flatMap(payloadOf)).toHaveLength(2891)
      expect(plugin.calls.filter((call) => call.method === 'Storage.getCookies')).toHaveLength(1)
      expect(summary.domains).toEqual({ expected: 2, landed: 2 })
      expect(summary.mismatched).toEqual([])
    } finally {
      await live.stop()
    }
  })

  it('answers with counts, and never with a cookie’s name or value', async () => {
    const live = await liveProfile()
    const secret = 'UNIQUE-VALUE-7b1e2d'
    try {
      const daily = fakeSocket({
        'Storage.getCookies': {
          cookies: [
            { name: 'TOKEN', value: secret, domain: 'a.example', path: '/', expires: FUTURE },
            { name: 'SID', value: secret, domain: 'b.example', path: '/', expires: -1 },
          ],
        },
      })
      const plugin = fakeSocket({
        'Storage.setCookies': {},
        // The destination hands the secret back, as it honestly does: the answer still may not have it.
        'Storage.getCookies': { cookies: [{ name: 'TOKEN', value: secret, domain: 'a.example' }] },
      })
      const summary = await copyDailyLoginsIntoPluginBrowser({
        kind: 'edge',
        profileDir: live.dir,
        now: NOW,
        connectDaily: daily.connect,
        connectPlugin: plugin.connect,
        ensure: pluginTarget().ensure,
      })
      const answer = JSON.stringify(summary)
      expect(answer).not.toContain(secret)
      expect(answer).not.toContain('TOKEN')
      // The word itself, not just the field: a count that happened to be called `value` would be
      // just as much a leak of what this route promises not to carry.
      expect(answer).not.toContain('value')
      expect(answer).not.toContain('"name"')
      expect(summary.cookiesLanded).toBe(1)
      expect(summary.mismatched).toEqual([{ domain: 'b.example', expected: 1, landed: 0 }])
    } finally {
      await live.stop()
    }
  })
})

describe('when the copy cannot happen', () => {
  it('says the switch is off, in the words the daily route already uses', async () => {
    const dir = profile({ enabled: false })
    const mine = await refusal(
      copyDailyLoginsIntoPluginBrowser({ kind: 'edge', profileDir: dir, ensure: pluginTarget().ensure }),
    )
    const theirs = await refusal(discoverDailyBrowser('edge', { profileDir: dir }))
    expect(mine).toBeInstanceOf(DailyBrowserError)
    expect(mine.message).toBe(theirs.message)
    expect(mine.message).toContain('允许远程调试')
  })

  it('says no port was ever written, in the same words', async () => {
    const dir = profile({ enabled: true })
    const mine = await refusal(
      copyDailyLoginsIntoPluginBrowser({ kind: 'edge', profileDir: dir, ensure: pluginTarget().ensure }),
    )
    const theirs = await refusal(discoverDailyBrowser('edge', { profileDir: dir }))
    expect(mine.message).toBe(theirs.message)
  })

  it('says the browser is not running, in the same words', async () => {
    const port = await closedPort()
    const dir = profile({ enabled: true, port: `${port}\n/devtools/browser/stale` })
    const mine = await refusal(
      copyDailyLoginsIntoPluginBrowser({ kind: 'edge', profileDir: dir, ensure: pluginTarget().ensure }),
    )
    const theirs = await refusal(discoverDailyBrowser('edge', { profileDir: dir }))
    expect(mine.message).toBe(theirs.message)
  })

  it('says the connection was not allowed, in the same words', async () => {
    // 403 is what an unaccepted 「允许远程调试？」 box answers. The copy reaches the same conclusion
    // from the socket side: the port answers, and the connection that carries the box does not open.
    const door = await fakeDoor(403)
    try {
      const dir = profile({ enabled: true, port: `${door.port}\n/devtools/browser/uuid` })
      const mine = await refusal(
        copyDailyLoginsIntoPluginBrowser({
          kind: 'edge',
          profileDir: dir,
          connectDaily: async () => {
            throw new Error('这个连接没被允许')
          },
          ensure: pluginTarget().ensure,
        }),
      )
      const theirs = await refusal(discoverDailyBrowser('edge', { profileDir: dir }))
      expect(mine).toBeInstanceOf(DailyBrowserError)
      expect(mine.message).toBe(theirs.message)
      expect(mine.message).toContain('「允许远程调试？」的框')
    } finally {
      await door.close()
    }
  })

  it('reads the reader’s browser first and closes it even when the plugin’s will not start', async () => {
    const live = await liveProfile()
    try {
      const daily = fakeSocket({
        'Storage.getCookies': { cookies: [{ name: 'S1', value: 'V1', domain: '.a.example', path: '/' }] },
      })
      const plugin = fakeSocket({ 'Storage.setCookies': {} })
      const mine = await refusal(
        copyDailyLoginsIntoPluginBrowser({
          kind: 'edge',
          profileDir: live.dir,
          now: NOW,
          connectDaily: daily.connect,
          connectPlugin: plugin.connect,
          ensure: async () => {
            throw new Error('没有找到 Edge 的程序。')
          },
        }),
      )
      expect(mine).toBeInstanceOf(CopyTargetError)
      expect(mine.message).toContain('插件自己的浏览器')
      expect(mine.message).toContain('没有找到 Edge 的程序。')
      // The reader's socket is what holds their permission box on screen, so it is already gone.
      expect(daily.closed()).toBe(true)
      expect(plugin.closed()).toBe(false)
      expect(plugin.calls).toEqual([])
    } finally {
      await live.stop()
    }
  })

  it('refuses to write into the reader’s own browser when the two addresses are one', async () => {
    const live = await liveProfile()
    try {
      const daily = fakeSocket({ 'Storage.getCookies': { cookies: [] } })
      const plugin = fakeSocket({ 'Storage.setCookies': {} })
      const mine = await refusal(
        copyDailyLoginsIntoPluginBrowser({
          kind: 'edge',
          profileDir: live.dir,
          now: NOW,
          connectDaily: daily.connect,
          connectPlugin: plugin.connect,
          // The same browser on both ends: writing there is exactly what this button must not do.
          ensure: pluginTarget(live.wsUrl).ensure,
        }),
      )
      expect(mine).toBeInstanceOf(CopyTargetError)
      expect(mine.message).toContain('插件自己的浏览器和你正在用的那个是同一个')
      expect(plugin.calls).toEqual([])
      expect(plugin.closed()).toBe(false)
    } finally {
      await live.stop()
    }
  })
})

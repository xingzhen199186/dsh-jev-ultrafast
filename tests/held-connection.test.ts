/**
 * The one connection the host holds, and what each of the two routes does when it goes away.
 *
 * What is being tested is a promise to the reader rather than a code path: 「允许远程调试？」 is raised
 * once per connection by Chrome/Edge 144+, so the connection is opened once and kept, and a task, a
 * probe and a copy all attach to a tab over the one that is already allowed. That promise has three
 * parts worth a test of their own — the second task must not open a second connection, a connection
 * that died must not be replaced quietly (the reader's press is the only thing that may replace it on
 * their own browser), and the plugin's own browser, which nobody has to allow, may be reconnected
 * without asking.
 *
 * Nothing here touches a real browser. The ordinary case runs against a scripted stand-in for one CDP
 * connection, which also makes "the factory was called once" a thing that can be counted. The
 * concurrent case needs the real `CdpConnection` — what is being tested there is that commands are
 * dispatched by id, and a stand-in with a hand-written `send` would be testing itself — so it runs
 * against a fake `WebSocket` that answers in the wrong order on purpose.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearAttached } from '../src/browser/attached'
import { DailyBrowserError, dailyFailure } from '../src/browser/discover'
import {
  clearHeld,
  heldStatus,
  holdConnection,
  reconnectConnection,
  setHeldConnector,
  type HeldConnector,
  type HeldSocket,
} from '../src/browser/held'
import { BrowserSession } from '../src/browser/session'
import type { Config as ConfigShape } from '../src/config'
import { Config } from '../src/index'
import { browserReport } from '../src/panel'
import { CONNECT_BUTTON, HELD_LABELS, RECONNECT_BUTTON, connectButtonLabel } from '../src/protocol'

const DAILY = 'ws://127.0.0.1:9222/devtools/browser/held'
const OWN = 'ws://127.0.0.1:9223/devtools/browser/own'

/** The sentence a task fails with when the held connection has gone, word for word. */
const DISCONNECTED = '和你的 Edge 连接断了，请到设置页点「重新连接」——Edge 会再弹一次「允许远程调试？」。'

/** A stand-in for one CDP connection: answers what a task asks, and dies when it is told to. */
class ScriptedSocket implements HeldSocket {
  readonly sent: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = []
  readonly #closers = new Set<(reason: Error) => void>()
  #targets = 0
  #sessions = 0

  async send<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    this.sent.push({ method, params, sessionId })
    return this.#answer(method) as T
  }

  onClose(listener: (reason: Error) => void): () => void {
    this.#closers.add(listener)
    return () => {
      this.#closers.delete(listener)
    }
  }

  /** Nothing to do here: closing is the holder's bookkeeping, and that is what is being tested. */
  close(): void {}

  /** The browser went away. A `close`/`error` on the socket is the only way the holder hears of it. */
  die(reason = '与浏览器的调试连接已断开'): void {
    for (const listener of [...this.#closers]) listener(new Error(reason))
  }

  #answer(method: string): unknown {
    if (method === 'Target.createTarget') return { targetId: `target-${++this.#targets}` }
    if (method === 'Target.attachToTarget') return { sessionId: `session-${++this.#sessions}` }
    // What `#waitForLoad` asks for, and the answer that says the page is finished.
    if (method === 'Runtime.evaluate') return { result: { value: 'complete' } }
    return {}
  }
}

/** A connector that hands back stand-ins and remembers every address it was asked for. */
function countingConnector(): { connect: HeldConnector; asked: string[]; last: () => ScriptedSocket } {
  const asked: string[] = []
  const sockets: ScriptedSocket[] = []
  const connect: HeldConnector = async (wsUrl) => {
    asked.push(wsUrl)
    const socket = new ScriptedSocket()
    sockets.push(socket)
    return socket
  }
  return {
    connect,
    asked,
    last: () => {
      const socket = sockets[sockets.length - 1]
      if (socket === undefined) throw new Error('没有任何连接被打开')
      return socket
    },
  }
}

/** Run something that is expected to fail, and hand back what it failed with. */
async function refusal(work: Promise<unknown>): Promise<Error> {
  try {
    await work
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('这一步本该失败，但它没有')
}

/** A profile directory holding the two files the daily route reads. */
function profile(files: { enabled?: boolean; port?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'jev-held-'))
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

/** The configuration the page's own row would resolve from a few settings. */
function config(input: Record<string, unknown> = {}): ConfigShape {
  return (Config as unknown as (data: unknown) => ConfigShape)({
    browserConnection: 'daily',
    browserKind: 'edge',
    ...input,
  })
}

afterEach(() => {
  // The holder is module state, and a test that left a connection in it would decide the next one.
  clearHeld()
  setHeldConnector(null)
  clearAttached()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('one connection, many tasks', () => {
  it('runs two tasks in a row on the connection it opened for the first one', async () => {
    const factory = countingConnector()
    setHeldConnector(factory.connect)

    const first = await BrowserSession.open('https://first.example/', { cdpUrl: DAILY, connection: 'daily' })
    await first.close()
    const second = await BrowserSession.open('https://second.example/', { cdpUrl: DAILY, connection: 'daily' })
    await second.close()

    // The whole point: one connection, one permission box, however many tasks follow.
    expect(factory.asked).toEqual([DAILY])
    expect(heldStatus('daily').state).toBe('connected')
    // What a task owns is its tab, and that is what closes with it — the connection stays.
    const sent = factory.last().sent
    expect(sent.filter((entry) => entry.method === 'Target.createTarget')).toHaveLength(2)
    expect(sent.filter((entry) => entry.method === 'Target.closeTarget')).toHaveLength(2)
  })

  it('shares one connection with a second task that starts while the first is still running', async () => {
    const factory = countingConnector()
    setHeldConnector(factory.connect)

    const [first, second] = await Promise.all([
      BrowserSession.open('https://a.example/', { cdpUrl: DAILY, connection: 'daily' }),
      BrowserSession.open('https://b.example/', { cdpUrl: DAILY, connection: 'daily' }),
    ])
    await Promise.all([first.close(), second.close()])

    expect(factory.asked).toEqual([DAILY])
  })
})

describe('a connection that went away', () => {
  it('fails the next task at once, in one sentence, and opens nothing by itself', async () => {
    const factory = countingConnector()
    setHeldConnector(factory.connect)

    const session = await BrowserSession.open('https://first.example/', { cdpUrl: DAILY, connection: 'daily' })
    await session.close()
    factory.last().die()
    expect(heldStatus('daily').state).toBe('disconnected')
    expect(heldStatus('daily').reason).toBe('与浏览器的调试连接已断开')

    const asked = factory.asked.length
    const failure = await refusal(BrowserSession.open('https://second.example/', { cdpUrl: DAILY, connection: 'daily' }))
    expect(failure).toBeInstanceOf(DailyBrowserError)
    expect(failure.message).toBe(DISCONNECTED)
    // Also the wording a task reports, so the page and a run cannot drift apart.
    expect(failure.message).toBe(dailyFailure('edge', 'disconnected').message)
    // The holder itself refuses, not the session: nothing was asked of the connector again.
    expect(factory.asked).toHaveLength(asked)
  })

  it('reconnects when the reader presses the button — and the button says which press it is', async () => {
    const factory = countingConnector()
    setHeldConnector(factory.connect)

    const session = await BrowserSession.open('https://first.example/', { cdpUrl: DAILY, connection: 'daily' })
    await session.close()
    factory.last().die()
    const asked = factory.asked.length

    // A connection that is held is not offered a button at all; the other two states are.
    expect(HELD_LABELS.connected).toBe('已连接')
    expect(HELD_LABELS.idle).toBe('未连接')
    expect(HELD_LABELS.disconnected).toBe('连接已断开')
    expect(connectButtonLabel(heldStatus('daily').state)).toBe(RECONNECT_BUTTON)
    expect(RECONNECT_BUTTON).toBe('重新连接')
    expect(connectButtonLabel('idle')).toBe(CONNECT_BUTTON)
    expect(CONNECT_BUTTON).toBe('连接你的浏览器')

    await reconnectConnection(DAILY, { route: 'daily', kind: 'edge' })
    expect(heldStatus('daily').state).toBe('connected')
    expect(factory.asked).toHaveLength(asked + 1)
    // A press after the connection really is gone opens a live one, and the page says so again.
    expect(connectButtonLabel(heldStatus('daily').state)).toBe(CONNECT_BUTTON)
  })

  it('does not raise a second permission box when the same press arrives twice', async () => {
    const factory = countingConnector()
    setHeldConnector(factory.connect)

    await reconnectConnection(DAILY, { route: 'daily', kind: 'edge' })
    await reconnectConnection(DAILY, { route: 'daily', kind: 'edge' })

    expect(factory.asked).toEqual([DAILY])
    expect(heldStatus('daily').state).toBe('connected')
  })

  it('replaces a dead connection without asking, on the plugin’s own browser', async () => {
    const factory = countingConnector()
    setHeldConnector(factory.connect)

    const session = await BrowserSession.open('https://a.example/', { cdpUrl: OWN })
    await session.close()
    factory.last().die()
    expect(heldStatus('plugin').state).toBe('disconnected')

    // Nobody has to allow anything for this browser, so the next task simply connects again — and it
    // may well be a different address, which is what a restart of it looks like from here.
    const restarted = 'ws://127.0.0.1:9333/devtools/browser/own'
    const second = await BrowserSession.open('https://b.example/', { cdpUrl: restarted })
    await second.close()
    expect(heldStatus('plugin').state).toBe('connected')
    expect(heldStatus('plugin').endpoint).toBe(restarted)
    expect(factory.asked).toEqual([OWN, restarted])
  })

  it('replaces a dead connection without asking even at the same address', async () => {
    const factory = countingConnector()
    setHeldConnector(factory.connect)

    const session = await BrowserSession.open('https://a.example/', { cdpUrl: OWN })
    await session.close()
    factory.last().die()
    await holdConnection(OWN, { route: 'plugin' })

    expect(heldStatus('plugin').state).toBe('connected')
    expect(factory.asked).toEqual([OWN, OWN])
  })
})

/**
 * The real transport, answering in the wrong order on purpose.
 *
 * Two sessions on one connection is the case that a single-connection design has to get right, and
 * the thing that can go wrong is dispatch: if an answer were resolved by position rather than by the
 * id it carries, both sessions would get their own command's answer swapped with the other's. So the
 * two commands are answered in reverse — and not reordered anywhere else — which is a difference only
 * an id-based client survives.
 */
class OrneryWebSocket {
  static readonly opened: OrneryWebSocket[] = []
  readonly sent: Array<{ id: number; method: string; params?: Record<string, unknown>; sessionId?: string }> = []
  readonly #listeners = new Map<string, Set<(event: unknown) => void>>()
  #held: Array<{ id: number; method: string }> = []
  #targets = 0
  #sessions = 0

  constructor() {
    OrneryWebSocket.opened.push(this)
    queueMicrotask(() => this.#emit('open', {}))
  }

  addEventListener(type: string, listener: (event: unknown) => void, options?: { once?: boolean }): void {
    const set = this.#listeners.get(type) ?? new Set()
    const wrapped: (event: unknown) => void = options?.once
      ? (event) => {
          set.delete(wrapped)
          listener(event)
        }
      : listener
    set.add(wrapped)
    this.#listeners.set(type, set)
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string }
    this.sent.push(message)
    if (message.method.startsWith('Test.')) {
      this.#held.push({ id: message.id, method: message.method })
      return
    }
    this.#answer(message.id, message.method)
  }

  close(): void {
    this.#emit('close', {})
  }

  /** Answer the two held commands in the opposite order to the one they arrived in. */
  replyInReverse(): void {
    for (const message of this.#held.splice(0).reverse()) this.#answer(message.id, message.method, { echo: message.id })
  }

  #answer(id: number, method: string, result?: unknown): void {
    const answer =
      result ??
      (method === 'Target.createTarget'
        ? { targetId: `target-${++this.#targets}` }
        : method === 'Target.attachToTarget'
          ? { sessionId: `session-${++this.#sessions}` }
          : method === 'Runtime.evaluate'
            ? { result: { value: 'complete' } }
            : {})
    queueMicrotask(() =>
      this.#emit('message', { data: JSON.stringify({ id, result: answer }) }),
    )
  }

  #emit(type: string, event: unknown): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event)
  }
}

describe('two sessions at once on one connection', () => {
  it('gives each its own session id, unique command ids, and answers dispatched by id', async () => {
    vi.stubGlobal('WebSocket', OrneryWebSocket)
    const [first, second] = await Promise.all([
      BrowserSession.open('https://a.example/', { cdpUrl: DAILY, connection: 'daily' }),
      BrowserSession.open('https://b.example/', { cdpUrl: DAILY, connection: 'daily' }),
    ])

    const socket = OrneryWebSocket.opened[0]
    if (socket === undefined) throw new Error('没有打开任何连接')
    expect(OrneryWebSocket.opened).toHaveLength(1)

    const answerA = first.call<{ echo: number }>('Test.echo')
    const answerB = second.call<{ echo: number }>('Test.echo')
    // Both are on the wire already; the answers come back the other way round.
    socket.replyInReverse()
    const [echoA, echoB] = await Promise.all([answerA, answerB])

    const asked = socket.sent.filter((entry) => entry.method === 'Test.echo')
    expect(asked).toHaveLength(2)
    // Two sessions, not one: each command names the session it belongs to.
    expect(asked[0]?.sessionId).not.toBe(asked[1]?.sessionId)
    expect(asked[0]?.sessionId).toBe('session-1')
    expect(asked[1]?.sessionId).toBe('session-2')
    // One counter for the connection: no two commands ever share an id.
    const ids = socket.sent.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    // The answer each caller got is the answer to the command it sent, not the other one's.
    expect(echoA.echo).toBe(asked[0]?.id)
    expect(echoB.echo).toBe(asked[1]?.id)

    await Promise.all([first.close(), second.close()])
    expect(socket.sent.filter((entry) => entry.method === 'Target.closeTarget')).toHaveLength(2)
    expect(heldStatus('daily').state).toBe('connected')
  })
})

describe('the settings page', () => {
  it('opens no connection and holds nothing, however it is asked to draw itself', async () => {
    const factory = countingConnector()
    setHeldConnector(factory.connect)
    // Both ways out of this process are stubs that throw: if drawing the page connected to anything,
    // the test would fail by name rather than by timing out.
    vi.stubGlobal('fetch', () => {
      throw new Error('状态查询不该发 HTTP 请求')
    })
    vi.stubGlobal('WebSocket', class {
      constructor() {
        throw new Error('状态查询不该打开调试 socket')
      }
    })

    const live = await listeningPort()
    try {
      const report = await browserReport(
        config({ userDataDir: profile({ enabled: true, port: `${live.port}\n/devtools/browser/status` }) }),
      )
      expect(report.state).toBe('listening')
      // 端口在听, and nothing more: the page is told what is held, and nothing is.
      expect(report.held).toEqual({ state: 'idle' })
      expect(report.message).toContain('这一页没有去连它')
      expect(factory.asked).toEqual([])
    } finally {
      await live.close()
    }
  })

  it('says what is held once a connection is, and what to press once it has gone', async () => {
    const factory = countingConnector()
    setHeldConnector(factory.connect)
    const live = await listeningPort()
    try {
      const dir = profile({ enabled: true, port: `${live.port}\n/devtools/browser/status` })
      await holdConnection(DAILY, { route: 'daily', kind: 'edge' })

      const held = await browserReport(config({ userDataDir: dir }))
      expect(held.held.state).toBe('connected')
      expect(held.message).toContain('这条连接正握着')
      // The address is still worth saying; the "nothing has connected" sentence is not.
      expect(held.message).toContain('调试端口在听')
      expect(held.message).not.toContain('这一页没有去连它')

      factory.last().die()
      const gone = await browserReport(config({ userDataDir: dir }))
      expect(gone.held.state).toBe('disconnected')
      // First, so that it is the sentence the state line shows rather than one behind a click.
      expect(gone.message.startsWith(DISCONNECTED)).toBe(true)
      expect(gone.message).not.toContain('这一页没有去连它')
    } finally {
      await live.close()
    }
  })
})

/**
 * The browser block's state line, and the connection it must never make.
 *
 * The page used to learn its state by connecting on open, and a connection is what makes Edge 144+
 * put 「允许远程调试？」 on screen: every single open asked the reader for permission. What is worth
 * testing is therefore two things — that the state comes out of the files on this machine, and that
 * nothing in the status path ever opens a socket or sends an HTTP request. The second is tested by
 * replacing both transports with stubs that throw the moment they are used.
 *
 * Everything runs on temporary directories and a local server standing in for a port, so a passing
 * run starts nothing, connects to nothing and leaves this machine as it was. The two conventional
 * debugging ports are passed in empty, so "nothing is running here" means exactly that rather than
 * "whatever this machine happens to have on 9222".
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearAttached, noteAttached } from '../src/browser/attached'
import { dailyFailure, localBrowserStatus } from '../src/browser/discover'
import type { Config as ConfigShape } from '../src/config'
import { Config } from '../src/index'
import { browserReport } from '../src/panel'

/** No conventional ports, for the tests that need to know nothing else is listening. */
const NO_PORTS: readonly number[] = []

/** A profile directory holding the two files the daily route reads, and nothing else. */
function profile(files: { enabled?: boolean; port?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'jev-status-'))
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

/** The configuration the page's own row would resolve from a few settings. */
function config(input: Record<string, unknown>): ConfigShape {
  return (Config as unknown as (data: unknown) => ConfigShape)({
    browserConnection: 'daily',
    browserKind: 'edge',
    ...input,
  })
}

/**
 * Run a test body with `DSH_HOME` naming an empty tree.
 *
 * The plugin's own browser keeps its profile under `DSH_HOME`, and a file left there by a browser
 * that has since closed is exactly the `not-running` case — so a test that expects "nothing at all"
 * has to say which home it means instead of reading the home this machine happens to have.
 */
async function withEmptyHome<T>(body: () => Promise<T>): Promise<T> {
  vi.stubEnv('DSH_HOME', mkdtempSync(join(tmpdir(), 'jev-home-')))
  try {
    return await body()
  } finally {
    vi.unstubAllEnvs()
  }
}

/**
 * Replace both ways out of this process with stubs that throw, and hand back the way to undo it.
 *
 * `fetch` is how a `/json/version` door is asked, and `WebSocket` is how a DevTools socket is
 * opened: if the status path does either, the stub fails the test by name rather than by a timeout.
 */
function forbidConnections(): () => void {
  vi.stubGlobal('fetch', () => {
    throw new Error('状态查询不该发 HTTP 请求')
  })
  vi.stubGlobal(
    'WebSocket',
    class {
      constructor() {
        throw new Error('状态查询不该打开调试 socket')
      }
    },
  )
  return () => vi.unstubAllGlobals()
}

describe('what this machine says about a browser, with nothing connected', () => {
  it('daily: the switch is not on', async () => {
    const status = await localBrowserStatus({
      connection: 'daily',
      preferredKind: 'edge',
      userDataDir: profile({ enabled: false }),
    })
    expect(status.state).toBe('switch-off')
    expect(status.endpoint).toBeUndefined()
  })

  it('daily: the switch is on and no port was ever written', async () => {
    const status = await localBrowserStatus({
      connection: 'daily',
      preferredKind: 'edge',
      userDataDir: profile({ enabled: true }),
    })
    expect(status.state).toBe('no-port')
    expect(status.endpoint).toBeUndefined()
  })

  it('daily: the port file is there and nobody is listening', async () => {
    const port = await closedPort()
    const dir = profile({ enabled: true, port: `${port}\n/devtools/browser/gone` })
    const status = await localBrowserStatus({ connection: 'daily', preferredKind: 'edge', userDataDir: dir })
    expect(status.state).toBe('not-running')
    expect(status.endpoint).toBe(`http://127.0.0.1:${port}`)
    expect(status.source).toContain('DevToolsActivePort')
  })

  it('daily: the port is there and answers', async () => {
    const socket = await listeningPort()
    try {
      const dir = profile({ enabled: true, port: `${socket.port}\n/devtools/browser/live` })
      const status = await localBrowserStatus({ connection: 'daily', preferredKind: 'edge', userDataDir: dir })
      expect(status.state).toBe('listening')
      expect(status.endpoint).toBe(`http://127.0.0.1:${socket.port}`)
    } finally {
      await socket.close()
    }
  })

  it('plugin: the plugin’s own port is there and answers', async () => {
    const socket = await listeningPort()
    try {
      const dir = profile({ port: `${socket.port}\n/devtools/browser/own` })
      // 数据目录 is where this browser would keep its profile, so the file is found the way the
      // discovery route finds it — only without the connection that route would make next.
      const status = await localBrowserStatus(
        { connection: 'plugin', preferredKind: 'edge', userDataDir: dir },
        NO_PORTS,
      )
      expect(status.state).toBe('listening')
      expect(status.endpoint).toBe(`http://127.0.0.1:${socket.port}`)
    } finally {
      await socket.close()
    }
  })

  it('plugin: nothing started yet, and nothing listening', async () => {
    await withEmptyHome(async () => {
      const status = await localBrowserStatus(
        { connection: 'plugin', preferredKind: 'edge', userDataDir: profile({}) },
        NO_PORTS,
      )
      expect(status.state).toBe('no-port')
      expect(status.message).toContain('还没有起过')
      expect(status.message).toContain('「启动并连接」')
    })
  })

  it('plugin: the port file is left over from a browser that has since closed', async () => {
    const port = await closedPort()
    // The plugin's own profile directories are candidates here too — and this machine's copy may
    // be running for real, which is a different browser than the one this test is about.
    await withEmptyHome(async () => {
      const status = await localBrowserStatus(
        { connection: 'plugin', preferredKind: 'edge', userDataDir: profile({ port: `${port}\n/devtools/browser/gone` }) },
        NO_PORTS,
      )
      expect(status.state).toBe('not-running')
      expect(status.endpoint).toBe(`http://127.0.0.1:${port}`)
      expect(status.message).toContain('没有人监听')
    })
  })

  it('says a hand-written address is a hand-written address rather than checking it', async () => {
    const status = await localBrowserStatus({
      connection: 'plugin',
      preferredKind: 'edge',
      cdpUrl: 'ws://127.0.0.1:9333/devtools/browser/pinned',
    })
    expect(status.state).toBe('pinned')
    expect(status.endpoint).toBe('http://127.0.0.1:9333')
    expect(status.source).toContain('cdpUrl')
    expect(status.message).toContain('这一页没有去连它')
  })
})

describe('the state line the page draws, and the connection behind it', () => {
  it('① the reader’s browser has the switch off, in the words the daily route already uses', async () => {
    clearAttached()
    const report = await browserReport(config({ userDataDir: profile({ enabled: false }) }))
    expect(report.state).toBe('switch-off')
    expect(report.connection).toBe('daily')
    expect(report.message).toBe(dailyFailure('edge', 'switch-off').message)
    expect(report.attached).toBeUndefined()
  })

  it('② the switch is on and no port was written, in the same words', async () => {
    clearAttached()
    const report = await browserReport(config({ userDataDir: profile({ enabled: true }) }))
    expect(report.state).toBe('no-port')
    expect(report.message).toBe(dailyFailure('edge', 'no-port').message)
  })

  it('③ the port file is there and nothing is listening, in the same words', async () => {
    clearAttached()
    const port = await closedPort()
    const report = await browserReport(
      config({ userDataDir: profile({ enabled: true, port: `${port}\n/devtools/browser/gone` }) }),
    )
    expect(report.state).toBe('not-running')
    expect(report.message).toBe(dailyFailure('edge', 'not-running').message)
  })

  it('③ the port is listening, and the line says the page did not connect to it', async () => {
    clearAttached()
    const socket = await listeningPort()
    try {
      const report = await browserReport(
        config({ userDataDir: profile({ enabled: true, port: `${socket.port}\n/devtools/browser/live` }) }),
      )
      expect(report.state).toBe('listening')
      expect(report.endpoint).toBe(`http://127.0.0.1:${socket.port}`)
      expect(report.message).toContain('这一页没有去连它')
      expect(report.message).toContain('允许远程调试')
    } finally {
      await socket.close()
    }
  })

  it('④ a connection this host really made is the only connected-after thing on the line', async () => {
    clearAttached()
    const socket = await listeningPort()
    try {
      noteAttached({ connection: 'daily', endpoint: 'http://127.0.0.1:4321', at: Date.now() })
      const report = await browserReport(
        config({ userDataDir: profile({ enabled: true, port: `${socket.port}\n/devtools/browser/live` }) }),
      )
      expect(report.state).toBe('listening')
      expect(report.attached).toEqual({ connection: 'daily', endpoint: 'http://127.0.0.1:4321', at: expect.any(Number) })
      expect(report.message).toContain('本次 DSH 启动以来连过一次：http://127.0.0.1:4321（刚刚）')
    } finally {
      await socket.close()
    }
  })

  it('a pinned address is reported without a connection being made to check it', async () => {
    clearAttached()
    const report = await browserReport(config({ browserConnection: 'plugin', cdpUrl: 'http://127.0.0.1:9333' }))
    expect(report.connection).toBe('plugin')
    expect(report.state).toBe('pinned')
    expect(report.endpoint).toBe('http://127.0.0.1:9333')
  })

  it('makes no connection at all: both transports are stubs that throw when used', async () => {
    clearAttached()
    const restore = forbidConnections()
    try {
      const live = await listeningPort()
      try {
        const dir = profile({ enabled: true, port: `${live.port}\n/devtools/browser/live` })
        // Every band, plus a plugin's own route: not one of them may need a socket or a request.
        await expect(browserReport(config({ userDataDir: dir }))).resolves.toMatchObject({ state: 'listening' })
        await expect(browserReport(config({ userDataDir: profile({ enabled: false }) }))).resolves.toMatchObject({
          state: 'switch-off',
        })
        await expect(
          browserReport(config({ userDataDir: profile({ enabled: true }) })),
        ).resolves.toMatchObject({ state: 'no-port' })
        await expect(
          browserReport(config({ browserConnection: 'plugin', cdpUrl: 'http://127.0.0.1:9333' })),
        ).resolves.toMatchObject({ state: 'pinned' })
        await expect(
          localBrowserStatus({ connection: 'plugin', preferredKind: 'edge', userDataDir: dir }, []),
        ).resolves.toMatchObject({ state: 'listening' })
      } finally {
        await live.close()
      }
    } finally {
      restore()
    }
  })
})

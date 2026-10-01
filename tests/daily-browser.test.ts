/**
 * The second route: the browser the reader is already using.
 *
 * Nothing here opens a window. What is worth testing is the pair of files the browser writes
 * about itself, what each of the four failures says, and — the reason this route exists at all
 * — that it never starts anything. All of it runs on temporary directories and a local server
 * standing in for a browser's HTTP door, so a passing run leaves this machine exactly as it was.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DailyBrowserError,
  dailyProfileDir,
  discoverBrowser,
  discoverDailyBrowser,
  parseActivePort,
  parseDevToolsActivePort,
  remoteDebuggingEnabled,
  wsUrlFromActivePort,
  type BrowserEndpoint,
} from '../src/browser/discover'
import { ensureBrowser } from '../src/browser/launch'

/** A profile directory holding the two files this route reads, and nothing else. */
function profile(files: { port?: string; enabled?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'jev-daily-'))
  if (files.enabled !== undefined) {
    writeFileSync(
      join(dir, 'Local State'),
      JSON.stringify({ devtools: { remote_debugging: { 'user-enabled': files.enabled } } }),
    )
  }
  if (files.port !== undefined) writeFileSync(join(dir, 'DevToolsActivePort'), files.port)
  return dir
}

/** A port nobody is listening on: opened, read, and closed again. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** A local stand-in for a browser's HTTP DevTools door. */
async function fakeDoor(status: number, body?: unknown): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body === undefined ? '' : JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
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

describe('the port file a browser writes next to its own profile', () => {
  it('reads both lines, because both of them are the endpoint', () => {
    expect(parseDevToolsActivePort('9222\n/devtools/browser/8f3c-4a\n')).toEqual({
      port: 9222,
      path: '/devtools/browser/8f3c-4a',
    })
    // A Windows browser writes CRLF; the path is the half that has to survive the trim.
    expect(parseDevToolsActivePort('64321\r\n/devtools/browser/x\r\n')).toEqual({
      port: 64321,
      path: '/devtools/browser/x',
    })
    // The port alone is still a port, and callers that only want one get one.
    expect(parseActivePort('9222\n/devtools/browser/x')).toBe(9222)
    expect(parseDevToolsActivePort('9222')).toEqual({ port: 9222, path: '' })
  })

  it('refuses a port line that is not a usable port', () => {
    // 0 is the value that *asks* for a port rather than reporting one, so a profile file
    // claiming 0 means the browser never wrote a real one.
    expect(parseDevToolsActivePort('0\n/devtools/browser/x')).toBeNull()
    expect(parseDevToolsActivePort('65536')).toBeNull()
    expect(parseDevToolsActivePort('')).toBeNull()
    expect(parseDevToolsActivePort('port: 9222')).toBeNull()
  })

  it('assembles the socket address from the two lines', () => {
    expect(wsUrlFromActivePort({ port: 9222, path: '/devtools/browser/abc' })).toBe(
      'ws://127.0.0.1:9222/devtools/browser/abc',
    )
    // A port with no path is not an address, and saying so is better than a URL that cannot work.
    expect(wsUrlFromActivePort({ port: 9222, path: '' })).toBeNull()
  })

  it('looks for each browser where that browser keeps its profile, on all three platforms', () => {
    const local = 'C:\\Users\\me\\AppData\\Local'
    expect(dailyProfileDir('edge', { platform: 'win32', env: { LOCALAPPDATA: local } })).toBe(
      join(local, 'Microsoft', 'Edge', 'User Data'),
    )
    expect(dailyProfileDir('chrome', { platform: 'win32', env: { LOCALAPPDATA: local } })).toBe(
      join(local, 'Google', 'Chrome', 'User Data'),
    )
    // A host with no LOCALAPPDATA must not produce a path built from `undefined`.
    expect(dailyProfileDir('edge', { platform: 'win32', env: {}, home: 'C:\\Users\\me' })).toBe(
      join('C:\\Users\\me', 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
    )
    expect(dailyProfileDir('edge', { platform: 'darwin', env: {}, home: '/Users/me' })).toBe(
      join('/Users/me', 'Library', 'Application Support', 'Microsoft Edge'),
    )
    expect(dailyProfileDir('chrome', { platform: 'darwin', env: {}, home: '/Users/me' })).toBe(
      join('/Users/me', 'Library', 'Application Support', 'Google', 'Chrome'),
    )
    expect(dailyProfileDir('edge', { platform: 'linux', env: { XDG_CONFIG_HOME: '/home/me/.config' } })).toBe(
      join('/home/me/.config', 'microsoft-edge'),
    )
    expect(dailyProfileDir('chrome', { platform: 'linux', env: {}, home: '/home/me' })).toBe(
      join('/home/me', '.config', 'google-chrome'),
    )
  })

  it('reads the switch out of the profile, and says nothing when the profile does not', async () => {
    expect(await remoteDebuggingEnabled(profile({ enabled: true }))).toBe(true)
    expect(await remoteDebuggingEnabled(profile({ enabled: false }))).toBe(false)
    // No `Local State` at all is not the same fact as a switch recorded off, but both mean the
    // browser is not going to answer on a debugging port.
    expect(await remoteDebuggingEnabled(profile({}))).toBeNull()
    expect(await remoteDebuggingEnabled(join(tmpdir(), 'jev-daily-does-not-exist'))).toBeNull()
  })
})

describe('reaching the reader’s own browser', () => {
  it('calls it off when the profile does not record the switch as on', async () => {
    const failure = await refusal(discoverDailyBrowser('edge', { profileDir: profile({ enabled: false }) }))
    expect(failure.problem).toBe('switch-off')
    expect(failure.message).toContain('edge://inspect/#remote-debugging')
    expect(failure.message).toContain('允许远程调试')
  })

  it('calls it off when the profile records nothing at all', async () => {
    // The reader may never have opened that page; the profile then has no `Local State` entry,
    // which is the same answer as off and the same thing to do about it.
    const failure = await refusal(discoverDailyBrowser('chrome', { profileDir: profile({}) }))
    expect(failure.problem).toBe('switch-off')
    expect(failure.message).toContain('chrome://inspect/#remote-debugging')
  })

  it('calls it off when the switch is on but no port was ever written', async () => {
    const failure = await refusal(discoverDailyBrowser('edge', { profileDir: profile({ enabled: true }) }))
    expect(failure.problem).toBe('no-port')
    expect(failure.message).toContain('没找到')
  })

  it('calls it off when the port file is left over from a browser that is gone', async () => {
    // The stale file is the trap this check exists for: without asking the port itself, the next
    // step would be waiting on a permission box that cannot exist.
    const port = await closedPort()
    const dir = profile({ enabled: true, port: `${port}\n/devtools/browser/stale` })
    const failure = await refusal(discoverDailyBrowser('edge', { profileDir: dir }))
    expect(failure.problem).toBe('not-running')
    expect(failure.message).toContain('没开着')
  })

  it('falls back to the port and the second line when /json/version answers 404', async () => {
    // Chrome/Edge 147+ answer 404 there for a default profile. Both halves of the endpoint are in
    // the file the browser wrote, so the HTTP door withholding them is not a reason to give up.
    const door = await fakeDoor(404)
    try {
      const dir = profile({ enabled: true, port: `${door.port}\n/devtools/browser/live-uuid` })
      const endpoint = await discoverDailyBrowser('edge', { profileDir: dir })
      expect(endpoint.wsUrl).toBe(`ws://127.0.0.1:${door.port}/devtools/browser/live-uuid`)
      expect(endpoint.httpUrl).toBe(`http://127.0.0.1:${door.port}`)
      expect(endpoint.source).toContain('你正在用的 Edge')
    } finally {
      await door.close()
    }
  })

  it('calls it a missing approval when the door refuses the request', async () => {
    // 403 is what an unaccepted 「允许远程调试？」 box answers.
    const door = await fakeDoor(403, { message: 'Forbidden' })
    try {
      const dir = profile({ enabled: true, port: `${door.port}\n/devtools/browser/uuid` })
      const failure = await refusal(discoverDailyBrowser('edge', { profileDir: dir }))
      expect(failure.problem).toBe('not-authorized')
      expect(failure.message).toContain('允许')
    } finally {
      await door.close()
    }
  })

  it('uses the socket address the door itself names when it answers', async () => {
    const door = await fakeDoor(200, {
      Browser: 'Edge/154.0.4258.37',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/browser/from-http',
    })
    try {
      const dir = profile({ enabled: true, port: `${door.port}\n/devtools/browser/from-file` })
      const endpoint = await discoverDailyBrowser('edge', { profileDir: dir })
      expect(endpoint.wsUrl).toBe('ws://127.0.0.1:9/devtools/browser/from-http')
      expect(endpoint.browser).toBe('Edge/154.0.4258.37')
    } finally {
      await door.close()
    }
  })

  it('reads the profile directory the settings name, through the same door a run uses', async () => {
    // 数据目录 is written for a browser started with `--user-data-dir`, and that is exactly the
    // case where the profile is not in the standard place — so the daily route has to honour it.
    const door = await fakeDoor(404)
    try {
      const dir = profile({ enabled: true, port: `${door.port}\n/devtools/browser/chosen` })
      const endpoint = await discoverBrowser({ connection: 'daily', preferredKind: 'edge', userDataDir: dir })
      expect(endpoint.wsUrl).toBe(`ws://127.0.0.1:${door.port}/devtools/browser/chosen`)
    } finally {
      await door.close()
    }
  })

  it('says a profile with nothing in it is not switched on, rather than failing to read it', async () => {
    const failure = await refusal(discoverDailyBrowser('edge', { profileDir: mkdtempSync(join(tmpdir(), 'jev-daily-')) }))
    expect(failure.problem).toBe('switch-off')
  })
})

describe('what a daily run is allowed to do to the browser', () => {
  const found: BrowserEndpoint = {
    wsUrl: 'ws://127.0.0.1:53412/devtools/browser/uuid',
    httpUrl: 'http://127.0.0.1:53412',
    browser: 'Edge/154.0.4258.37',
    source: '你正在用的 Edge（C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data）',
  }

  it('connects to the one that answers, and still starts nothing', async () => {
    let launches = 0
    const ensured = await ensureBrowser(
      { connection: 'daily', preferredKind: 'edge' },
      {
        discover: async () => found,
        launch: async () => {
          launches += 1
          throw new Error('这条路不该启动任何浏览器')
        },
      },
    )
    expect(ensured).toEqual({ endpoint: found, launched: null })
    expect(launches).toBe(0)
  })

  it('reports why it could not connect instead of starting a browser of its own', async () => {
    // The whole point of the route: the window is the reader's own. A second browser would be
    // answering a question nobody asked, and would not be where their logins are.
    let launches = 0
    const refused = new DailyBrowserError('switch-off', '你正在用的 Edge 还没打开远程调试。')
    await expect(
      ensureBrowser(
        { connection: 'daily', preferredKind: 'edge' },
        {
          discover: async () => {
            throw refused
          },
          launch: async () => {
            launches += 1
            throw new Error('这条路不该启动任何浏览器')
          },
        },
      ),
    ).rejects.toBe(refused)
    expect(launches).toBe(0)
  })
})

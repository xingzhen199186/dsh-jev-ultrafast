/**
 * The launcher's deterministic half: which executable, which port file, which browser.
 *
 * Nothing here starts a browser — a test that really opened a window would fail on a
 * machine without Chrome and would leave one running when it passed. What is worth
 * testing is exactly what the button depends on and a wrong answer to which would send
 * the user to check their browser instead of ours: the port a profile directory reports,
 * and the list of places an install usually sits.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseActivePort,
  pluginProfileDir,
  pluginProfileDirs,
  type BrowserEndpoint,
  type DiscoverOptions,
} from '../src/browser/discover'
import {
  BROWSER_KINDS,
  BROWSER_LABELS,
  browserExecutableCandidates,
  ensureBrowser,
  findBrowserExecutable,
  keepSessionCookies,
  type BrowserKind,
  type LaunchedBrowser,
  type LaunchOptions,
} from '../src/browser/launch'

describe('browser launcher', () => {
  it('offers the two browsers the page lets the reader pick', () => {
    expect([...BROWSER_KINDS]).toEqual(['chrome', 'edge'])
    expect(BROWSER_LABELS.chrome).toBe('Chrome')
    expect(BROWSER_LABELS.edge).toBe('Edge')
  })

  it('reads the port a browser writes next to its profile', () => {
    // The file's first line is the port and its second the WebSocket path; only the first
    // line matters here.
    expect(parseActivePort('9222\n/devtools/browser/8f3c-4a\n')).toBe(9222)
    expect(parseActivePort('64321\n/devtools/browser/x')).toBe(64321)
  })

  it('refuses a port line that is not a usable port', () => {
    // 0 is the value that *asks* for a port rather than reporting one, so a profile file
    // claiming 0 means the browser never wrote a real one; anything out of range or
    // unparsable is the same kind of nothing.
    expect(parseActivePort('0\n/devtools/browser/x')).toBeNull()
    expect(parseActivePort('65536')).toBeNull()
    expect(parseActivePort('')).toBeNull()
    expect(parseActivePort('port: 9222')).toBeNull()
  })

  it('keeps each browser to its own executable', () => {
    const chrome = browserExecutableCandidates('chrome')
    const edge = browserExecutableCandidates('edge')
    expect(chrome.some((path) => path.endsWith('chrome.exe'))).toBe(true)
    expect(chrome.some((path) => path.includes('msedge'))).toBe(false)
    expect(edge.some((path) => path.endsWith('msedge.exe'))).toBe(true)
    expect(edge.some((path) => path.endsWith('chrome.exe'))).toBe(false)
    // Both are Chromium-based, so both lists have to work away from Windows as well.
    expect(chrome).toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    expect(edge).toContain('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
  })

  it('looks in the per-user install location too, when there is one', () => {
    const withLocal = browserExecutableCandidates('chrome', {
      ProgramFiles: 'C:\\PF',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    })
    expect(withLocal).toContain('C:\\PF\\Google\\Chrome\\Application\\chrome.exe')
    expect(withLocal).toContain('C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')

    // A host with no such variable must not produce a path built from `undefined`.
    const withoutLocal = browserExecutableCandidates('chrome', { ProgramFiles: 'C:\\PF' })
    expect(withoutLocal.some((path) => path.includes('undefined'))).toBe(false)
  })

  it('takes the first candidate that is really there', () => {
    const edge = browserExecutableCandidates('edge')
    const present = edge[1]
    expect(findBrowserExecutable('edge', undefined, (path) => path === present)).toBe(present)
    expect(findBrowserExecutable('edge', undefined, () => false)).toBeNull()
  })

  it('uses the path from the settings when one is given, and trusts nothing else', () => {
    const portable = 'D:\\portable\\chrome\\chrome.exe'
    expect(findBrowserExecutable('chrome', portable, (path) => path === portable)).toBe(portable)
    // A path the reader typed is not a hint to fall back from: if it is wrong, saying so is
    // the only way they can fix it. Silently starting a different browser would not be.
    expect(findBrowserExecutable('chrome', portable, () => false)).toBeNull()
    // Whitespace is a box that looks filled and is not.
    expect(findBrowserExecutable('chrome', '   ', (path) => path.endsWith('chrome.exe'))).toContain('chrome.exe')
  })

  it('tries the chosen browser before the other one, and reads both from the same place', () => {
    // Both browsers can be running at once — one press of the button each — so the order of
    // these two candidates is the only thing deciding which one a task drives.
    //
    // Pinned to a scratch harness home: each entry is built from the harness home, so reading
    // the real home would make this test mean something different on a machine that has
    // already run the browser than on one that has not.
    const before = process.env.DSH_HOME
    const home = mkdtempSync(join(tmpdir(), 'jev-profiles-'))
    process.env.DSH_HOME = home
    try {
      expect(pluginProfileDirs('chrome')[0]).toBe(pluginProfileDir('chrome'))
      expect(pluginProfileDirs('chrome')[0].endsWith(join('browser', 'chrome'))).toBe(true)
      expect(pluginProfileDirs('chrome')[1].endsWith(join('browser', 'edge'))).toBe(true)
      expect(pluginProfileDirs('edge')[0].endsWith(join('browser', 'edge'))).toBe(true)
      expect(pluginProfileDirs('edge')[1].endsWith(join('browser', 'chrome'))).toBe(true)
      // Nothing chosen yet: Chrome, the same default the settings page shows.
      expect(pluginProfileDirs(undefined)[0].endsWith(join('browser', 'chrome'))).toBe(true)
    } finally {
      if (before === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = before
      rmSync(home, { recursive: true, force: true })
    }
  })
})

/**
 * The setting a login that lives in this plugin's own browser depends on.
 *
 * Every launch writes it before the browser opens, because a Chromium browser drops session
 * cookies on a normal close unless it is set to reopen the last session — and a reader who
 * logs in once and is signed out on the next start has been told something false by the page.
 */
describe('keeping the logins across a restart', () => {
  const scratch = (): string => mkdtempSync(join(tmpdir(), 'jev-preferences-'))
  const sessionOf = (dir: string): Record<string, unknown> =>
    (JSON.parse(readFileSync(join(dir, 'Default', 'Preferences'), 'utf8')) as { session?: Record<string, unknown> })
      .session ?? {}

  it('writes the setting into a profile that has no preferences yet', async () => {
    const dir = scratch()
    try {
      await keepSessionCookies(dir)
      expect(sessionOf(dir).restore_on_startup).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps every preference the profile already had', async () => {
    // The browser writes its own state into this one file, and a version of this that replaced
    // the file wholesale would quietly discard it on every launch.
    const dir = scratch()
    try {
      await mkdir(join(dir, 'Default'), { recursive: true })
      writeFileSync(
        join(dir, 'Default', 'Preferences'),
        JSON.stringify({ session: { startup_urls: ['https://example.test'] }, intl: { app_locale: 'zh-CN' } }),
      )
      await keepSessionCookies(dir)
      const preferences = JSON.parse(readFileSync(join(dir, 'Default', 'Preferences'), 'utf8')) as {
        session: { restore_on_startup?: number; startup_urls?: string[] }
        intl?: { app_locale?: string }
      }
      expect(preferences.session.restore_on_startup).toBe(1)
      expect(preferences.session.startup_urls).toEqual(['https://example.test'])
      expect(preferences.intl?.app_locale).toBe('zh-CN')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('starts from an empty set rather than failing when the file is unreadable', async () => {
    // A half-written file is a real state for this one, and refusing to open a browser because
    // of it would lose the reader their session for no gain.
    const dir = scratch()
    try {
      await mkdir(join(dir, 'Default'), { recursive: true })
      writeFileSync(join(dir, 'Default', 'Preferences'), '{ this is not json')
      await keepSessionCookies(dir)
      expect(sessionOf(dir).restore_on_startup).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * The other door into the launcher: a task that finds no browser at all, rather than a
 * reader pressing the button.
 *
 * A fake launcher, because a test that really started a browser would open a window on
 * whatever machine runs it. What is pinned here is the deciding: when the plugin starts
 * something and when it refuses to, and which browser it starts.
 */
describe('the browser a task finds or starts', () => {
  const unreachable = new Error('没有找到可用的浏览器调试端口。设置页里的「启动并连接」可以由插件自己启动一个 Chrome 或 Edge；')
  const found: BrowserEndpoint = {
    httpUrl: 'http://127.0.0.1:9222',
    wsUrl: 'ws://127.0.0.1:9222/devtools/browser/aaa',
    browser: 'Chrome/140.0.7339.128',
    source: '常用的调试端口 9222',
  }
  const started: LaunchedBrowser = {
    kind: 'edge',
    label: 'Edge',
    exe: 'C:\\msedge.exe',
    endpoint: 'http://127.0.0.1:63412',
    profileDir: 'C:\\profile\\edge',
    source: '插件启动的 Edge（C:\\profile\\edge）',
  }
  const ended = (httpUrl: string): BrowserEndpoint => ({
    httpUrl,
    wsUrl: `${httpUrl.replace('http', 'ws')}/devtools/browser/bbb`,
    browser: 'Edge/154.0.4258.37',
    source: '插件启动的 Edge（C:\\profile\\edge）',
  })

  it('drives a browser that is already reachable, and starts nothing', async () => {
    let launches = 0
    const ensured = await ensureBrowser(
      { preferredKind: 'edge' },
      {
        discover: async () => found,
        launch: async () => {
          launches += 1
          return started
        },
      },
    )
    expect(ensured).toEqual({ endpoint: found, launched: null })
    expect(launches).toBe(0)
  })

  it('starts the browser the settings page names, then connects to what it started', async () => {
    const lookups: DiscoverOptions[] = []
    const asked: Array<{ kind: BrowserKind; options: LaunchOptions }> = []
    const ensured = await ensureBrowser(
      { preferredKind: 'edge', exeOverride: 'D:\\portable\\msedge.exe' },
      {
        discover: async (options) => {
          lookups.push({ ...options })
          if (!options.cdpUrl) throw unreachable
          return ended(options.cdpUrl)
        },
        launch: async (kind, options) => {
          asked.push({ kind, options })
          return started
        },
      },
    )
    // Looked first, started second, then looked again *at the launched endpoint*: the run
    // must drive the browser this call started, not whatever a later search would find.
    expect(lookups.map((options) => options.cdpUrl)).toEqual([undefined, started.endpoint])
    expect(asked).toEqual([{ kind: 'edge', options: { exeOverride: 'D:\\portable\\msedge.exe', timeoutMs: undefined } }])
    expect(ensured.launched).toBe(started)
    expect(ensured.endpoint.httpUrl).toBe(started.endpoint)
  })

  it('starts Chrome when the reader never picked a browser', async () => {
    const kinds: BrowserKind[] = []
    await ensureBrowser(
      {},
      {
        discover: async (options) => {
          if (!options.cdpUrl) throw unreachable
          return ended(options.cdpUrl)
        },
        launch: async (kind) => {
          kinds.push(kind)
          return { ...started, kind: 'chrome', label: 'Chrome' }
        },
      },
    )
    expect(kinds).toEqual(['chrome'])
  })

  it('reports a pinned endpoint that does not answer instead of starting a different browser', async () => {
    // A setting the reader typed is an instruction, not a hint. Starting anything else here
    // would drive a browser they did not choose, which is worse than saying it is not there.
    let launches = 0
    const refuse = {
      discover: async () => {
        throw unreachable
      },
      launch: async () => {
        launches += 1
        return started
      },
    }
    await expect(ensureBrowser({ cdpUrl: 'http://127.0.0.1:9222' }, refuse)).rejects.toBe(unreachable)
    await expect(ensureBrowser({ userDataDir: 'C:\\chrome-cdp' }, refuse)).rejects.toBe(unreachable)
    expect(launches).toBe(0)
    // Whitespace is a box that looks filled and is not, so it pins nothing.
    await ensureBrowser(
      { cdpUrl: '   ' },
      {
        discover: async (options) => {
          if (options.cdpUrl !== started.endpoint) throw unreachable
          return ended(options.cdpUrl)
        },
        launch: async () => {
          launches += 1
          return started
        },
      },
    )
    expect(launches).toBe(1)
  })

  it('says why it could not start one, rather than repeating that none was found', async () => {
    const refused = new Error('没有找到 Edge 的程序。找过这些位置：…')
    await expect(
      ensureBrowser(
        { preferredKind: 'edge' },
        {
          discover: async () => {
            throw unreachable
          },
          launch: async () => {
            throw refused
          },
        },
      ),
    ).rejects.toBe(refused)
  })
})

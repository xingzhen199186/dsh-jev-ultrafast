/**
 * What the "use the logins I already have" button actually copies, and what it refuses to.
 *
 * The two assertions worth having are the plain ones: the login carriers arrive, and the
 * cache does not. The first failure mode is silent — a copy without the cookie store's key
 * looks complete and reads as logged out — so it is checked by name rather than by size.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LOGIN_CARRIERS,
  adoptProfile,
  adoptedProfileDir,
  dailyProfileDir,
  dropAdoptedProfile,
  isShareViolation,
  storeIsLocked,
} from '../src/browser/adopt'
import { activeProfileDir } from '../src/browser/discover'

const created: string[] = []
const originalHome = process.env.DSH_HOME

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jev-adopt-'))
  created.push(dir)
  return dir
}

/** One browser profile with a login, a per-site store, and a cache worth not copying. */
async function fakeDailyProfile(root: string): Promise<string> {
  const from = join(root, 'daily')
  await mkdir(join(from, 'Default', 'Network'), { recursive: true })
  await mkdir(join(from, 'Default', 'Local Storage', 'leveldb'), { recursive: true })
  await mkdir(join(from, 'Default', 'Cache'), { recursive: true })
  await writeFile(join(from, 'Local State'), '{"os_crypt":{"encrypted_key":"…"}}')
  await writeFile(join(from, 'Default', 'Network', 'Cookies'), 'pretend sqlite')
  await writeFile(join(from, 'Default', 'Preferences'), '{}')
  await writeFile(join(from, 'Default', 'Local Storage', 'leveldb', 'site.ldb'), 'x')
  await writeFile(join(from, 'Default', 'Cache', 'big.bin'), 'x'.repeat(4096))
  return from
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
})

describe('where the reader’s own browser keeps its data', () => {
  it('names the usual directory per platform, and only when it is really there', async () => {
    const home = await scratch()
    const env = { LOCALAPPDATA: join(home, 'AppData', 'Local') }

    expect(dailyProfileDir('edge', { platform: 'win32', env, home })).toBeNull()
    const edge = join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data')
    await mkdir(edge, { recursive: true })
    expect(dailyProfileDir('edge', { platform: 'win32', env, home })).toBe(edge)
    expect(dailyProfileDir('chrome', { platform: 'win32', env, home })).toBeNull()

    expect(dailyProfileDir('chrome', { platform: 'darwin', env: {}, home })).toBeNull()
    const chrome = join(home, 'Library', 'Application Support', 'Google', 'Chrome')
    await mkdir(chrome, { recursive: true })
    expect(dailyProfileDir('chrome', { platform: 'darwin', env: {}, home })).toBe(chrome)

    const linux = join(home, '.config', 'microsoft-edge')
    await mkdir(linux, { recursive: true })
    expect(dailyProfileDir('edge', { platform: 'linux', env: {}, home })).toBe(linux)
  })
})

describe('telling a held cookie store from a readable one', () => {
  it('reads a file it may read, and calls a missing one not held', async () => {
    const home = await scratch()
    const file = join(home, 'Cookies')
    await writeFile(file, 'x')
    expect(await storeIsLocked(file)).toBe(false)
    expect(await storeIsLocked(join(home, 'nothing-here'))).toBe(false)
  })

  it('counts only the sharing errors as held', () => {
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      expect(isShareViolation(Object.assign(new Error('busy'), { code }))).toBe(true)
    }
    expect(isShareViolation(Object.assign(new Error('gone'), { code: 'ENOENT' }))).toBe(false)
    expect(isShareViolation(new Error('no code'))).toBe(false)
    expect(isShareViolation(null)).toBe(false)
  })
})

describe('copying the logins into the profile this plugin drives', () => {
  it('takes the login carriers and the per-site store, and leaves the cache behind', async () => {
    const home = await scratch()
    const from = await fakeDailyProfile(home)
    const to = join(home, 'shared', 'edge')

    const report = await adoptProfile('edge', { label: 'Edge', dailyDir: from, destination: to })

    expect(report.ok).toBe(true)
    expect(report.from).toBe(from)
    expect(report.to).toBe(to)
    expect(report.files).toBeGreaterThanOrEqual(4)
    expect(report.bytes).toBeGreaterThan(0)
    expect(existsSync(join(to, 'Local State'))).toBe(true)
    expect(existsSync(join(to, 'Default', 'Network', 'Cookies'))).toBe(true)
    expect(existsSync(join(to, 'Default', 'Local Storage', 'leveldb', 'site.ldb'))).toBe(true)
    expect(existsSync(join(to, 'Default', 'Cache'))).toBe(false)

    // The copy has to reopen the last session, or every session cookie it carries — and with
    // them the logins of every site that authenticates that way — is discarded on first start.
    const preferences = JSON.parse(await readFile(join(to, 'Default', 'Preferences'), 'utf8')) as {
      session?: { restore_on_startup?: number }
    }
    expect(preferences.session?.restore_on_startup).toBe(1)
  })

  it('replaces the previous copy instead of piling a second one on top', async () => {
    const home = await scratch()
    const from = await fakeDailyProfile(home)
    const to = join(home, 'shared', 'edge')
    await mkdir(join(to, 'Default'), { recursive: true })
    await writeFile(join(to, 'Default', 'stale-file'), 'from an older copy')

    await adoptProfile('edge', { label: 'Edge', dailyDir: from, destination: to })

    expect(existsSync(join(to, 'Default', 'stale-file'))).toBe(false)
  })

  it('says so instead of copying nothing when there is no profile or no login data', async () => {
    const home = await scratch()

    const missing = await adoptProfile('edge', { label: 'Edge', dailyDir: null, destination: join(home, 'a') })
    expect(missing.ok).toBe(false)
    expect(missing.reason).toBe('no-profile')

    const empty = join(home, 'fresh-profile')
    await mkdir(join(empty, 'Default', 'Network'), { recursive: true })
    await writeFile(join(empty, 'Default', 'Network', 'Cookies'), 'x')
    const nothing = await adoptProfile('edge', {
      label: 'Edge',
      dailyDir: join(home, 'not-a-browser'),
      destination: join(home, 'b'),
    })
    expect(nothing.ok).toBe(false)
    expect(nothing.reason).toBe('empty')
  })

  it('keeps the cookie store’s key on the carrier list', () => {
    // A tripwire, not a description: without this file the copy looks complete and reads as
    // logged out, which is the one failure that would be blamed on the browser instead.
    expect(LOGIN_CARRIERS.files).toContain('Local State')
    expect(LOGIN_CARRIERS.files.some((path) => path.endsWith(join('Network', 'Cookies')))).toBe(true)
  })
})

describe('going back to the plugin’s own profile', () => {
  it('moves the copy aside, and the next launch uses the plugin’s own again', async () => {
    const home = await scratch()
    process.env.DSH_HOME = home
    const adopted = adoptedProfileDir('edge')
    await mkdir(join(adopted, 'Default'), { recursive: true })
    expect(activeProfileDir('edge')).toBe(adopted)

    const report = await dropAdoptedProfile('edge', { label: 'Edge' })

    expect(report.ok).toBe(true)
    expect(existsSync(adopted)).toBe(false)
    expect(String(report.to)).toContain('停用')
    expect(existsSync(String(report.to))).toBe(true)
    expect(activeProfileDir('edge')).not.toBe(adopted)
    expect(activeProfileDir('edge')).toContain(join('jev-ultrafast', 'browser', 'edge'))
  })

  it('is a no-op when nothing was ever adopted', async () => {
    const home = await scratch()
    process.env.DSH_HOME = home
    const report = await dropAdoptedProfile('edge', { label: 'Edge' })
    expect(report.ok).toBe(true)
    expect(report.note).toContain('本来就没有')
  })
})

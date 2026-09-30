/**
 * Put the logins from the browser the reader actually uses where this plugin may drive them.
 *
 * Three facts shape this file, and all three were measured on this machine rather than
 * assumed:
 *
 *   1. A debugging port cannot be opened on the browser's *default* profile — Chrome and
 *      Edge have refused that since version 136 — and driving that profile would in any case
 *      take over the tabs the reader is working in. So this plugin drives a profile of its
 *      own, and the only question left open here is what that profile starts out with.
 *   2. What a login actually lives in is small: the cookie store, the key that store is
 *      encrypted with, and the per-site storage. The rest of a profile is cache — about
 *      three gigabytes of it in the profile this was written against, against roughly a
 *      hundred megabytes of logins.
 *   3. A copied store still decrypts from a different directory, because the encryption key
 *      is bound to this machine, this account and this browser, and not to the directory.
 *      That was checked directly: a cookie written in one profile, the store and the key
 *      copied into a fresh directory, and the cookie read back there.
 *
 * What this cannot do is read the cookie store while that browser is running: it holds the
 * file exclusively. That case comes back as `locked`, and the page asks the reader to close
 * the browser, then carries on by itself.
 */
import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ProfileAdoptReport } from '../protocol'
import type { BrowserKind } from './discover'

/** Where the browser the reader actually uses keeps its data, on this platform. */
export function dailyProfileDir(
  kind: BrowserKind,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string } = {},
): string | null {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  const candidates =
    platform === 'win32'
      ? kind === 'edge'
        ? [join(local, 'Microsoft', 'Edge', 'User Data')]
        : [join(local, 'Google', 'Chrome', 'User Data')]
      : platform === 'darwin'
        ? kind === 'edge'
          ? [join(home, 'Library', 'Application Support', 'Microsoft Edge')]
          : [join(home, 'Library', 'Application Support', 'Google', 'Chrome')]
        : kind === 'edge'
          ? [join(home, '.config', 'microsoft-edge')]
          : [join(home, '.config', 'google-chrome')]
  return candidates.find((dir) => existsSync(dir)) ?? null
}

/**
 * Where an adopted profile lives.
 *
 * Under the harness home, and never the reader's own directory: the copy has to be a profile
 * no other window is using, or a browser launched on it would be a second window fighting
 * the first one over the same files.
 */
export function adoptedProfileDir(kind: BrowserKind): string {
  const home = process.env.DSH_HOME?.trim()
  return join(home && home.length > 0 ? home : join(homedir(), '.dsh'), 'jev-ultrafast', 'shared', kind)
}

/** Is there an adopted profile for this browser? */
export function hasAdoptedProfile(kind: BrowserKind): boolean {
  return existsSync(adoptedProfileDir(kind))
}

/**
 * What carries a login, relative to a profile root.
 *
 * `Local State` is on the list for exactly one reason: it holds the key the cookie store is
 * encrypted with. Leaving it out produces a copy that looks complete and reads as logged
 * out — the most confusing way this could possibly fail.
 */
export const LOGIN_CARRIERS = {
  files: [
    'Local State',
    join('Default', 'Network', 'Cookies'),
    join('Default', 'Network', 'Cookies-journal'),
    join('Default', 'Network', 'Cookies-wal'),
    join('Default', 'Network', 'Cookies-shm'),
    join('Default', 'Network', 'TransportSecurity'),
    join('Default', 'Preferences'),
  ],
  dirs: [
    join('Default', 'Local Storage'),
    join('Default', 'IndexedDB'),
    join('Default', 'Session Storage'),
  ],
}

/**
 * Is that cookie store held open by a running browser?
 *
 * Cheap and exact: opening it for reading fails with a sharing violation while the browser
 * has it and succeeds otherwise. Only the sharing errors count — a missing file is a
 * different situation, and is left for the copy step to report honestly.
 */
export async function storeIsLocked(path: string): Promise<boolean> {
  try {
    const handle = await open(path, 'r')
    await handle.close()
    return false
  } catch (error) {
    return isShareViolation(error)
  }
}

/** Windows reports a file another process holds open as EBUSY, EPERM or EACCES. */
export function isShareViolation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
}

export interface AdoptOptions {
  /** The browser's name, for the sentence the page shows. */
  label: string
  /** Where to read from: the usual place for that browser unless a caller says otherwise. */
  dailyDir?: string | null
  /** Where to write: this plugin's adopted profile unless a caller says otherwise. */
  destination?: string
}

/**
 * Copy the logins out of the reader's browser and into the profile this plugin drives.
 *
 * The destination is replaced rather than merged, so a second press means exactly what the
 * reader's browser holds now. Anything logged into *inside* the adopted profile since the
 * last copy is the price of that, which is why the page says so before the press.
 */
export async function adoptProfile(
  kind: BrowserKind,
  options: AdoptOptions,
): Promise<ProfileAdoptReport> {
  const from = options.dailyDir === undefined ? dailyProfileDir(kind) : options.dailyDir
  if (!from) {
    return {
      ok: false,
      reason: 'no-profile',
      browser: options.label,
      note: `没有找到 ${options.label} 的档案目录——这个浏览器可能还没用过，或者装在别的地方。`,
    }
  }
  const to = options.destination ?? adoptedProfileDir(kind)
  const store = join(from, join('Default', 'Network', 'Cookies'))
  if (await storeIsLocked(store)) {
    return {
      ok: false,
      reason: 'locked',
      browser: options.label,
      from,
      to,
      note: `${options.label} 正开着，它把登录数据独自占着，现在读不了。`,
    }
  }

  await rm(to, { recursive: true, force: true })
  const copied = await copyCarriers(from, to)
  if (copied.files === 0) {
    return {
      ok: false,
      reason: 'empty',
      browser: options.label,
      from,
      to,
      note: `在 ${from} 里没有找到可搬的登录数据。`,
    }
  }
  return { ok: true, browser: options.label, from, to, files: copied.files, bytes: copied.bytes }
}

/**
 * Go back to the profile this plugin started with.
 *
 * Moved aside rather than deleted: what sits there is a copy of the reader's logins, and a
 * button that silently deleted that would be the wrong kind of tidy. The new name says what
 * it is, so it can be deleted by hand whenever it is no longer wanted.
 */
export async function dropAdoptedProfile(
  kind: BrowserKind,
  options: { label: string },
): Promise<ProfileAdoptReport> {
  const dir = adoptedProfileDir(kind)
  if (!existsSync(dir)) return { ok: true, browser: options.label, note: '本来就没有在用它。' }
  const stamp = new Date().toISOString().slice(0, 10)
  const aside = `${dir}-停用-${stamp}`
  await rm(aside, { recursive: true, force: true })
  await rename(dir, aside)
  return {
    ok: true,
    browser: options.label,
    to: aside,
    note: `已改回插件自己的档案。搬过来的那份登录数据移到了 ${aside}，确认不用了可以整个删掉。`,
  }
}

/** Copy the carriers that exist, and add up what actually landed. */
async function copyCarriers(from: string, to: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  for (const relative of LOGIN_CARRIERS.files) {
    const source = join(from, relative)
    if (!existsSync(source)) continue
    const target = join(to, relative)
    await mkdir(dirname(target), { recursive: true })
    try {
      await copyFile(source, target)
    } catch {
      // One file that cannot be read is not a reason to abandon the others. The report is
      // only `ok` when something did land, and the size tells the reader how much.
      continue
    }
    files += 1
    bytes += (await stat(target)).size
  }
  for (const relative of LOGIN_CARRIERS.dirs) {
    const source = join(from, relative)
    if (!existsSync(source)) continue
    const target = join(to, relative)
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, { recursive: true, force: true })
    const landed = await measure(target)
    files += landed.files
    bytes += landed.bytes
  }
  return { files, bytes }
}

/** How much one copied directory holds, for the sentence the page shows. */
async function measure(path: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile()) {
        files += 1
        bytes += (await stat(child)).size
      }
    }
  }
  await walk(path)
  return { files, bytes }
}

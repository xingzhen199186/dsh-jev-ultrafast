/**
 * Write build-info.json: which build a tarball holds, for when the version number cannot say.
 *
 * The plugin's version is fixed at 0.1.0 by the reader's own rule, so two tarballs built from
 * different sources share a version and a file name, and rebuilding one in place leaves the
 * installed copies looking identical from the outside. This file is what tells them apart
 * after the fact: open `node_modules/dsh-jev-ultrafast/build-info.json` (it is not a subpath
 * export, so read the file rather than importing it) and compare `commit`, `dirty` and
 * `builtAt` against the build you meant to install.
 *
 * Best effort by design: with no git on PATH the two git fields say "unknown" instead of
 * failing the build — a build with a vague id beats no build at all.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const git = (args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'unknown'
  }
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const commit = git(['rev-parse', '--short', 'HEAD'])
const status = git(['status', '--porcelain'])

const info = {
  name: pkg.name,
  version: pkg.version,
  builtAt: new Date().toISOString(),
  commit,
  dirty: status === 'unknown' ? 'unknown' : status.length > 0,
}

writeFileSync(new URL('../build-info.json', import.meta.url), `${JSON.stringify(info, null, 2)}\n`)
console.log(`[build-info] ${info.name}@${info.version} ${info.commit}${info.dirty === true ? ' (dirty tree)' : ''}`)

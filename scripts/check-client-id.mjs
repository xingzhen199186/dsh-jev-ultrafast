// The startup guard finds a client bundle by matching `id: "<package name>"` with
// a plain quote, so a minified bundle - which rewrites it to a backtick template -
// registers nothing and the plugin is disabled silently. Cheaper to fail the build.
import { readFile } from 'node:fs/promises'

const ID = 'dsh-jev-ultrafast'
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

if (!source.includes(`id: "${ID}"`)) {
  console.error(
    `[check-client-id] lib/client.js does not contain \`id: "${ID}"\`. ` +
      'Do not enable minify for the client bundle, and keep the banner id quoted.',
  )
  process.exit(1)
}

console.log(`[check-client-id] ok: lib/client.js registers ${ID}`)

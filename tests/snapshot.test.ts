import { describe, expect, it } from 'vitest'
import { SNAPSHOT_SOURCE, SNAPSHOT_SOURCE_PLAIN } from '../src/browser/snapshot'

/**
 * The snapshot script is carried inside a `String.raw` template. These checks
 * guard the two ways that could silently corrupt it: an edit that introduces a
 * backtick or `${`, and an escaping change that would eat the regex backslashes.
 */
describe('in-page snapshot source', () => {
  it('contains nothing a raw template would interpolate or terminate', () => {
    expect(SNAPSHOT_SOURCE).not.toContain('`')
    expect(SNAPSHOT_SOURCE).not.toContain('${')
  })

  it('keeps its regular expressions intact', () => {
    expect(SNAPSHOT_SOURCE).toContain('split(/\\s+/)')
    expect(SNAPSHOT_SOURCE).toContain('closest(\'script,style,noscript,template\')')
  })

  it('is still valid JavaScript on its own', () => {
    expect(() => new Function(`return ${SNAPSHOT_SOURCE}`)).not.toThrow()
  })

  it('still owns the identity cache and the guards it is documented to own', () => {
    expect(SNAPSHOT_SOURCE).toContain('window.__jevFast ||=')
    expect(SNAPSHOT_SOURCE).toContain('cache.guard=')
    expect(SNAPSHOT_SOURCE).toContain("actions.push({id:'wait'")
  })

  it('keeps the two readings one substitution apart', () => {
    // What the setting turns off is a block, not a second copy of the script: the two differ in the
    // single guard word, so the off variant is the reading every page had before the block existed —
    // and it keeps the same raw-template promises on its own, since it is injected the same way.
    expect(SNAPSHOT_SOURCE.replace('if (true) {', 'if (false) {')).toBe(SNAPSHOT_SOURCE_PLAIN)
    expect(SNAPSHOT_SOURCE_PLAIN).not.toContain('`')
    expect(SNAPSHOT_SOURCE_PLAIN).not.toContain('${')
    expect(() => new Function(`return ${SNAPSHOT_SOURCE_PLAIN}`)).not.toThrow()
  })
})

import { describe, expect, it } from 'vitest'
import { SNAPSHOT_SOURCE } from '../src/browser/snapshot'

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
})

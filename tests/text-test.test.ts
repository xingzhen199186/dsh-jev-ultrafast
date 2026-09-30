import { describe, expect, it } from 'vitest'
import { probeOk } from '../src/panel'

/**
 * Reading the connectivity probe's answer.
 *
 * The tolerance matters in both directions: refusing a fenced or chatty answer would report a
 * working door as broken, and accepting anything less than that one key would report a broken door
 * as working — which is the worse of the two, because the reader would trust it.
 */
describe('reading the connectivity probe’s answer', () => {
  it('accepts the one-key JSON it asked for', () => {
    expect(probeOk('{"ok":true}')).toBe(true)
    expect(probeOk(' {"ok": true} ')).toBe(true)
    expect(probeOk('```json\n{"ok":true}\n```')).toBe(true)
    expect(probeOk('好的：{"ok":true}')).toBe(true)
    expect(probeOk('{"ok":"true"}')).toBe(true)
  })

  it('refuses everything else, rather than calling a broken door working', () => {
    expect(probeOk('{"ok":false}')).toBe(false)
    expect(probeOk('{}')).toBe(false)
    expect(probeOk('{"text":"ok"}')).toBe(false)
    expect(probeOk('好的')).toBe(false)
    expect(probeOk('')).toBe(false)
    expect(probeOk('{不是 JSON}')).toBe(false)
  })
})

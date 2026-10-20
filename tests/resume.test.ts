import { describe, expect, it } from 'vitest'
import { priorNote, seedFromLastRun } from '../src/resume'
import type { LastRun } from '../src/run-slot'

/** What a continuation may take from the run before it, and nothing it must not. */

const last: LastRun = {
  url: 'https://example.test/checkout',
  status: 'blocked',
  reason: '登录浮层挡住了「搜索」',
  actions: ['click 「Sign in」', 'type 「a@b.c」', 'click 「Search」'],
  steps: 5,
  decisions: 7,
}

describe('resume', () => {
  it('continues on the address the last run stopped on', () => {
    const seeded = seedFromLastRun(last)
    expect(seeded.ok).toBe(true)
    if (!seeded.ok) return
    expect(seeded.seed.url).toBe('https://example.test/checkout')
    expect(seeded.seed.prior.actions).toEqual(last.actions)
    expect(seeded.seed.prior.reason).toBe(last.reason)
  })

  it('says there is nothing to continue rather than starting an empty run', () => {
    const seeded = seedFromLastRun(null)
    expect(seeded.ok).toBe(false)
    if (seeded.ok) return
    expect(seeded.error).toContain('网址')
  })

  it('refuses a run that never reported where it stopped', () => {
    const seeded = seedFromLastRun({ ...last, url: '' })
    expect(seeded.ok).toBe(false)
    if (seeded.ok) return
    expect(seeded.error).toContain('地址')
  })

  it('carries what was done and why it stopped, and says it is a continuation', () => {
    const note = priorNote(last)
    expect(note).toContain('接着上一次')
    expect(note).toContain('不要从头重来')
    expect(note).toContain('「click 「Sign in」」')
    expect(note).toContain(last.reason)
  })

  it('keeps only the tail of a long action list', () => {
    const many = Array.from({ length: 20 }, (_, index) => `step ${index + 1}`)
    const note = priorNote({ actions: many, status: 'blocked', reason: '' })
    expect(note).not.toContain('step 1」')
    expect(note).toContain('step 20')
    // Eight actions is the stated budget, not one more.
    expect(note.split('」').length - 1).toBe(8)
  })

  it('says nothing about actions or a reason it does not have', () => {
    const note = priorNote({ actions: [], status: 'done', reason: '' })
    expect(note).not.toContain('已经做过')
    expect(note).not.toContain('停下的原因')
    expect(note.startsWith('这次是接着上一次')).toBe(true)
  })
})

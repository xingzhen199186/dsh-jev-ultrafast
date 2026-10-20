import { describe, expect, it } from 'vitest'
import {
  activeState,
  claimRun,
  controlActive,
  forgetLastRun,
  lastRun,
  lastRunOf,
  type LastRun,
} from '../src/run-slot'
import type { TaskResult } from '../src/loop'

/**
 * The run table every door shares. These cases are about the two things a reader can feel — one
 * run at a time, and a pause that really holds — plus the memory `resume` reads.
 *
 * The slot is one module-level table on purpose, so each case hands it back before it ends: a
 * lease left behind would make the next case look busy.
 */

/** Hold the slot for one case, and always give it back. */
async function withLease<T>(run: (lease: ReturnType<typeof claim>) => Promise<T>): Promise<T> {
  const claim = claimRun({ owner: 'tool', goal: 'find a flight' })
  expect(claim.ok).toBe(true)
  if (!claim.ok) throw new Error('unreachable')
  try {
    return await run(claim.lease)
  } finally {
    claim.lease.release()
  }
}

function claim() {
  const claimed = claimRun({ owner: 'tool', goal: 'find a flight' })
  if (!claimed.ok) throw new Error(claimed.error)
  return claimed.lease
}

describe('run slot', () => {
  it('lets a run through when nobody has paused it', async () => {
    await withLease(async (lease) => {
      await lease.gate({ step: 1, action: 'click Search' })
      expect(activeState()?.waiting).toBe(false)
      expect(lease.state().paused).toBe(false)
    })
  })

  it('holds the run at the gate while paused, and the release is what lets it go', async () => {
    await withLease(async (lease) => {
      expect(lease.control('pause')).toBe(true)
      let through = false
      const held = lease.gate({ step: 3, action: 'type Zürich' }).then(() => {
        through = true
      })
      await Promise.resolve()
      expect(through).toBe(false)
      expect(activeState()?.waiting).toBe(true)
      expect(controlActive('resume')).toBe(true)
      await held
      expect(through).toBe(true)
      expect(activeState()?.waiting).toBe(false)
    })
  })

  it('lets exactly one step through, then holds again', async () => {
    await withLease(async (lease) => {
      lease.control('pause')
      const first = lease.gate({ step: 1, action: 'click Search' })
      await Promise.resolve()
      expect(lease.control('step')).toBe(true)
      await first
      let secondThrough = false
      const second = lease.gate({ step: 2, action: 'type Zürich' }).then(() => {
        secondThrough = true
      })
      await Promise.resolve()
      expect(secondThrough).toBe(false)
      lease.control('stop')
      await second
    })
  })

  it('aborts the controller when stopped, so a held run stops without acting', async () => {
    await withLease(async (lease) => {
      lease.control('pause')
      const held = lease.gate({ step: 1, action: 'click Search' })
      await Promise.resolve()
      expect(lease.control('stop')).toBe(true)
      await held
      expect(lease.controller.signal.aborted).toBe(true)
      // Stopping does not hand the slot back by itself: the run is still unwinding, and its own
      // `finally` is what releases it. Until then the slot still names the run it stopped.
      expect(activeState()?.owner).toBe('tool')
    })
  })

  it('refuses a second run with a sentence naming the one that is running', async () => {
    await withLease(async () => {
      const second = claimRun({ owner: 'command', goal: 'second goal' })
      expect(second.ok).toBe(false)
      if (second.ok) return
      expect(second.error).toContain('find a flight')
      expect(second.error).toContain('停止')
    })
  })

  it('says which door started the run, so the inspector can tell its own from someone else’s', async () => {
    const claimed = claimRun({ owner: 'command', goal: 'from the command' })
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    expect(activeState()?.owner).toBe('command')
    claimed.lease.release()
    expect(activeState()).toBeNull()
  })

  it('keeps the last run for resume only when it is handed over with one', async () => {
    forgetLastRun()
    await withLease(async (lease) => {
      lease.release({ url: 'https://example.test/a', status: 'blocked', reason: 'stuck', actions: ['click Search'], steps: 3, decisions: 4 })
    })
    expect(lastRun()?.url).toBe('https://example.test/a')
    // A second release without a run (the `finally` every caller has) must not erase it.
    expect(lastRun()?.status).toBe('blocked')
    expect(controlActive('pause')).toBe(false)
    forgetLastRun()
    expect(lastRun()).toBeNull()
  })

  it('takes the memory of a run from what the run already reported', () => {
    const result = {
      page: { url: 'https://example.test/done', title: 'Done', text: 'ok' },
      status: 'blocked' as const,
      reason: '编号在页面里找不到',
      history: [
        { action: 'click 「Search」' },
        { action: 'type 「Zürich」' },
      ],
      steps: 7,
      decisions: 9,
    }
    const remembered: LastRun = lastRunOf(result as unknown as TaskResult)
    expect(remembered.url).toBe('https://example.test/done')
    expect(remembered.actions).toEqual(['click 「Search」', 'type 「Zürich」'])
    expect(remembered.steps).toBe(7)
    expect(remembered.decisions).toBe(9)
  })
})

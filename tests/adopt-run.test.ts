/**
 * The sequence behind the button, and the promise it makes about order.
 *
 * Everything here is injected, including the sleep. What is worth testing is the order — close
 * the reader's browser, copy, start this plugin's browser, put the reader's browser back — and
 * exactly what is skipped when a step fails. Starting a real browser would turn this into a
 * manual test that opens a window on whatever machine ran it.
 */
import { describe, expect, it } from 'vitest'
import { createAdoptRun, type AdoptRunDeps } from '../src/browser/adopt-run'

function harness(countdownSeconds = 0, overrides: (calls: string[]) => Partial<AdoptRunDeps> = () => ({})) {
  const calls: string[] = []
  const deps: AdoptRunDeps = {
    close: async () => {
      calls.push('close')
      return { ok: true }
    },
    adopt: async () => {
      calls.push('adopt')
      return { ok: true, browser: 'Edge', from: 'a', to: 'b', files: 3, bytes: 10 }
    },
    startPluginBrowser: async () => {
      calls.push('start-plugin')
    },
    reopenReaderBrowser: async () => {
      calls.push('reopen')
    },
    sleep: async (ms) => {
      calls.push(`sleep:${ms}`)
    },
    now: () => 0,
    ...overrides(calls),
  }
  return { calls, run: createAdoptRun({ countdownSeconds, deps }) }
}

/** The steps the sequence took, with the countdown's own sleeps taken out. */
function steps(calls: string[]): string[] {
  return calls.filter((call) => !call.startsWith('sleep:'))
}

const pressed = { kind: 'edge' as const, label: 'Edge', page: 'http://127.0.0.1:3080/' }

describe('the adopt sequence', () => {
  it('closes, copies, starts this plugin’s browser, and puts the reader’s back', async () => {
    const { calls, run } = harness()

    const first = run.start(pressed)

    expect(first.state).toBe('counting')
    expect(first.browser).toBe('Edge')
    await run.settled()
    expect(calls).toEqual(['sleep:0', 'close', 'adopt', 'start-plugin', 'reopen'])
    expect(run.status()?.state).toBe('done')
    expect(run.status()?.report?.files).toBe(3)
  })

  it('stops before the copy when the browser will not close, and still puts it back', async () => {
    const { calls, run } = harness(0, (calls) => ({
      close: async () => {
        calls.push('close')
        return { ok: false, note: '还占着登录数据' }
      },
    }))

    run.start(pressed)
    await run.settled()

    expect(calls).toEqual(['sleep:0', 'close', 'reopen'])
    expect(run.status()?.state).toBe('failed')
    expect(run.status()?.note).toBe('还占着登录数据')
  })

  it('starts no browser of ours when the copy itself fails', async () => {
    const { calls, run } = harness(0, (calls) => ({
      adopt: async () => {
        calls.push('adopt')
        return { ok: false, browser: 'Edge', note: '读不了' }
      },
    }))

    run.start(pressed)
    await run.settled()

    expect(calls).toEqual(['sleep:0', 'close', 'adopt', 'reopen'])
    expect(run.status()?.state).toBe('failed')
    expect(run.status()?.note).toBe('读不了')
  })

  it('does nothing at all when the countdown is stopped in time', async () => {
    const sleepers: Array<() => void> = []
    const { calls, run } = harness(10, () => ({
      sleep: () => new Promise<void>((resolve) => sleepers.push(resolve)),
    }))

    run.start(pressed)
    expect(run.cancel()).toBe(true)
    expect(run.status()).toBeUndefined()

    sleepers[0]?.()
    await run.settled()
    expect(calls).toEqual([])
  })

  it('cannot be stopped once the browser is being closed', async () => {
    const { run } = harness()
    run.start(pressed)
    await run.settled()
    expect(run.cancel()).toBe(false)
  })

  it('counts the seconds down against the clock the page reads', () => {
    let clock = 1000
    const { run } = harness(10, () => ({ now: () => clock }))

    run.start(pressed)
    expect(run.status()?.secondsLeft).toBe(10)
    clock = 4000
    expect(run.status()?.secondsLeft).toBe(7)
    clock = 12_000
    expect(run.status()?.secondsLeft).toBe(0)
  })

  it('lets a second press take over from the first', async () => {
    const sleepers: Array<() => void> = []
    const { calls, run } = harness(10, () => ({
      sleep: () => new Promise<void>((resolve) => sleepers.push(resolve)),
    }))

    run.start(pressed)
    run.start(pressed)
    // The abandoned sequence wakes up, finds it is no longer the current one, and does nothing.
    sleepers[0]?.()
    await Promise.resolve()
    expect(steps(calls)).toEqual([])

    sleepers[1]?.()
    await run.settled()
    expect(steps(calls)).toEqual(['close', 'adopt', 'start-plugin', 'reopen'])
  })
})

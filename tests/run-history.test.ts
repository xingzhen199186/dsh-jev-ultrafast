import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasLastWord, interruptedRuns, pastRuns, unfinishedDeaths } from '../src/run-history'

/**
 * Which runs never finished, read from what they left on disk.
 *
 * This is the evidence behind one sentence the reader sees: "上一趟没跑完". Getting it wrong in
 * either direction is bad in its own way — a finished run called dead is a false alarm, and a dead
 * run called alive is exactly the silence this module exists to end.
 */
describe('reading which runs never finished', () => {
  const root = () => mkdtempSync(join(tmpdir(), 'jev-history-'))

  const run = (where: string, name: string, trace: string) => {
    mkdirSync(join(where, name), { recursive: true })
    writeFileSync(join(where, name, 'trace.jsonl'), trace)
    return join(where, name)
  }

  it('knows the loop’s last word from anything else in the trace', () => {
    expect(hasLastWord(run(root(), 'run-1000-aaaa', '{"kind":"decision"}\n{"kind":"run","status":"done"}\n'))).toBe(true)
    expect(hasLastWord(run(root(), 'run-1000-aaaa', '{"kind":"decision"}\n'))).toBe(false)
    expect(hasLastWord(run(root(), 'run-1000-aaaa', '半行没写完的\n'))).toBe(false)
    expect(hasLastWord(join(root(), 'run-1000-aaaa'))).toBe(false)
  })

  it('reads the start time out of the directory name, oldest first', () => {
    const where = root()
    run(where, 'run-2000-bbbb', '{}')
    run(where, 'run-1000-aaaa', '{}')
    mkdirSync(join(where, 'run-notours'), { recursive: true })
    mkdirSync(join(where, 'something-else'), { recursive: true })
    expect(pastRuns(where)).toEqual([
      { name: 'run-1000-aaaa', startedAt: 1000 },
      { name: 'run-2000-bbbb', startedAt: 2000 },
    ])
  })

  it('counts only runs that predate this process and never finished', () => {
    const where = root()
    run(where, 'run-1000-aaaa', '{"kind":"decision"}\n')
    run(where, 'run-2000-bbbb', '{"kind":"run","status":"done"}\n')
    run(where, 'run-9000-cccc', '{"kind":"decision"}\n')
    // bootedAt 5000: the first run died before this process, the second finished, the third is
    // this process's own run in flight — reporting that one as dead would be the opposite of true.
    expect(interruptedRuns(where, 5000)).toEqual([{ name: 'run-1000-aaaa', startedAt: 1000 }])
  })

  it('stops mentioning a death once a later run has finished', () => {
    const where = root()
    run(where, 'run-1000-aaaa', '{"kind":"decision"}\n')
    expect(unfinishedDeaths(where, 5000)).toEqual([{ name: 'run-1000-aaaa', startedAt: 1000 }])
    // A run that finished afterwards is the proof the reader got what they asked for; the older
    // loss becomes stale news and stops being repeated.
    run(where, 'run-2000-bbbb', '{"kind":"run","status":"done"}\n')
    expect(unfinishedDeaths(where, 5000)).toEqual([])
    // A death after that successful run is news again.
    run(where, 'run-3000-cccc', '{"kind":"decision"}\n')
    expect(unfinishedDeaths(where, 5000)).toEqual([{ name: 'run-3000-cccc', startedAt: 3000 }])
  })

  it('is quiet when there is nothing to read', () => {
    expect(pastRuns(join(root(), 'missing'))).toEqual([])
    expect(interruptedRuns(join(root(), 'missing'), 5000)).toEqual([])
    expect(unfinishedDeaths(join(root(), 'missing'), 5000)).toEqual([])
  })
})

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openArtifacts, recordable } from '../src/artifacts'

// Every directory a test opens is removed afterwards: the point of the module is that a
// run leaves evidence behind, and the tests are not allowed to leave a pile of their own.
const made: string[] = []
const open = (frames: boolean) => {
  const artifacts = openArtifacts(frames)
  made.push(artifacts.dir)
  return artifacts
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('what a run leaves behind', () => {
  it('appends one JSON line per exchange', () => {
    const artifacts = open(false)
    artifacts.trace.write({ at: 1, kind: 'decision', status: 200 })
    artifacts.trace.write({ at: 2, kind: 'run', status: 'done' })

    const lines = readFileSync(join(artifacts.dir, 'trace.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toEqual({ at: 1, kind: 'decision', status: 200 })
    expect(JSON.parse(lines[1]!)).toEqual({ at: 2, kind: 'run', status: 'done' })
  })

  it('keeps no frames at all when the screenshot switch is off', () => {
    const artifacts = open(false)
    artifacts.frame('aGVsbG8=', 120)
    artifacts.finish(500)

    expect(existsSync(join(artifacts.dir, 'frames'))).toBe(false)
    expect(existsSync(join(artifacts.dir, 'frames.json'))).toBe(false)
  })

  it('writes one frame per step, named by elapsed milliseconds, next to a manifest', () => {
    const artifacts = open(true)
    artifacts.frame('aGVsbG8=', 0)
    artifacts.frame('d29ybGQ=', 1200)
    artifacts.finish(3000)

    expect(readFileSync(join(artifacts.dir, 'frames', '000000.jpg'), 'utf8')).toBe('hello')
    expect(readFileSync(join(artifacts.dir, 'frames', '001200.jpg'), 'utf8')).toBe('world')
    expect(JSON.parse(readFileSync(join(artifacts.dir, 'frames.json'), 'utf8'))).toEqual({
      run_ms: 3000,
      frames: [
        { file: '000000.jpg', at_ms: 0 },
        { file: '001200.jpg', at_ms: 1200 },
      ],
    })
  })

  it('never writes a credential, and cuts an enormous body short', () => {
    expect(recordable({ authorization: 'Bearer sk-secret', text: 'ok' }, 'sk-secret')).toEqual({
      authorization: 'Bearer ***',
      text: 'ok',
    })

    const long = recordable({ text: 'x'.repeat(30_000) })
    expect(typeof long).toBe('string')
    expect(String(long)).toContain('已截断')
    expect(String(long).length).toBeLessThan(20_100)
  })

  it('says nothing about a frame it was handed nothing for', () => {
    const artifacts = open(true)
    artifacts.frame(null, 10)
    artifacts.frame(undefined, 20)
    artifacts.frame('', 30)
    artifacts.finish(40)

    expect(JSON.parse(readFileSync(join(artifacts.dir, 'frames.json'), 'utf8')).frames).toEqual([])
  })
})

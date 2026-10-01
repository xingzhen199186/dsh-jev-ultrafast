import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openArtifacts, recordable, redactUrl } from '../src/artifacts'

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

/**
 * The address a step was on is what a trace keeps for every step, and a login callback puts
 * a credential in that address. These are the pure rules; the write points that use them are
 * covered where they are written (`decision.test.ts`, and the body case below).
 */
describe('the address in a trace', () => {
  it('blanks the value of a callback parameter in the query string', () => {
    expect(redactUrl('https://example.test/cb?code=abc123&state=keep')).toBe(
      'https://example.test/cb?code=REDACTED&state=keep',
    )
  })

  it('blanks it in the fragment too', () => {
    expect(redactUrl('https://example.test/cb#code=abc123')).toBe('https://example.test/cb#code=REDACTED')
    expect(redactUrl('https://example.test/cb#/done?access_token=abc123')).toBe(
      'https://example.test/cb#/done?access_token=REDACTED',
    )
  })

  it('knows the name whatever its case, and keeps the spelling it was written in', () => {
    expect(redactUrl('https://example.test/cb?CODE=abc123')).toBe('https://example.test/cb?CODE=REDACTED')
    expect(redactUrl('https://example.test/cb?Access_Token=abc123')).toBe(
      'https://example.test/cb?Access_Token=REDACTED',
    )
  })

  it('leaves a parameter that has no value alone', () => {
    expect(redactUrl('https://example.test/cb?code&state=1')).toBe('https://example.test/cb?code&state=1')
  })

  it('does not touch names that only look like the sensitive ones', () => {
    const address = 'https://example.test/?score=7&codex=9&key=k&codes=1&signed=yes'
    expect(redactUrl(address)).toBe(address)
  })

  it('leaves ordinary text alone', () => {
    const text = '这只是一句话，没有地址，也没有 score 这种东西'
    expect(redactUrl(text)).toBe(text)
  })

  it('blanks every sensitive parameter of one address', () => {
    expect(redactUrl('https://example.test/cb?code=a&access_token=b#refresh_token=c')).toBe(
      'https://example.test/cb?code=REDACTED&access_token=REDACTED#refresh_token=REDACTED',
    )
  })

  it('reaches an address wherever it sits in a recorded body', () => {
    // The step's address is not a field of the trace record: the request carries it inside
    // `state.page.url`, which is why the whole body goes through the same rule.
    expect(
      recordable({
        state: { page: { url: 'https://example.test/cb?code=abc123', title: 'Callback' } },
        recent: ['https://example.test/next?id_token=xyz'],
      }),
    ).toEqual({
      state: { page: { url: 'https://example.test/cb?code=REDACTED', title: 'Callback' } },
      recent: ['https://example.test/next?id_token=REDACTED'],
    })
  })

  it('leaves a body without an address as it was', () => {
    expect(recordable({ model: 'jev-latest', state: { note: '没有地址' } })).toEqual({
      model: 'jev-latest',
      state: { note: '没有地址' },
    })
  })
})

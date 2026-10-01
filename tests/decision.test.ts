import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotAction } from '../src/browser/session'
import { actionSpace } from '../src/decision/action-space'
import { askText, fieldContext, fieldText, type DshChunk, type TextHelperSource } from '../src/decision/text-helper'
import {
  type DecisionContext,
  InvalidDecision,
  buildQuestionnaire,
  choose,
  readDecision,
  validateChoice,
} from '../src/decision/typesafe'

/** The observed page these tests decide about: two operations on one node, and a dropdown. */
const observed: SnapshotAction[] = [
  { id: 'e1', kind: 'click', node: 1, role: 'button', label: 'Search' },
  { id: 'e2', kind: 'fill', node: 2, role: 'combobox', label: 'Where from?', value: '' },
  { id: 'e3', kind: 'click', node: 2, role: 'combobox', label: 'Open Where from?', value: '' },
  {
    id: 'e4',
    kind: 'select',
    node: 3,
    role: 'combobox',
    label: 'Trip → One way',
    value: 'oneway',
    current_value: 'Round trip',
  },
  { id: 'e5', kind: 'select', node: 3, role: 'combobox', label: 'Trip → Round trip', value: 'roundtrip' },
  { id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 },
  { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
]

const context: DecisionContext = {
  goal: 'Find a one-way flight from Zürich to London',
  page: { url: 'https://example.test/flights', title: 'Flights', text: 'Where from?' },
  history: [],
}

describe('action space', () => {
  it('keeps one index for a node that both types and clicks', () => {
    const space = actionSpace(observed)
    expect(space.elements).toHaveLength(3)
    expect(space.elements[1]).toMatchObject({ index: '2', label: 'Where from?', operations: ['TYPE_TEXT', 'CLICK'] })
    expect(Object.keys(space.targets.CLICK!)).toEqual(['1', '2'])
    expect(Object.keys(space.targets.TYPE_TEXT!)).toEqual(['2'])
  })

  it('mints its own target for each dropdown option', () => {
    const space = actionSpace(observed)
    expect(Object.keys(space.targets.SELECT!)).toEqual(['3:1', '3:2'])
    expect(space.targets.SELECT!['3:2']!.value).toBe('roundtrip')
    // The element shows what is selected now, not the option it would choose.
    expect(space.elements[2]!.value).toBe('Round trip')
    expect(space.elements[2]!.options).toHaveLength(2)
  })

  it('keeps the synthetic operations out of the element table', () => {
    const space = actionSpace(observed)
    expect(Object.keys(space.controls).sort()).toEqual(['SCROLL_DOWN', 'WAIT'])
    expect(space.targets.SCROLL_DOWN).toBeUndefined()
  })
})

describe('questionnaire', () => {
  const space = actionSpace(observed)

  it('offers every operation, including the two terminal ones', () => {
    const { operations } = buildQuestionnaire(space, context, 'jev-latest')
    expect(operations).toEqual(['CLICK', 'TYPE_TEXT', 'SELECT', 'SCROLL_DOWN', 'WAIT', 'DONE', 'BLOCKED'])
  })

  it('asks each target question about its own operation only', () => {
    const { request, targetIds } = buildQuestionnaire(space, context, 'jev-latest')
    const questions = request.questions as Record<string, { criteria: Record<string, unknown>; instructions: Record<string, unknown> }>
    expect(Object.keys(questions)).toEqual(['operation', 'click_target', 'type_text_target', 'select_target'])
    expect(Object.keys(questions.click_target!.criteria)).toEqual(['1', '2'])
    expect(Object.keys(questions.select_target!.criteria)).toEqual(['3:1', '3:2'])
    expect(questions.click_target!.instructions.operation).toBe('CLICK')
    expect(targetIds.SELECT).toEqual(['3:1', '3:2'])
  })

  it('shows the state without leaking geometry or node identity', () => {
    const { request } = buildQuestionnaire(space, context, 'jev-latest')
    const state = request.state as { elements: unknown }
    expect(JSON.stringify(state)).not.toContain('rect')
    expect(JSON.stringify(state)).not.toContain('"node"')
  })

  it('carries the run\'s one-off sentence into the request, and nothing when there is none', () => {
    const note = '你上次选的编号在页面里已经找不到了，页面可能自己刷新过，请重新选'
    const said = buildQuestionnaire(space, { ...context, note }, 'jev-latest').request.state as { note?: string }
    expect(said.note).toBe(note)

    const quiet = buildQuestionnaire(space, context, 'jev-latest').request.state as { note?: string }
    expect(quiet.note).toBeUndefined()
  })
})

describe('answer validation', () => {
  it('accepts a well-formed distribution over exactly the offered choices', () => {
    const answer = { choice: 'b', confidence: 0.6, probabilities: { a: 0.4, b: 0.6 } }
    expect(validateChoice(answer, ['a', 'b']).choice).toBe('b')
  })

  it.each([
    ['a choice we never offered', { choice: 'c', confidence: 0.5, probabilities: { a: 0.5, b: 0.5 } }],
    ['a probability for an unknown choice', { choice: 'a', confidence: 0.5, probabilities: { a: 0.5, b: 0.3, c: 0.2 } }],
    ['a distribution that does not sum to one', { choice: 'a', confidence: 0.5, probabilities: { a: 0.2, b: 0.2 } }],
    ['a winner that is not the most probable choice', { choice: 'a', confidence: 0.5, probabilities: { a: 0.3, b: 0.7 } }],
    ['a confidence outside 0..1', { choice: 'a', confidence: 1.4, probabilities: { a: 0.7, b: 0.3 } }],
    ['a missing answer', undefined],
  ])('refuses %s', (_name, answer) => {
    expect(() => validateChoice(answer, ['a', 'b'])).toThrow(InvalidDecision)
  })
})

describe('decision reading', () => {
  const space = actionSpace(observed)
  const questionnaire = buildQuestionnaire(space, context, 'jev-latest')
  /**
   * A well-formed answer to the operation question. It must cover every operation
   * the question offered, including the two synthetic actions and the two
   * terminal ones — the service is never asked a partial question.
   */
  const operation = (choice: string, confidence = 0.8) => {
    const names = ['CLICK', 'TYPE_TEXT', 'SELECT', 'SCROLL_DOWN', 'WAIT', 'DONE', 'BLOCKED']
    const rest = 0.1 / (names.length - 1)
    const probabilities: Record<string, number> = {}
    for (const name of names) probabilities[name] = name === choice ? 0.9 : rest
    return { choice, confidence, probabilities }
  }

  it('maps the winning target index back to an action id', () => {
    const decision = readDecision(
      {
        answers: {
          operation: operation('CLICK'),
          click_target: { choice: '1', confidence: 0.7, probabilities: { '1': 0.7, '2': 0.3 } },
        },
      },
      space,
      questionnaire,
    )
    expect(decision).toMatchObject({ choice: 'e1', operation: 'CLICK', target: '1', confidence: 0.8 })
    expect(decision.probabilities).toEqual({ e1: 0.7, e3: 0.3 })
  })

  it('reads a dropdown option through its own target key', () => {
    const decision = readDecision(
      {
        answers: {
          operation: operation('SELECT', 0.6),
          select_target: { choice: '3:2', confidence: 0.9, probabilities: { '3:1': 0.1, '3:2': 0.9 } },
        },
      },
      space,
      questionnaire,
    )
    expect(decision.choice).toBe('e5')
    expect(decision.operationProbabilities.SELECT).toBe(0.9)
  })

  it('passes the terminal operations straight through', () => {
    const decision = readDecision(
      {
        answers: {
          operation: operation('DONE', 0.95),
        },
      },
      space,
      questionnaire,
    )
    expect(decision.choice).toBe('DONE')
    expect(decision.target).toBeNull()
  })

  it('reads a synthetic operation as its own action', () => {
    const decision = readDecision(
      {
        answers: {
          operation: operation('WAIT', 0.5),
        },
      },
      space,
      questionnaire,
    )
    expect(decision.choice).toBe('wait')
  })

  it('ignores target heads it is not allowed to act on', () => {
    const decision = readDecision(
      {
        answers: {
          operation: operation('CLICK'),
          click_target: { choice: '2', confidence: 0.7, probabilities: { '1': 0.3, '2': 0.7 } },
          select_target: { choice: 'nonsense', confidence: 9, probabilities: {} },
        },
      },
      space,
      questionnaire,
    )
    expect(decision.choice).toBe('e3')
  })

  it('refuses a response with no answers at all', () => {
    expect(() => readDecision({}, space, questionnaire)).toThrow(InvalidDecision)
    expect(() => readDecision({ answers: null }, space, questionnaire)).toThrow(InvalidDecision)
  })
})

describe('decision call', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const source = { endpoint: 'https://decide.example.test/v1/systemone', apiKey: 'test-key', model: 'jev-latest' }
  const space = actionSpace(observed)
  const operation = (choice: string, confidence = 0.8) => {
    const names = ['CLICK', 'TYPE_TEXT', 'SELECT', 'SCROLL_DOWN', 'WAIT', 'DONE', 'BLOCKED']
    const rest = 0.1 / (names.length - 1)
    const probabilities: Record<string, number> = {}
    for (const name of names) probabilities[name] = name === choice ? 0.9 : rest
    return { choice, confidence, probabilities }
  }
  const accepted = {
    answers: {
      operation: operation('CLICK'),
      click_target: { choice: '1', confidence: 0.7, probabilities: { '1': 0.7, '2': 0.3 } },
    },
    model: 'jev-latest-20260101',
    usage: { total_tokens: 120 },
  }
  type Wire = { url: string; init: { method: string; headers: Record<string, string>; body: string } }

  it('posts the questionnaire to the configured endpoint, under the configured model and key', async () => {
    const seen: Wire[] = []
    vi.stubGlobal('fetch', async (url: string, init: Wire['init']) => {
      seen.push({ url, init })
      return new Response(JSON.stringify(accepted))
    })

    const decision = await choose(source, space, context)

    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe(source.endpoint)
    expect(seen[0]!.init.method).toBe('POST')
    expect(seen[0]!.init.headers.authorization).toBe('Bearer test-key')
    expect(seen[0]!.init.headers['content-type']).toBe('application/json')
    // The goal is what the service decides about, so it has to be on the wire.
    expect(seen[0]!.init.body).toContain(context.goal)
    expect(JSON.parse(seen[0]!.init.body).model).toBe('jev-latest')

    expect(decision).toMatchObject({ choice: 'e1', operation: 'CLICK', model: 'jev-latest-20260101' })
    expect(decision.usage).toEqual({ total_tokens: 120 })
  })

  it("reports a refused key in one sentence, with the service's own words and never the key", async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      // The service is made to echo the key, which is what the scrub has to survive.
      return new Response('{"error":{"message":"Missing Authentication header for test-key"}}', { status: 401 })
    })
    const error = await choose(source, space, context).catch((thrown: Error) => thrown)
    expect(String(error)).toMatch(/决策服务返回 HTTP 401/)
    expect(String(error)).toContain('服务端原话：')
    expect(String(error)).toContain('Missing Authentication header')
    expect(String(error)).not.toContain('test-key')
    expect(calls).toBe(1)
  })

  it('waits and tries again only for the statuses that mean "later"', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      return calls === 1 ? new Response('slow down', { status: 429 }) : new Response(JSON.stringify(accepted))
    })
    const decision = await choose(source, space, context)
    expect(calls).toBe(2)
    expect(decision.choice).toBe('e1')
  })

  it('hands the raw exchange to the trace, with the credential taken out', async () => {
    const written: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async () =>
      // A service echoing the key back is the case this is really about: an error body is
      // still text from somewhere else, and a key must never surface in a file we wrote.
      new Response(JSON.stringify({ ...accepted, echo: 'your key is test-key' })),
    )

    await choose({ ...source, trace: { write: (record) => written.push(record) } }, space, context)

    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ kind: 'decision', status: 200, attempt: 0, wrapped: false })
    expect(written[0]!.request).toMatchObject({ model: 'jev-latest' })
    expect(JSON.stringify(written[0])).not.toContain('test-key')
    expect(JSON.stringify(written[0])).toContain('***')
  })

  it('sends the flat body first and the wrapped one only after a refusal about shape', async () => {
    const bodies: string[] = []
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      bodies.push(init.body)
      return bodies.length === 1
        ? new Response('bad shape', { status: 422 })
        : new Response(JSON.stringify(accepted))
    })

    const decision = await choose({ ...source, wrapFallback: true }, space, context)

    expect(bodies).toHaveLength(2)
    expect(JSON.parse(bodies[0]!).decisionsRequest).toBeUndefined()
    const wrapped = JSON.parse(bodies[1]!) as { decisionsRequest: { model: string; questions: unknown } }
    expect(wrapped.decisionsRequest.model).toBe('jev-latest')
    expect(wrapped.decisionsRequest.questions).toBeDefined()
    expect(decision.choice).toBe('e1')
  })

  it('does not wrap when the door says this endpoint takes the flat body', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      return new Response('bad shape', { status: 422 })
    })
    await expect(choose(source, space, context)).rejects.toThrow(/决策服务返回 HTTP 422/)
    expect(calls).toBe(1)
  })

  it('says that the wrapped retry was already tried when both shapes fail', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 400 }))
    await expect(choose({ ...source, wrapFallback: true }, space, context)).rejects.toThrow(/decisionsRequest/)
  })

  it('never reports a decision it did not receive', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    await expect(choose(source, space, context)).rejects.toThrow(/连接决策服务失败/)
  })
})

describe('text helper', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const source = { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'test-key', model: 'deepseek-chat', reasoning: 'none' as const }
  const field = observed[1]!
  const build = () => fieldContext(context.goal, field, context.page, context.history)

  it('shows the helper the field, the goal and the recent actions', () => {
    expect(build()).toEqual({
      goal: context.goal,
      field: { label: 'Where from?', role: 'combobox', value: '' },
      page: { title: 'Flights', text: 'Where from?' },
      recent_actions: [],
    })
  })

  it('never types anything without a credential', async () => {
    await expect(fieldText({ ...source, apiKey: '' }, build())).rejects.toThrow(/密钥/)
  })

  it('accepts exactly one non-empty string', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"text":"Zürich"}' } }],
      usage: { total_tokens: 31 },
    })))
    const result = await fieldText(source, build())
    expect(result.text).toBe('Zürich')
    expect(result.usage).toEqual({ total_tokens: 31 })
  })

  it.each([
    ['prose instead of JSON', 'Zürich'],
    ['an empty value', '{"text":""}'],
    ['a null value', '{"text":null}'],
    ['extra keys', '{"text":"Zürich","note":"guessed"}'],
    ['an over-long value', `{"text":"${'x'.repeat(2001)}"}`],
  ])('types nothing when the helper returns %s', async (_name, content) => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content } }] })))
    await expect(fieldText(source, build())).rejects.toThrow(/什么都没有输入/)
  })

  it('gives the model room that cannot be the reason it failed', async () => {
    // The cap only ever stops a runaway or cuts a real answer off, and on a route where the model
    // thinks first the thinking shares this budget: a tight cap is how "it said nothing" happens.
    let sent: Record<string, unknown> = {}
    vi.stubGlobal('fetch', async (_url: unknown, init: { body?: string }) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"Zürich"}' } }] }))
    })
    await fieldText(source, build())
    expect(Number(sent.max_tokens)).toBe(393_216)
  })

  it('asks again with the limit the refusal names, when it names one', async () => {
    const sent: number[] = []
    let calls = 0
    vi.stubGlobal('fetch', async (_url: unknown, init: { body?: string }) => {
      calls += 1
      sent.push(Number((JSON.parse(String(init.body)) as { max_tokens?: unknown }).max_tokens))
      return calls === 1
        ? new Response(
            JSON.stringify({ error: { message: 'max_tokens: 393216 > 8192, which is the maximum allowed' } }),
            { status: 400 },
          )
        : new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"Zürich"}' } }] }))
    })
    const result = await fieldText(source, build())
    expect(result.text).toBe('Zürich')
    expect(calls).toBe(2)
    expect(sent[0]).toBe(393_216)
    expect(sent[1]).toBe(8192)
  })

  it('asks again with its own small ceiling when the refusal names no limit', async () => {
    // The sentence this reads is the helper's own wrapper, so it carries "HTTP 400" as well as the
    // vendor's words: the retry must not mistake a status code for the route's own limit.
    const sent: number[] = []
    let calls = 0
    vi.stubGlobal('fetch', async (_url: unknown, init: { body?: string }) => {
      calls += 1
      sent.push(Number((JSON.parse(String(init.body)) as { max_tokens?: unknown }).max_tokens))
      return calls === 1
        ? new Response(JSON.stringify({ error: { message: 'max_tokens is too large' } }), { status: 400 })
        : new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"Zürich"}' } }] }))
    })
    await fieldText(source, build())
    expect(calls).toBe(2)
    expect(sent[1]).toBe(8192)
  })

  it('waits out a busy text model instead of giving up', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      return calls === 1
        ? new Response('slow down', { status: 503 })
        : new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"Zürich"}' } }] }))
    })
    const result = await fieldText(source, build())
    expect(calls).toBe(2)
    expect(result.text).toBe('Zürich')
  })

  it('does not retry a refusal that will not change', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      return new Response('bad request', { status: 400 })
    })
    await expect(fieldText(source, build())).rejects.toThrow(/HTTP 400/)
    expect(calls).toBe(1)
  })

  it('hands the text exchange to the trace as well', async () => {
    const written: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"Zürich"}' } }] })),
    )

    await fieldText({ ...source, trace: { write: (record) => written.push(record) } }, build())

    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ kind: 'text', door: 'preset', status: 200 })
    expect(JSON.stringify(written[0]!.request)).toContain('Where from?')
    expect(JSON.stringify(written[0])).not.toContain('test-key')
  })

  it('keeps DeepSeek reasoning off when asked to', async () => {
    let body: Record<string, unknown> = {}
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body) as Record<string, unknown>
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"Zürich"}' } }] }))
    })
    await fieldText(source, build())
    expect(body.reasoning).toEqual({ enabled: false })
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.messages).toHaveLength(2)
  })
})

/**
 * The other door: DSH's own model service, which never throws at the caller. Everything a
 * failed or truncated call has to say arrives as one `finish` reason, so the reader's sentence
 * is only as useful as what this block keeps.
 */
describe('the DSH door of the text helper', () => {
  const dshSource = (chunks: DshChunk[], seen?: Array<Record<string, unknown>>): TextHelperSource => ({
    baseUrl: '',
    apiKey: '',
    model: 'deepseek-flash',
    reasoning: 'none',
    dsh: {
      provider: 'opencode-go-new',
      stream: async function* (options) {
        seen?.push(options as unknown as Record<string, unknown>)
        for (const chunk of chunks) yield chunk
      },
    },
  })

  const ask = (chunks: DshChunk[], seen?: Array<Record<string, unknown>>) =>
    askText(dshSource(chunks, seen), 'system', 'user')

  it('reads the answer out of the streamed text', async () => {
    const answer = await ask([{ type: 'text-delta', text: '{"url":"https://www.baidu.com"}' }])
    expect(answer.content).toBe('{"url":"https://www.baidu.com"}')
  })

  it('never invents a reasoning setting for the route, because a wrong one fails the whole call', async () => {
    const seen: Array<Record<string, unknown>> = []
    await ask([{ type: 'text-delta', text: '{}' }], seen)
    expect(seen[0]).toMatchObject({ provider: 'opencode-go-new', model: 'deepseek-flash' })
    expect(seen[0]).not.toHaveProperty('reasoningEffort')
  })

  it('sends the question itself unchanged, however reasoning is set', async () => {
    const seen: Array<Record<string, unknown>> = []
    const source = { ...dshSource([{ type: 'text-delta', text: '{}' }], seen), reasoning: 'auto' as const }
    await askText(source, 'system', 'user')
    expect(seen[0]).toMatchObject({ system: 'system', user: 'user' })
    expect(seen[0]).not.toHaveProperty('reasoningEffort')
  })

  it.each([
    ['the route itself failed', [{ type: 'finish', reason: { kind: 'error', failure: { message: 'model not found' } } }], /失败（error/],
    ['the output budget ran out', [{ type: 'finish', reason: { kind: 'max-tokens' } }], /额度/],
    ['only thinking came back', [{ type: 'reasoning-delta', text: '想想' }, { type: 'finish', reason: { kind: 'stop' } }], /思考/],
    ['nothing came back at all', [{ type: 'finish', reason: { kind: 'stop' } }], /没有返回可用的字段值/],
  ])('says what happened when %s', async (_name, chunks, pattern) => {
    await expect(ask(chunks as DshChunk[])).rejects.toThrow(pattern)
  })

  it('records what the stream said, so a failure can be read back later', async () => {
    const written: Array<Record<string, unknown>> = []
    const source = {
      ...dshSource([{ type: 'reasoning-delta', text: '想想' }, { type: 'finish', reason: { kind: 'max-tokens' } }]),
      trace: { write: (record: Record<string, unknown>) => written.push(record) },
    }
    await expect(askText(source, 'system', 'user')).rejects.toThrow()
    expect(written[0]).toMatchObject({ kind: 'text', door: 'dsh', ok: false, finish: 'max-tokens', reasoning_chars: 2 })
  })
})

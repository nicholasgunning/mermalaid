/**
 * The IBM Consulting Advantage provider: the OpenAI-compatible wire format, the streaming reader,
 * and the errors the user is shown.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyIcaStreamChunk,
  buildIcaMessages,
  describeIcaError,
  icaAssistantProvider,
  IcaRequestError,
  listIcaModels,
  readIcaErrorMessage,
  readSseData,
} from './icaAssistant'
import { DEFAULT_ICA_MODEL, storeIcaModel } from './icaKey'
import { DIAGRAM_ASSISTANT_SYSTEM_PROMPT, type AssistantTurn } from './diagramAssistant'

const CONTEXT_BLOCK = 'Document: flow.mmd\n\n<diagram>\ngraph TD\n  A-->B\n</diagram>'

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
}

describe('buildIcaMessages', () => {
  it('leads with the system prompt and puts the diagram on the last user turn', () => {
    const messages = buildIcaMessages([{ role: 'user', text: 'add a step' }], CONTEXT_BLOCK)

    expect(messages[0]).toEqual({ role: 'system', content: DIAGRAM_ASSISTANT_SYSTEM_PROMPT })
    expect(messages[1].role).toBe('user')
    expect(messages[1].content).toBe(`add a step\n\n${CONTEXT_BLOCK}`)
  })

  it('answers a tool call with a tool message before the next question', () => {
    const turns: AssistantTurn[] = [
      { role: 'user', text: 'add a retry' },
      {
        role: 'assistant',
        text: '',
        edit: { callId: 'call_1', mermaid: 'graph TD', summary: 'Add a retry' },
        raw: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }] },
      },
      { role: 'user', text: 'now label it', decision: { callId: 'call_1', decision: 'applied' } },
    ]

    const messages = buildIcaMessages(turns, CONTEXT_BLOCK)

    // system, user, assistant (replayed verbatim), tool, user
    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'user',
    ])
    expect(messages[2]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }] })
    expect(messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' })
    expect(String(messages[3].content)).toMatch(/approved/i)
    expect(messages[4].content).toContain('now label it')
  })

  it('only carries the diagram on the latest turn, so no stale copy is replayed', () => {
    const turns: AssistantTurn[] = [
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'ok' },
      { role: 'user', text: 'second' },
    ]
    const messages = buildIcaMessages(turns, CONTEXT_BLOCK)
    expect(messages[1].content).toBe('first')
    expect(messages[3].content).toContain(CONTEXT_BLOCK)
  })
})

describe('applyIcaStreamChunk', () => {
  function chunk(delta: unknown) {
    return { choices: [{ delta }] }
  }

  it('accumulates prose and reports each piece as it arrives', () => {
    const accumulator = { text: '', calls: new Map() }
    const onTextDelta = vi.fn()

    applyIcaStreamChunk(accumulator, chunk({ content: 'Hello ' }), { onTextDelta })
    applyIcaStreamChunk(accumulator, chunk({ content: 'there.' }), { onTextDelta })

    expect(accumulator.text).toBe('Hello there.')
    expect(onTextDelta.mock.calls).toEqual([['Hello '], ['there.']])
  })

  it('reports reasoning under either name gateways give it, without mixing it into the answer', () => {
    const accumulator = { text: '', calls: new Map() }
    const onThinkingDelta = vi.fn()
    const onTextDelta = vi.fn()
    const callbacks = { onThinkingDelta, onTextDelta }

    applyIcaStreamChunk(accumulator, chunk({ reasoning_content: 'Looking at ' }), callbacks)
    applyIcaStreamChunk(accumulator, chunk({ reasoning: 'the edges.' }), callbacks)
    applyIcaStreamChunk(accumulator, chunk({ content: 'It is a flowchart.' }), callbacks)

    expect(onThinkingDelta.mock.calls).toEqual([['Looking at '], ['the edges.']])
    // Reasoning is never part of the reply that is replayed to the model.
    expect(accumulator.text).toBe('It is a flowchart.')
    expect(onTextDelta.mock.calls).toEqual([['It is a flowchart.']])
  })

  it('names the phase each kind of chunk puts the turn into', () => {
    const accumulator = { text: '', calls: new Map() }
    const onPhase = vi.fn()

    applyIcaStreamChunk(accumulator, chunk({ reasoning_content: 'hmm' }), { onPhase })
    applyIcaStreamChunk(accumulator, chunk({ content: 'ok' }), { onPhase })
    applyIcaStreamChunk(
      accumulator,
      chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'update_diagram' } }] }),
      { onPhase },
    )

    expect(onPhase.mock.calls.flat()).toEqual(['thinking', 'replying', 'drafting'])
  })

  it('joins tool arguments that arrive a few characters at a time', () => {
    const accumulator = { text: '', calls: new Map() }

    // The id comes with the first chunk only; later chunks are keyed by index.
    applyIcaStreamChunk(
      accumulator,
      chunk({ tool_calls: [{ index: 0, id: 'call_7', function: { name: 'update_diagram', arguments: '{"merm' } }] }),
    )
    applyIcaStreamChunk(accumulator, chunk({ tool_calls: [{ index: 0, function: { arguments: 'aid":"graph TD"}' } }] }))

    expect(accumulator.calls.get(0)).toEqual({
      id: 'call_7',
      name: 'update_diagram',
      args: '{"mermaid":"graph TD"}',
    })
  })

  it('ignores a chunk with nothing in it', () => {
    const accumulator = { text: '', calls: new Map() }
    applyIcaStreamChunk(accumulator, {})
    applyIcaStreamChunk(accumulator, chunk(undefined))
    expect(accumulator.text).toBe('')
    expect(accumulator.calls.size).toBe(0)
  })
})

describe('readSseData', () => {
  it('reads data frames and stops at the done sentinel', async () => {
    const frames = ['data: {"a":1}\n', 'data: {"a":2}\n', 'data: [DONE]\n']
    const seen: unknown[] = []
    for await (const chunk of readSseData(sseStream(frames))) seen.push(chunk)
    expect(seen).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('reassembles a frame split across network chunks', async () => {
    const seen: unknown[] = []
    for await (const chunk of readSseData(sseStream(['data: {"a":', '"split"}\n']))) seen.push(chunk)
    expect(seen).toEqual([{ a: 'split' }])
  })

  it('skips comments, blank lines and unparseable frames rather than failing the turn', async () => {
    const frames = [': keep-alive\n', '\n', 'data: not json\n', 'data: {"ok":true}\n']
    const seen: unknown[] = []
    for await (const chunk of readSseData(sseStream(frames))) seen.push(chunk)
    expect(seen).toEqual([{ ok: true }])
  })
})

describe('listIcaModels', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('goes through the proxy with the key as a bearer token, and maps the listing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b' }, { name: 'no id' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const models = await listIcaModels('sk-ica-123', 'chat-models')

    expect(models).toEqual([
      { id: 'model-a', name: 'Model A' },
      // An entry with no name falls back to its id rather than being dropped.
      { id: 'model-b', name: 'model-b' },
    ])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/ica?path=chat-models')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-ica-123')
  })

  it('says the proxy is not running when the dev server answers with the app shell', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<!doctype html><html></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      ),
    )

    await expect(listIcaModels('sk-ica-123', 'chat-models')).rejects.toThrow(/vercel dev|not running/i)
  })

  it('says the proxy is not running when the dev server serves the handler as a module', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('export default async function handler() {}', {
          status: 200,
          headers: { 'Content-Type': 'text/javascript' },
        }),
      ),
    )

    await expect(listIcaModels('sk-ica-123', 'chat-models')).rejects.toThrow(/not running/i)
  })

  it('does not blame the model when an empty 404 means there is no /api/ica route at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))

    await expect(listIcaModels('sk-ica-123', 'chat-models')).rejects.toMatchObject({ status: 503 })
  })

  it('still reports a described 404 from IBM itself', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'model not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    await expect(listIcaModels('sk-ica-123', 'chat-models')).rejects.toMatchObject({
      status: 404,
      message: 'model not found',
    })
  })

  it('turns a failure into an error carrying the status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 }),
      ),
    )

    await expect(listIcaModels('sk-bad', 'chat-models')).rejects.toMatchObject({
      status: 401,
      message: 'invalid key',
    })
  })
})

describe('the chat request', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  function stubChat(frames: string[]) {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()
            for (const frame of frames) controller.enqueue(encoder.encode(frame))
            controller.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  const request = {
    apiKey: 'sk-ica-123',
    turns: [{ role: 'user' as const, text: 'add a step' }],
    context: { code: 'graph TD', documentName: 'flow.mmd', error: null },
  }

  it('uses the default model when nothing has been chosen, so a key alone is enough', async () => {
    const fetchMock = stubChat(['data: {"choices":[{"delta":{"content":"hi"}}]}\n', 'data: [DONE]\n'])

    const reply = await icaAssistantProvider.send(request)

    expect(reply.text).toBe('hi')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/ica?path=chat-models%2Fchat%2Fcompletions')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe(DEFAULT_ICA_MODEL.model)
    expect(body.model).toBe('claude-opus-5')
    expect(body.stream).toBe(true)
    expect(body.tools[0].function.name).toBe('update_diagram')
  })

  it('uses the chosen model and namespace once one is stored', async () => {
    storeIcaModel({ namespace: 'agents', model: 'agent-id-1' })
    const fetchMock = stubChat(['data: [DONE]\n'])

    await icaAssistantProvider.send(request)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/ica?path=agents%2Fchat%2Fcompletions')
    expect(JSON.parse(init.body as string).model).toBe('agent-id-1')
  })

  it('reads a proposed change out of the streamed tool call', async () => {
    stubChat([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"update_diagram","arguments":"{\\"mermaid\\":\\"graph TD\\\\n  A-->C\\","}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"summary\\":\\"Point A at C\\"}"}}]}}]}\n',
      'data: [DONE]\n',
    ])

    const reply = await icaAssistantProvider.send(request)

    expect(reply.edit).toEqual({
      callId: 'call_9',
      mermaid: 'graph TD\n  A-->C',
      summary: 'Point A at C',
    })
  })
})

describe('readIcaErrorMessage', () => {
  it('digs the message out of whichever shape came back', () => {
    expect(readIcaErrorMessage(400, '{"error":{"message":"nested"}}')).toBe('nested')
    expect(readIcaErrorMessage(400, '{"error":"flat"}')).toBe('flat')
    expect(readIcaErrorMessage(400, '{"detail":"detail text"}')).toBe('detail text')
    expect(readIcaErrorMessage(502, 'Bad Gateway')).toBe('Bad Gateway')
    expect(readIcaErrorMessage(500, '')).toBe('HTTP 500')
  })
})

describe('describeIcaError', () => {
  it('says what the user can do about each failure', () => {
    expect(describeIcaError(new IcaRequestError(401, 'nope'))).toMatch(/rejected that API key/i)
    // IBM answers an unusable key with a 400 and this exact wording.
    expect(describeIcaError(new IcaRequestError(400, 'Invalid icaKey'))).toMatch(
      /rejected that API key/i,
    )
    expect(describeIcaError(new IcaRequestError(400, 'bad messages'))).toContain('bad messages')
    expect(describeIcaError(new IcaRequestError(503, 'The /api/ica route is not running here.'))).toBe(
      'The /api/ica route is not running here.',
    )
    expect(describeIcaError(new IcaRequestError(403, 'nope'))).toMatch(/not allowed/i)
    expect(describeIcaError(new IcaRequestError(404, 'no model'))).toMatch(/Settings/i)
    expect(describeIcaError(new IcaRequestError(429, 'slow down'))).toMatch(/Rate limited/i)
    expect(describeIcaError(new IcaRequestError(500, 'boom'))).toContain('500')
  })

  it('points at the proxy when the request never left the page', () => {
    expect(describeIcaError(new TypeError('Failed to fetch'))).toMatch(/\/api\/ica/)
  })
})

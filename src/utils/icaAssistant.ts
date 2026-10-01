/**
 * The diagram assistant on IBM Consulting Advantage.
 *
 * ICA's chat endpoints are OpenAI-compatible, so this speaks `POST /{namespace}/chat/completions`
 * with `messages` / `tools` / `stream`. It goes through {@link ../../api/ica.ts} rather than
 * straight to IBM: the ICA API returns no `Access-Control-Allow-Origin`, so a browser blocks a
 * direct call. The user's key still never leaves their own deployment's request path.
 */
import {
  buildDiagramContextBlock,
  describeEditDecision,
  DIAGRAM_ASSISTANT_SYSTEM_PROMPT,
  parseEditArguments,
  UPDATE_DIAGRAM_TOOL_DESCRIPTION,
  UPDATE_DIAGRAM_TOOL_NAME,
  UPDATE_DIAGRAM_TOOL_SCHEMA,
  type AssistantProvider,
  type AssistantReply,
  type AssistantRequest,
  type AssistantTurn,
} from './diagramAssistant'
import { resolveIcaModel } from './icaKey'
import { DEFAULT_ICA_NAMESPACE, type IcaNamespace } from './icaModel'

export {
  DEFAULT_ICA_MODEL,
  DEFAULT_ICA_NAMESPACE,
  ICA_NAMESPACES,
  type IcaModelChoice,
  type IcaNamespace,
} from './icaModel'

const PROXY_PATH = '/api/ica'

function proxyUrl(path: string): string {
  return `${PROXY_PATH}?path=${encodeURIComponent(path)}`
}

export class IcaRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'IcaRequestError'
    this.status = status
  }
}

/** The error text an ICA (or proxy) failure carries, dug out of whichever shape came back. */
export function readIcaErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: string | { message?: string }
      message?: string
      detail?: string
    }
    const fromError =
      typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? undefined
    const message = fromError ?? parsed.message ?? parsed.detail
    if (message) return message
  } catch {
    /* not JSON — fall through to the raw body */
  }
  return body.trim().slice(0, 200) || `HTTP ${status}`
}

/** The /api/ica route is missing, not reachable, or being served as something other than JSON. */
function missingProxyError(): IcaRequestError {
  return new IcaRequestError(
    503,
    'The /api/ica route is not running here. IBM ICA needs the Mermalaid API routes — run `npm run dev` with the API plugin, `vercel dev`, or use a deployment.',
  )
}

/**
 * Whether an answer came from something other than the proxy.
 *
 * Every reply the proxy makes itself is JSON, and IBM's own errors carry a content type and a body.
 * A dev server with no /api route instead answers a GET with the handler's transpiled source or the
 * SPA shell, and a POST with an empty 404 — which must not be reported as a bad model, because IBM
 * never saw the request.
 */
function isMissingProxyResponse(response: Response, body: string | null): boolean {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/html') || contentType.includes('javascript')) return true
  // A 404 with nothing in it is a route that does not exist; IBM's own 404s describe themselves.
  return response.status === 404 && body?.trim() === ''
}

async function icaFetch(
  path: string,
  apiKey: string,
  init: { method: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal },
): Promise<Response> {
  const response = await fetch(proxyUrl(path), {
    method: init.method,
    headers: {
      // An OpenAI-style bearer token, as the ICA developer docs specify.
      Authorization: `Bearer ${apiKey}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  })
  if (!response.ok) {
    const body = await response.text()
    if (isMissingProxyResponse(response, body)) throw missingProxyError()
    throw new IcaRequestError(response.status, readIcaErrorMessage(response.status, body))
  }
  if (isMissingProxyResponse(response, null)) throw missingProxyError()
  return response
}

export interface IcaModelSummary {
  id: string
  name: string
}

/** Everything the key can chat with in a namespace, for the picker in Settings. */
export async function listIcaModels(
  apiKey: string,
  namespace: IcaNamespace = DEFAULT_ICA_NAMESPACE,
  signal?: AbortSignal,
): Promise<IcaModelSummary[]> {
  const response = await icaFetch(namespace, apiKey, { method: 'GET', signal })
  const payload = (await response.json()) as { data?: unknown }
  if (!Array.isArray(payload.data)) return []
  return payload.data
    .map((entry) => entry as { id?: unknown; name?: unknown })
    .filter((entry): entry is { id: string; name?: string } => typeof entry.id === 'string')
    .map((entry) => ({ id: entry.id, name: typeof entry.name === 'string' ? entry.name : entry.id }))
}

interface OpenAiToolCall {
  id?: string
  index?: number
  function?: { name?: string; arguments?: string }
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
}

/** The conversation in OpenAI's shape, with the current diagram on the last user turn. */
export function buildIcaMessages(turns: AssistantTurn[], contextBlock: string): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [
    { role: 'system', content: DIAGRAM_ASSISTANT_SYSTEM_PROMPT },
  ]

  turns.forEach((turn, index) => {
    if (turn.role === 'assistant') {
      messages.push(
        (turn.raw as OpenAiMessage | undefined) ?? { role: 'assistant', content: turn.text },
      )
      return
    }

    // A tool result is its own message in this dialect, and must come before the next user turn.
    if (turn.decision) {
      messages.push({
        role: 'tool',
        tool_call_id: turn.decision.callId,
        content: describeEditDecision(turn.decision.decision),
      })
    }
    const isLast = index === turns.length - 1
    const text = [turn.text, isLast ? contextBlock : null].filter(Boolean).join('\n\n')
    if (text) messages.push({ role: 'user', content: text })
  })

  return messages
}

const updateDiagramTool = {
  type: 'function',
  function: {
    name: UPDATE_DIAGRAM_TOOL_NAME,
    description: UPDATE_DIAGRAM_TOOL_DESCRIPTION,
    parameters: UPDATE_DIAGRAM_TOOL_SCHEMA,
  },
} as const

interface StreamAccumulator {
  text: string
  calls: Map<number, { id: string; name: string; args: string }>
}

/**
 * Folds one streamed chunk into the answer so far.
 *
 * Tool arguments arrive a few characters at a time and are keyed by `index`, not by id — the id
 * only comes with the first chunk of each call — so they are accumulated per index and read once
 * the stream ends.
 */
export function applyIcaStreamChunk(
  accumulator: StreamAccumulator,
  chunk: unknown,
  onTextDelta?: (delta: string) => void,
): void {
  const delta = (chunk as { choices?: { delta?: { content?: unknown; tool_calls?: OpenAiToolCall[] } }[] })
    ?.choices?.[0]?.delta
  if (!delta) return

  if (typeof delta.content === 'string' && delta.content) {
    accumulator.text += delta.content
    onTextDelta?.(delta.content)
  }

  for (const call of delta.tool_calls ?? []) {
    const index = call.index ?? 0
    const existing = accumulator.calls.get(index) ?? { id: '', name: '', args: '' }
    accumulator.calls.set(index, {
      id: call.id ?? existing.id,
      name: call.function?.name ?? existing.name,
      args: existing.args + (call.function?.arguments ?? ''),
    })
  }
}

/** Reads `data:` lines out of a server-sent-events body, ignoring the `[DONE]` sentinel. */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          yield JSON.parse(payload)
        } catch {
          /* a partial or non-JSON frame is not worth failing the turn over */
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function replyFromAccumulator(accumulator: StreamAccumulator): AssistantReply {
  const toolCalls: OpenAiToolCall[] = []
  let edit: AssistantReply['edit']

  for (const [index, call] of [...accumulator.calls.entries()].sort((a, b) => a[0] - b[0])) {
    const id = call.id || `call_${index}`
    toolCalls.push({ id, function: { name: call.name, arguments: call.args } })
    if (edit || call.name !== UPDATE_DIAGRAM_TOOL_NAME) continue
    const args = parseEditArguments(call.args)
    if (args) edit = { callId: id, ...args }
  }

  const raw: OpenAiMessage = {
    role: 'assistant',
    content: accumulator.text || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
  return { text: accumulator.text.trim(), edit, raw }
}

async function send({
  apiKey,
  turns,
  context,
  onTextDelta,
  signal,
}: AssistantRequest): Promise<AssistantReply> {
  // Falls back to the default model, so a key alone is enough to start chatting.
  const choice = resolveIcaModel()

  const response = await icaFetch(`${choice.namespace}/chat/completions`, apiKey, {
    method: 'POST',
    signal,
    body: {
      model: choice.model,
      stream: true,
      messages: buildIcaMessages(turns, buildDiagramContextBlock(context)),
      tools: [updateDiagramTool],
      tool_choice: 'auto',
    },
  })

  const accumulator: StreamAccumulator = { text: '', calls: new Map() }

  if (!response.body) {
    // A deployment or gateway that buffers the response still answers, just not progressively.
    const payload = (await response.json()) as {
      choices?: { message?: { content?: string; tool_calls?: OpenAiToolCall[] } }[]
    }
    const message = payload.choices?.[0]?.message
    accumulator.text = message?.content ?? ''
    ;(message?.tool_calls ?? []).forEach((call, index) => {
      accumulator.calls.set(index, {
        id: call.id ?? `call_${index}`,
        name: call.function?.name ?? '',
        args: call.function?.arguments ?? '',
      })
    })
    if (accumulator.text) onTextDelta?.(accumulator.text)
    return replyFromAccumulator(accumulator)
  }

  for await (const chunk of readSseData(response.body)) {
    applyIcaStreamChunk(accumulator, chunk, onTextDelta)
  }
  return replyFromAccumulator(accumulator)
}

export function describeIcaError(err: unknown): string {
  if (err instanceof IcaRequestError) {
    switch (err.status) {
      case 400:
        // IBM answers an unusable key with a 400, not the 401 the status code would suggest.
        return /\bica\s*key\b/i.test(err.message)
          ? 'IBM ICA rejected that API key. Check it in Settings.'
          : `IBM ICA rejected the request: ${err.message}`
      case 401:
        return 'IBM ICA rejected that API key. Check it in Settings.'
      case 403:
        return 'That ICA key is not allowed to use this model. Pick another one in Settings.'
      case 404:
        return `IBM ICA has no such endpoint or model (${err.message}). Check the model chosen in Settings.`
      case 503:
        return err.message
      case 429:
        return 'Rate limited by IBM ICA. Wait a moment and try again.'
      default:
        return `IBM ICA error ${err.status}: ${err.message}`
    }
  }
  if (err instanceof TypeError) {
    // The proxy lives on the same origin, so this is the deployment not serving /api/ica.
    return 'Could not reach the ICA proxy at /api/ica. It is only available where the Mermalaid API routes are deployed.'
  }
  if (err instanceof Error) return err.message
  return 'Something went wrong talking to IBM ICA.'
}

export const icaAssistantProvider: AssistantProvider = {
  id: 'ica',
  label: 'IBM Consulting Advantage',
  send,
  describeError: describeIcaError,
}

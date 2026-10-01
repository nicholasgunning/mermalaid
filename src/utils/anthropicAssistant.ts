/**
 * The diagram assistant on Claude, through the Anthropic Messages API.
 *
 * The key is the user's own and the request goes straight from the page to api.anthropic.com, which
 * is what `dangerouslyAllowBrowser` is for here — there is no server to proxy through, and it makes
 * the SDK send the direct-browser-access header the API requires.
 */
import Anthropic from '@anthropic-ai/sdk'
import {
  buildDiagramContextBlock,
  describeEditDecision,
  DIAGRAM_ASSISTANT_SYSTEM_PROMPT,
  readEditArguments,
  UPDATE_DIAGRAM_TOOL_DESCRIPTION,
  UPDATE_DIAGRAM_TOOL_NAME,
  UPDATE_DIAGRAM_TOOL_SCHEMA,
  type AssistantPhase,
  type AssistantProvider,
  type AssistantReply,
  type AssistantRequest,
  type AssistantTurn,
} from './diagramAssistant'

export const ANTHROPIC_ASSISTANT_MODEL = 'claude-opus-5'

/**
 * Opus 5 thinks by default but keeps it to itself: `display` defaults to `omitted`, which streams
 * thinking blocks with empty text and reads as a long pause before the answer. The panel shows the
 * reasoning as it arrives, so it asks for the summary the API is willing to give.
 */
const THINKING: Anthropic.Beta.BetaThinkingConfigParam = { type: 'adaptive', display: 'summarized' }

/** Streaming, so a long answer cannot hit a request timeout; this is a ceiling, not a reservation. */
const MAX_OUTPUT_TOKENS = 64_000

/** Routes a policy refusal to a fallback model inside the same call rather than failing the turn. */
const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01'

export const updateDiagramTool: Anthropic.Beta.BetaTool = {
  name: UPDATE_DIAGRAM_TOOL_NAME,
  description: UPDATE_DIAGRAM_TOOL_DESCRIPTION,
  input_schema: UPDATE_DIAGRAM_TOOL_SCHEMA as unknown as Anthropic.Beta.BetaTool['input_schema'],
  // Guarantees the arguments validate, so the proposal can be trusted to have both fields.
  strict: true,
}

/**
 * The conversation in Anthropic's shape, with the current diagram on the last user turn.
 *
 * The context goes in the user turn rather than a system message on purpose: the diagram is the
 * user's own text, and a system message would hand whatever it contains the authority of an
 * instruction. Only the latest turn carries it, so the history never accumulates stale snapshots.
 */
export function buildAnthropicMessages(
  turns: AssistantTurn[],
  contextBlock: string,
): Anthropic.Beta.BetaMessageParam[] {
  const messages: Anthropic.Beta.BetaMessageParam[] = []

  turns.forEach((turn, index) => {
    if (turn.role === 'assistant') {
      // Replayed verbatim: the response's own blocks carry reasoning and the tool call's id.
      messages.push({
        role: 'assistant',
        content: (turn.raw as Anthropic.Beta.BetaContentBlockParam[] | undefined) ?? [
          { type: 'text', text: turn.text },
        ],
      })
      return
    }

    const content: Anthropic.Beta.BetaContentBlockParam[] = []
    if (turn.decision) {
      // Every tool call must be answered before the conversation can go on.
      content.push({
        type: 'tool_result',
        tool_use_id: turn.decision.callId,
        content: describeEditDecision(turn.decision.decision),
        is_error: turn.decision.decision === 'rejected',
      })
    }
    if (turn.text) content.push({ type: 'text', text: turn.text })
    if (index === turns.length - 1) content.push({ type: 'text', text: contextBlock })
    messages.push({ role: 'user', content })
  })

  return messages
}

/**
 * The client is created per key and reused, so one conversation does not open a connection pool per
 * turn.
 */
let cachedClient: { apiKey: string; client: Anthropic } | null = null

function clientFor(apiKey: string): Anthropic {
  if (cachedClient?.apiKey === apiKey) return cachedClient.client
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
  cachedClient = { apiKey, client }
  return client
}

/** Test seam: forget the memoized client. */
export function resetAnthropicClientCache(): void {
  cachedClient = null
}

/** A safety decline, which arrives as a normal response rather than an error. */
export function describeRefusal(message: Anthropic.Beta.BetaMessage): string | null {
  if (message.stop_reason !== 'refusal') return null
  const explanation = message.stop_details?.explanation
  return explanation
    ? `Claude declined to answer that: ${explanation}`
    : 'Claude declined to answer that.'
}

export function readAnthropicReply(message: Anthropic.Beta.BetaMessage): AssistantReply {
  const text = message.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()

  let edit: AssistantReply['edit']
  for (const block of message.content) {
    if (block.type !== 'tool_use' || block.name !== UPDATE_DIAGRAM_TOOL_NAME) continue
    const args = readEditArguments(block.input)
    if (!args) continue
    edit = { callId: block.id, ...args }
    break
  }

  return {
    text: describeRefusal(message) ?? text,
    edit,
    raw: message.content,
  }
}

/** The phase a newly started content block puts the turn into, or null for a block the panel ignores. */
export function phaseForContentBlock(type: string): AssistantPhase | null {
  switch (type) {
    case 'thinking':
    case 'redacted_thinking':
      return 'thinking'
    case 'text':
      return 'replying'
    case 'tool_use':
      return 'drafting'
    default:
      return null
  }
}

/**
 * One assistant turn, streamed.
 *
 * `eager_input_streaming` is deliberately off: nothing here renders a half-written diagram, and
 * leaving it off keeps the API's own validation of the tool input. The panel still says when a
 * diagram is being written, from the block starting rather than from its contents.
 */
async function send({
  apiKey,
  turns,
  context,
  onTextDelta,
  onThinkingDelta,
  onPhase,
  signal,
}: AssistantRequest): Promise<AssistantReply> {
  const stream = clientFor(apiKey).beta.messages.stream(
    {
      model: ANTHROPIC_ASSISTANT_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      thinking: THINKING,
      betas: [SERVER_SIDE_FALLBACK_BETA],
      fallbacks: 'default',
      system: [
        {
          type: 'text',
          text: DIAGRAM_ASSISTANT_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [updateDiagramTool],
      messages: buildAnthropicMessages(turns, buildDiagramContextBlock(context)),
    },
    { signal },
  )

  for await (const event of stream) {
    if (event.type === 'content_block_start') {
      const phase = phaseForContentBlock(event.content_block.type)
      if (phase) onPhase?.(phase)
      continue
    }
    if (event.type !== 'content_block_delta') continue
    if (event.delta.type === 'text_delta') onTextDelta?.(event.delta.text)
    else if (event.delta.type === 'thinking_delta') onThinkingDelta?.(event.delta.thinking)
  }
  return readAnthropicReply(await stream.finalMessage())
}

/** What to show the user when a turn fails, from the SDK's typed errors rather than their text. */
export function describeAnthropicError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Anthropic rejected that API key. Check it in Settings.'
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return 'That API key is not allowed to use this model. Check the key’s workspace in the Anthropic Console.'
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Rate limited by Anthropic. Wait a moment and try again.'
  }
  if (err instanceof Anthropic.BadRequestError) {
    return `Anthropic rejected the request: ${err.message}`
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Could not reach Anthropic. Check your connection and try again.'
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error ${err.status ?? ''}: ${err.message}`.trim()
  }
  if (err instanceof Error) return err.message
  return 'Something went wrong talking to Anthropic.'
}

export const anthropicAssistantProvider: AssistantProvider = {
  id: 'anthropic',
  label: 'Claude (Anthropic)',
  send,
  describeError: describeAnthropicError,
}

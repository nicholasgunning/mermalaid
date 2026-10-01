/**
 * The Anthropic provider: the Messages-API wire format and the errors the user is shown.
 */
import { describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import {
  buildAnthropicMessages,
  describeAnthropicError,
  describeRefusal,
  phaseForContentBlock,
  readAnthropicReply,
  updateDiagramTool,
} from './anthropicAssistant'
import type { AssistantTurn } from './diagramAssistant'

const CONTEXT_BLOCK = 'Document: flow.mmd\n\n<diagram>\ngraph TD\n  A-->B\n</diagram>'

function message(
  content: Anthropic.Beta.BetaContentBlock[],
  overrides: Partial<Anthropic.Beta.BetaMessage> = {},
): Anthropic.Beta.BetaMessage {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...overrides,
  } as Anthropic.Beta.BetaMessage
}

const text = (value: string) =>
  ({ type: 'text', text: value, citations: null }) as Anthropic.Beta.BetaContentBlock

const toolUse = (input: unknown, name = 'update_diagram') =>
  ({ type: 'tool_use', id: 'toolu_1', name, input }) as Anthropic.Beta.BetaContentBlock

describe('the tool the assistant changes diagrams with', () => {
  it('validates its arguments, so a proposal always has both fields', () => {
    expect(updateDiagramTool.name).toBe('update_diagram')
    expect(updateDiagramTool.strict).toBe(true)
  })
})

describe('buildAnthropicMessages', () => {
  it('attaches the diagram to the last user turn as user content, not as an instruction', () => {
    const messages = buildAnthropicMessages([{ role: 'user', text: 'add a step' }], CONTEXT_BLOCK)

    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'add a step' },
      { type: 'text', text: CONTEXT_BLOCK },
    ])
  })

  it('replays an assistant turn in its own blocks, so the tool call and its id survive', () => {
    const raw = [toolUse({ mermaid: 'graph TD', summary: 's' })]
    const turns: AssistantTurn[] = [
      { role: 'user', text: 'add a retry' },
      { role: 'assistant', text: '', raw },
      { role: 'user', text: 'now label it', decision: { callId: 'toolu_1', decision: 'applied' } },
    ]

    const messages = buildAnthropicMessages(turns, CONTEXT_BLOCK)

    expect(messages[1]).toEqual({ role: 'assistant', content: raw })
    const lastContent = messages[2].content as Anthropic.Beta.BetaContentBlockParam[]
    // The tool result comes first: the call has to be answered before anything else is said.
    expect(lastContent[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      is_error: false,
    })
    expect(lastContent[1]).toEqual({ type: 'text', text: 'now label it' })
    expect(lastContent[2]).toEqual({ type: 'text', text: CONTEXT_BLOCK })
  })

  it('marks a rejection as an error so the model does not repeat it', () => {
    const turns: AssistantTurn[] = [
      { role: 'user', text: 'x', decision: { callId: 'toolu_9', decision: 'rejected' } },
    ]
    const content = buildAnthropicMessages(turns, CONTEXT_BLOCK)[0]
      .content as Anthropic.Beta.BetaContentBlockParam[]
    expect(content[0]).toMatchObject({ type: 'tool_result', is_error: true })
  })

  it('falls back to plain text for an assistant turn with no stored blocks', () => {
    const messages = buildAnthropicMessages(
      [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }],
      CONTEXT_BLOCK,
    )
    expect(messages[1].content).toEqual([{ type: 'text', text: 'hello' }])
  })
})

describe('phaseForContentBlock', () => {
  it('names what the panel should say a started block means', () => {
    expect(phaseForContentBlock('thinking')).toBe('thinking')
    // A redacted block carries no text, but the turn is still thinking.
    expect(phaseForContentBlock('redacted_thinking')).toBe('thinking')
    expect(phaseForContentBlock('text')).toBe('replying')
    expect(phaseForContentBlock('tool_use')).toBe('drafting')
  })

  it('has nothing to say about a block the panel does not show', () => {
    expect(phaseForContentBlock('signature')).toBeNull()
  })
})

describe('readAnthropicReply', () => {
  it('splits the prose from the proposed change', () => {
    const reply = readAnthropicReply(
      message([text('Here you go. '), toolUse({ mermaid: 'graph TD\n  A-->C\n', summary: 'Point A at C' })]),
    )

    expect(reply.text).toBe('Here you go.')
    expect(reply.edit).toEqual({
      callId: 'toolu_1',
      mermaid: 'graph TD\n  A-->C',
      summary: 'Point A at C',
    })
    // The turn is kept verbatim for replay on the next request.
    expect(reply.raw).toHaveLength(2)
  })

  it('ignores an unusable call, and another tool entirely', () => {
    expect(readAnthropicReply(message([toolUse({ mermaid: '  ' })])).edit).toBeUndefined()
    expect(
      readAnthropicReply(message([toolUse({ mermaid: 'graph TD' }, 'other_tool')])).edit,
    ).toBeUndefined()
  })

  it('shows a decline as the reply, since it arrives as a normal response', () => {
    const declined = message([], {
      stop_reason: 'refusal',
      stop_details: {
        type: 'refusal',
        category: 'cyber',
        explanation: 'policy',
      } as Anthropic.Beta.BetaRefusalStopDetails,
    })
    expect(readAnthropicReply(declined).text).toContain('policy')
    expect(describeRefusal(message([text('hi')]))).toBeNull()
  })
})

describe('describeAnthropicError', () => {
  it('passes an ordinary error through and always has something to say', () => {
    expect(describeAnthropicError(new Error('boom'))).toBe('boom')
    expect(describeAnthropicError('not an error')).toMatch(/went wrong/i)
  })
})

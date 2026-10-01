import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDiagramAssistant } from './useDiagramAssistant'
import { anthropicAssistantProvider } from '../utils/anthropicAssistant'
import type { AssistantReply, AssistantRequest } from '../utils/diagramAssistant'

/** The provider is the seam: the hook is tested without any wire format in the way. */
const turn = vi.fn<(request: AssistantRequest) => Promise<AssistantReply>>()
vi.spyOn(anthropicAssistantProvider, 'send').mockImplementation((request) => turn(request))

const EDIT = { callId: 'call_1', mermaid: 'graph TD\n  A-->R', summary: 'Add a step' }
const CONTEXT = { code: 'graph TD\n  A-->B', documentName: 'flow.mmd', error: null }

function setup(onApplyDiagram = vi.fn()) {
  const rendered = renderHook(() => useDiagramAssistant({ context: CONTEXT, onApplyDiagram }))
  return { ...rendered, onApplyDiagram }
}

describe('useDiagramAssistant', () => {
  beforeEach(() => {
    localStorage.setItem('anthropic-api-key', 'sk-ant-test-key-0123456789')
  })

  afterEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('shows the question, then the streamed answer', async () => {
    turn.mockImplementation(async ({ onTextDelta }) => {
      onTextDelta?.('It ')
      onTextDelta?.('flows A to B.')
      return { text: 'It flows A to B.' }
    })

    const { result } = setup()
    act(() => result.current.send('what does this do?'))

    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.entries.map((entry) => [entry.role, entry.text])).toEqual([
      ['user', 'what does this do?'],
      ['assistant', 'It flows A to B.'],
    ])
    expect(result.current.entries[1].edit).toBeUndefined()
  })

  it('keeps the reasoning out of the reply, and reports each phase while the turn runs', async () => {
    // The turn is held open at each phase so the state the panel renders can be read mid-flight.
    let release = () => {}
    const held = () => new Promise<void>((resolve) => { release = resolve })
    turn.mockImplementation(async ({ onPhase, onThinkingDelta, onTextDelta }) => {
      onPhase?.('thinking')
      onThinkingDelta?.('The graph has ')
      onThinkingDelta?.('two nodes.')
      await held()
      onPhase?.('replying')
      onTextDelta?.('It flows A to B.')
      await held()
      return { text: 'It flows A to B.' }
    })

    const { result } = setup()
    act(() => result.current.send('what does this do?'))

    await waitFor(() => expect(result.current.status).toBe('thinking'))
    expect(result.current.entries[1].thinking).toBe('The graph has two nodes.')
    // Reasoning is not mistaken for the answer.
    expect(result.current.entries[1].text).toBe('')

    await act(async () => release())
    await waitFor(() => expect(result.current.status).toBe('replying'))
    expect(result.current.entries[1].text).toBe('It flows A to B.')

    await act(async () => release())
    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.entries[1].thinking).toBe('The graph has two nodes.')
  })

  it('names the entry being streamed into, and stops naming one when the turn ends', async () => {
    turn.mockResolvedValue({ text: 'done' })

    const { result } = setup()
    act(() => result.current.send('hello'))

    // The panel attaches its progress to this entry, so it has to be named before the reply lands.
    expect(result.current.streamingEntryId).toBe(result.current.entries[1].id)
    // Until a provider names a phase, the turn is simply waiting to be answered.
    expect(result.current.status).toBe('waiting')

    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.streamingEntryId).toBeNull()
  })

  it('keeps what was already streamed when a turn is stopped', async () => {
    turn.mockImplementation(async ({ onThinkingDelta, signal }) => {
      onThinkingDelta?.('Considering the layout…')
      await new Promise((resolve) => signal?.addEventListener('abort', resolve))
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    })

    const { result } = setup()
    act(() => result.current.send('rework this'))
    await waitFor(() => expect(result.current.entries[1]?.thinking).toBeTruthy())

    act(() => result.current.stop())
    await waitFor(() => expect(result.current.status).toBe('idle'))

    // Reasoning alone is enough to keep the entry: it is what the user watched happen.
    expect(result.current.entries).toHaveLength(2)
    expect(result.current.entries[1].thinking).toBe('Considering the layout…')
    expect(result.current.entries[1].text).toBe('(stopped)')
    expect(result.current.error).toBeNull()
  })

  it('sends the diagram as it is at that moment, with the key for the chosen provider', async () => {
    turn.mockResolvedValue({ text: 'ok' })
    const { result } = setup()

    act(() => result.current.send('hello'))
    await waitFor(() => expect(result.current.status).toBe('idle'))

    expect(turn).toHaveBeenCalledWith(
      expect.objectContaining({ context: CONTEXT, apiKey: 'sk-ant-test-key-0123456789' }),
    )
    expect(turn.mock.calls[0][0].turns).toEqual([{ role: 'user', text: 'hello' }])
    expect(result.current.provider?.provider.id).toBe('anthropic')
  })

  it('holds a proposed change until the user approves it', async () => {
    turn.mockResolvedValue({ text: 'Here is a retry step.', edit: EDIT })
    const { result, onApplyDiagram } = setup()

    act(() => result.current.send('add a retry'))
    await waitFor(() => expect(result.current.hasPendingEdit).toBe(true))

    // Nothing reaches the document while the proposal is pending.
    expect(onApplyDiagram).not.toHaveBeenCalled()
    expect(result.current.entries[1].edit).toEqual({
      summary: 'Add a step',
      mermaid: 'graph TD\n  A-->R',
      status: 'pending',
    })

    act(() => result.current.approveEdit())
    expect(onApplyDiagram).toHaveBeenCalledExactlyOnceWith('graph TD\n  A-->R')
    expect(result.current.entries[1].edit?.status).toBe('applied')
    expect(result.current.hasPendingEdit).toBe(false)
  })

  it('leaves the diagram alone when the user discards a proposal', async () => {
    turn.mockResolvedValue({ text: '', edit: EDIT })
    const { result, onApplyDiagram } = setup()

    act(() => result.current.send('add a retry'))
    await waitFor(() => expect(result.current.hasPendingEdit).toBe(true))

    act(() => result.current.rejectEdit())
    expect(onApplyDiagram).not.toHaveBeenCalled()
    expect(result.current.entries[1].edit?.status).toBe('rejected')
  })

  it('tells the assistant what became of its proposal on the next message', async () => {
    turn.mockResolvedValue({ text: '', edit: EDIT, raw: ['provider-specific turn'] })
    const { result } = setup()

    act(() => result.current.send('add a retry'))
    await waitFor(() => expect(result.current.hasPendingEdit).toBe(true))
    act(() => result.current.approveEdit())

    turn.mockResolvedValue({ text: 'Done.' })
    act(() => result.current.send('now label it'))
    await waitFor(() => expect(result.current.status).toBe('idle'))

    expect(turn.mock.calls[1][0].turns).toEqual([
      { role: 'user', text: 'add a retry' },
      // The assistant turn is replayed in the provider's own form.
      { role: 'assistant', text: '', edit: EDIT, raw: ['provider-specific turn'] },
      { role: 'user', text: 'now label it', decision: { callId: 'call_1', decision: 'applied' } },
    ])
  })

  it('treats moving on without answering as a rejection, so the conversation stays valid', async () => {
    turn.mockResolvedValue({ text: '', edit: EDIT })
    const { result, onApplyDiagram } = setup()

    act(() => result.current.send('add a retry'))
    await waitFor(() => expect(result.current.hasPendingEdit).toBe(true))

    turn.mockResolvedValue({ text: 'Alright.' })
    act(() => result.current.send('never mind, explain it instead'))
    await waitFor(() => expect(result.current.status).toBe('idle'))

    expect(onApplyDiagram).not.toHaveBeenCalled()
    expect(result.current.entries[1].edit?.status).toBe('rejected')
    const sent = turn.mock.calls[1][0].turns
    expect(sent[sent.length - 1].decision).toEqual({ callId: 'call_1', decision: 'rejected' })
  })

  it('reports a failed turn and drops it, so the next one starts clean', async () => {
    turn.mockRejectedValue(new Error('network is down'))
    const { result } = setup()

    act(() => result.current.send('add a retry'))
    await waitFor(() => expect(result.current.error).toBe('network is down'))
    expect(result.current.entries.map((entry) => entry.role)).toEqual(['user'])

    turn.mockResolvedValue({ text: 'back' })
    act(() => result.current.send('again'))
    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(turn.mock.calls[1][0].turns).toEqual([{ role: 'user', text: 'again' }])
  })

  it('asks for an API key instead of calling the API without one', () => {
    localStorage.clear()
    const { result } = setup()

    act(() => result.current.send('hello'))

    expect(turn).not.toHaveBeenCalled()
    expect(result.current.error).toMatch(/API key/i)
    expect(result.current.hasApiKey).toBe(false)
    expect(result.current.entries).toEqual([])
  })

  it('falls to the ICA provider when that is the only key configured', () => {
    localStorage.clear()
    localStorage.setItem('ica-api-key', 'sk-ica-key-0123456789')

    const { result } = setup()

    expect(result.current.provider?.provider.id).toBe('ica')
    expect(result.current.hasApiKey).toBe(true)
  })

  it('honours the stored provider preference when both keys are set', () => {
    localStorage.setItem('ica-api-key', 'sk-ica-key-0123456789')
    localStorage.setItem('assistant-provider', 'ica')

    const { result } = setup()

    expect(result.current.provider?.provider.id).toBe('ica')
    expect(result.current.provider?.apiKey).toBe('sk-ica-key-0123456789')
  })

  it('clears the conversation on request', async () => {
    turn.mockResolvedValue({ text: 'hi' })
    const { result } = setup()

    act(() => result.current.send('hello'))
    await waitFor(() => expect(result.current.status).toBe('idle'))

    act(() => result.current.clear())
    expect(result.current.entries).toEqual([])

    act(() => result.current.send('starting over'))
    expect(turn.mock.calls[1][0].turns).toEqual([{ role: 'user', text: 'starting over' }])
  })
})

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AiChatPanel from './AiChatPanel'
import { useDiagramAssistant } from '../hooks/useDiagramAssistant'
import { anthropicAssistantProvider } from '../utils/anthropicAssistant'
import type { AssistantReply, AssistantRequest } from '../utils/diagramAssistant'

const turn = vi.fn<(request: AssistantRequest) => Promise<AssistantReply>>()
vi.spyOn(anthropicAssistantProvider, 'send').mockImplementation((request) => turn(request))

const PROPOSAL = {
  callId: 'call_1',
  mermaid: 'graph TD\n  A-->Retry',
  summary: 'Add a retry step',
}

/** The panel takes the assistant from the hook, so the test wires the two together as App does. */
function Harness({ onApplyDiagram }: { onApplyDiagram: (mermaid: string) => void }) {
  const assistant = useDiagramAssistant({
    context: { code: 'graph TD\n  A-->B', documentName: 'flow.mmd', error: null },
    onApplyDiagram,
  })
  return (
    <AiChatPanel open assistant={assistant} onClose={() => {}} onOpenSettings={() => {}} />
  )
}

describe('AiChatPanel', () => {
  beforeEach(() => {
    localStorage.setItem('anthropic-api-key', 'sk-ant-test-key-0123456789')
  })

  afterEach(() => {
    // This project does not enable Vitest globals, so RTL's auto-cleanup is not installed.
    cleanup()
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('asks for an API key before anything else, and offers the way to add one', () => {
    localStorage.clear()
    render(<Harness onApplyDiagram={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Add API key' })).toBeInTheDocument()
    expect(screen.getByLabelText('Message the AI assistant')).toBeDisabled()
  })

  it('applies a proposed change only once the user says so', async () => {
    const user = userEvent.setup()
    const onApplyDiagram = vi.fn()
    turn.mockResolvedValue({ text: 'Added a retry.', edit: PROPOSAL })

    render(<Harness onApplyDiagram={onApplyDiagram} />)
    await user.type(screen.getByLabelText('Message the AI assistant'), 'add a retry step')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByText('Add a retry step')).toBeInTheDocument())
    expect(screen.getByText('Added a retry.')).toBeInTheDocument()
    expect(onApplyDiagram).not.toHaveBeenCalled()

    // The diagram it wants to write is reviewable before it is applied.
    await user.click(screen.getByRole('button', { name: 'Show the proposed diagram' }))
    expect(screen.getByText(/A-->Retry/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Apply to diagram' }))
    expect(onApplyDiagram).toHaveBeenCalledExactlyOnceWith('graph TD\n  A-->Retry')
    expect(screen.getByText('Applied to the diagram')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply to diagram' })).not.toBeInTheDocument()
  })

  it('discards a proposal without touching the diagram', async () => {
    const user = userEvent.setup()
    const onApplyDiagram = vi.fn()
    turn.mockResolvedValue({ text: '', edit: PROPOSAL })

    render(<Harness onApplyDiagram={onApplyDiagram} />)
    await user.type(screen.getByLabelText('Message the AI assistant'), 'add a retry step')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await user.click(await screen.findByRole('button', { name: 'Discard' }))
    expect(onApplyDiagram).not.toHaveBeenCalled()
    expect(screen.getByText('Discarded')).toBeInTheDocument()
  })

  it('sends on Enter and keeps Shift+Enter for a new line', async () => {
    const user = userEvent.setup()
    turn.mockResolvedValue({ text: 'ok' })

    render(<Harness onApplyDiagram={vi.fn()} />)
    const input = screen.getByLabelText('Message the AI assistant')

    await user.type(input, 'first line{Shift>}{Enter}{/Shift}second line')
    expect(turn).not.toHaveBeenCalled()

    await user.type(input, '{Enter}')
    await waitFor(() => expect(turn).toHaveBeenCalledOnce())
    expect(turn.mock.calls[0][0].turns).toEqual([
      { role: 'user', text: 'first line\nsecond line' },
    ])
    expect(input).toHaveValue('')
  })

  it('shows a failed turn without losing the conversation', async () => {
    const user = userEvent.setup()
    turn.mockRejectedValue(new Error('Rate limited by Anthropic. Wait a moment and try again.'))

    render(<Harness onApplyDiagram={vi.fn()} />)
    await user.type(screen.getByLabelText('Message the AI assistant'), 'hello')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/rate limited/i)
    await user.click(screen.getByRole('button', { name: 'Dismiss the error' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('hello')).toBeInTheDocument()
  })
})

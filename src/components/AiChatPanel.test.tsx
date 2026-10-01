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
function Harness({
  onApplyDiagram,
  width,
}: {
  onApplyDiagram: (mermaid: string) => void
  width?: number
}) {
  const assistant = useDiagramAssistant({
    context: { code: 'graph TD\n  A-->B', documentName: 'flow.mmd', error: null },
    onApplyDiagram,
  })
  return (
    <AiChatPanel
      open
      assistant={assistant}
      onClose={() => {}}
      onOpenSettings={() => {}}
      width={width}
    />
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

  it('docks as a column at the width the divider gives it', () => {
    render(<Harness onApplyDiagram={vi.fn()} width={420} />)

    const panel = screen.getByRole('complementary', { name: 'AI assistant' })
    expect(panel).toHaveClass('ai-chat-panel-docked')
    expect(panel).toHaveStyle({ width: '420px' })
  })

  it('shows the reasoning and the phase while a turn is in flight, then settles', async () => {
    const user = userEvent.setup()
    let release = () => {}
    turn.mockImplementation(async ({ onPhase, onThinkingDelta, onTextDelta }) => {
      onPhase?.('thinking')
      onThinkingDelta?.('Two nodes, one edge.')
      await new Promise<void>((resolve) => { release = resolve })
      onPhase?.('replying')
      onTextDelta?.('It flows A to B.')
      return { text: 'It flows A to B.' }
    })

    render(<Harness onApplyDiagram={vi.fn()} />)
    await user.type(screen.getByLabelText('Message the AI assistant'), 'explain this')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    // Reasoning opens itself while it streams — that is the whole point of showing it.
    expect(await screen.findByRole('status')).toHaveTextContent('Thinking…')
    expect(screen.getByText('Two nodes, one edge.')).toBeVisible()
    expect(screen.getByRole('button', { name: /Thinking/ })).toHaveAttribute('aria-expanded', 'true')
    // A turn in flight can be stopped, not sent again.
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()

    release()

    await waitFor(() => expect(screen.getByText('It flows A to B.')).toBeInTheDocument())
    // Once the reply lands the phase line goes, and the reasoning folds away behind its toggle.
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: /Thought about this/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Two nodes, one edge.')).not.toBeInTheDocument()

    // It stays one click away.
    await user.click(toggle)
    expect(screen.getByText('Two nodes, one edge.')).toBeVisible()
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

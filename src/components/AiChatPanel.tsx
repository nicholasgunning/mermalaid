/**
 * The AI assistant panel: a column docked to the right of the workspace that can propose changes to
 * the diagram.
 *
 * Nothing the assistant writes reaches the canvas on its own — a proposed change is rendered as a
 * card with the new Mermaid behind a toggle, and Apply is the only thing that touches the document.
 *
 * A turn is shown while it happens rather than after: the phase it is in, the reasoning it shows on
 * the way, and the prose as it streams.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { AssistantEntry, DiagramAssistant } from '../hooks/useDiagramAssistant'
import { ASSISTANT_PHASE_LABELS } from '../utils/diagramAssistant'
import './AiChatPanel.css'

interface AiChatPanelProps {
  open: boolean
  assistant: DiagramAssistant
  onClose: () => void
  /** Opens the settings dialog, where the API key lives. */
  onOpenSettings: () => void
  isMobile?: boolean
  /** Width of the docked column in px, set by the divider. Ignored on mobile, which goes full width. */
  width?: number
}

const SUGGESTIONS = [
  'Explain this diagram',
  'Add an error path',
  'Rename the nodes to be clearer',
]

/** The live phase of the turn, so a long wait reads as progress rather than as nothing happening. */
function PhaseIndicator({ status }: { status: DiagramAssistant['status'] }) {
  if (status === 'idle') return null
  return (
    <div className="ai-chat-phase" role="status">
      <span className="ai-chat-phase-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="ai-chat-phase-label">{ASSISTANT_PHASE_LABELS[status]}</span>
    </div>
  )
}

/**
 * The reasoning behind a reply.
 *
 * It opens itself while it is streaming — that is the point of showing it — and closes once the
 * reply lands, so a finished conversation reads as prose with the reasoning still a click away.
 */
function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const [openedByUser, setOpenedByUser] = useState<boolean | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const expanded = openedByUser ?? live

  // Keep the newest reasoning in view while it streams.
  useEffect(() => {
    if (!expanded || !live) return
    const body = bodyRef.current
    if (body) body.scrollTop = body.scrollHeight
  }, [text, expanded, live])

  return (
    <div className={`ai-chat-thinking-block ${live ? 'ai-chat-thinking-live' : ''}`}>
      <button
        type="button"
        className="ai-chat-thinking-toggle"
        aria-expanded={expanded}
        onClick={() => setOpenedByUser(!expanded)}
      >
        <span className="ai-chat-thinking-caret" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        {live ? 'Thinking' : 'Thought about this'}
      </button>
      {expanded && (
        <div className="ai-chat-thinking-text" ref={bodyRef}>
          {text}
        </div>
      )}
    </div>
  )
}

function EditCard({ entry, assistant }: { entry: AssistantEntry; assistant: DiagramAssistant }) {
  const [showSource, setShowSource] = useState(false)
  const edit = entry.edit
  if (!edit) return null

  return (
    <div className={`ai-chat-edit ai-chat-edit-${edit.status}`}>
      <div className="ai-chat-edit-summary">{edit.summary}</div>
      <button
        type="button"
        className="ai-chat-edit-toggle"
        aria-expanded={showSource}
        onClick={() => setShowSource((shown) => !shown)}
      >
        {showSource ? 'Hide the proposed diagram' : 'Show the proposed diagram'}
      </button>
      {showSource && <pre className="ai-chat-edit-source">{edit.mermaid}</pre>}
      {edit.status === 'pending' ? (
        <div className="ai-chat-edit-actions">
          <button type="button" className="ai-chat-btn ai-chat-btn-primary" onClick={assistant.approveEdit}>
            Apply to diagram
          </button>
          <button type="button" className="ai-chat-btn" onClick={assistant.rejectEdit}>
            Discard
          </button>
        </div>
      ) : (
        <div className="ai-chat-edit-status">
          {edit.status === 'applied' ? 'Applied to the diagram' : 'Discarded'}
        </div>
      )}
    </div>
  )
}

export default function AiChatPanel({
  open,
  assistant,
  onClose,
  onOpenSettings,
  isMobile = false,
  width,
}: AiChatPanelProps) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const { entries, status, streamingEntryId, error, hasApiKey, provider } = assistant
  const isBusy = status !== 'idle'

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  // Follow the conversation as it grows, including while a reply streams in.
  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [entries, status])

  if (!open) return null

  const submit = () => {
    const text = draft.trim()
    if (!text || isBusy) return
    assistant.send(text)
    setDraft('')
  }

  const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <aside
      className={`ai-chat-panel ${isMobile ? 'ai-chat-panel-mobile' : 'ai-chat-panel-docked'}`}
      style={isMobile || !width ? undefined : { width: `${width}px` }}
      role="complementary"
      aria-label="AI assistant"
    >
      <header className="ai-chat-header">
        <div className="ai-chat-heading">
          <div className="ai-chat-title">AI assistant</div>
          {provider && <div className="ai-chat-provider">{provider.provider.label}</div>}
        </div>
        <div className="ai-chat-header-actions">
          <button
            type="button"
            className="ai-chat-btn ai-chat-btn-quiet"
            onClick={assistant.clear}
            disabled={entries.length === 0}
          >
            Clear
          </button>
          <button
            type="button"
            className="ai-chat-btn ai-chat-btn-quiet"
            onClick={onClose}
            aria-label="Close the AI assistant"
          >
            Close
          </button>
        </div>
      </header>

      {!hasApiKey && (
        <div className="ai-chat-notice">
          <p>
            Add an Anthropic or IBM Consulting Advantage API key to chat about this diagram. Keys
            stay in this browser.
          </p>
          <button type="button" className="ai-chat-btn ai-chat-btn-primary" onClick={onOpenSettings}>
            Add API key
          </button>
        </div>
      )}

      <div className="ai-chat-log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation">
        {entries.length === 0 && hasApiKey && (
          <div className="ai-chat-empty">
            <p>Ask about the diagram you are looking at, or ask for a change to it.</p>
            <div className="ai-chat-suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="ai-chat-suggestion"
                  onClick={() => assistant.send(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {entries.map((entry) => {
          const isStreaming = entry.id === streamingEntryId
          return (
            <div key={entry.id} className={`ai-chat-entry ai-chat-entry-${entry.role}`}>
              {entry.thinking && <ThinkingBlock text={entry.thinking} live={isStreaming} />}
              {entry.text && <div className="ai-chat-bubble">{entry.text}</div>}
              {entry.edit && <EditCard entry={entry} assistant={assistant} />}
              {isStreaming && <PhaseIndicator status={status} />}
            </div>
          )
        })}
      </div>

      {error && (
        <div className="ai-chat-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="ai-chat-btn ai-chat-btn-quiet"
            onClick={assistant.dismissError}
            aria-label="Dismiss the error"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="ai-chat-composer">
        <textarea
          ref={inputRef}
          className="ai-chat-input"
          value={draft}
          rows={3}
          placeholder={hasApiKey ? 'Ask for a change…' : 'Add an API key to start'}
          aria-label="Message the AI assistant"
          disabled={!hasApiKey}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onInputKeyDown}
        />
        <div className="ai-chat-composer-actions">
          <span className="ai-chat-hint">Enter sends · Shift+Enter for a new line</span>
          {isBusy ? (
            <button type="button" className="ai-chat-btn" onClick={assistant.stop}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="ai-chat-btn ai-chat-btn-primary"
              onClick={submit}
              disabled={!draft.trim() || !hasApiKey}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}

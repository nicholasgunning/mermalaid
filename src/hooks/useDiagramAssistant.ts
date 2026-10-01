/**
 * Conversation state for the AI chat panel.
 *
 * It holds one provider-neutral transcript ({@link AssistantTurn}), which is both what the panel
 * renders and what a provider turns into its own wire format. Two things are worth knowing: an
 * assistant turn keeps the provider's own representation of itself for replay, and the user's answer
 * to a proposal rides along with the *next* message rather than costing a round trip of its own.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  resolveAssistantProvider,
  subscribeToAssistantProviders,
  type ConfiguredProvider,
} from '../utils/assistantProviders'
import type { AssistantTurn, DiagramContext, EditDecision } from '../utils/diagramAssistant'

export type { EditDecision }

export interface AssistantEdit {
  summary: string
  mermaid: string
  status: EditDecision | 'pending'
}

export interface AssistantEntry {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** Set on an assistant entry that proposed a change to the diagram. */
  edit?: AssistantEdit
}

export type AssistantStatus = 'idle' | 'waiting' | 'streaming'

export interface UseDiagramAssistantOptions {
  /** The diagram as it currently stands; read at send time, never captured. */
  context: DiagramContext
  /** Applies an approved diagram to the document. */
  onApplyDiagram: (mermaid: string) => void
}

export interface DiagramAssistant {
  entries: AssistantEntry[]
  status: AssistantStatus
  error: string | null
  /** The provider that will answer, or null when no key is configured. */
  provider: ConfiguredProvider | null
  hasApiKey: boolean
  /** True while a proposal is waiting on the user. */
  hasPendingEdit: boolean
  send: (text: string) => void
  approveEdit: () => void
  rejectEdit: () => void
  stop: () => void
  clear: () => void
  dismissError: () => void
}

export function useDiagramAssistant({
  context,
  onApplyDiagram,
}: UseDiagramAssistantOptions): DiagramAssistant {
  const [entries, setEntries] = useState<AssistantEntry[]>([])
  const [status, setStatus] = useState<AssistantStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [hasPendingEdit, setHasPendingEdit] = useState(false)
  const [provider, setProvider] = useState<ConfiguredProvider | null>(resolveAssistantProvider)

  // Settings is a separate dialog (and may be in another tab), so the keys are watched rather than
  // re-read at moments we would otherwise have to guess at.
  useEffect(() => subscribeToAssistantProviders(() => setProvider(resolveAssistantProvider())), [])

  /** What a provider sees. Kept in a ref: it is bookkeeping, and the entries are what render. */
  const turnsRef = useRef<AssistantTurn[]>([])
  /** The proposal still waiting on the user, and the entry showing it. */
  const pendingEditRef = useRef<{ callId: string; mermaid: string; entryId: string } | null>(null)
  /** The answer to the last proposal, sent with the next message. */
  const pendingDecisionRef = useRef<AssistantTurn['decision'] | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const contextRef = useRef(context)
  contextRef.current = context
  const applyRef = useRef(onApplyDiagram)
  applyRef.current = onApplyDiagram
  const entryIdRef = useRef(0)

  const nextEntryId = () => {
    entryIdRef.current += 1
    return `entry-${entryIdRef.current}`
  }

  const patchEntry = useCallback((id: string, patch: Partial<AssistantEntry>) => {
    setEntries((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    )
  }, [])

  /** Records the user's answer to the open proposal; it goes out with the next turn. */
  const resolvePendingEdit = useCallback((decision: EditDecision) => {
    const pending = pendingEditRef.current
    if (!pending) return
    if (decision === 'applied') applyRef.current(pending.mermaid)
    pendingDecisionRef.current = { callId: pending.callId, decision }
    pendingEditRef.current = null
    setHasPendingEdit(false)
    setEntries((current) =>
      current.map((entry) =>
        entry.id === pending.entryId && entry.edit
          ? { ...entry, edit: { ...entry.edit, status: decision } }
          : entry,
      ),
    )
  }, [])

  const send = useCallback(
    (text: string) => {
      const prompt = text.trim()
      if (!prompt || status !== 'idle') return

      const active = resolveAssistantProvider()
      setProvider(active)
      if (!active) {
        setError('Add an API key in Settings to use the assistant.')
        return
      }

      // Moving on without answering a proposal is a rejection — every tool call has to be answered,
      // and leaving it open would stall the next turn.
      resolvePendingEdit('rejected')

      const decision = pendingDecisionRef.current
      pendingDecisionRef.current = null
      turnsRef.current = [
        ...turnsRef.current,
        { role: 'user', text: prompt, ...(decision ? { decision } : {}) },
      ]

      const askId = nextEntryId()
      const replyId = nextEntryId()
      setEntries((current) => [
        ...current,
        { id: askId, role: 'user', text: prompt },
        { id: replyId, role: 'assistant', text: '' },
      ])
      setError(null)
      setStatus('waiting')

      const controller = new AbortController()
      abortRef.current = controller

      void (async () => {
        let streamed = ''
        try {
          const reply = await active.provider.send({
            apiKey: active.apiKey,
            turns: turnsRef.current,
            context: contextRef.current,
            signal: controller.signal,
            onTextDelta: (delta: string) => {
              streamed += delta
              setStatus('streaming')
              patchEntry(replyId, { text: streamed })
            },
          })

          turnsRef.current = [
            ...turnsRef.current,
            { role: 'assistant', text: reply.text, edit: reply.edit, raw: reply.raw },
          ]

          patchEntry(replyId, {
            text: reply.text || (reply.edit ? reply.edit.summary : 'No reply.'),
            edit: reply.edit
              ? { summary: reply.edit.summary, mermaid: reply.edit.mermaid, status: 'pending' }
              : undefined,
          })
          if (reply.edit) {
            pendingEditRef.current = {
              callId: reply.edit.callId,
              mermaid: reply.edit.mermaid,
              entryId: replyId,
            }
            setHasPendingEdit(true)
          }
        } catch (err) {
          // A turn that failed or was stopped never happened: drop it so the next one starts clean.
          turnsRef.current = turnsRef.current.slice(0, -1)
          if (controller.signal.aborted) {
            if (streamed) {
              patchEntry(replyId, { text: `${streamed}\n\n(stopped)` })
            } else {
              setEntries((current) => current.filter((entry) => entry.id !== replyId))
            }
          } else {
            setEntries((current) => current.filter((entry) => entry.id !== replyId))
            setError(active.provider.describeError(err))
          }
        } finally {
          if (abortRef.current === controller) abortRef.current = null
          setStatus('idle')
        }
      })()
    },
    [status, patchEntry, resolvePendingEdit],
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const clear = useCallback(() => {
    abortRef.current?.abort()
    turnsRef.current = []
    pendingEditRef.current = null
    pendingDecisionRef.current = null
    setEntries([])
    setError(null)
    setHasPendingEdit(false)
  }, [])

  return {
    entries,
    status,
    error,
    provider,
    hasApiKey: provider !== null,
    hasPendingEdit,
    send,
    approveEdit: () => resolvePendingEdit('applied'),
    rejectEdit: () => resolvePendingEdit('rejected'),
    stop,
    clear,
    dismissError: () => setError(null),
  }
}

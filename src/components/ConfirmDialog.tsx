import { useEffect, useRef, type ReactNode } from 'react'
import './ConfirmDialog.css'

interface ConfirmDialogAction {
  label: string
  /** Styles the button as the dangerous choice (discarding work, deleting, …). */
  destructive?: boolean
  onClick: () => void
}

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  /** Styles the confirm button as the dangerous choice (discarding work, deleting, …). */
  destructive?: boolean
  /** Optional middle button, for the three-way "save / discard / cancel" question. */
  extraAction?: ConfirmDialogAction
  /** Disables every button while the confirmed action is still running. */
  busy?: boolean
  /** Extra controls between the message and the buttons (e.g. export options). */
  children?: ReactNode
  onConfirm: () => void
  onCancel: () => void
}

/**
 * In-app replacement for `window.confirm`.
 *
 * The native dialog cannot be used for decisions that gate an action: in the Tauri desktop
 * webview `confirm()` does not block, so it returns before the user has answered and the action
 * runs anyway. This dialog resolves through React state instead, so it behaves the same on web,
 * desktop and mobile — and is reachable from tests.
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive = false,
  extraAction,
  busy = false,
  children,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  // A destructive dialog focuses the safe choice, so Enter cannot discard work by accident;
  // an ordinary one focuses its action, which is what the user came for.
  useEffect(() => {
    if (!open) return
    const target = destructive ? cancelRef.current : confirmRef.current
    target?.focus?.()
  }, [open, destructive])

  useEffect(() => {
    if (!open || busy) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, busy, onCancel])

  if (!open) return null

  return (
    <div className="confirm-dialog-backdrop" onClick={busy ? undefined : onCancel}>
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="confirm-dialog-title" id="confirm-dialog-title">
          {title}
        </h2>
        <p className="confirm-dialog-message" id="confirm-dialog-message">
          {message}
        </p>
        {children}
        <div className="confirm-dialog-actions">
          <button
            type="button"
            ref={cancelRef}
            className="confirm-dialog-btn confirm-dialog-cancel"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          {extraAction && (
            <button
              type="button"
              className={`confirm-dialog-btn ${extraAction.destructive ? 'destructive' : ''}`}
              disabled={busy}
              onClick={extraAction.onClick}
            >
              {extraAction.label}
            </button>
          )}
          <button
            type="button"
            ref={confirmRef}
            className={`confirm-dialog-btn confirm-dialog-confirm ${destructive ? 'destructive' : ''}`}
            disabled={busy}
            aria-busy={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

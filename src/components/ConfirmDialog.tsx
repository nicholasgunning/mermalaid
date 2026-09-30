import { useEffect, useRef } from 'react'
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
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  // Focus the safe choice, so Enter/Space cannot discard work by accident.
  useEffect(() => {
    if (open) cancelRef.current?.focus?.()
  }, [open])

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

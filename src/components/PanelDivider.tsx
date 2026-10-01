import { useEffect, useRef } from 'react'
import { MIN_EDITOR_WIDTH_PX, MIN_PREVIEW_WIDTH_PX } from '../hooks/useEditorWidth'
import './PanelDivider.css'

interface PanelDividerProps {
  /** Current applied width in px of the panel being sized — where the divider sits. */
  width: number
  onWidthChange: (width: number) => void
  /** Live width of the `.app-content` row, used to clamp so the other panes stay usable. */
  containerWidth: number
  /**
   * Which side of the divider the panel being sized is on. `left` (the editor) grows as the pointer
   * moves right; `right` (the assistant column) grows as it moves left.
   */
  side?: 'left' | 'right'
  /** Narrowest the sized panel may get. */
  min?: number
  /** Room the rest of the row must keep, which is what caps the sized panel. */
  minRemaining?: number
  label?: string
}

/** Keyboard nudge per arrow-key press. */
const KEYBOARD_STEP_PX = 24

/** The track the divider occupies in the row — kept in step with `flex-basis` in PanelDivider.css. */
export const PANEL_DIVIDER_WIDTH_PX = 6

/**
 * Draggable separator that sets one panel's width (GitHub #91). Desktop-only; the caller omits it
 * on the stacked smartphone layout, while the editor is collapsed, and when the panel it sizes is
 * not showing.
 *
 * The bounds are the caller's, so the same divider serves the editor/preview split and the
 * assistant column on the far right.
 */
export default function PanelDivider({
  width,
  onWidthChange,
  containerWidth,
  side = 'left',
  min = MIN_EDITOR_WIDTH_PX,
  minRemaining = MIN_PREVIEW_WIDTH_PX,
  label = 'Resize editor and preview panels',
}: PanelDividerProps) {
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const maxWidth = Math.max(min, containerWidth - minRemaining)
  const clamp = (next: number) => Math.min(Math.max(next, min), maxWidth)
  /** A divider on the right edge sizes its panel in the opposite direction to the pointer. */
  const grain = side === 'right' ? -1 : 1

  // If the divider unmounts mid-drag (e.g. a tablet rotates into the stacked mobile layout),
  // endDrag never fires — make sure the global resize cursor / text-selection lock is cleared.
  useEffect(() => () => document.body.classList.remove('is-resizing-panels'), [])

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: width }
    e.currentTarget.setPointerCapture(e.pointerId)
    document.body.classList.add('is-resizing-panels')
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const nextWidth = drag.startWidth + grain * (e.clientX - drag.startX)
    onWidthChange(clamp(nextWidth))
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    document.body.classList.remove('is-resizing-panels')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      // Left and right always move the divider itself, whichever panel that widens.
      case 'ArrowLeft':
        e.preventDefault()
        onWidthChange(clamp(width - grain * KEYBOARD_STEP_PX))
        break
      case 'ArrowRight':
        e.preventDefault()
        onWidthChange(clamp(width + grain * KEYBOARD_STEP_PX))
        break
      case 'Home':
        e.preventDefault()
        onWidthChange(min)
        break
      case 'End':
        e.preventDefault()
        onWidthChange(maxWidth)
        break
    }
  }

  return (
    <div
      className="panel-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={Math.round(maxWidth)}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
    >
      <span className="panel-divider-handle" aria-hidden="true" />
    </div>
  )
}

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { isTabDirty, tabTitle, type DiagramTab } from '../utils/documentTabs'
import './TabBar.css'

interface TabBarProps {
  tabs: DiagramTab[]
  activeId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  /** Arrow-key navigation inside the tab strip. */
  onSelectRelative: (delta: number) => void
  /** Drag-to-reorder (and Alt+Arrow): move the tab to `toIndex`. */
  onReorder: (id: string, toIndex: number) => void
}

/** Pointer travel before a press on a tab counts as a drag rather than a click. */
const DRAG_THRESHOLD_PX = 4

interface DragState {
  id: string
  fromIndex: number
  pointerId: number
  startX: number
  /** False until the pointer passes {@link DRAG_THRESHOLD_PX}, so plain clicks still select. */
  moved: boolean
  targetIndex: number
  /** Removes the window-level move/up listeners this drag installed. */
  detach: () => void
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path
        d="M2.5 2.5l7 7M9.5 2.5l-7 7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * Index the dragged tab would land on if the pointer were released at `clientX`.
 *
 * The strip is not reordered while dragging, so the dragged tab still occupies its own slot:
 * landing to the right of it loses one position to that gap, hence the `k - 1`.
 */
function dropIndexAt(strip: HTMLElement, clientX: number, fromIndex: number): number {
  const elements = Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-id]'))
  let k = elements.length
  for (let i = 0; i < elements.length; i += 1) {
    const rect = elements[i].getBoundingClientRect()
    if (clientX < rect.left + rect.width / 2) {
      k = i
      break
    }
  }
  const index = k > fromIndex ? k - 1 : k
  return Math.max(0, Math.min(index, elements.length - 1))
}

/**
 * The open-document strip above the editor/preview split (GitHub #113).
 *
 * Renders one tab per open `.mmd` document, marks unsaved ones with a dot, and always ends with
 * the new-tab button. Middle-click closes a tab, as in a browser or code editor, and tabs can be
 * dragged into any order (Alt+Left/Alt+Right does the same from the keyboard).
 */
export default function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
  onSelectRelative,
  onReorder,
}: TabBarProps) {
  const activeTabRef = useRef<HTMLButtonElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  // Mirrors `dragRef` for rendering the dragged tab and the insertion line.
  const [drag, setDrag] = useState<{ id: string; fromIndex: number; targetIndex: number } | null>(
    null,
  )
  // A drag ends with a pointerup over the tab, which the browser follows with a click; that click
  // must not also select the tab the user was only moving.
  const suppressClickRef = useRef(false)

  // Keep the focused tab visible when it is selected by shortcut rather than by click.
  // `scrollIntoView` is absent in jsdom and non-essential, hence the optional call.
  useEffect(() => {
    activeTabRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeId])

  // Unmounting mid-drag must not leave the window listeners behind.
  useEffect(
    () => () => {
      dragRef.current?.detach()
      dragRef.current = null
    },
    [],
  )

  const endDrag = (commit: boolean) => {
    const current = dragRef.current
    dragRef.current = null
    current?.detach()
    setDrag(null)
    if (!current?.moved) return
    const moving = commit && current.targetIndex !== current.fromIndex
    // Only a drag that actually moved the tab swallows the click the browser sends next: a press
    // that wobbled a few pixels and stayed put is still a click, and must still select the tab.
    suppressClickRef.current = moving
    if (moving) onReorder(current.id, current.targetIndex)
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>, index: number) => {
    // A drag whose click never arrived must not swallow the next real one.
    suppressClickRef.current = false
    // Left button only, and never touch: the strip scrolls horizontally by touch-drag.
    if (event.button !== 0 || event.pointerType === 'touch') return
    if (tabs.length < 2) return
    // Pressing the close button is never the start of a drag.
    if ((event.target as HTMLElement).closest('.tab-close-btn')) return
    if (dragRef.current) endDrag(false)

    const pointerId = event.pointerId
    // Tracked on the window rather than through `setPointerCapture`: capturing retargets the
    // mouse events that follow, which swallowed the first click after a drop.
    const onMove = (moveEvent: PointerEvent) => {
      const current = dragRef.current
      if (!current || current.pointerId !== moveEvent.pointerId) return
      if (!current.moved && Math.abs(moveEvent.clientX - current.startX) < DRAG_THRESHOLD_PX) return

      const strip = stripRef.current
      if (!strip) return
      current.moved = true
      current.targetIndex = dropIndexAt(strip, moveEvent.clientX, current.fromIndex)
      setDrag({ id: current.id, fromIndex: current.fromIndex, targetIndex: current.targetIndex })
    }
    const onUp = (upEvent: PointerEvent) => {
      if (dragRef.current?.pointerId !== upEvent.pointerId) return
      endDrag(true)
    }
    const onCancel = (cancelEvent: PointerEvent) => {
      if (dragRef.current?.pointerId !== cancelEvent.pointerId) return
      endDrag(false)
    }
    const detach = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)

    dragRef.current = {
      id: tabs[index].id,
      fromIndex: index,
      pointerId,
      startX: event.clientX,
      moved: false,
      targetIndex: index,
      detach,
    }
  }

  const moveActiveTab = (delta: number) => {
    const index = tabs.findIndex((tab) => tab.id === activeId)
    if (index === -1) return
    const target = index + delta
    if (target < 0 || target >= tabs.length) return
    onReorder(activeId, target)
  }

  return (
    <div className="tab-bar">
      <div
        className="tab-bar-strip"
        ref={stripRef}
        role="tablist"
        aria-label="Open diagrams"
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            if (event.altKey) moveActiveTab(1)
            else onSelectRelative(1)
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault()
            if (event.altKey) moveActiveTab(-1)
            else onSelectRelative(-1)
          } else if (event.key === 'Escape' && dragRef.current) {
            event.preventDefault()
            endDrag(false)
          }
        }}
      >
        {tabs.map((tab, index) => {
          const title = tabTitle(tab)
          const isActive = tab.id === activeId
          const dirty = isTabDirty(tab)
          const isDragging = drag?.id === tab.id
          // The line sits on the side of the target tab the dragged tab is heading for.
          const dropBefore =
            drag !== null && !isDragging && index === drag.targetIndex && drag.targetIndex <= drag.fromIndex
          const dropAfter =
            drag !== null && !isDragging && index === drag.targetIndex && drag.targetIndex > drag.fromIndex
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              className={[
                'tab',
                isActive ? 'tab-active' : '',
                isDragging ? 'tab-dragging' : '',
                dropBefore ? 'tab-drop-before' : '',
                dropAfter ? 'tab-drop-after' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              role="presentation"
              onPointerDown={(event) => handlePointerDown(event, index)}
            >
              <button
                type="button"
                role="tab"
                ref={isActive ? activeTabRef : undefined}
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                className="tab-btn"
                title={`${tab.path ?? title}\nDrag to reorder (Alt+←/→)`}
                onClick={() => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false
                    return
                  }
                  onSelect(tab.id)
                }}
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault()
                    onClose(tab.id)
                  }
                }}
              >
                <span className="tab-title">{title}</span>
                {dirty && (
                  <span className="tab-dirty" title="Unsaved changes" aria-hidden="true">
                    ●
                  </span>
                )}
                {dirty && <span className="tab-sr-only"> (unsaved changes)</span>}
              </button>
              <button
                type="button"
                className="tab-close-btn"
                aria-label={`Close ${title}`}
                title={`Close ${title}`}
                onClick={() => onClose(tab.id)}
              >
                <CloseIcon />
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        className="tab-new-btn"
        onClick={onNew}
        aria-label="New diagram tab"
        title="New diagram tab (⌘T)"
      >
        +
      </button>
    </div>
  )
}

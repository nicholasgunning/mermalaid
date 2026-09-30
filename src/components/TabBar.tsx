import { useEffect, useRef } from 'react'
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
 * The open-document strip above the editor/preview split (GitHub #113).
 *
 * Renders one tab per open `.mmd` document, marks unsaved ones with a dot, and always ends with
 * the new-tab button. Middle-click closes a tab, as in a browser or code editor.
 */
export default function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
  onSelectRelative,
}: TabBarProps) {
  const activeTabRef = useRef<HTMLButtonElement>(null)

  // Keep the focused tab visible when it is selected by shortcut rather than by click.
  // `scrollIntoView` is absent in jsdom and non-essential, hence the optional call.
  useEffect(() => {
    activeTabRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeId])

  return (
    <div className="tab-bar">
      <div
        className="tab-bar-strip"
        role="tablist"
        aria-label="Open diagrams"
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            onSelectRelative(1)
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault()
            onSelectRelative(-1)
          }
        }}
      >
        {tabs.map((tab) => {
          const title = tabTitle(tab)
          const isActive = tab.id === activeId
          const dirty = isTabDirty(tab)
          return (
            <div key={tab.id} className={`tab ${isActive ? 'tab-active' : ''}`} role="presentation">
              <button
                type="button"
                role="tab"
                ref={isActive ? activeTabRef : undefined}
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                className="tab-btn"
                title={tab.path ?? title}
                onClick={() => onSelect(tab.id)}
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

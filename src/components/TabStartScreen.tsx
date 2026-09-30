import './TabStartScreen.css'

interface TabStartScreenProps {
  onNewDiagram: () => void
  onOpenFile: () => void
  /** Desktop only: paths that can be reopened straight into this tab. */
  recentPaths?: string[]
  onOpenRecent?: (path: string) => void
  /** Last path segment for display. */
  fileLabel?: (path: string) => string
  isMobile?: boolean
}

function NewDiagramIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M14 3v5h5M12 11v6M9 14h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function OpenFileIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * What an empty tab shows instead of a blank preview.
 *
 * Each tab is its own workspace, so a fresh one asks which workspace it should be: a new diagram
 * or an existing `.mmd` file. Both actions fill this tab rather than opening another one.
 */
export default function TabStartScreen({
  onNewDiagram,
  onOpenFile,
  recentPaths = [],
  onOpenRecent,
  fileLabel = (path) => path,
  isMobile = false,
}: TabStartScreenProps) {
  const showRecents = recentPaths.length > 0 && Boolean(onOpenRecent)

  return (
    <div className="tab-start-screen" role="group" aria-label="Empty tab">
      <div className="tab-start-inner">
        <h2 className="tab-start-title">This tab is empty</h2>
        <p className="tab-start-subtitle">Start a new diagram, or open one you already have.</p>

        <div className="tab-start-actions">
          <button type="button" className="tab-start-btn primary" onClick={onNewDiagram}>
            <NewDiagramIcon />
            <span>New diagram</span>
          </button>
          <button type="button" className="tab-start-btn" onClick={onOpenFile}>
            <OpenFileIcon />
            <span>Open .mmd file…</span>
          </button>
        </div>

        {showRecents && (
          <div className="tab-start-recents">
            <h3 className="tab-start-recents-title">Recent files</h3>
            <ul className="tab-start-recent-list">
              {recentPaths.map((path) => (
                <li key={path}>
                  <button
                    type="button"
                    className="tab-start-recent-btn"
                    title={path}
                    onClick={() => onOpenRecent?.(path)}
                  >
                    {fileLabel(path)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="tab-start-hint">
          {isMobile
            ? 'Or switch to Code and start typing.'
            : 'Or drop a file here — you can also just start typing in the editor.'}
        </p>
      </div>
    </div>
  )
}

import { useState, useEffect, useRef, useLayoutEffect, useCallback, useMemo } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ThemeProvider } from './contexts/ThemeContext'
import { ToastProvider } from './contexts/ToastContext'
import { useTheme } from './hooks/useTheme'
import { useUpdateCheck } from './hooks/useUpdateCheck'
import { useMountEffect } from './hooks/useMountEffect'
import { useToast } from './hooks/useToast'
import { useEditorWidth, clampEditorWidth, viewportWidth } from './hooks/useEditorWidth'
import Editor from './components/Editor'
import Preview from './components/Preview'
import PanelDivider from './components/PanelDivider'
import Toolbar, { type ToolbarRef } from './components/Toolbar'
import AiChatPanel from './components/AiChatPanel'
import { useDiagramAssistant } from './hooks/useDiagramAssistant'
import { applyDiagramCode } from './utils/applyDiagramCode'
import TabBar from './components/TabBar'
import ConfirmDialog from './components/ConfirmDialog'
import LandingPage from './components/LandingPage'
import SlackLandingPage from './components/SlackLandingPage'
import UpdateAvailableBanner from './components/UpdateAvailableBanner'
import { useAgentBridge } from './hooks/useAgentBridge'
import { AgentBridgeProvider } from './contexts/AgentBridgeContext'
import { useExternalFileWatch } from './hooks/useExternalFileWatch'
import { useDocumentTabs } from './hooks/useDocumentTabs'
import { formatUnsavedTabList, useUnsavedWindowClose } from './hooks/useUnsavedWindowClose'
import type { LatestReleaseInfo } from './utils/githubRelease'
import { isDiagramImportFileName } from './utils/diagramImportFiles'
import { NEW_DIAGRAM_CODE, tabTitle } from './utils/documentTabs'
import { addRecentFile, getRecentPaths, recentFileLabel } from './utils/recentFiles'
import type { SavedTabRecord } from './utils/saveAllUnsavedTabs'
import {
  clearUrlFragment,
  decodePrivateShareHash,
  getPrivateShareErrorMessage,
  isPrivateShareHash,
} from './utils/privateUrlShare'
import { decodePublicDiagram } from './utils/publicShareLink'
import { extractMermaidCode, extractAllMermaidBlocks } from './utils/mermaidCodeBlock'
import { getAppThemeCssVars, isAppThemeDark } from './utils/mermaidThemes'
import { initNativeAppMenu, setNativeMenuHandlerSource } from './nativeAppMenu'
import './App.css'

const SMARTPHONE_BREAKPOINT_PX = 768

type MobileWorkspacePanel = 'editor' | 'preview'

function useIsSmartphoneLayout() {
  const [isSmartphoneLayout, setIsSmartphoneLayout] = useState(
    () => window.innerWidth <= SMARTPHONE_BREAKPOINT_PX,
  )

  useEffect(() => {
    const updateLayout = () => setIsSmartphoneLayout(window.innerWidth <= SMARTPHONE_BREAKPOINT_PX)

    updateLayout()
    window.addEventListener('resize', updateLayout)
    return () => window.removeEventListener('resize', updateLayout)
  }, [])

  return isSmartphoneLayout
}

function useVisualViewportCssVars(isSmartphoneLayout: boolean) {
  useEffect(() => {
    if (!isSmartphoneLayout) return

    const vv = window.visualViewport
    if (!vv) return

    const apply = () => {
      // Use px so layout always matches the visual viewport (iOS Safari address bar + keyboard).
      document.documentElement.style.setProperty('--vvh', `${vv.height}px`)
      document.documentElement.style.setProperty('--vvw', `${vv.width}px`)
    }

    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    window.addEventListener('orientationchange', apply)
    window.addEventListener('resize', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      window.removeEventListener('orientationchange', apply)
      window.removeEventListener('resize', apply)
    }
  }, [isSmartphoneLayout])
}

function useIsKeyboardOpen(isSmartphoneLayout: boolean) {
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false)

  useEffect(() => {
    if (!isSmartphoneLayout) {
      setIsKeyboardOpen(false)
      return
    }

    const vv = window.visualViewport
    if (!vv) return

    const KEYBOARD_THRESHOLD_PX = 140
    const update = () => {
      // Heuristic: a sizable reduction from the *layout* viewport height implies a soft keyboard.
      // Using current values (not initial height) avoids “stuck open” on iOS when the URL bar collapses/expands.
      const delta = window.innerHeight - vv.height
      // If nothing is focused, be more eager to declare the keyboard closed.
      const active = document.activeElement as HTMLElement | null
      const isTextFocus =
        Boolean(active) &&
        (active?.tagName === 'INPUT' ||
          active?.tagName === 'TEXTAREA' ||
          active?.isContentEditable)

      const shouldBeOpen = delta > KEYBOARD_THRESHOLD_PX && isTextFocus
      const shouldBeMaybeOpen = delta > KEYBOARD_THRESHOLD_PX && !isTextFocus
      setIsKeyboardOpen(shouldBeOpen || shouldBeMaybeOpen)
    }

    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    window.addEventListener('focusin', update)
    window.addEventListener('focusout', update)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      window.removeEventListener('focusin', update)
      window.removeEventListener('focusout', update)
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [isSmartphoneLayout])

  return isKeyboardOpen
}

interface ReleaseBannerRouteProps {
  pendingRelease: LatestReleaseInfo | null
  onDismissPendingRelease: () => void
}

function PrivateShareHashRedirect() {
  const navigate = useNavigate()
  const location = useLocation()

  useLayoutEffect(() => {
    if (location.pathname !== '/') return
    const h = location.hash
    if (!isPrivateShareHash(h)) return
    navigate(`/editor${h}`, { replace: true })
  }, [location.pathname, location.hash, navigate])

  return null
}

function EditorView({ pendingRelease, onDismissPendingRelease }: ReleaseBannerRouteProps) {
  const { mermaidTheme } = useTheme()
  const { showToast } = useToast()
  const location = useLocation()
  const isSmartphoneLayout = useIsSmartphoneLayout()
  useVisualViewportCssVars(isSmartphoneLayout)
  const isKeyboardOpen = useIsKeyboardOpen(isSmartphoneLayout)
  // Every open `.mmd` document lives here; the editor, preview and toolbar all act on the
  // focused tab, so the rest of this view still works against a single `code`/`setCode` pair.
  const documents = useDocumentTabs()
  const activeTab = documents.activeTab
  const code = activeTab.code
  const setCode = documents.setActiveCode
  const [error, setError] = useState<string | null>(null)
  const [isEditorCollapsed, setIsEditorCollapsed] = useState(false)
  const [editorWidth, setEditorWidth] = useEditorWidth()
  const [containerWidth, setContainerWidth] = useState(viewportWidth)
  const [mobileWorkspacePanel, setMobileWorkspacePanel] = useState<MobileWorkspacePanel>('preview')
  const documentPath = activeTab.path
  const documentPathRef = documents.activePathRef
  const setDocumentPath = documents.setActivePath
  const appContentRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<ToolbarRef>(null)
  const agentBridge = useAgentBridge({ code, setCode, error })
  const { markSaved: markDocumentSaved } = useExternalFileWatch({
    documentPath,
    code,
    setCode,
    onReloaded: documents.markActiveSaved,
  })

  /** A save is the one moment both the tab's unsaved marker and the watcher must be reset. */
  const handleDocumentSaved = useCallback(
    (content: string) => {
      markDocumentSaved(content)
      documents.markActiveSaved(content)
    },
    [markDocumentSaved, documents.markActiveSaved],
  )

  const handleTabSavedOnClose = useCallback(
    ({ id, content, path }: SavedTabRecord) => {
      documents.markTabSaved(id, content, path)
      addRecentFile(path)
    },
    [documents.markTabSaved],
  )

  /** Desktop: the window itself must not close unsaved work (every tab, not just this one). */
  const windowClose = useUnsavedWindowClose({
    unsavedTabs: documents.unsavedTabs,
    onTabSaved: handleTabSavedOnClose,
  })

  // A stale syntax error from the previous document would otherwise flash on the new one.
  useEffect(() => {
    setError(null)
  }, [documents.activeId])

  // Compute mermaid blocks from the code
  const mermaidBlocks = extractAllMermaidBlocks(code)
  const hasMultipleBlocks = mermaidBlocks.length > 1
  // The tab remembers its block, which a later edit (or a restored session) can put out of range.
  const selectedBlockIndex = Math.min(
    activeTab.selectedBlockIndex,
    Math.max(0, mermaidBlocks.length - 1),
  )
  const setSelectedBlockIndex = documents.setActiveSelectedBlockIndex
  const activeCode = hasMultipleBlocks
    ? (mermaidBlocks[selectedBlockIndex]?.code ?? '')
    : extractMermaidCode(code)

  const [showAiChat, setShowAiChat] = useState(false)

  /** An approved assistant edit lands exactly where the visual editor's would. */
  const applyAssistantDiagram = useCallback(
    (mermaid: string) => {
      setCode(applyDiagramCode(code, mermaidBlocks, selectedBlockIndex, mermaid))
    },
    [code, mermaidBlocks, selectedBlockIndex, setCode],
  )

  const assistant = useDiagramAssistant({
    context: { code: activeCode, documentName: tabTitle(activeTab), error },
    onApplyDiagram: applyAssistantDiagram,
  })

  // Reset the block index when this document's block count changes — but not when the count
  // changes because another tab was focused, since each tab keeps its own selection.
  const prevBlocks = useRef({ tabId: documents.activeId, count: mermaidBlocks.length })
  useEffect(() => {
    const prev = prevBlocks.current
    prevBlocks.current = { tabId: documents.activeId, count: mermaidBlocks.length }
    if (prev.tabId === documents.activeId && prev.count !== mermaidBlocks.length) {
      setSelectedBlockIndex(0)
    }
  }, [documents.activeId, mermaidBlocks.length, setSelectedBlockIndex])

  // Track the live width of the split row so we can clamp the applied editor width without
  // ever mutating the user's saved preference (they keep their wide layout after a shrink).
  useMountEffect(() => {
    const el = appContentRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width
      if (measured && measured > 0) setContainerWidth(measured)
    })
    observer.observe(el)
    return () => observer.disconnect()
  })

  useMountEffect(() => {
    try { localStorage.setItem('mermalaid-has-used-editor', '1') } catch {}
  })

  /** Web: react to private `#v1…` on load and when the hash changes while staying on /editor. */
  useEffect(() => {
    if (isTauri()) return
    const hash = location.hash
    if (!isPrivateShareHash(hash)) return

    let cancelled = false
    void (async () => {
      try {
        const state = await decodePrivateShareHash(hash)
        if (cancelled) return
        // Its own tab, so a restored session is never overwritten by a link.
        documents.openDocument({ code: state.code, name: 'Shared diagram' })
        clearUrlFragment()
        showToast('Opened diagram from private link')
      } catch (e) {
        if (cancelled) return
        showToast(getPrivateShareErrorMessage(e), 'error')
        clearUrlFragment()
      }
    })()

    return () => {
      cancelled = true
    }
  }, [location.hash, showToast, documents.openDocument])

  /** Web: open a diagram from a public preview link (`/editor?c=…`). */
  useEffect(() => {
    if (isTauri()) return
    const c = new URLSearchParams(location.search).get('c')
    if (!c) return

    let cancelled = false
    void (async () => {
      try {
        const source = await decodePublicDiagram(c)
        if (cancelled) return
        documents.openDocument({ code: source, name: 'Shared diagram' })
        // Strip the param so it doesn't linger or re-trigger.
        window.history.replaceState(null, '', location.pathname)
        showToast('Opened diagram from shared link')
      } catch {
        if (cancelled) return
        window.history.replaceState(null, '', location.pathname)
        showToast('Could not open the shared diagram link.', 'error')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [location.search, showToast, documents.openDocument])

  /** Finder / Explorer / argv: open the requested file instead of restoring draft (issue #41). */
  useMountEffect(() => {
    if (!isTauri()) return

    const tryConsumePrivateShareHash = async (): Promise<'loaded' | 'none' | 'invalid'> => {
      const hash = window.location.hash
      if (!isPrivateShareHash(hash)) return 'none'
      try {
        const state = await decodePrivateShareHash(hash)
        documents.openDocument({ code: state.code, name: 'Shared diagram' })
        clearUrlFragment()
        showToast('Opened diagram from private link')
        return 'loaded'
      } catch (e) {
        showToast(getPrivateShareErrorMessage(e), 'error')
        clearUrlFragment()
        return 'invalid'
      }
    }

    const openQueuedPaths = async () => {
      const paths = await invoke<string[]>('take_open_files')
      if (paths.length === 0) return false
      for (const p of paths) {
        await toolbarRef.current?.openPath(p)
      }
      return true
    }

    const openStartupDocuments = async () => {
      const shareOutcome = await tryConsumePrivateShareHash()
      if (shareOutcome === 'loaded') return
      // Restored tabs are already open; files the OS handed us are added alongside them.
      await openQueuedPaths()
    }

    void openStartupDocuments()

    let unlisten: (() => void) | undefined
    void listen('open-files', () => {
      void openQueuedPaths()
    }).then((fn) => {
      unlisten = fn
    })

    return () => {
      unlisten?.()
    }
  })

  useMountEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      // Shift (and caps lock) report the letter uppercase, so compare case-insensitively —
      // otherwise Save As (⇧⌘S) would never match.
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      if (mod && key === 'n') {
        e.preventDefault()
        toolbarRef.current?.handleNew()
      } else if (mod && key === 'o') {
        e.preventDefault()
        void toolbarRef.current?.handleOpen()
      } else if (mod && key === 's') {
        e.preventDefault()
        if (e.shiftKey) {
          void toolbarRef.current?.handleSaveAs()
        } else {
          void toolbarRef.current?.handleSave()
        }
      } else if (mod && !isTauri() && key === 't') {
        // Desktop routes ⌘T/⌘W/⌃Tab through the native menu accelerators (see nativeAppMenu.ts),
        // so they are only bound here for the web app, where the browser may still claim them.
        e.preventDefault()
        documents.newTab()
      } else if (mod && !isTauri() && key === 'w') {
        e.preventDefault()
        documents.closeActiveTab()
      } else if (e.ctrlKey && !isTauri() && key === 'Tab') {
        e.preventDefault()
        documents.selectRelativeTab(e.shiftKey ? -1 : 1)
      } else if (mod && e.altKey && (key === 'ArrowRight' || key === 'ArrowLeft')) {
        e.preventDefault()
        documents.selectRelativeTab(key === 'ArrowRight' ? 1 : -1)
      } else if (mod && !e.altKey && /^[1-9]$/.test(key)) {
        // ⌘9 jumps to the last tab, as in browsers and editors.
        e.preventDefault()
        const digit = Number.parseInt(key, 10)
        documents.selectTabAtIndex(digit === 9 ? Number.MAX_SAFE_INTEGER : digit - 1)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

  useMountEffect(() => {
    if (!isTauri()) return
    setNativeMenuHandlerSource(() => ({
      onNew: () => toolbarRef.current?.handleNew(),
      onOpen: () => void toolbarRef.current?.handleOpen(),
      onSave: () => void toolbarRef.current?.handleSave(),
      onSaveAs: () => void toolbarRef.current?.handleSaveAs(),
      onPrint: () => toolbarRef.current?.handlePrint(),
      onShare: () => void toolbarRef.current?.handleShare(),
      onDuplicate: () => void toolbarRef.current?.handleDuplicate(),
      onNewTab: () => documents.newTab(),
      onCloseTab: () => documents.closeActiveTab(),
      onNextTab: () => documents.selectRelativeTab(1),
      onPreviousTab: () => documents.selectRelativeTab(-1),
      onEngineVersion: () => toolbarRef.current?.handleEngineVersionInfo(),
      onShowLicense: () => toolbarRef.current?.handleShowLicenseInfo(),
      onOpenRecent: (path) => void toolbarRef.current?.openPath(path),
    }))
    void initNativeAppMenu()
  })

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files).filter((file) =>
      isDiagramImportFileName(file.name),
    )
    if (files.length === 0) return

    // Each dropped diagram opens in its own tab; browsers expose no path, so use the file name.
    for (const file of files) {
      const reader = new FileReader()
      reader.onload = (event) => {
        const content = event.target?.result as string
        if (typeof content === 'string') {
          documents.openDocument({ code: content, name: file.name })
        }
      }
      reader.readAsText(file)
    }
  }

  /**
   * Empty-tab actions. Both go through `openDocument`, which fills the focused empty tab rather
   * than opening yet another one.
   */
  const handleStartNewDiagram = () => {
    documents.openDocument({ code: NEW_DIAGRAM_CODE })
  }

  const handleOpenFileInTab = () => {
    void toolbarRef.current?.handleOpen()
  }

  // Desktop only: reopening a recent file needs a path the app is allowed to read. Re-read when
  // the focused tab changes, which covers every point at which an empty tab can appear.
  const recentPaths = useMemo(
    () => (isTauri() ? getRecentPaths() : []),
    [documents.activeId],
  )

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const showEditorPanel = !isSmartphoneLayout || mobileWorkspacePanel === 'editor'
  const showPreviewPanel = !isSmartphoneLayout || mobileWorkspacePanel === 'preview'
  // Applied width is the saved preference clamped to the current window; the saved value is untouched.
  const appliedEditorWidth = clampEditorWidth(editorWidth, containerWidth)

  return (
    <AgentBridgeProvider value={agentBridge}>
    <div
      className={`app ${isAppThemeDark(mermaidTheme) ? 'app-theme-dark' : 'app-theme-light'} ${isSmartphoneLayout ? 'app-mobile' : ''} ${isKeyboardOpen ? 'app-mobile-keyboard-open' : ''}`}
      style={getAppThemeCssVars(mermaidTheme) as React.CSSProperties}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {pendingRelease && (
        <UpdateAvailableBanner
          update={pendingRelease}
          onDismiss={onDismissPendingRelease}
          variant="editor"
        />
      )}
      <Toolbar
        ref={toolbarRef}
        code={code}
        setCode={setCode}
        error={error}
        activeCode={activeCode}
        mermaidBlocks={mermaidBlocks}
        tabs={documents.tabs}
        activeTabId={documents.activeId}
        documentPathRef={documentPathRef}
        setDocumentPath={setDocumentPath}
        openDocument={documents.openDocument}
        newDocument={documents.newTab}
        setDocumentName={documents.setActiveName}
        onDocumentSaved={handleDocumentSaved}
        isMobile={isSmartphoneLayout}
        aiChatOpen={showAiChat}
        onToggleAiChat={() => setShowAiChat((open) => !open)}
      />
      <TabBar
        tabs={documents.tabs}
        activeId={documents.activeId}
        onSelect={documents.selectTab}
        onClose={documents.closeTab}
        onNew={documents.newTab}
        onSelectRelative={documents.selectRelativeTab}
      />
      <ConfirmDialog
        open={documents.pendingCloseTab !== null && !windowClose.isAsking}
        title="Unsaved changes"
        message={
          documents.pendingCloseTab
            ? `${tabTitle(documents.pendingCloseTab)} has changes that have not been saved. Closing this tab discards them.`
            : ''
        }
        confirmLabel="Close without saving"
        cancelLabel="Keep editing"
        destructive
        onConfirm={documents.confirmPendingClose}
        onCancel={documents.cancelPendingClose}
      />
      <ConfirmDialog
        open={windowClose.isAsking}
        title="Unsaved changes"
        message={
          documents.unsavedTabs.length === 1
            ? `${formatUnsavedTabList(documents.unsavedTabs)} has changes that have not been saved.`
            : `${documents.unsavedTabs.length} diagrams have changes that have not been saved: ${formatUnsavedTabList(documents.unsavedTabs)}.`
        }
        confirmLabel={windowClose.isSaving ? 'Saving…' : 'Save all and close'}
        cancelLabel="Cancel"
        busy={windowClose.isSaving}
        extraAction={{
          label: 'Close without saving',
          destructive: true,
          onClick: windowClose.closeWithoutSaving,
        }}
        onConfirm={windowClose.saveAllAndClose}
        onCancel={windowClose.cancelClose}
      />
      <div className="app-content" ref={appContentRef}>
        {showEditorPanel && (
          <Editor
            code={code}
            setCode={setCode}
            error={error}
            mermaidBlocks={mermaidBlocks}
            selectedBlockIndex={selectedBlockIndex}
            setSelectedBlockIndex={setSelectedBlockIndex}
            isCollapsed={isSmartphoneLayout ? false : isEditorCollapsed}
            onToggleCollapsed={() => setIsEditorCollapsed((collapsed) => !collapsed)}
            isMobile={isSmartphoneLayout}
            width={appliedEditorWidth}
          />
        )}
        {!isSmartphoneLayout && !isEditorCollapsed && (
          <PanelDivider
            width={appliedEditorWidth}
            onWidthChange={setEditorWidth}
            containerWidth={containerWidth}
          />
        )}
        {showPreviewPanel && (
          <Preview
            code={code}
            setError={setError}
            onCodeChange={setCode}
            activeCode={activeCode}
            mermaidBlocks={mermaidBlocks}
            selectedBlockIndex={selectedBlockIndex}
            setSelectedBlockIndex={setSelectedBlockIndex}
            isMobile={isSmartphoneLayout}
            onNewDiagram={handleStartNewDiagram}
            onOpenFile={handleOpenFileInTab}
            recentPaths={recentPaths}
            onOpenRecent={(path) => void toolbarRef.current?.openPath(path)}
            fileLabel={recentFileLabel}
          />
        )}
        <AiChatPanel
          open={showAiChat}
          assistant={assistant}
          onClose={() => setShowAiChat(false)}
          onOpenSettings={() => toolbarRef.current?.openSettings()}
          isMobile={isSmartphoneLayout}
        />
      </div>
      {isSmartphoneLayout && (
        <div className="mobile-bottom-bar" role="navigation" aria-label="Mobile workspace">
          <div className="mobile-bottom-bar-inner" role="tablist" aria-label="Mobile workspace tabs">
            <button
              type="button"
              role="tab"
              aria-selected={mobileWorkspacePanel === 'preview'}
              className={`mobile-bottom-bar-btn ${mobileWorkspacePanel === 'preview' ? 'active' : ''}`}
              onClick={() => setMobileWorkspacePanel('preview')}
            >
              Preview
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mobileWorkspacePanel === 'editor'}
              className={`mobile-bottom-bar-btn ${mobileWorkspacePanel === 'editor' ? 'active' : ''}`}
              onClick={() => setMobileWorkspacePanel('editor')}
            >
              Code
            </button>
            <button
              type="button"
              className="mobile-bottom-bar-btn mobile-bottom-bar-more-btn"
              onClick={() => toolbarRef.current?.openMobileActions?.()}
              aria-haspopup="dialog"
            >
              More
            </button>
          </div>
        </div>
      )}
    </div>
    </AgentBridgeProvider>
  )
}

function App() {
  const { update: pendingRelease, dismiss: dismissPendingRelease } = useUpdateCheck()

  useMountEffect(() => {
    if (!isTauri()) return
    void initNativeAppMenu()
  })

  return (
    <ThemeProvider>
      <ToastProvider>
        <PrivateShareHashRedirect />
        <Routes>
          <Route
            path="/"
            element={
              isTauri()
                ? <Navigate to="/editor" replace />
                : (
                  <LandingPage
                    pendingRelease={pendingRelease}
                    onDismissPendingRelease={dismissPendingRelease}
                  />
                )
            }
          />
          <Route
            path="/editor"
            element={
              <EditorView
                pendingRelease={pendingRelease}
                onDismissPendingRelease={dismissPendingRelease}
              />
            }
          />
          <Route
            path="/slack"
            element={
              isTauri()
                ? <Navigate to="/editor" replace />
                : <SlackLandingPage />
            }
          />
        </Routes>
      </ToastProvider>
    </ThemeProvider>
  )
}

export default App

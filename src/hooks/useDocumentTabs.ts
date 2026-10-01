import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { MERMLAID_EDITOR_AUTOSAVE_DEBOUNCE_MS } from '../constants/mermalaidTiming'
import {
  activateRelativeTab,
  activateTab,
  activateTabAtIndex,
  addTab,
  closeTab as closeTabState,
  createInitialState,
  getActiveTab,
  isTabDirty,
  moveTab as moveTabState,
  openDocument as openDocumentState,
  parseTabsState,
  serializeTabsState,
  updateActiveTab,
  updateTab,
  type DiagramTab,
  type DiagramTabsState,
  type OpenDocumentInput,
} from '../utils/documentTabs'

const TABS_STORAGE_KEY = 'mermalaid-tabs'
/** Pre-tabs single-document autosave; read once to migrate, and kept in sync for downgrades. */
const LEGACY_DRAFT_KEY = 'mermalaid-draft'

export interface DocumentTabsApi {
  tabs: DiagramTab[]
  activeTab: DiagramTab
  activeId: string
  /** Path of the active tab, for callers that read it outside of render (Toolbar saves). */
  activePathRef: MutableRefObject<string | null>
  setActiveCode: (code: string) => void
  setActivePath: (path: string | null) => void
  /** Label for the focused tab while it has no path (web saves name the tab after the file). */
  setActiveName: (name: string) => void
  setActiveSelectedBlockIndex: (index: number | ((prev: number) => number)) => void
  /** Record content Mermalaid read from or wrote to disk, clearing the unsaved marker. */
  markActiveSaved: (content: string) => void
  /** Same, for a tab that is not focused — used when every unsaved tab is saved at once. */
  markTabSaved: (id: string, content: string, path?: string) => void
  /** Tabs with changes that are not on disk; empty when everything is saved. */
  unsavedTabs: DiagramTab[]
  /** Open a document: focuses an existing tab for the same path, else reuses/appends a tab. */
  openDocument: (input: OpenDocumentInput) => void
  newTab: () => void
  /** Closes at once when saved; otherwise raises {@link pendingCloseTab} to ask first. */
  closeTab: (id: string) => void
  closeActiveTab: () => void
  /** The tab waiting on an unsaved-changes answer, or null when nothing is being confirmed. */
  pendingCloseTab: DiagramTab | null
  /** Discards the pending tab's changes and closes it. */
  confirmPendingClose: () => void
  cancelPendingClose: () => void
  selectTab: (id: string) => void
  selectRelativeTab: (delta: number) => void
  selectTabAtIndex: (index: number) => void
  /** Drag-to-reorder: put `id` at `toIndex` in the strip, leaving focus where it is. */
  moveTab: (id: string, toIndex: number) => void
}

function readInitialState(): DiagramTabsState {
  try {
    const restored = parseTabsState(localStorage.getItem(TABS_STORAGE_KEY))
    if (restored) return restored
    const legacyDraft = localStorage.getItem(LEGACY_DRAFT_KEY)
    if (legacyDraft) return createInitialState(legacyDraft)
  } catch {
    /* private mode / blocked storage: fall through to a fresh workspace */
  }
  return createInitialState()
}

/**
 * Owns the open `.mmd` documents shown in the tab bar (GitHub #113).
 *
 * The whole workspace is persisted to localStorage (debounced) so a reload restores every tab,
 * migrating the pre-tabs single-draft key on first run. Every action is a stable callback over
 * functional updates, so window/menu shortcuts can be bound once on mount.
 */
export function useDocumentTabs(): DocumentTabsApi {
  const [state, setState] = useState<DiagramTabsState>(readInitialState)
  // Closing a tab with unsaved work waits on an in-app dialog rather than `window.confirm`,
  // which does not block in the desktop webview (it returned before the user had answered,
  // so the tab closed either way).
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null)
  const activeTab = getActiveTab(state)
  const unsavedTabs = state.tabs.filter(isTabDirty)
  const pendingCloseTab = pendingCloseId
    ? (state.tabs.find((tab) => tab.id === pendingCloseId) ?? null)
    : null

  // Mirrors of live state for callbacks that must not close over a render (menu + key handlers).
  const stateRef = useRef(state)
  const activePathRef = useRef<string | null>(activeTab.path)
  useEffect(() => {
    stateRef.current = state
  }, [state])
  useEffect(() => {
    activePathRef.current = activeTab.path
  }, [activeTab.path])

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(TABS_STORAGE_KEY, serializeTabsState(state))
        // Keep the legacy key pointing at the focused diagram so an older build still opens it.
        localStorage.setItem(LEGACY_DRAFT_KEY, getActiveTab(state).code)
      } catch {
        /* ignore quota / blocked storage */
      }
    }, MERMLAID_EDITOR_AUTOSAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [state])

  const setActiveCode = useCallback((code: string) => {
    setState((prev) => updateActiveTab(prev, { code }))
  }, [])

  const setActivePath = useCallback((path: string | null) => {
    setState((prev) => updateActiveTab(prev, { path }))
  }, [])

  const setActiveName = useCallback((name: string) => {
    setState((prev) => updateActiveTab(prev, { name }))
  }, [])

  const setActiveSelectedBlockIndex = useCallback(
    (index: number | ((prev: number) => number)) => {
      setState((prev) => {
        const current = getActiveTab(prev).selectedBlockIndex
        const next = typeof index === 'function' ? index(current) : index
        return updateActiveTab(prev, { selectedBlockIndex: Math.max(0, next) })
      })
    },
    [],
  )

  const markActiveSaved = useCallback((content: string) => {
    setState((prev) => updateActiveTab(prev, { savedCode: content }))
  }, [])

  const markTabSaved = useCallback((id: string, content: string, path?: string) => {
    setState((prev) => updateTab(prev, id, path ? { savedCode: content, path } : { savedCode: content }))
  }, [])

  const openDocument = useCallback((input: OpenDocumentInput) => {
    setState((prev) => openDocumentState(prev, input))
  }, [])

  const newTab = useCallback(() => {
    setState((prev) => addTab(prev))
  }, [])

  const closeTab = useCallback((id: string) => {
    const tab = stateRef.current.tabs.find((t) => t.id === id)
    if (tab && isTabDirty(tab)) {
      setPendingCloseId(id)
      return
    }
    setState((prev) => closeTabState(prev, id))
  }, [])

  const closeActiveTab = useCallback(() => {
    closeTab(stateRef.current.activeId)
  }, [closeTab])

  const confirmPendingClose = useCallback(() => {
    if (!pendingCloseId) return
    setState((prev) => closeTabState(prev, pendingCloseId))
    setPendingCloseId(null)
  }, [pendingCloseId])

  const cancelPendingClose = useCallback(() => {
    setPendingCloseId(null)
  }, [])

  const selectTab = useCallback((id: string) => {
    setState((prev) => activateTab(prev, id))
  }, [])

  const selectRelativeTab = useCallback((delta: number) => {
    setState((prev) => activateRelativeTab(prev, delta))
  }, [])

  const selectTabAtIndex = useCallback((index: number) => {
    setState((prev) => activateTabAtIndex(prev, index))
  }, [])

  const moveTab = useCallback((id: string, toIndex: number) => {
    setState((prev) => moveTabState(prev, id, toIndex))
  }, [])

  return useMemo(
    () => ({
      tabs: state.tabs,
      activeTab,
      activeId: state.activeId,
      activePathRef,
      setActiveCode,
      setActivePath,
      setActiveName,
      setActiveSelectedBlockIndex,
      markActiveSaved,
      markTabSaved,
      unsavedTabs,
      openDocument,
      newTab,
      closeTab,
      closeActiveTab,
      pendingCloseTab,
      confirmPendingClose,
      cancelPendingClose,
      selectTab,
      selectRelativeTab,
      selectTabAtIndex,
      moveTab,
    }),
    [
      state.tabs,
      state.activeId,
      activeTab,
      setActiveCode,
      setActivePath,
      setActiveName,
      setActiveSelectedBlockIndex,
      markActiveSaved,
      markTabSaved,
      unsavedTabs,
      openDocument,
      newTab,
      closeTab,
      closeActiveTab,
      pendingCloseTab,
      confirmPendingClose,
      cancelPendingClose,
      selectTab,
      selectRelativeTab,
      selectTabAtIndex,
      moveTab,
    ],
  )
}

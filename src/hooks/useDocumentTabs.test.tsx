import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useDocumentTabs } from './useDocumentTabs'
import { DEFAULT_DIAGRAM_CODE, parseTabsState, tabTitle } from '../utils/documentTabs'

const TABS_STORAGE_KEY = 'mermalaid-tabs'
const LEGACY_DRAFT_KEY = 'mermalaid-draft'

/** Persistence is debounced, so tests advance timers instead of waiting 500ms. */
function flushPersist() {
  act(() => {
    vi.advanceTimersByTime(1000)
  })
}

describe('useDocumentTabs', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('starts with one untitled tab on a fresh install', () => {
    const { result } = renderHook(() => useDocumentTabs())
    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.activeTab.code).toBe(DEFAULT_DIAGRAM_CODE)
  })

  it('migrates the pre-tabs single draft into the first tab', () => {
    localStorage.setItem(LEGACY_DRAFT_KEY, 'graph TD\n  legacy')
    const { result } = renderHook(() => useDocumentTabs())
    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.activeTab.code).toBe('graph TD\n  legacy')
  })

  it('persists every open tab and restores them on the next mount', () => {
    const first = renderHook(() => useDocumentTabs())
    act(() => {
      first.result.current.openDocument({ path: '/docs/a.mmd', code: 'graph TD\n  A' })
    })
    act(() => {
      first.result.current.newTab()
    })
    act(() => {
      first.result.current.setActiveCode('graph TD\n  scratch')
    })
    flushPersist()

    const stored = parseTabsState(localStorage.getItem(TABS_STORAGE_KEY))
    expect(stored?.tabs).toHaveLength(2)
    // The legacy key keeps pointing at the focused diagram for older builds.
    expect(localStorage.getItem(LEGACY_DRAFT_KEY)).toBe('graph TD\n  scratch')

    first.unmount()
    const second = renderHook(() => useDocumentTabs())
    expect(second.result.current.tabs.map((tab) => tabTitle(tab))).toEqual([
      'a.mmd',
      'Untitled 1',
    ])
    expect(second.result.current.activeTab.code).toBe('graph TD\n  scratch')
  })

  it('edits, saves and switches only the focused tab', () => {
    const { result } = renderHook(() => useDocumentTabs())
    act(() => {
      result.current.openDocument({ path: '/docs/a.mmd', code: 'graph TD\n  A' })
    })
    act(() => {
      result.current.openDocument({ path: '/docs/b.mmd', code: 'graph TD\n  B' })
    })
    act(() => {
      result.current.setActiveCode('graph TD\n  B edited')
    })

    expect(result.current.tabs[0].code).toBe('graph TD\n  A')
    expect(result.current.activePathRef.current).toBe('/docs/b.mmd')

    act(() => {
      result.current.markActiveSaved('graph TD\n  B edited')
    })
    expect(result.current.activeTab.code).toBe(result.current.activeTab.savedCode)

    const firstId = result.current.tabs[0].id
    act(() => {
      result.current.selectTab(firstId)
    })
    expect(result.current.activeTab.code).toBe('graph TD\n  A')
    expect(result.current.activePathRef.current).toBe('/docs/a.mmd')
  })

  it('keeps a per-tab block selection', () => {
    const { result } = renderHook(() => useDocumentTabs())
    act(() => {
      result.current.setActiveSelectedBlockIndex(2)
    })
    const firstId = result.current.activeId
    act(() => {
      result.current.newTab()
    })
    expect(result.current.activeTab.selectedBlockIndex).toBe(0)

    act(() => {
      result.current.selectTab(firstId)
    })
    expect(result.current.activeTab.selectedBlockIndex).toBe(2)
  })

  /** Two tabs, the focused one holding unsaved work. */
  function withUnsavedActiveTab() {
    const { result } = renderHook(() => useDocumentTabs())
    act(() => {
      result.current.openDocument({ path: '/docs/a.mmd', code: 'graph TD\n  A' })
    })
    act(() => {
      result.current.newTab()
    })
    act(() => {
      result.current.setActiveCode('graph TD\n  unsaved work')
    })
    return result
  }

  it('waits for an answer before closing a tab with unsaved changes', () => {
    const result = withUnsavedActiveTab()

    act(() => {
      result.current.closeActiveTab()
    })
    // Nothing is closed while the question is outstanding.
    expect(result.current.pendingCloseTab?.code).toBe('graph TD\n  unsaved work')
    expect(result.current.tabs).toHaveLength(2)
  })

  it('keeps the tab when the close is cancelled', () => {
    const result = withUnsavedActiveTab()
    const activeId = result.current.activeId

    act(() => {
      result.current.closeActiveTab()
    })
    act(() => {
      result.current.cancelPendingClose()
    })

    expect(result.current.pendingCloseTab).toBeNull()
    expect(result.current.tabs).toHaveLength(2)
    expect(result.current.activeId).toBe(activeId)
    expect(result.current.activeTab.code).toBe('graph TD\n  unsaved work')
  })

  it('closes the tab once the close is confirmed', () => {
    const result = withUnsavedActiveTab()

    act(() => {
      result.current.closeActiveTab()
    })
    act(() => {
      result.current.confirmPendingClose()
    })

    expect(result.current.pendingCloseTab).toBeNull()
    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.activeTab.path).toBe('/docs/a.mmd')
  })

  it('closes a saved tab without asking', () => {
    const { result } = renderHook(() => useDocumentTabs())
    act(() => {
      result.current.openDocument({ path: '/docs/a.mmd', code: 'graph TD\n  A' })
    })
    act(() => {
      result.current.openDocument({ path: '/docs/b.mmd', code: 'graph TD\n  B' })
    })
    act(() => {
      result.current.closeTab(result.current.tabs[0].id)
    })
    expect(result.current.pendingCloseTab).toBeNull()
    expect(result.current.tabs).toHaveLength(1)
  })

  it('steps through tabs and selects by index, wrapping at the ends', () => {
    const { result } = renderHook(() => useDocumentTabs())
    act(() => {
      result.current.newTab()
    })
    act(() => {
      result.current.newTab()
    })
    const ids = result.current.tabs.map((tab) => tab.id)

    act(() => {
      result.current.selectRelativeTab(1)
    })
    expect(result.current.activeId).toBe(ids[0])

    act(() => {
      result.current.selectRelativeTab(-1)
    })
    expect(result.current.activeId).toBe(ids[2])

    act(() => {
      result.current.selectTabAtIndex(1)
    })
    expect(result.current.activeId).toBe(ids[1])
  })

  it('survives blocked storage', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })

    const { result } = renderHook(() => useDocumentTabs())
    expect(result.current.tabs).toHaveLength(1)
    act(() => {
      result.current.setActiveCode('graph TD\n  A')
    })
    flushPersist()
    expect(result.current.activeTab.code).toBe('graph TD\n  A')

    getItem.mockRestore()
    setItem.mockRestore()
  })
})

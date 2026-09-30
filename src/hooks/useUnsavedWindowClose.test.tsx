import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { DiagramTab } from '../utils/documentTabs'

const showToast = vi.fn()
const destroy = vi.fn().mockResolvedValue(undefined)
const writeTextFile = vi.fn().mockResolvedValue(undefined)
const save = vi.fn().mockResolvedValue('/picked/Untitled 2.mmd')

/** Set by the close-requested mock so tests can fire the event the OS would send. */
let closeRequestedHandler: ((event: { preventDefault: () => void }) => unknown) | null = null

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    destroy,
    // Mirrors Tauri: the handler is awaited, then the window is destroyed unless prevented.
    onCloseRequested: async (handler: (event: { preventDefault: () => void }) => unknown) => {
      closeRequestedHandler = handler
      return () => {
        closeRequestedHandler = null
      }
    },
  }),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: (...args: unknown[]) => save(...args) }))
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: (...args: unknown[]) => writeTextFile(...args),
}))
vi.mock('./useToast', () => ({ useToast: () => ({ showToast }) }))

const { useUnsavedWindowClose, formatUnsavedTabList } = await import('./useUnsavedWindowClose')

function tab(overrides: Partial<DiagramTab>): DiagramTab {
  return {
    id: 'id',
    path: null,
    name: 'Untitled 1',
    code: 'graph TD',
    savedCode: 'graph TD',
    selectedBlockIndex: 0,
    ...overrides,
  }
}

/** Fire the OS close request and report whether the window would have been destroyed. */
async function requestClose(): Promise<{ prevented: boolean }> {
  let prevented = false
  await act(async () => {
    await closeRequestedHandler?.({
      preventDefault: () => {
        prevented = true
      },
    })
  })
  if (!prevented) await destroy()
  return { prevented }
}

function renderGuard(unsavedTabs: DiagramTab[], onTabSaved = vi.fn()) {
  const view = renderHook(({ tabs }) => useUnsavedWindowClose({ unsavedTabs: tabs, onTabSaved }), {
    initialProps: { tabs: unsavedTabs },
  })
  return { ...view, onTabSaved }
}

describe('useUnsavedWindowClose', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    save.mockResolvedValue('/picked/Untitled 2.mmd')
    writeTextFile.mockResolvedValue(undefined)
    destroy.mockResolvedValue(undefined)
  })

  afterEach(() => {
    closeRequestedHandler = null
  })

  it('lets the window close when nothing is unsaved', async () => {
    const { result } = renderGuard([])
    await waitFor(() => expect(closeRequestedHandler).not.toBeNull())

    const { prevented } = await requestClose()
    expect(prevented).toBe(false)
    expect(destroy).toHaveBeenCalled()
    expect(result.current.isAsking).toBe(false)
  })

  it('holds the window open and asks when a tab is unsaved', async () => {
    const { result } = renderGuard([tab({ id: '1', code: 'new', savedCode: 'old' })])
    await waitFor(() => expect(closeRequestedHandler).not.toBeNull())

    const { prevented } = await requestClose()
    expect(prevented).toBe(true)
    expect(destroy).not.toHaveBeenCalled()
    expect(result.current.isAsking).toBe(true)
  })

  it('keeps the window open when the close is cancelled', async () => {
    const { result } = renderGuard([tab({ id: '1', code: 'new', savedCode: 'old' })])
    await waitFor(() => expect(closeRequestedHandler).not.toBeNull())
    await requestClose()

    act(() => {
      result.current.cancelClose()
    })

    expect(result.current.isAsking).toBe(false)
    expect(destroy).not.toHaveBeenCalled()
    expect(writeTextFile).not.toHaveBeenCalled()
  })

  it('closes without writing anything when the changes are discarded', async () => {
    const { result } = renderGuard([tab({ id: '1', code: 'new', savedCode: 'old' })])
    await waitFor(() => expect(closeRequestedHandler).not.toBeNull())
    await requestClose()

    await act(async () => {
      result.current.closeWithoutSaving()
    })

    expect(writeTextFile).not.toHaveBeenCalled()
    expect(destroy).toHaveBeenCalled()
  })

  it('saves every unsaved tab, then closes', async () => {
    const onTabSaved = vi.fn()
    const { result } = renderGuard(
      [
        tab({ id: '1', path: '/a.mmd', code: 'new a', savedCode: 'old' }),
        tab({ id: '2', name: 'Untitled 2', code: 'new b', savedCode: 'old' }),
      ],
      onTabSaved,
    )
    await waitFor(() => expect(closeRequestedHandler).not.toBeNull())
    await requestClose()

    await act(async () => {
      result.current.saveAllAndClose()
    })

    await waitFor(() => expect(destroy).toHaveBeenCalled())
    expect(writeTextFile).toHaveBeenCalledWith('/a.mmd', 'new a')
    expect(writeTextFile).toHaveBeenCalledWith('/picked/Untitled 2.mmd', 'new b')
    expect(onTabSaved).toHaveBeenCalledTimes(2)
    expect(onTabSaved).toHaveBeenCalledWith({ id: '2', content: 'new b', path: '/picked/Untitled 2.mmd' })
  })

  it('abandons the close when the save location picker is cancelled', async () => {
    save.mockResolvedValue(null)
    const { result } = renderGuard([tab({ id: '1', name: 'Untitled 2', code: 'new', savedCode: 'old' })])
    await waitFor(() => expect(closeRequestedHandler).not.toBeNull())
    await requestClose()

    await act(async () => {
      result.current.saveAllAndClose()
    })

    await waitFor(() => expect(result.current.isAsking).toBe(false))
    expect(destroy).not.toHaveBeenCalled()
    expect(result.current.isSaving).toBe(false)
  })

  it('keeps asking when a write fails, so nothing is lost', async () => {
    writeTextFile.mockRejectedValue(new Error('disk full'))
    const { result } = renderGuard([tab({ id: '1', path: '/a.mmd', code: 'new', savedCode: 'old' })])
    await waitFor(() => expect(closeRequestedHandler).not.toBeNull())
    await requestClose()

    await act(async () => {
      result.current.saveAllAndClose()
    })

    await waitFor(() => expect(result.current.isSaving).toBe(false))
    expect(destroy).not.toHaveBeenCalled()
    expect(result.current.isAsking).toBe(true)
    expect(showToast).toHaveBeenCalledWith('Could not save a.mmd.', 'error')
  })

  it('reads the latest tabs, not the ones open when the guard was attached', async () => {
    const { result, rerender } = renderGuard([])
    await waitFor(() => expect(closeRequestedHandler).not.toBeNull())

    rerender({ tabs: [tab({ id: '1', code: 'new', savedCode: 'old' })] })
    const { prevented } = await requestClose()

    expect(prevented).toBe(true)
    expect(result.current.isAsking).toBe(true)
  })

  it('lists unsaved documents for the dialog', () => {
    expect(formatUnsavedTabList([])).toBe('')
    expect(formatUnsavedTabList([tab({ path: '/a.mmd' })])).toBe('a.mmd')
    expect(
      formatUnsavedTabList([tab({ path: '/a.mmd' }), tab({ name: 'Untitled 2' }), tab({ path: '/c.mmd' })]),
    ).toBe('a.mmd, Untitled 2 and c.mmd')
  })
})

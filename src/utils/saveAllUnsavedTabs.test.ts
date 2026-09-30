import { describe, expect, it, vi } from 'vitest'
import { createInitialState, openDocument, updateActiveTab, type DiagramTab } from './documentTabs'
import {
  getUnsavedTabs,
  saveAllUnsavedTabs,
  suggestedFileNameForTab,
  type SaveAllTabsIo,
} from './saveAllUnsavedTabs'

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

function io(overrides: Partial<SaveAllTabsIo> = {}): SaveAllTabsIo {
  return {
    writeFile: vi.fn().mockResolvedValue(undefined),
    chooseSavePath: vi.fn().mockResolvedValue('/chosen/path.mmd'),
    ...overrides,
  }
}

describe('saveAllUnsavedTabs', () => {
  it('lists only the tabs whose content differs from disk', () => {
    let state = createInitialState()
    state = openDocument(state, { path: '/a.mmd', code: 'graph TD' })
    state = updateActiveTab(state, { code: 'graph TD\n  edited' })
    expect(getUnsavedTabs(state.tabs).map((t) => t.path)).toEqual(['/a.mmd'])
  })

  it('writes tabs that already have a path without asking for one', async () => {
    const fs = io()
    const result = await saveAllUnsavedTabs(
      [tab({ id: '1', path: '/a.mmd', code: 'new', savedCode: 'old' })],
      fs,
    )

    expect(fs.chooseSavePath).not.toHaveBeenCalled()
    expect(fs.writeFile).toHaveBeenCalledWith('/a.mmd', 'new')
    expect(result).toEqual({
      outcome: 'saved',
      saved: [{ id: '1', content: 'new', path: '/a.mmd' }],
    })
  })

  it('asks where to put a tab that has never been saved', async () => {
    const fs = io({ chooseSavePath: vi.fn().mockResolvedValue('/picked/Untitled 2.mmd') })
    const result = await saveAllUnsavedTabs(
      [tab({ id: '1', name: 'Untitled 2', code: 'new', savedCode: 'old' })],
      fs,
    )

    expect(fs.chooseSavePath).toHaveBeenCalledWith('Untitled 2.mmd')
    expect(result.saved).toEqual([{ id: '1', content: 'new', path: '/picked/Untitled 2.mmd' }])
  })

  it('skips tabs that are already saved', async () => {
    const fs = io()
    const result = await saveAllUnsavedTabs([tab({ code: 'same', savedCode: 'same' })], fs)
    expect(fs.writeFile).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: 'saved', saved: [] })
  })

  it('stops at a cancelled location picker and reports what was already written', async () => {
    const fs = io({ chooseSavePath: vi.fn().mockResolvedValue(null) })
    const result = await saveAllUnsavedTabs(
      [
        tab({ id: '1', path: '/a.mmd', code: 'new', savedCode: 'old' }),
        tab({ id: '2', name: 'Untitled 2', code: 'new', savedCode: 'old' }),
        tab({ id: '3', path: '/c.mmd', code: 'new', savedCode: 'old' }),
      ],
      fs,
    )

    expect(result.outcome).toBe('cancelled')
    expect(result.saved.map((r) => r.id)).toEqual(['1'])
    // The tab after the cancelled one is left alone.
    expect(fs.writeFile).toHaveBeenCalledTimes(1)
  })

  it('stops at a failed write and names the tab that failed', async () => {
    const boom = new Error('disk full')
    const fs = io({
      writeFile: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(boom),
    })
    const result = await saveAllUnsavedTabs(
      [
        tab({ id: '1', path: '/a.mmd', code: 'new', savedCode: 'old' }),
        tab({ id: '2', path: '/b/second.mmd', code: 'new', savedCode: 'old' }),
        tab({ id: '3', path: '/c.mmd', code: 'new', savedCode: 'old' }),
      ],
      fs,
    )

    expect(result).toMatchObject({
      outcome: 'error',
      failedTitle: 'second.mmd',
      error: boom,
    })
    expect(result.saved.map((r) => r.id)).toEqual(['1'])
    expect(fs.writeFile).toHaveBeenCalledTimes(2)
  })

  it('suggests a file name, keeping one the tab already has', () => {
    expect(suggestedFileNameForTab(tab({ name: 'Untitled 3' }))).toBe('Untitled 3.mmd')
    expect(suggestedFileNameForTab(tab({ name: 'notes.md' }))).toBe('notes.md')
    expect(suggestedFileNameForTab(tab({ path: '/x/flow.mmd', name: 'ignored' }))).toBe('flow.mmd')
  })
})

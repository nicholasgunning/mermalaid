import { describe, expect, it } from 'vitest'
import {
  activateRelativeTab,
  activateTab,
  activateTabAtIndex,
  addTab,
  closeTab,
  createInitialState,
  DEFAULT_DIAGRAM_CODE,
  EMPTY_DIAGRAM_CODE,
  getActiveTab,
  isTabDirty,
  moveTab,
  NEW_DIAGRAM_CODE,
  nextUntitledName,
  openDocument,
  parseTabsState,
  serializeTabsState,
  tabTitle,
  updateActiveTab,
  type DiagramTabsState,
} from './documentTabs'

/** Two saved files plus an edited scratch tab — the shape most rules below care about. */
function threeTabs(): DiagramTabsState {
  let state = createInitialState()
  state = openDocument(state, { path: '/docs/a.mmd', code: 'graph TD\n  A-->B' })
  state = openDocument(state, { path: '/docs/b.mmd', code: 'graph TD\n  C-->D' })
  state = addTab(state)
  return updateActiveTab(state, { code: 'graph TD\n  edited' })
}

describe('documentTabs', () => {
  it('starts with a single untitled tab holding the default diagram', () => {
    const state = createInitialState()
    expect(state.tabs).toHaveLength(1)
    expect(state.activeId).toBe(state.tabs[0].id)
    expect(state.tabs[0].code).toBe(DEFAULT_DIAGRAM_CODE)
    expect(tabTitle(state.tabs[0])).toBe('Untitled 1')
    expect(isTabDirty(state.tabs[0])).toBe(false)
  })

  it('titles a tab by its file name once it has a path', () => {
    const state = openDocument(createInitialState(), {
      path: '/Users/me/diagrams/flow.mmd',
      code: 'graph TD',
    })
    expect(tabTitle(state.tabs[0])).toBe('flow.mmd')
  })

  it('marks a tab unsaved only while its code differs from disk', () => {
    let state = openDocument(createInitialState(), { path: '/a.mmd', code: 'graph TD' })
    expect(isTabDirty(getActiveTab(state))).toBe(false)

    state = updateActiveTab(state, { code: 'graph LR' })
    expect(isTabDirty(getActiveTab(state))).toBe(true)

    state = updateActiveTab(state, { savedCode: 'graph LR' })
    expect(isTabDirty(getActiveTab(state))).toBe(false)
  })

  it('takes over a lone untouched tab instead of leaving it empty', () => {
    const state = openDocument(createInitialState(), { path: '/a.mmd', code: 'graph TD' })
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0].path).toBe('/a.mmd')
  })

  it('keeps an edited tab and appends the opened document next to it', () => {
    const edited = updateActiveTab(createInitialState(), { code: 'graph TD\n  mine' })
    const state = openDocument(edited, { path: '/a.mmd', code: 'graph TD' })
    expect(state.tabs).toHaveLength(2)
    expect(state.activeId).toBe(state.tabs[1].id)
    expect(state.tabs[0].code).toBe('graph TD\n  mine')
  })

  it('focuses and refreshes the existing tab when the same path is opened twice', () => {
    let state = openDocument(createInitialState(), { path: '/a.mmd', code: 'graph TD' })
    state = openDocument(state, { path: '/b.mmd', code: 'graph LR' })
    expect(state.tabs).toHaveLength(2)

    state = openDocument(state, { path: '/a.mmd', code: 'graph TD\n  fresh' })
    expect(state.tabs).toHaveLength(2)
    expect(state.activeId).toBe(state.tabs[0].id)
    expect(state.tabs[0].code).toBe('graph TD\n  fresh')
    expect(isTabDirty(state.tabs[0])).toBe(false)
  })

  it('names pathless documents, reusing numbers freed by closed tabs', () => {
    let state = createInitialState()
    state = addTab(state)
    state = addTab(state)
    expect(state.tabs.map((tab) => tab.name)).toEqual(['Untitled 1', 'Untitled 2', 'Untitled 3'])

    state = closeTab(state, state.tabs[1].id)
    expect(nextUntitledName(state.tabs)).toBe('Untitled 2')
  })

  it('opens a new tab empty and focuses it, so the tab can be filled either way', () => {
    const state = addTab(createInitialState())
    expect(state.tabs).toHaveLength(2)
    expect(getActiveTab(state).code).toBe(EMPTY_DIAGRAM_CODE)
    expect(isTabDirty(getActiveTab(state))).toBe(false)
  })

  it('fills the focused empty tab instead of opening another one', () => {
    let state = openDocument(createInitialState(), { path: '/a.mmd', code: 'graph TD\n  A' })
    state = addTab(state)
    const emptyTabId = state.activeId

    state = openDocument(state, { path: '/b.mmd', code: 'graph TD\n  B' })

    expect(state.tabs).toHaveLength(2)
    expect(state.activeId).toBe(emptyTabId)
    expect(getActiveTab(state).path).toBe('/b.mmd')
    // The other tab is untouched.
    expect(state.tabs[0].path).toBe('/a.mmd')
  })

  it('keeps the empty tab’s own name when what it is filled with has none', () => {
    let state = addTab(createInitialState())
    expect(getActiveTab(state).name).toBe('Untitled 2')

    state = openDocument(state, { code: NEW_DIAGRAM_CODE })
    expect(getActiveTab(state).name).toBe('Untitled 2')
    expect(getActiveTab(state).code).toBe(NEW_DIAGRAM_CODE)
    // A starter diagram is not unsaved work.
    expect(isTabDirty(getActiveTab(state))).toBe(false)
  })

  it('leaves an empty tab alone when it is not the focused one', () => {
    // The focused tab has work in it, so the open cannot take it over either.
    let state = updateActiveTab(createInitialState(), { code: 'graph TD\n  mine' })
    state = addTab(state)
    const emptyTabId = state.activeId
    state = activateTab(state, state.tabs[0].id)

    state = openDocument(state, { path: '/b.mmd', code: 'graph TD\n  B' })

    expect(state.tabs).toHaveLength(3)
    expect(state.tabs.find((tab) => tab.id === emptyTabId)?.code).toBe(EMPTY_DIAGRAM_CODE)
  })

  it('focuses the right-hand neighbour when the active tab closes', () => {
    const state = threeTabs()
    const middle = activateTab(state, state.tabs[1].id)

    const next = closeTab(middle, middle.activeId)
    expect(next.tabs).toHaveLength(2)
    expect(next.activeId).toBe(state.tabs[2].id)
  })

  it('falls back to the left-hand neighbour when the last tab closes', () => {
    const state = threeTabs()
    const next = closeTab(state, state.tabs[2].id)
    expect(next.tabs).toHaveLength(2)
    expect(next.activeId).toBe(state.tabs[1].id)
  })

  it('leaves the focus alone when a background tab closes', () => {
    const state = threeTabs()
    const next = closeTab(state, state.tabs[0].id)
    expect(next.activeId).toBe(state.activeId)
  })

  it('never leaves the workspace without a tab', () => {
    const state = createInitialState()
    const next = closeTab(state, state.tabs[0].id)
    expect(next.tabs).toHaveLength(1)
    expect(next.tabs[0].code).toBe(EMPTY_DIAGRAM_CODE)
    expect(next.activeId).toBe(next.tabs[0].id)
  })

  it('ignores closing or activating an unknown tab', () => {
    const state = threeTabs()
    expect(closeTab(state, 'nope')).toBe(state)
    expect(activateTab(state, 'nope')).toBe(state)
  })

  it('wraps around when stepping through tabs', () => {
    const state = threeTabs()
    const first = activateTab(state, state.tabs[0].id)
    expect(activateRelativeTab(first, -1).activeId).toBe(state.tabs[2].id)
    expect(activateRelativeTab(first, 1).activeId).toBe(state.tabs[1].id)
    expect(activateRelativeTab(activateTab(state, state.tabs[2].id), 1).activeId).toBe(
      state.tabs[0].id,
    )
  })

  it('selects by index and clamps past the end to the last tab', () => {
    const state = threeTabs()
    expect(activateTabAtIndex(state, 1).activeId).toBe(state.tabs[1].id)
    expect(activateTabAtIndex(state, 99).activeId).toBe(state.tabs[2].id)
    expect(activateTabAtIndex(state, -1)).toBe(state)
  })

  it('moves a tab to another position without changing which one is focused', () => {
    const state = threeTabs()
    const [a, b, c] = state.tabs

    const toFront = moveTab(state, c.id, 0)
    expect(toFront.tabs.map((tab) => tab.id)).toEqual([c.id, a.id, b.id])
    expect(toFront.activeId).toBe(state.activeId)

    expect(moveTab(state, a.id, 1).tabs.map((tab) => tab.id)).toEqual([b.id, a.id, c.id])
  })

  it('clamps out-of-range moves and ignores no-ops', () => {
    const state = threeTabs()
    const [a, , c] = state.tabs

    expect(moveTab(state, a.id, 99).tabs.map((tab) => tab.id)).toEqual([
      state.tabs[1].id,
      c.id,
      a.id,
    ])
    expect(moveTab(state, c.id, -5).tabs[0].id).toBe(c.id)
    expect(moveTab(state, a.id, 0)).toBe(state)
    expect(moveTab(state, 'nope', 0)).toBe(state)
  })

  it('round-trips the workspace through storage', () => {
    const state = threeTabs()
    const restored = parseTabsState(serializeTabsState(state))
    expect(restored).toEqual(state)
    expect(restored && isTabDirty(getActiveTab(restored))).toBe(true)
  })

  it('restores nothing from a missing, malformed, or empty payload', () => {
    expect(parseTabsState(null)).toBeNull()
    expect(parseTabsState('not json')).toBeNull()
    expect(parseTabsState('{"v":1}')).toBeNull()
    expect(parseTabsState('{"v":1,"tabs":[]}')).toBeNull()
    expect(parseTabsState('{"v":1,"tabs":[{"id":"x"}]}')).toBeNull()
  })

  it('fills in defaults for partially written tabs and a stale active id', () => {
    const restored = parseTabsState(
      '{"v":1,"activeId":"gone","tabs":[{"id":"x","name":"Untitled 1","code":"graph TD","path":null}]}',
    )
    expect(restored).not.toBeNull()
    expect(restored?.activeId).toBe('x')
    expect(restored?.tabs[0].savedCode).toBe('graph TD')
    expect(restored?.tabs[0].selectedBlockIndex).toBe(0)
  })
})

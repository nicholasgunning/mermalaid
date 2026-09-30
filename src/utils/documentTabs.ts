/**
 * Tab model for working on several `.mmd` documents at once (GitHub #113).
 *
 * Kept free of React so the open/close/focus rules and the persisted shape can be unit-tested
 * on their own. {@link ../hooks/useDocumentTabs.ts} owns the state and the localStorage writes.
 */
import { recentFileLabel } from './recentFiles'

/** First diagram a brand-new install sees. */
export const DEFAULT_DIAGRAM_CODE =
  'graph TD\n    A[Start] --> B{Decision}\n    B -->|Yes| C[Action 1]\n    B -->|No| D[Action 2]\n    C --> E[End]\n    D --> E'

/** Starter diagram offered by the empty tab's "New diagram" action. */
export const NEW_DIAGRAM_CODE = 'graph TD\n    A[Start] --> B[End]'

/**
 * A new tab opens empty rather than pre-filled: the tab is a workspace, and the user chooses
 * whether it holds a new diagram or an existing file (see {@link ../components/TabStartScreen}).
 */
export const EMPTY_DIAGRAM_CODE = ''

/** Templates a tab may still hold and count as untouched, so Open can reuse it. */
const TEMPLATE_CODES = [DEFAULT_DIAGRAM_CODE, NEW_DIAGRAM_CODE, '']

export interface DiagramTab {
  id: string
  /** Absolute filesystem path (desktop) — null for tabs that have never been saved to disk. */
  path: string | null
  /** Display name used while there is no path (browser file picker, share links, Untitled N). */
  name: string
  code: string
  /**
   * Content as last read from or written to disk, or the seed for a tab with no file.
   * `code !== savedCode` is what marks a tab unsaved.
   */
  savedCode: string
  /** Which ```mermaid block of a multi-block document this tab is focused on. */
  selectedBlockIndex: number
}

export interface DiagramTabsState {
  tabs: DiagramTab[]
  activeId: string
}

export interface OpenDocumentInput {
  code: string
  /** Desktop path, when the document came from the filesystem. */
  path?: string | null
  /** Label for pathless documents; ignored when `path` is set. */
  name?: string
  /** Defaults to `code` — pass the disk content when it differs (it rarely does). */
  savedCode?: string
}

let tabIdCounter = 0

export function createTabId(): string {
  tabIdCounter += 1
  return `tab-${Date.now().toString(36)}-${tabIdCounter}`
}

/** Label shown on the tab: the file name once saved, the assigned name until then. */
export function tabTitle(tab: DiagramTab): string {
  return tab.path ? recentFileLabel(tab.path) : tab.name
}

export function isTabDirty(tab: DiagramTab): boolean {
  return tab.code !== tab.savedCode
}

/** `Untitled 1`, then the lowest free number — reusing gaps left by closed tabs. */
export function nextUntitledName(tabs: DiagramTab[]): string {
  const taken = new Set(
    tabs
      .map((tab) => /^Untitled (\d+)$/.exec(tab.name)?.[1])
      .filter((n): n is string => Boolean(n))
      .map((n) => Number.parseInt(n, 10)),
  )
  let n = 1
  while (taken.has(n)) n += 1
  return `Untitled ${n}`
}

export function createTab(input: OpenDocumentInput & { name: string }): DiagramTab {
  return {
    id: createTabId(),
    path: input.path ?? null,
    name: input.name,
    code: input.code,
    savedCode: input.savedCode ?? input.code,
    selectedBlockIndex: 0,
  }
}

export function createInitialState(code: string = DEFAULT_DIAGRAM_CODE): DiagramTabsState {
  const tab = createTab({ code, name: 'Untitled 1' })
  return { tabs: [tab], activeId: tab.id }
}

export function getActiveTab(state: DiagramTabsState): DiagramTab {
  return state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0]
}

/**
 * A single tab still holding a template with nothing typed into it: Open and share links take it
 * over instead of leaving an empty tab behind (matches how code editors treat a scratch tab).
 */
function isPristine(tab: DiagramTab): boolean {
  return !tab.path && !isTabDirty(tab) && TEMPLATE_CODES.includes(tab.code)
}

/**
 * Focus the tab already showing `path` (refreshing it from disk), reuse a lone pristine tab,
 * or append a new tab — in that order.
 */
export function openDocument(state: DiagramTabsState, input: OpenDocumentInput): DiagramTabsState {
  const savedCode = input.savedCode ?? input.code

  if (input.path) {
    const existing = state.tabs.find((tab) => tab.path === input.path)
    if (existing) {
      return {
        tabs: state.tabs.map((tab) =>
          tab.id === existing.id ? { ...tab, code: input.code, savedCode } : tab,
        ),
        activeId: existing.id,
      }
    }
  }

  // Opening into an untouched tab fills that tab — it is the workspace the user is looking at —
  // instead of leaving an empty one behind.
  const active = state.tabs.find((tab) => tab.id === state.activeId)
  const reusable = active && isPristine(active) ? active : null
  const name =
    input.name ??
    (input.path ? recentFileLabel(input.path) : (reusable?.name ?? nextUntitledName(state.tabs)))

  if (reusable) {
    const replaced: DiagramTab = {
      ...reusable,
      path: input.path ?? null,
      name,
      code: input.code,
      savedCode,
      selectedBlockIndex: 0,
    }
    return {
      tabs: state.tabs.map((tab) => (tab.id === reusable.id ? replaced : tab)),
      activeId: replaced.id,
    }
  }

  const tab = createTab({ ...input, name })
  return { tabs: [...state.tabs, tab], activeId: tab.id }
}

/** New empty document, always appended and focused. */
export function addTab(
  state: DiagramTabsState,
  code: string = EMPTY_DIAGRAM_CODE,
): DiagramTabsState {
  const tab = createTab({ code, name: nextUntitledName(state.tabs) })
  return { tabs: [...state.tabs, tab], activeId: tab.id }
}

/** Closing the last tab leaves a fresh empty one — the workspace is never tabless. */
export function closeTab(state: DiagramTabsState, id: string): DiagramTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id)
  if (index === -1) return state

  const tabs = state.tabs.filter((tab) => tab.id !== id)
  if (tabs.length === 0) return createInitialState(EMPTY_DIAGRAM_CODE)
  if (state.activeId !== id) return { tabs, activeId: state.activeId }

  // Focus the neighbour to the right, falling back to the one on the left.
  const next = tabs[Math.min(index, tabs.length - 1)]
  return { tabs, activeId: next.id }
}

export function activateTab(state: DiagramTabsState, id: string): DiagramTabsState {
  if (!state.tabs.some((tab) => tab.id === id)) return state
  return { ...state, activeId: id }
}

/** Wraps around, so Next Tab on the last tab returns to the first. */
export function activateRelativeTab(state: DiagramTabsState, delta: number): DiagramTabsState {
  if (state.tabs.length < 2) return state
  const index = state.tabs.findIndex((tab) => tab.id === state.activeId)
  const from = index === -1 ? 0 : index
  const count = state.tabs.length
  const next = (((from + delta) % count) + count) % count
  return { ...state, activeId: state.tabs[next].id }
}

/** Zero-based; an index past the end selects the last tab (⌘9 = last, as in browsers). */
export function activateTabAtIndex(state: DiagramTabsState, index: number): DiagramTabsState {
  if (index < 0 || state.tabs.length === 0) return state
  const tab = state.tabs[Math.min(index, state.tabs.length - 1)]
  return { ...state, activeId: tab.id }
}

export function updateTab(
  state: DiagramTabsState,
  id: string,
  patch: Partial<Omit<DiagramTab, 'id'>>,
): DiagramTabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
  }
}

export function updateActiveTab(
  state: DiagramTabsState,
  patch: Partial<Omit<DiagramTab, 'id'>>,
): DiagramTabsState {
  return updateTab(state, state.activeId, patch)
}

const STORED_VERSION = 1

interface StoredTabsState {
  v: number
  activeId: string
  tabs: DiagramTab[]
}

export function serializeTabsState(state: DiagramTabsState): string {
  const stored: StoredTabsState = {
    v: STORED_VERSION,
    activeId: state.activeId,
    tabs: state.tabs,
  }
  return JSON.stringify(stored)
}

function isStoredTab(value: unknown): value is DiagramTab {
  if (!value || typeof value !== 'object') return false
  const tab = value as Record<string, unknown>
  return (
    typeof tab.id === 'string' &&
    tab.id.length > 0 &&
    typeof tab.code === 'string' &&
    typeof tab.name === 'string' &&
    (tab.path === null || typeof tab.path === 'string')
  )
}

/** Tolerant of anything but a well-formed payload: a bad value restores nothing rather than throwing. */
export function parseTabsState(raw: string | null): DiagramTabsState | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const stored = parsed as Record<string, unknown>
  if (!Array.isArray(stored.tabs)) return null

  const tabs = stored.tabs.filter(isStoredTab).map((tab) => ({
    id: tab.id,
    path: tab.path ?? null,
    name: tab.name,
    code: tab.code,
    savedCode: typeof tab.savedCode === 'string' ? tab.savedCode : tab.code,
    selectedBlockIndex:
      typeof tab.selectedBlockIndex === 'number' && tab.selectedBlockIndex >= 0
        ? tab.selectedBlockIndex
        : 0,
  }))
  if (tabs.length === 0) return null

  const activeId =
    typeof stored.activeId === 'string' && tabs.some((tab) => tab.id === stored.activeId)
      ? stored.activeId
      : tabs[0].id
  return { tabs, activeId }
}

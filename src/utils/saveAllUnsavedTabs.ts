/**
 * Writing every unsaved tab to disk, used when the window is closed with work in progress.
 *
 * The filesystem and dialog calls are injected so the sequencing rules — stop at the first
 * cancelled Save As, stop at the first failed write, never silently skip a tab — can be tested
 * without Tauri.
 */
import { isTabDirty, tabTitle, type DiagramTab } from './documentTabs'

export interface SaveAllTabsIo {
  writeFile: (path: string, content: string) => Promise<void>
  /** Native Save As for a tab with no path yet; resolves to null when the user cancels. */
  chooseSavePath: (suggestedName: string) => Promise<string | null>
}

export interface SavedTabRecord {
  id: string
  content: string
  path: string
}

export type SaveAllUnsavedResult =
  | { outcome: 'saved'; saved: SavedTabRecord[] }
  | { outcome: 'cancelled'; saved: SavedTabRecord[] }
  | { outcome: 'error'; saved: SavedTabRecord[]; failedTitle: string; error: unknown }

const DIAGRAM_EXTENSION = /\.(mmd|txt|md|markdown)$/i

/** `Untitled 2` → `Untitled 2.mmd`; a name that already carries an extension is kept as is. */
export function suggestedFileNameForTab(tab: DiagramTab): string {
  const name = tabTitle(tab)
  return DIAGRAM_EXTENSION.test(name) ? name : `${name}.mmd`
}

export function getUnsavedTabs(tabs: DiagramTab[]): DiagramTab[] {
  return tabs.filter(isTabDirty)
}

/**
 * Saves each unsaved tab in order. Tabs that already have a path are written straight back;
 * the rest ask for a location first. Stops at the first cancellation or failure and reports
 * what had already been written, so the caller can record those tabs as saved.
 */
export async function saveAllUnsavedTabs(
  tabs: DiagramTab[],
  io: SaveAllTabsIo,
): Promise<SaveAllUnsavedResult> {
  const saved: SavedTabRecord[] = []

  for (const tab of getUnsavedTabs(tabs)) {
    let path = tab.path
    if (!path) {
      try {
        path = await io.chooseSavePath(suggestedFileNameForTab(tab))
      } catch (error) {
        return { outcome: 'error', saved, failedTitle: tabTitle(tab), error }
      }
      if (!path) return { outcome: 'cancelled', saved }
    }

    // Capture the content now: it is what `savedCode` must become for this tab.
    const content = tab.code
    try {
      await io.writeFile(path, content)
    } catch (error) {
      return { outcome: 'error', saved, failedTitle: tabTitle(tab), error }
    }
    saved.push({ id: tab.id, content, path })
  }

  return { outcome: 'saved', saved }
}

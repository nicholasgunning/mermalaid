import { useCallback, useEffect, useRef, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { save } from '@tauri-apps/plugin-dialog'
import { writeTextFile } from '@tauri-apps/plugin-fs'
import { useMountEffect } from './useMountEffect'
import { useToast } from './useToast'
import { DIAGRAM_FILE_EXTENSIONS } from '../utils/diagramImportFiles'
import { tabTitle, type DiagramTab } from '../utils/documentTabs'
import {
  saveAllUnsavedTabs,
  type SaveAllTabsIo,
  type SavedTabRecord,
} from '../utils/saveAllUnsavedTabs'

interface UseUnsavedWindowCloseParams {
  /** Tabs whose content is not on disk; the window only asks when this is non-empty. */
  unsavedTabs: DiagramTab[]
  /** Called for each tab written to disk, so its unsaved marker and path can be updated. */
  onTabSaved: (record: SavedTabRecord) => void
}

export interface UnsavedWindowCloseApi {
  /** True while the window is held open waiting for an answer. */
  isAsking: boolean
  isSaving: boolean
  saveAllAndClose: () => void
  closeWithoutSaving: () => void
  cancelClose: () => void
}

const SAVE_DIALOG_FILTERS = [
  { name: 'Mermaid / Text', extensions: [...DIAGRAM_FILE_EXTENSIONS] },
]

function tauriSaveIo(): SaveAllTabsIo {
  return {
    writeFile: (path, content) => writeTextFile(path, content),
    chooseSavePath: async (suggestedName) => {
      const path = await save({ defaultPath: suggestedName, filters: SAVE_DIALOG_FILTERS })
      return typeof path === 'string' && path.length > 0 ? path : null
    },
  }
}

/**
 * Desktop-only: hold the window open when it is closed with unsaved diagrams.
 *
 * Tauri's `onCloseRequested` destroys the window once its handler resolves unless the event is
 * prevented, so the answer has to be given here rather than by the OS. Closing the window is not
 * the same as closing a tab — every unsaved tab is at stake, not just the focused one.
 */
export function useUnsavedWindowClose({
  unsavedTabs,
  onTabSaved,
}: UseUnsavedWindowCloseParams): UnsavedWindowCloseApi {
  const { showToast } = useToast()
  const [isAsking, setIsAsking] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const unsavedRef = useRef(unsavedTabs)
  const onTabSavedRef = useRef(onTabSaved)
  const showToastRef = useRef(showToast)

  useEffect(() => {
    unsavedRef.current = unsavedTabs
  }, [unsavedTabs])
  useEffect(() => {
    onTabSavedRef.current = onTabSaved
  }, [onTabSaved])
  useEffect(() => {
    showToastRef.current = showToast
  }, [showToast])

  useMountEffect(() => {
    if (!isTauri()) return

    let unlisten: (() => void) | undefined
    let cancelled = false

    void getCurrentWindow()
      .onCloseRequested((event) => {
        // Returning without preventing lets Tauri destroy the window as usual.
        if (unsavedRef.current.length === 0) return
        event.preventDefault()
        setIsAsking(true)
      })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch((err) => {
        // Without the guard the window closes as it did before — never block closing on this.
        console.error('Window close guard failed to attach:', err)
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  })

  const destroyWindow = useCallback(async () => {
    try {
      await getCurrentWindow().destroy()
    } catch (err) {
      console.error('Could not close the window:', err)
      showToastRef.current('Could not close the window.', 'error')
      setIsSaving(false)
    }
  }, [])

  const closeWithoutSaving = useCallback(() => {
    void destroyWindow()
  }, [destroyWindow])

  const cancelClose = useCallback(() => {
    setIsAsking(false)
  }, [])

  const saveAllAndClose = useCallback(() => {
    setIsSaving(true)
    void (async () => {
      const result = await saveAllUnsavedTabs(unsavedRef.current, tauriSaveIo())
      // Record what reached disk even when a later tab cancelled or failed.
      for (const record of result.saved) {
        onTabSavedRef.current(record)
      }

      if (result.outcome === 'saved') {
        await destroyWindow()
        return
      }

      setIsSaving(false)
      if (result.outcome === 'error') {
        console.error('Save all before closing failed:', result.error)
        // Keep the question open: the user still has to choose what to do with the rest.
        showToastRef.current(`Could not save ${result.failedTitle}.`, 'error')
      } else {
        // Cancelling the location picker cancels the close, so nothing is lost.
        setIsAsking(false)
      }
    })()
  }, [destroyWindow])

  return { isAsking, isSaving, saveAllAndClose, closeWithoutSaving, cancelClose }
}

/** "a.mmd, Untitled 2 and diagram.mmd" */
export function formatUnsavedTabList(tabs: DiagramTab[]): string {
  const titles = tabs.map(tabTitle)
  if (titles.length <= 1) return titles.join('')
  return `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`
}

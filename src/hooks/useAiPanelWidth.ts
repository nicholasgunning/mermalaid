import { useEffect, useState } from 'react'
import { MIN_EDITOR_WIDTH_PX, MIN_PREVIEW_WIDTH_PX, viewportWidth } from './useEditorWidth'

/** Persisted width of the docked AI assistant column. */
const STORAGE_KEY = 'mermalaid-ai-panel-width'

/** Delay before a width change is written to storage — avoids a disk write on every drag frame. */
const PERSIST_DEBOUNCE_MS = 200

/** Narrow enough to sit beside a diagram, wide enough for a conversation to be readable. */
export const MIN_AI_PANEL_WIDTH_PX = 300
export const DEFAULT_AI_PANEL_WIDTH_PX = 380

/** The assistant never takes so much room that the editor/preview split stops working. */
export const MIN_WORKSPACE_WIDTH_PX = MIN_EDITOR_WIDTH_PX + MIN_PREVIEW_WIDTH_PX

export function getMaxAiPanelWidth(containerWidth: number): number {
  return Math.max(MIN_AI_PANEL_WIDTH_PX, containerWidth - MIN_WORKSPACE_WIDTH_PX)
}

export function clampAiPanelWidth(width: number, containerWidth: number): number {
  return Math.min(Math.max(width, MIN_AI_PANEL_WIDTH_PX), getMaxAiPanelWidth(containerWidth))
}

/**
 * The user's preferred width for the assistant column, persisted to localStorage.
 *
 * Like {@link ./useEditorWidth.ts}, this is the *desired* width and is never clamped here —
 * consumers clamp against the live container, so a wide panel comes back when the window grows
 * rather than being permanently shrunk by one narrow moment.
 */
export function useAiPanelWidth() {
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = Number.parseInt(localStorage.getItem(STORAGE_KEY) ?? '', 10)
      if (Number.isFinite(saved) && saved > 0) return saved
    } catch {}
    // A third of the window, so the panel is proportionate on a wide display.
    return Math.max(DEFAULT_AI_PANEL_WIDTH_PX, Math.round(viewportWidth() / 3))
  })

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, String(Math.round(width)))
      } catch {}
    }, PERSIST_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [width])

  return [width, setWidth] as const
}

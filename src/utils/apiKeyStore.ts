/**
 * Per-provider API key storage, kept in this browser only.
 *
 * Mermalaid has no account system, so a key is read out of localStorage and used directly. That is
 * the trade the AI features make: no account, no key of ours — but anything that can run script on
 * this origin can read it, which is why the settings panel says so and why a key is never written
 * to a diagram, a share link or a log.
 *
 * Writes are announced to subscribers, so the chat panel notices a key added in the settings dialog
 * over it without being told, and notices one added in another tab.
 */
export interface ApiKeyStore {
  get: () => string | null
  /** False when the browser refused the write — a private window, or site data blocked. */
  set: (value: string) => boolean
  clear: () => void
  /** Calls `listener` on every change here or in another tab; returns the unsubscribe function. */
  subscribe: (listener: (value: string | null) => void) => () => void
}

type Listener = (value: string | null) => void

const listenersByKey = new Map<string, Set<Listener>>()
let crossTabWatcherAttached = false

function notify(storageKey: string): void {
  const listeners = listenersByKey.get(storageKey)
  if (!listeners?.size) return
  const value = readStoredValue(storageKey)
  for (const listener of listeners) listener(value)
}

function readStoredValue(storageKey: string): string | null {
  try {
    const stored = localStorage.getItem(storageKey)
    return stored && stored.trim() ? stored.trim() : null
  } catch {
    return null
  }
}

function attachCrossTabWatcher(): void {
  if (crossTabWatcherAttached || typeof window === 'undefined') return
  // `storage` only fires for *other* tabs, which is why same-tab writes notify explicitly.
  window.addEventListener('storage', (event) => {
    if (event.key === null) {
      for (const storageKey of listenersByKey.keys()) notify(storageKey)
    } else if (listenersByKey.has(event.key)) {
      notify(event.key)
    }
  })
  crossTabWatcherAttached = true
}

export function createApiKeyStore(storageKey: string, label: string): ApiKeyStore {
  return {
    get: () => readStoredValue(storageKey),

    set(value) {
      const trimmed = value.trim()
      try {
        localStorage.setItem(storageKey, trimmed)
        return readStoredValue(storageKey) === trimmed
      } catch (err) {
        console.error(`Could not save the ${label} API key:`, err)
        return false
      } finally {
        notify(storageKey)
      }
    },

    clear() {
      try {
        localStorage.removeItem(storageKey)
      } catch {
        /* ignore blocked storage */
      } finally {
        notify(storageKey)
      }
    },

    subscribe(listener) {
      const listeners = listenersByKey.get(storageKey) ?? new Set<Listener>()
      listeners.add(listener)
      listenersByKey.set(storageKey, listeners)
      attachCrossTabWatcher()
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

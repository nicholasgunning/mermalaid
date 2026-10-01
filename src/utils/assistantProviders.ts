/**
 * Which backend answers the diagram assistant.
 *
 * A provider is available when its key is stored; when both are, the preferred one wins. The
 * preference is stored rather than asked for every time, so the panel can show which backend is
 * answering and the user can switch without clearing a key.
 */
import { anthropicAssistantProvider } from './anthropicAssistant'
import { icaAssistantProvider } from './icaAssistant'
import { getStoredAnthropicKey, subscribeToAnthropicKey } from './anthropicKey'
import { getStoredIcaKey, subscribeToIcaKey } from './icaKey'
import type { AssistantProvider, AssistantProviderId } from './diagramAssistant'

const PREFERRED_PROVIDER_STORAGE_KEY = 'assistant-provider'

interface ProviderEntry {
  provider: AssistantProvider
  getKey: () => string | null
}

/** In preference order, so the first configured one answers when nothing has been chosen. */
const PROVIDERS: ProviderEntry[] = [
  { provider: anthropicAssistantProvider, getKey: getStoredAnthropicKey },
  { provider: icaAssistantProvider, getKey: getStoredIcaKey },
]

export interface ConfiguredProvider {
  provider: AssistantProvider
  apiKey: string
}

export function getAssistantProvider(id: AssistantProviderId): AssistantProvider {
  const entry = PROVIDERS.find((candidate) => candidate.provider.id === id)
  return entry?.provider ?? anthropicAssistantProvider
}

/** Every provider the user has a key for. */
export function listConfiguredProviders(): AssistantProvider[] {
  return PROVIDERS.filter((entry) => entry.getKey() !== null).map((entry) => entry.provider)
}

export function getPreferredProviderId(): AssistantProviderId | null {
  try {
    const stored = localStorage.getItem(PREFERRED_PROVIDER_STORAGE_KEY)
    return PROVIDERS.some((entry) => entry.provider.id === stored)
      ? (stored as AssistantProviderId)
      : null
  } catch {
    return null
  }
}

export function setPreferredProviderId(id: AssistantProviderId): void {
  try {
    localStorage.setItem(PREFERRED_PROVIDER_STORAGE_KEY, id)
  } catch {
    /* ignore blocked storage */
  }
  for (const listener of listeners) listener()
}

/**
 * The provider that will answer the next message: the preferred one when it has a key, otherwise
 * the first one that does, or null when none is configured.
 */
export function resolveAssistantProvider(): ConfiguredProvider | null {
  const preferredId = getPreferredProviderId()
  const ordered = preferredId
    ? [...PROVIDERS].sort((a, b) =>
        a.provider.id === preferredId ? -1 : b.provider.id === preferredId ? 1 : 0,
      )
    : PROVIDERS

  for (const entry of ordered) {
    const apiKey = entry.getKey()
    if (apiKey) return { provider: entry.provider, apiKey }
  }
  return null
}

const listeners = new Set<() => void>()

/** Fires when a key changes or the preference does, i.e. when the answering provider may differ. */
export function subscribeToAssistantProviders(listener: () => void): () => void {
  listeners.add(listener)
  const unsubscribes = [subscribeToAnthropicKey(listener), subscribeToIcaKey(listener)]
  return () => {
    listeners.delete(listener)
    for (const unsubscribe of unsubscribes) unsubscribe()
  }
}

/**
 * The user's own Anthropic API key. Stored and watched by {@link ./apiKeyStore.ts}; the request
 * goes straight from this page to api.anthropic.com, with no Mermalaid server in between.
 */
import { createApiKeyStore } from './apiKeyStore'

const store = createApiKeyStore('anthropic-api-key', 'Anthropic')

export const getStoredAnthropicKey = store.get
export const storeAnthropicKey = store.set
export const clearAnthropicKey = store.clear
export const subscribeToAnthropicKey = store.subscribe

/**
 * Shape check only — whether the key works is for the API to say.
 *
 * It catches the common paste mistakes (an OpenAI key, a truncated copy) before a request is spent
 * on them.
 */
export function isLikelyAnthropicKey(apiKey: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{16,}$/.test(apiKey.trim())
}

/**
 * The user's own IBM Consulting Advantage key, plus which model it should talk to.
 *
 * Issued from the ICA UI under Settings → API Keys → ICA APIs. Unlike the Anthropic key this one
 * cannot be used from the page directly — the ICA API sends no CORS headers — so it travels to
 * IBM through this deployment's `/api/ica` route. It is still the user's own key, stored here only.
 */
import { createApiKeyStore } from './apiKeyStore'
import { DEFAULT_ICA_MODEL, DEFAULT_ICA_NAMESPACE, isIcaNamespace, type IcaModelChoice } from './icaModel'

export { DEFAULT_ICA_MODEL } from './icaModel'

const store = createApiKeyStore('ica-api-key', 'IBM ICA')

export const getStoredIcaKey = store.get
export const storeIcaKey = store.set
export const clearIcaKey = store.clear
export const subscribeToIcaKey = store.subscribe

const ICA_MODEL_STORAGE_KEY = 'ica-model-choice'


/**
 * Shape check only. ICA issues OpenAI-style `sk-` keys (the docs call them "an OpenAI-style bearer
 * token"), so this only rules out something that is clearly not a key at all.
 */
export function isLikelyIcaKey(apiKey: string): boolean {
  return /^sk-[A-Za-z0-9_-]{16,}$/.test(apiKey.trim())
}

/** The namespace and model the assistant should use, or null until one has been chosen. */
export function getStoredIcaModel(): IcaModelChoice | null {
  try {
    const raw = localStorage.getItem(ICA_MODEL_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { namespace?: unknown; model?: unknown }
    if (typeof parsed.model !== 'string' || !parsed.model) return null
    return {
      namespace: isIcaNamespace(parsed.namespace) ? parsed.namespace : DEFAULT_ICA_NAMESPACE,
      model: parsed.model,
    }
  } catch {
    return null
  }
}

/** The choice that will actually be used: the user's pick, or {@link DEFAULT_ICA_MODEL}. */
export function resolveIcaModel(): IcaModelChoice {
  return getStoredIcaModel() ?? DEFAULT_ICA_MODEL
}

export function storeIcaModel(choice: IcaModelChoice): void {
  try {
    localStorage.setItem(ICA_MODEL_STORAGE_KEY, JSON.stringify(choice))
  } catch (err) {
    console.error('Could not save the ICA model choice:', err)
  }
}

export function clearIcaModel(): void {
  try {
    localStorage.removeItem(ICA_MODEL_STORAGE_KEY)
  } catch {
    /* ignore blocked storage */
  }
}

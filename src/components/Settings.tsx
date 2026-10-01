import { useEffect, useState, type ReactNode } from 'react'
import { useTheme } from '../hooks/useTheme'
import { isAppThemeDark } from '../utils/mermaidThemes'
import { getStoredApiKey, storeApiKey, clearApiKey } from '../utils/aiErrorFixer'
import {
  clearAnthropicKey,
  getStoredAnthropicKey,
  isLikelyAnthropicKey,
  storeAnthropicKey,
} from '../utils/anthropicKey'
import {
  clearIcaKey,
  clearIcaModel,
  DEFAULT_ICA_MODEL,
  getStoredIcaKey,
  isLikelyIcaKey,
  resolveIcaModel,
  storeIcaKey,
  storeIcaModel,
} from '../utils/icaKey'
import {
  DEFAULT_ICA_NAMESPACE,
  describeIcaError,
  ICA_NAMESPACES,
  listIcaModels,
  type IcaModelSummary,
  type IcaNamespace,
} from '../utils/icaAssistant'
import {
  getPreferredProviderId,
  listConfiguredProviders,
  setPreferredProviderId,
} from '../utils/assistantProviders'
import type { AssistantProviderId } from '../utils/diagramAssistant'
import './Settings.css'

interface SettingsProps {
  isOpen: boolean
  onClose: () => void
}

/** Whether what is in the field is what is in storage, so the user never has to wonder. */
type KeyStatus = 'empty' | 'saved' | 'blocked'

interface ApiKeyFieldProps {
  id: string
  label: string
  placeholder: string
  value: string
  status: KeyStatus
  onChange: (value: string) => void
  onClear: () => void
  /** Shown under the field when the typed key is not shaped like one of this provider's. */
  warning?: string | null
  children: ReactNode
}

const KEY_STATUS_TEXT: Record<KeyStatus, string | null> = {
  empty: null,
  saved: 'Saved in this browser — it will be here next time.',
  blocked:
    'This browser would not store the key (private window, or site data is blocked), so it will be gone when you reload.',
}

const ICA_NAMESPACE_LABELS: Record<IcaNamespace, string> = {
  'chat-models': 'Chat models',
  agents: 'Agents',
  assistants: 'Assistants',
  'digital-workforce': 'Digital workforce',
}

function ApiKeyField({
  id,
  label,
  placeholder,
  value,
  status,
  onChange,
  onClear,
  warning,
  children,
}: ApiKeyFieldProps) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="settings-field">
      <label htmlFor={id}>{label}</label>
      <div className="api-key-row">
        <div className="api-key-input-wrapper">
          <input
            id={id}
            type={visible ? 'text' : 'password'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className="api-key-input"
          />
          <button
            type="button"
            onClick={() => setVisible(!visible)}
            className="toggle-visibility"
            title={visible ? 'Hide' : 'Show'}
            aria-label={visible ? `Hide ${label}` : `Show ${label}`}
          >
            {visible ? '👁️' : '👁️‍🗨️'}
          </button>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="button-secondary api-key-clear"
          disabled={!value}
        >
          Clear
        </button>
      </div>
      {warning && <p className="settings-warning">{warning}</p>}
      {KEY_STATUS_TEXT[status] && (
        <p className={status === 'blocked' ? 'settings-warning' : 'settings-saved'} role="status">
          {status === 'saved' ? '✓ ' : ''}
          {KEY_STATUS_TEXT[status]}
        </p>
      )}
      <p className="settings-hint">{children}</p>
    </div>
  )
}

/** Writes the OpenAI key through the same contract as the others: false if it did not land. */
function persistOpenAiKey(apiKey: string): boolean {
  try {
    if (apiKey) storeApiKey(apiKey)
    else clearApiKey()
    return !apiKey || getStoredApiKey() === apiKey
  } catch (err) {
    console.error('Could not save the OpenAI API key:', err)
    return false
  }
}

export default function Settings({ isOpen, onClose }: SettingsProps) {
  const { mermaidTheme } = useTheme()
  const [openAiKey, setOpenAiKey] = useState('')
  const [anthropicKey, setAnthropicKey] = useState('')
  const [icaKey, setIcaKey] = useState('')
  const [openAiStatus, setOpenAiStatus] = useState<KeyStatus>('empty')
  const [anthropicStatus, setAnthropicStatus] = useState<KeyStatus>('empty')
  const [icaStatus, setIcaStatus] = useState<KeyStatus>('empty')

  const [icaNamespace, setIcaNamespace] = useState<IcaNamespace>(DEFAULT_ICA_NAMESPACE)
  const [icaModel, setIcaModel] = useState('')
  const [icaModels, setIcaModels] = useState<IcaModelSummary[]>([])
  const [icaLoading, setIcaLoading] = useState(false)
  const [icaError, setIcaError] = useState<string | null>(null)

  const [preferredProvider, setPreferredProvider] = useState<AssistantProviderId | null>(null)
  const [configured, setConfigured] = useState(listConfiguredProviders)

  useEffect(() => {
    if (!isOpen) return
    const openAi = getStoredApiKey() || ''
    const anthropic = getStoredAnthropicKey() || ''
    const ica = getStoredIcaKey() || ''
    setOpenAiKey(openAi)
    setAnthropicKey(anthropic)
    setIcaKey(ica)
    setOpenAiStatus(openAi ? 'saved' : 'empty')
    setAnthropicStatus(anthropic ? 'saved' : 'empty')
    setIcaStatus(ica ? 'saved' : 'empty')

    // The resolved choice, so the field shows the default rather than looking unconfigured.
    const choice = resolveIcaModel()
    setIcaNamespace(choice.namespace)
    setIcaModel(choice.model)
    setIcaModels([])
    setIcaError(null)
    setPreferredProvider(getPreferredProviderId())
    setConfigured(listConfiguredProviders())
  }, [isOpen])

  /**
   * Keys are written as they are typed rather than on a Save button.
   *
   * A key is not a setting you tweak, it is a credential you paste once — and a dialog that
   * discards it when closed any way other than Save means pasting it again every session. An empty
   * field clears that provider's key.
   */
  const updateAnthropicKey = (value: string) => {
    setAnthropicKey(value)
    const trimmed = value.trim()
    if (!trimmed) {
      clearAnthropicKey()
      setAnthropicStatus('empty')
    } else {
      setAnthropicStatus(storeAnthropicKey(trimmed) ? 'saved' : 'blocked')
    }
    setConfigured(listConfiguredProviders())
  }

  const updateIcaKey = (value: string) => {
    setIcaKey(value)
    const trimmed = value.trim()
    if (!trimmed) {
      clearIcaKey()
      setIcaStatus('empty')
    } else {
      setIcaStatus(storeIcaKey(trimmed) ? 'saved' : 'blocked')
    }
    setConfigured(listConfiguredProviders())
  }

  const updateOpenAiKey = (value: string) => {
    setOpenAiKey(value)
    const trimmed = value.trim()
    if (!trimmed) {
      persistOpenAiKey('')
      setOpenAiStatus('empty')
      return
    }
    setOpenAiStatus(persistOpenAiKey(trimmed) ? 'saved' : 'blocked')
  }

  const chooseIcaModel = (model: string) => {
    setIcaModel(model)
    if (model) storeIcaModel({ namespace: icaNamespace, model })
    else clearIcaModel()
  }

  const chooseIcaNamespace = (namespace: IcaNamespace) => {
    setIcaNamespace(namespace)
    setIcaModels([])
    // Model ids differ per namespace, so the previous pick cannot carry over — except back to the
    // default namespace, where the default model applies again.
    const model = namespace === DEFAULT_ICA_MODEL.namespace ? DEFAULT_ICA_MODEL.model : ''
    setIcaModel(model)
    if (model) storeIcaModel({ namespace, model })
    else clearIcaModel()
  }

  const loadIcaModels = () => {
    const apiKey = getStoredIcaKey()
    if (!apiKey) {
      setIcaError('Add your ICA API key first.')
      return
    }
    setIcaLoading(true)
    setIcaError(null)
    void listIcaModels(apiKey, icaNamespace)
      .then((models) => {
        setIcaModels(models)
        if (models.length === 0) setIcaError('That namespace returned no models for this key.')
      })
      .catch((err) => setIcaError(describeIcaError(err)))
      .finally(() => setIcaLoading(false))
  }

  const choosePreferredProvider = (id: AssistantProviderId) => {
    setPreferredProvider(id)
    setPreferredProviderId(id)
  }

  if (!isOpen) return null

  const anthropicWarning =
    anthropicKey.trim() && !isLikelyAnthropicKey(anthropicKey)
      ? 'Anthropic keys start with “sk-ant-”. Double-check this one.'
      : null
  const icaWarning =
    icaKey.trim() && !isLikelyIcaKey(icaKey)
      ? 'ICA developer keys are OpenAI-style tokens starting with “sk-”. Double-check this one.'
      : null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={`settings-modal ${isAppThemeDark(mermaidTheme) ? 'dark' : 'light'}`} onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="close-button" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>

        <div className="settings-content">
          <div className="settings-section">
            <h3>AI Assistant</h3>
            <p className="settings-description">
              Chat about the diagram you are working on and let it propose changes, which you approve
              before anything is applied. Add a key for whichever service you want to use — keys are
              stored in this browser only, and anyone with access to this browser profile can read
              them, so use keys you can revoke.
            </p>

            {configured.length > 1 && (
              <div className="settings-field">
                <label htmlFor="assistant-provider">Assistant uses</label>
                <select
                  id="assistant-provider"
                  className="settings-select settings-select-block"
                  value={preferredProvider ?? configured[0].id}
                  onChange={(e) => choosePreferredProvider(e.target.value as AssistantProviderId)}
                >
                  {configured.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <ApiKeyField
              id="anthropic-api-key"
              label="Anthropic API Key"
              placeholder="sk-ant-..."
              value={anthropicKey}
              status={anthropicStatus}
              onChange={updateAnthropicKey}
              onClear={() => updateAnthropicKey('')}
              warning={anthropicWarning}
            >
              Sent straight from this page to Anthropic. Get a key from{' '}
              <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">
                console.anthropic.com
              </a>
            </ApiKeyField>

            <ApiKeyField
              id="ica-api-key"
              label="IBM Consulting Advantage API Key"
              placeholder="sk-..."
              value={icaKey}
              status={icaStatus}
              onChange={updateIcaKey}
              onClear={() => updateIcaKey('')}
              warning={icaWarning}
            >
              Issued in the ICA UI under Settings → API Keys → ICA APIs. The ICA API refuses browser
              calls, so requests go through this site’s own <code>/api/ica</code> route — which means
              ICA works only where the Mermalaid API routes are deployed, not on a static build.
            </ApiKeyField>

            {icaKey.trim() && (
              <div className="settings-field">
                <label htmlFor="ica-namespace">ICA model</label>
                <div className="settings-inline-row">
                  <select
                    id="ica-namespace"
                    className="settings-select"
                    value={icaNamespace}
                    onChange={(e) => chooseIcaNamespace(e.target.value as IcaNamespace)}
                    aria-label="ICA namespace"
                  >
                    {ICA_NAMESPACES.map((namespace) => (
                      <option key={namespace} value={namespace}>
                        {ICA_NAMESPACE_LABELS[namespace]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={loadIcaModels}
                    disabled={icaLoading}
                  >
                    {icaLoading ? 'Loading…' : 'Load models'}
                  </button>
                </div>

                {icaModels.length > 0 ? (
                  <select
                    className="settings-select settings-select-block"
                    value={icaModel}
                    onChange={(e) => chooseIcaModel(e.target.value)}
                    aria-label="ICA model"
                  >
                    <option value="">Choose a model…</option>
                    {icaModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="api-key-input settings-select-block"
                    value={icaModel}
                    onChange={(e) => chooseIcaModel(e.target.value)}
                    placeholder="Model or agent id"
                    aria-label="ICA model id"
                  />
                )}

                {icaError && <p className="settings-warning">{icaError}</p>}
                {icaModel && !icaError && (
                  <p className="settings-saved" role="status">
                    ✓ The assistant will use {icaModel}
                    {icaModel === DEFAULT_ICA_MODEL.model &&
                    icaNamespace === DEFAULT_ICA_MODEL.namespace
                      ? ' (the default)'
                      : ''}
                    .
                  </p>
                )}
                <p className="settings-hint">
                  Chat models are plain LLMs. Agents and assistants carry instructions of their own,
                  which can pull against the diagram-editing prompt.
                </p>
              </div>
            )}
          </div>

          <div className="settings-section">
            <h3>AI Error Fixer</h3>
            <p className="settings-description">
              Add your OpenAI API key to enable AI-powered error fixing. Your key is stored locally and never shared.
            </p>

            <ApiKeyField
              id="api-key"
              label="OpenAI API Key"
              placeholder="sk-..."
              value={openAiKey}
              status={openAiStatus}
              onChange={updateOpenAiKey}
              onClear={() => updateOpenAiKey('')}
            >
              Get your API key from{' '}
              <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">
                platform.openai.com
              </a>
            </ApiKeyField>
          </div>
        </div>

        <div className="settings-footer">
          <div>
            <button onClick={onClose} className="button-primary">
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

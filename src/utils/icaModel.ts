/**
 * Which IBM Consulting Advantage model the assistant talks to.
 *
 * These live apart from both the provider and the key store because each needs them: the provider
 * builds a URL from the namespace, the key store reads and defaults the choice. Importing them from
 * either one would make a cycle, and a cycle here leaves the default undefined at module-init time.
 */

/** The namespaces ICA exposes; all four share one request/response shape. */
export const ICA_NAMESPACES = ['chat-models', 'agents', 'assistants', 'digital-workforce'] as const
export type IcaNamespace = (typeof ICA_NAMESPACES)[number]

/** Plain models rather than preconfigured agents, which carry system prompts of their own. */
export const DEFAULT_ICA_NAMESPACE: IcaNamespace = 'chat-models'

export interface IcaModelChoice {
  namespace: IcaNamespace
  /** Model or agent id, as the listing returns it. */
  model: string
}

/**
 * What the assistant uses until the user picks something else.
 *
 * ICA lists it as "Claude Opus 5 [Global]" under chat-models — the same id Anthropic uses, reached
 * through IBM's deployment rather than Anthropic's, so the two providers stay separate paths.
 */
export const DEFAULT_ICA_MODEL: IcaModelChoice = {
  namespace: DEFAULT_ICA_NAMESPACE,
  model: 'claude-opus-5',
}

export function isIcaNamespace(value: unknown): value is IcaNamespace {
  return ICA_NAMESPACES.includes(value as IcaNamespace)
}

/**
 * What the diagram assistant is, independent of which API answers it.
 *
 * The prompt, the tool it changes diagrams with, and the shape of a conversation live here; the
 * wire format lives in a provider ({@link ./anthropicAssistant.ts}, {@link ./icaAssistant.ts}).
 * The assistant never writes to the document: asking for a change produces a proposal the UI shows,
 * and only the user's approval applies it. The answer goes back to the model on the next turn.
 */

export const UPDATE_DIAGRAM_TOOL_NAME = 'update_diagram'

/**
 * Stable across every turn, so providers that cache a prompt prefix keep hitting it; the diagram
 * itself is appended per turn as user content, never as an instruction.
 */
export const DIAGRAM_ASSISTANT_SYSTEM_PROMPT = `You are the diagram assistant inside Mermalaid, a Mermaid diagram editor. The user is looking at one diagram, and its current Mermaid source is included with every message.

How to work:
- To change the diagram, call the ${UPDATE_DIAGRAM_TOOL_NAME} tool with the complete new Mermaid source. The tool is the only way a change reaches the canvas: Mermaid you write in your reply is not applied, so never paste the diagram back as a code block.
- Every call is shown to the user as a proposal they approve or reject. Make one call per message, holding the whole diagram as it should end up.
- Change what was asked and leave the rest alone: keep the user's node ids, labels, direction, comments, formatting and any \`config:\` front matter unless the request is to change them.
- When a request is ambiguous enough that two readings give different diagrams, ask instead of guessing.
- Answer questions about the diagram without calling the tool.

Your replies appear in a narrow side panel next to the diagram. Keep them to a sentence or two of plain prose — no headings, no bullet lists, no restating the Mermaid you just proposed.`

export const UPDATE_DIAGRAM_TOOL_DESCRIPTION =
  'Propose a new version of the diagram the user is looking at. Pass the complete Mermaid source, not a patch. The user sees the change and approves or rejects it before it is applied.'

/** JSON Schema for the tool's arguments, in the form both providers accept. */
export const UPDATE_DIAGRAM_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    mermaid: {
      type: 'string',
      description:
        'The complete new Mermaid source, exactly as it should appear in the editor. No ``` fences.',
    },
    summary: {
      type: 'string',
      description: 'One short sentence naming the change, e.g. "Add a retry step after Validate".',
    },
  },
  required: ['mermaid', 'summary'],
  additionalProperties: false,
} as const

export interface DiagramContext {
  /** Source of the diagram being previewed (one ```mermaid block, or the whole document). */
  code: string
  /** Tab name, so the assistant can refer to the document the user sees. */
  documentName: string
  /** Current renderer error, when the diagram does not parse. */
  error: string | null
}

/** The diagram as the user currently has it, delimited so its own text cannot be read as framing. */
export function buildDiagramContextBlock({ code, documentName, error }: DiagramContext): string {
  const diagram = code.trim()
  const lines = [
    `Document: ${documentName}`,
    diagram
      ? `Current diagram source:\n<diagram>\n${diagram}\n</diagram>`
      : 'The document is empty — there is no diagram yet.',
  ]
  if (error) {
    lines.push(`Mermaid does not render this source. The renderer reports:\n<error>\n${error}\n</error>`)
  }
  return lines.join('\n\n')
}

export type EditDecision = 'applied' | 'rejected'

export interface ProposedDiagramEdit {
  /** The provider's id for the call, so the decision can be paired back to it. */
  callId: string
  mermaid: string
  summary: string
}

/**
 * One turn of the conversation, in the form the UI and both providers agree on.
 *
 * `raw` is the provider's own representation of an assistant turn. Replaying a turn verbatim is
 * safer than rebuilding one — it keeps whatever the provider expects back (reasoning blocks,
 * signatures, its own call ids) — so each provider stashes its turn here and reads it back.
 */
export interface AssistantTurn {
  role: 'user' | 'assistant'
  text: string
  /** On an assistant turn: the change it proposed. */
  edit?: ProposedDiagramEdit
  /** On a user turn: the answer to the proposal in the previous assistant turn. */
  decision?: { callId: string; decision: EditDecision }
  raw?: unknown
}

/** What the model is told became of a proposal, as the next turn's tool result. */
export function describeEditDecision(decision: EditDecision): string {
  return decision === 'applied'
    ? 'The user approved this change and it is now in the editor.'
    : 'The user rejected this change. The diagram is unchanged — do not propose it again unchanged.'
}

/** Tool arguments as the model produced them, validated before they are shown as a proposal. */
export function readEditArguments(
  input: unknown,
): { mermaid: string; summary: string } | null {
  const args = input as { mermaid?: unknown; summary?: unknown } | null
  if (typeof args?.mermaid !== 'string' || !args.mermaid.trim()) return null
  return {
    mermaid: args.mermaid.trim(),
    summary:
      typeof args.summary === 'string' && args.summary.trim()
        ? args.summary.trim()
        : 'Update the diagram',
  }
}

/** Tool arguments as a JSON string (how OpenAI-compatible APIs return them). */
export function parseEditArguments(json: string): { mermaid: string; summary: string } | null {
  try {
    // Always parsed, never string-matched: escaping differs between models.
    return readEditArguments(JSON.parse(json))
  } catch {
    return null
  }
}

/**
 * What the assistant is doing right now, so the panel can say so rather than showing a dead spinner.
 *
 * The phases are reported in the order a turn goes through them, but none of them is guaranteed: a
 * short answer never thinks, and only a turn that changes the diagram ever drafts one.
 */
export type AssistantPhase = 'waiting' | 'thinking' | 'replying' | 'drafting'

/** What the panel shows for each phase while a turn is in flight. */
export const ASSISTANT_PHASE_LABELS: Record<AssistantPhase, string> = {
  waiting: 'Sending…',
  thinking: 'Thinking…',
  replying: 'Replying…',
  drafting: 'Drafting the diagram…',
}

export interface AssistantRequest {
  apiKey: string
  /** The conversation so far, ending with the user turn to answer. */
  turns: AssistantTurn[]
  context: DiagramContext
  /** Called with each piece of prose as it arrives. */
  onTextDelta?: (delta: string) => void
  /**
   * Called with each piece of the model's reasoning as it arrives.
   *
   * Only what the API chooses to show: this is a summary of the reasoning, never the raw chain of
   * thought, and a provider whose models do not report one simply never calls this.
   */
  onThinkingDelta?: (delta: string) => void
  /** Called when the turn moves into a new phase, newest wins. */
  onPhase?: (phase: AssistantPhase) => void
  signal?: AbortSignal
}

export interface AssistantReply {
  text: string
  edit?: ProposedDiagramEdit
  /** The provider's own form of this turn, replayed verbatim on the next request. */
  raw?: unknown
}

/** One backend the assistant can run on. */
export interface AssistantProvider {
  id: AssistantProviderId
  label: string
  send: (request: AssistantRequest) => Promise<AssistantReply>
  /** Turns a thrown error into something worth showing the user. */
  describeError: (err: unknown) => string
}

export type AssistantProviderId = 'anthropic' | 'ica'

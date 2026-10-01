/**
 * The provider-neutral half of the assistant: the prompt, the diagram context, and reading the
 * tool arguments a model produced.
 */
import { describe, expect, it } from 'vitest'
import {
  buildDiagramContextBlock,
  describeEditDecision,
  DIAGRAM_ASSISTANT_SYSTEM_PROMPT,
  parseEditArguments,
  readEditArguments,
  UPDATE_DIAGRAM_TOOL_NAME,
  UPDATE_DIAGRAM_TOOL_SCHEMA,
} from './diagramAssistant'

const CONTEXT = { code: 'graph TD\n  A-->B', documentName: 'flow.mmd', error: null }

describe('diagramAssistant', () => {
  it('asks for the whole diagram and a summary, and nothing else', () => {
    expect(UPDATE_DIAGRAM_TOOL_SCHEMA.required).toEqual(['mermaid', 'summary'])
    expect(UPDATE_DIAGRAM_TOOL_SCHEMA.additionalProperties).toBe(false)
  })

  it('tells the assistant the tool is the only way a change reaches the canvas', () => {
    expect(DIAGRAM_ASSISTANT_SYSTEM_PROMPT).toContain(UPDATE_DIAGRAM_TOOL_NAME)
    expect(DIAGRAM_ASSISTANT_SYSTEM_PROMPT).toMatch(/approve|proposal/i)
  })

  describe('buildDiagramContextBlock', () => {
    it('names the document and delimits the diagram', () => {
      const block = buildDiagramContextBlock(CONTEXT)
      expect(block).toContain('Document: flow.mmd')
      expect(block).toContain('<diagram>\ngraph TD\n  A-->B\n</diagram>')
      expect(block).not.toContain('<error>')
    })

    it('passes the renderer error along, so the assistant can fix what it sees', () => {
      const block = buildDiagramContextBlock({ ...CONTEXT, error: 'Parse error on line 2' })
      expect(block).toContain('<error>\nParse error on line 2\n</error>')
    })

    it('says so when there is no diagram yet', () => {
      const block = buildDiagramContextBlock({ ...CONTEXT, code: '   ' })
      expect(block).toMatch(/empty/i)
      expect(block).not.toContain('<diagram>')
    })
  })

  describe('readEditArguments', () => {
    it('reads the proposed diagram and its summary', () => {
      expect(readEditArguments({ mermaid: 'graph TD\n  A-->C\n', summary: 'Point A at C' })).toEqual({
        mermaid: 'graph TD\n  A-->C',
        summary: 'Point A at C',
      })
    })

    it('falls back to a generic summary rather than losing the change', () => {
      expect(readEditArguments({ mermaid: 'graph TD', summary: '  ' })?.summary).toBe(
        'Update the diagram',
      )
    })

    it('rejects arguments with no diagram in them', () => {
      expect(readEditArguments({ mermaid: '   ', summary: 'nothing' })).toBeNull()
      expect(readEditArguments({ mermaid: 42, summary: 'wrong type' })).toBeNull()
      expect(readEditArguments(null)).toBeNull()
    })
  })

  describe('parseEditArguments', () => {
    it('parses the JSON string an OpenAI-compatible API returns', () => {
      expect(parseEditArguments('{"mermaid":"graph TD","summary":"s"}')).toEqual({
        mermaid: 'graph TD',
        summary: 's',
      })
    })

    it('survives a truncated or non-JSON payload', () => {
      expect(parseEditArguments('{"mermaid":"graph T')).toBeNull()
      expect(parseEditArguments('')).toBeNull()
    })
  })

  it('tells the model what became of its proposal', () => {
    expect(describeEditDecision('applied')).toMatch(/approved/i)
    expect(describeEditDecision('rejected')).toMatch(/rejected/i)
  })
})

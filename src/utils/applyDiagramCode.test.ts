import { describe, expect, it } from 'vitest'
import { applyDiagramCode } from './applyDiagramCode'
import { extractAllMermaidBlocks } from './mermaidCodeBlock'

const NEW_DIAGRAM = 'graph TD\n  A-->C'

describe('applyDiagramCode', () => {
  it('replaces the whole document when it is plain diagram source', () => {
    expect(applyDiagramCode('graph TD\n  A-->B', [], 0, NEW_DIAGRAM)).toBe(NEW_DIAGRAM)
  })

  it('replaces only the block being previewed, leaving the markdown around it', () => {
    const doc = '# Notes\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nmore\n\n```mermaid\ngraph LR\n  X-->Y\n```\n'
    const updated = applyDiagramCode(doc, extractAllMermaidBlocks(doc), 1, NEW_DIAGRAM)

    expect(updated).toContain('# Notes')
    expect(updated).toContain('graph TD\n  A-->B')
    expect(updated).toContain(NEW_DIAGRAM)
    expect(updated).not.toContain('X-->Y')
    expect(extractAllMermaidBlocks(updated)).toHaveLength(2)
  })

  it('keeps the block’s config front matter, which the new diagram source does not carry', () => {
    const doc = '```mermaid\n---\nconfig:\n  theme: forest\n---\ngraph TD\n  A-->B\n```\n'
    const updated = applyDiagramCode(doc, extractAllMermaidBlocks(doc), 0, NEW_DIAGRAM)

    expect(updated).toContain('theme: forest')
    expect(updated).toContain(NEW_DIAGRAM)
  })

  it('falls back to the new source when the selected block is out of range', () => {
    const doc = '```mermaid\ngraph TD\n  A-->B\n```'
    expect(applyDiagramCode(doc, extractAllMermaidBlocks(doc), 7, NEW_DIAGRAM)).toBe(NEW_DIAGRAM)
  })
})

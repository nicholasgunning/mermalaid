/**
 * Writing a new diagram back into the document it came from.
 *
 * The preview works on one diagram, but the document may be markdown holding several ```mermaid
 * blocks, and the block may carry a YAML `config:` header the edit must not drop. Both the visual
 * editor and the AI assistant write back through this, so an edit lands the same way whatever
 * produced it.
 */
import { replaceMermaidBlock, type MermaidBlock } from './mermaidCodeBlock'
import { replaceDiagramInBlock } from './mermaidYamlConfig'

export function applyDiagramCode(
  documentText: string,
  mermaidBlocks: MermaidBlock[],
  selectedBlockIndex: number,
  newDiagramCode: string,
): string {
  const block = mermaidBlocks[selectedBlockIndex]
  if (!block) return newDiagramCode
  return replaceMermaidBlock(documentText, block, replaceDiagramInBlock(block.code, newDiagramCode))
}

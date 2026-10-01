/**
 * Rendering one `mermaid` block to standalone SVG markup, away from the preview pane.
 *
 * Export All (HTML) and PDF export both need the same thing: a block's own `config:` front matter
 * honoured, the official renderer first, and beautiful-mermaid as the last resort so a diagram the
 * official engine rejects still lands in the file. That chain lived inside the toolbar's Export
 * All handler; it is shared from here now.
 */
import { renderMermaid } from 'beautiful-mermaid'
import { normalizeMermaidForBeautifulMermaid } from './normalizeMermaidForBeautifulMermaid'
import { renderOfficialMermaidPreview } from './officialMermaidPreview'
import {
  mapMermaidConfigToThemeOptions,
  parseMermaidConfigForOfficialRenderer,
  parseMermaidWithConfig,
  type BeautifulMermaidThemeOptions,
} from './mermaidYamlConfig'

export interface DiagramSvgRenderOptions {
  isDark: boolean
  /** Used unless the block carries its own `config:` front matter. */
  defaultThemeOptions: BeautifulMermaidThemeOptions | undefined
  /** Plain SVG `<text>` labels, for engines that cannot rasterize `<foreignObject>`. */
  plainTextLabels?: boolean
}

/**
 * SVG for `rawBlock` (diagram source, optionally with a YAML config header).
 *
 * Throws only when every renderer failed, so callers can report the block that could not be drawn.
 */
export async function renderDiagramSvgMarkup(
  rawBlock: string,
  { isDark, defaultThemeOptions, plainTextLabels }: DiagramSvgRenderOptions,
): Promise<string> {
  const { code: diagramCode, config: blockConfig } = parseMermaidWithConfig(rawBlock)
  const officialYamlConfig = parseMermaidConfigForOfficialRenderer(rawBlock)
  const themeOptions = blockConfig
    ? mapMermaidConfigToThemeOptions(blockConfig)
    : defaultThemeOptions
  const normalizedForCompat = normalizeMermaidForBeautifulMermaid(diagramCode)
  const renderOptions = plainTextLabels ? { plainTextLabels: true } : undefined

  try {
    return await renderOfficialMermaidPreview(
      diagramCode,
      isDark,
      themeOptions,
      officialYamlConfig,
      renderOptions,
    )
  } catch (primaryErr) {
    try {
      // Some dialects only parse after normalization; retry before giving up on the official engine.
      if (normalizedForCompat === diagramCode) throw primaryErr
      return await renderOfficialMermaidPreview(
        normalizedForCompat,
        isDark,
        themeOptions,
        officialYamlConfig,
        renderOptions,
      )
    } catch {
      return await renderMermaid(normalizedForCompat, themeOptions)
    }
  }
}

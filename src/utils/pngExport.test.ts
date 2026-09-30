import { describe, expect, it } from 'vitest'
import {
  clampScaleToCanvasLimits,
  DEFAULT_PNG_EXPORT_SCALE,
  getPngOutputSize,
  getSvgExportSize,
  isValidPngExportScale,
  PNG_EXPORT_SCALES,
  serializeSvgForExport,
} from './pngExport'

const SVG_NS = 'http://www.w3.org/2000/svg'

function makeSvg(attrs: Record<string, string>, inlineStyle = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  for (const [name, value] of Object.entries(attrs)) svg.setAttribute(name, value)
  if (inlineStyle) svg.setAttribute('style', inlineStyle)
  return svg
}

describe('pngExport', () => {
  describe('getSvgExportSize', () => {
    it('takes the diagram size from the viewBox, not the rendered box', () => {
      // The preview stretches the node to the pane and scales it with a CSS transform, so the
      // attributes and the measured rect both follow the zoom; the viewBox does not.
      const svg = makeSvg({ viewBox: '0 0 303.5 465.25', width: '100%', height: '100%' })
      expect(getSvgExportSize(svg)).toEqual({ width: 303.5, height: 465.25 })
    })

    it('accepts a comma separated viewBox', () => {
      expect(getSvgExportSize(makeSvg({ viewBox: '0,0,120,80' }))).toEqual({
        width: 120,
        height: 80,
      })
    })

    it('falls back to width and height when the viewBox is missing or unusable', () => {
      expect(getSvgExportSize(makeSvg({ width: '400', height: '250' }))).toEqual({
        width: 400,
        height: 250,
      })
      expect(
        getSvgExportSize(makeSvg({ viewBox: '0 0 0 0', width: '400', height: '250' })),
      ).toEqual({ width: 400, height: 250 })
      expect(
        getSvgExportSize(makeSvg({ viewBox: 'nonsense', width: '400', height: '250' })),
      ).toEqual({ width: 400, height: 250 })
    })

    it('returns null when there is no usable size at all', () => {
      expect(getSvgExportSize(makeSvg({}))).toBeNull()
      // "100%" must not be read as 100px, or the export collapses to a 100x100 thumbnail.
      expect(getSvgExportSize(makeSvg({ width: '100%', height: '100%' }))).toBeNull()
      expect(getSvgExportSize(makeSvg({ width: '20em', height: '30em' }))).toBeNull()
      expect(getSvgExportSize(makeSvg({ width: '400px', height: '250px' }))).toEqual({
        width: 400,
        height: 250,
      })
    })
  })

  describe('clampScaleToCanvasLimits', () => {
    it('leaves ordinary diagrams alone', () => {
      expect(clampScaleToCanvasLimits({ width: 800, height: 600 }, 4)).toBe(4)
      expect(clampScaleToCanvasLimits({ width: 303, height: 465 }, 1)).toBe(1)
    })

    it('caps a long diagram at the maximum canvas side', () => {
      // 5000px tall at 4x would be 20000px, past the 16384px limit.
      const scale = clampScaleToCanvasLimits({ width: 1000, height: 5000 }, 4)
      expect(scale).toBeCloseTo(16384 / 5000, 5)
      expect(5000 * scale).toBeLessThanOrEqual(16384)
    })

    it('caps a large diagram at the maximum canvas area', () => {
      const size = { width: 9000, height: 9000 }
      const scale = clampScaleToCanvasLimits(size, 3)
      expect(size.width * scale * size.height * scale).toBeLessThanOrEqual(268_435_456)
    })

    it('gives a wide diagram the most it can take rather than dropping to 1x', () => {
      const scale = clampScaleToCanvasLimits({ width: 16_000, height: 100 }, 4)
      expect(scale).toBeGreaterThanOrEqual(1)
      expect(16_000 * scale).toBeLessThanOrEqual(16_384)
    })

    it('goes under 1 only when the diagram itself is past the limit', () => {
      expect(clampScaleToCanvasLimits({ width: 32_768, height: 100 }, 2)).toBeCloseTo(0.5, 5)
    })
  })

  describe('getPngOutputSize', () => {
    it('multiplies the diagram size by the chosen resolution', () => {
      expect(getPngOutputSize({ width: 303.5, height: 465.25 }, 2)).toEqual({
        width: 607,
        height: 931,
      })
      expect(getPngOutputSize({ width: 303.5, height: 465.25 }, 4)).toEqual({
        width: 1214,
        height: 1861,
      })
    })

    it('reports the clamped size for a diagram that cannot be scaled that far', () => {
      const output = getPngOutputSize({ width: 1000, height: 5000 }, 4)
      expect(output.height).toBe(16_384)
      expect(output.width).toBeLessThan(4000)
    })
  })

  describe('serializeSvgForExport', () => {
    it('pins the copy to absolute pixels and drops the pane-driven sizing', () => {
      const svg = makeSvg(
        { viewBox: '0 0 300 450', width: '100%', height: '100%' },
        'max-width: 300px; width: 100%;',
      )
      const markup = serializeSvgForExport(svg, { width: 300, height: 450 })

      expect(markup).toContain('width="300"')
      expect(markup).toContain('height="450"')
      expect(markup).toContain('viewBox="0 0 300 450"')
      expect(markup).not.toContain('max-width')
      expect(markup).toContain('xmlns="http://www.w3.org/2000/svg"')
    })

    it('adds a viewBox when the diagram has none, so it scales instead of cropping', () => {
      const markup = serializeSvgForExport(makeSvg({ width: '120', height: '90' }), {
        width: 120,
        height: 90,
      })
      expect(markup).toContain('viewBox="0 0 120 90"')
    })

    it('keeps the diagram contents', () => {
      const svg = makeSvg({ viewBox: '0 0 10 10' })
      const rect = document.createElementNS(SVG_NS, 'rect')
      rect.setAttribute('width', '10')
      svg.appendChild(rect)
      expect(serializeSvgForExport(svg, { width: 10, height: 10 })).toContain('<rect')
    })

    it('does not modify the live preview node', () => {
      const svg = makeSvg({ viewBox: '0 0 300 450', width: '100%' }, 'max-width: 300px;')
      serializeSvgForExport(svg, { width: 300, height: 450 })
      expect(svg.getAttribute('width')).toBe('100%')
      expect(svg.getAttribute('style')).toContain('max-width')
    })
  })

  it('offers resolutions from 1x to 4x, defaulting to 2x', () => {
    expect([...PNG_EXPORT_SCALES]).toEqual([1, 2, 3, 4])
    expect(DEFAULT_PNG_EXPORT_SCALE).toBe(2)
    expect(isValidPngExportScale(3)).toBe(true)
    expect(isValidPngExportScale(5)).toBe(false)
    expect(isValidPngExportScale('2')).toBe(false)
  })
})

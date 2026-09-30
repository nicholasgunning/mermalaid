import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canRasterizeForeignObject,
  prepareDiagramPngMarkup,
  resetForeignObjectSupportCache,
} from './pngExport'

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * jsdom has no image decoding or 2D canvas, so both are stubbed: `pixel` is what the probe reads
 * back after drawing, which is how an engine reports whether it rendered the foreignObject.
 */
function stubRasterizer({
  pixel,
  imageLoads = true,
}: {
  pixel: [number, number, number]
  imageLoads?: boolean
}) {
  const drawImage = vi.fn()
  class FakeImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      queueMicrotask(() => (imageLoads ? this.onload?.() : this.onerror?.()))
    }
  }
  vi.stubGlobal('Image', FakeImage)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect: vi.fn(),
    drawImage,
    getImageData: () => ({ data: Uint8ClampedArray.from([...pixel, 255]) }),
    set fillStyle(_v: string) {},
  } as unknown as CanvasRenderingContext2D)
  return { drawImage }
}

function diagramSvg({ withForeignObject }: { withForeignObject: boolean }): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 200 100')
  const node = document.createElementNS(SVG_NS, withForeignObject ? 'foreignObject' : 'text')
  node.textContent = 'Label'
  svg.appendChild(node)
  return svg
}

describe('foreignObject support probe', () => {
  beforeEach(() => {
    resetForeignObjectSupportCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reports support when the HTML inside the probe was painted', async () => {
    stubRasterizer({ pixel: [255, 0, 0] })
    await expect(canRasterizeForeignObject()).resolves.toBe(true)
  })

  it('reports no support when the probe comes back blank', async () => {
    stubRasterizer({ pixel: [255, 255, 255] })
    await expect(canRasterizeForeignObject()).resolves.toBe(false)
  })

  it('reports no support when the probe image cannot be loaded', async () => {
    stubRasterizer({ pixel: [255, 0, 0], imageLoads: false })
    await expect(canRasterizeForeignObject()).resolves.toBe(false)
  })

  it('probes once and reuses the answer', async () => {
    const { drawImage } = stubRasterizer({ pixel: [255, 0, 0] })
    await canRasterizeForeignObject()
    await canRasterizeForeignObject()
    expect(drawImage).toHaveBeenCalledTimes(1)
  })
})

describe('prepareDiagramPngMarkup', () => {
  beforeEach(() => {
    resetForeignObjectSupportCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const size = { width: 200, height: 100 }

  it('exports the previewed diagram when the engine handles foreignObject', async () => {
    stubRasterizer({ pixel: [255, 0, 0] })
    const renderPlain = vi.fn()

    const result = await prepareDiagramPngMarkup(
      diagramSvg({ withForeignObject: true }),
      size,
      renderPlain,
    )

    expect(renderPlain).not.toHaveBeenCalled()
    expect(result.usedPlainLabels).toBe(false)
    expect(result.markup).toContain('foreignObject')
  })

  it('does not probe at all for a diagram without foreignObject labels', async () => {
    const { drawImage } = stubRasterizer({ pixel: [255, 255, 255] })
    const renderPlain = vi.fn()

    const result = await prepareDiagramPngMarkup(
      diagramSvg({ withForeignObject: false }),
      size,
      renderPlain,
    )

    expect(drawImage).not.toHaveBeenCalled()
    expect(renderPlain).not.toHaveBeenCalled()
    expect(result.usedPlainLabels).toBe(false)
  })

  it('re-renders with text labels when the engine would drop them', async () => {
    stubRasterizer({ pixel: [255, 255, 255] })
    const renderPlain = vi
      .fn()
      .mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 120"><text>Label</text></svg>')

    const result = await prepareDiagramPngMarkup(
      diagramSvg({ withForeignObject: true }),
      size,
      renderPlain,
    )

    expect(renderPlain).toHaveBeenCalledOnce()
    expect(result.usedPlainLabels).toBe(true)
    expect(result.markup).toContain('<text')
    expect(result.markup).not.toContain('foreignObject')
    // The re-render can lay out slightly differently, so its own size is used.
    expect(result.size).toEqual({ width: 220, height: 120 })
  })

  it('falls back to the previewed diagram when the re-render fails', async () => {
    stubRasterizer({ pixel: [255, 255, 255] })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await prepareDiagramPngMarkup(
      diagramSvg({ withForeignObject: true }),
      size,
      vi.fn().mockRejectedValue(new Error('render failed')),
    )

    expect(result.usedPlainLabels).toBe(false)
    expect(result.markup).toContain('foreignObject')
  })

  it('falls back when the re-render returns something that is not an SVG', async () => {
    stubRasterizer({ pixel: [255, 255, 255] })
    const result = await prepareDiagramPngMarkup(
      diagramSvg({ withForeignObject: true }),
      size,
      vi.fn().mockResolvedValue('not an svg at all'),
    )

    expect(result.usedPlainLabels).toBe(false)
    expect(result.markup).toContain('foreignObject')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderDiagramsToPdf, type PdfDiagramEntry } from './pdfExport'

/**
 * jsdom decodes no images and has no 2D canvas, so both are stubbed: every rasterized page comes
 * back as opaque pixels of the size the exporter asked the canvas for.
 */
function stubRasterizer() {
  class FakeImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      queueMicrotask(() => this.onload?.())
    }
  }
  vi.stubGlobal('Image', FakeImage)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    getImageData: (_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4).fill(255),
    }),
    set fillStyle(_v: string) {},
  } as unknown as CanvasRenderingContext2D)
}

function diagramSvg(width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%"><text>Label</text></svg>`
}

function entries(...labels: string[]): PdfDiagramEntry[] {
  return labels.map((label) => ({ label, code: `graph TD\n  ${label}` }))
}

/** The written file as a latin1 string, so byte offsets and string indices are the same thing. */
async function blobText(blob: Blob): Promise<string> {
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
}

describe('renderDiagramsToPdf', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const options = (render: (code: string, plainTextLabels: boolean) => Promise<string>) => ({
    scale: 2,
    background: '#ffffff',
    render,
  })

  it('writes one page per diagram, sized from that diagram', async () => {
    stubRasterizer()
    const sizes = [
      [400, 300],
      [100, 800],
    ]
    let call = 0
    const result = await renderDiagramsToPdf(
      entries('first', 'second'),
      options(async () => {
        const [width, height] = sizes[call]
        call += 1
        return diagramSvg(width, height)
      }),
    )

    expect(result.pageCount).toBe(2)
    expect(result.skipped).toEqual([])
    const pdf = await blobText(result.blob)
    expect(pdf).toContain('/MediaBox [0 0 300 225]')
    expect(pdf).toContain('/MediaBox [0 0 75 600]')
    // 2x resolution, and the diagram has no foreignObject, so labels are never re-rendered.
    expect(pdf).toContain('/Width 800 /Height 600')
  })

  it('asks for the diagram as previewed, not for plain labels', async () => {
    stubRasterizer()
    const render = vi.fn(async () => diagramSvg(200, 100))
    await renderDiagramsToPdf(entries('only'), options(render))
    expect(render).toHaveBeenCalledExactlyOnceWith('graph TD\n  only', false)
  })

  it('skips a diagram it cannot render and keeps the rest of the document', async () => {
    stubRasterizer()
    const result = await renderDiagramsToPdf(
      entries('good', 'broken', 'also good'),
      options(async (code) => {
        if (code.includes('broken')) throw new Error('nope')
        return diagramSvg(200, 100)
      }),
    )
    expect(result.pageCount).toBe(2)
    expect(result.skipped).toEqual(['broken'])
  })

  it('skips a diagram whose SVG has no usable size', async () => {
    stubRasterizer()
    const result = await renderDiagramsToPdf(
      entries('sizeless'),
      options(async () => '<svg xmlns="http://www.w3.org/2000/svg" width="100%"></svg>'),
    ).catch((err: Error) => err)
    // Nothing could be drawn, so there is no file to save — the caller reports that.
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/none of the diagrams/i)
  })

  it('reports progress for each diagram and once it starts writing', async () => {
    stubRasterizer()
    const onProgress = vi.fn()
    await renderDiagramsToPdf(entries('a', 'b'), {
      ...options(async () => diagramSvg(200, 100)),
      onProgress,
    })
    expect(onProgress.mock.calls).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ])
  })

  it('has nothing to do without diagrams', async () => {
    await expect(renderDiagramsToPdf([], options(async () => ''))).rejects.toThrow(
      /no diagrams to export/i,
    )
  })
})

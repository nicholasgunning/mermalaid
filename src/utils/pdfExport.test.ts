import { describe, expect, it } from 'vitest'
import {
  buildPdfBlob,
  buildPdfBytes,
  canvasToPdfPage,
  clampScaleForPdfPage,
  collectDiagramsFromTabs,
  getPdfPageBox,
  pdfFileNameFor,
  type PdfPageImage,
} from './pdfExport'
import { createTab, type DiagramTab } from './documentTabs'

function tab(code: string, name: string, path: string | null = null): DiagramTab {
  return { ...createTab({ code, name }), path }
}

/** A page of solid colour, small enough to assert on byte for byte. */
function page(width: number, height: number, colour = [1, 2, 3]): PdfPageImage {
  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = colour[0]
    rgb[i + 1] = colour[1]
    rgb[i + 2] = colour[2]
  }
  const box = getPdfPageBox({ width, height })
  return { rgb, pixelWidth: width, pixelHeight: height, pointWidth: box.width, pointHeight: box.height }
}

/** The written file as a latin1 string, so byte offsets and string indices are the same thing. */
async function pdfText(pages: PdfPageImage[], title?: string): Promise<string> {
  const chunks = await buildPdfBytes(pages, title === undefined ? {} : { title })
  return chunks
    .map((chunk) => Array.from(chunk, (byte) => String.fromCharCode(byte)).join(''))
    .join('')
}

describe('pdfExport', () => {
  describe('collectDiagramsFromTabs', () => {
    it('gives every tab one entry, in tab order', () => {
      const entries = collectDiagramsFromTabs([
        tab('graph TD\n  A-->B', 'Untitled 1'),
        tab('flowchart LR\n  C-->D', 'second.mmd', '/tmp/second.mmd'),
      ])
      expect(entries.map((entry) => entry.label)).toEqual(['Untitled 1', 'second.mmd'])
      expect(entries[1].code).toBe('flowchart LR\n  C-->D')
    })

    it('gives a multi-block document one entry per block, labelled with its position', () => {
      const markdown = '# Doc\n\n```mermaid\ngraph TD\n  A-->B\n```\n\ntext\n\n```mermaid\ngraph TD\n  C-->D\n```\n'
      const entries = collectDiagramsFromTabs([tab(markdown, 'notes.md')])
      expect(entries.map((entry) => entry.label)).toEqual(['notes.md (1/2)', 'notes.md (2/2)'])
      expect(entries[0].code).toContain('A-->B')
      expect(entries[1].code).toContain('C-->D')
    })

    it('skips empty tabs, so a fresh start screen adds no blank page', () => {
      const entries = collectDiagramsFromTabs([
        tab('', 'Untitled 1'),
        tab('   \n', 'Untitled 2'),
        tab('graph TD\n  A-->B', 'Untitled 3'),
      ])
      expect(entries.map((entry) => entry.label)).toEqual(['Untitled 3'])
    })

    it('has nothing to export when there are no tabs', () => {
      expect(collectDiagramsFromTabs([])).toEqual([])
    })
  })

  describe('page geometry', () => {
    it('sizes the page so the diagram prints at its on-screen size', () => {
      // 96 CSS px to the inch, 72 points to the inch.
      expect(getPdfPageBox({ width: 800, height: 600 })).toEqual({ width: 600, height: 450 })
    })

    it('scales a diagram past the format maximum down, keeping its aspect ratio', () => {
      const box = getPdfPageBox({ width: 40_000, height: 20_000 })
      expect(box.width).toBeCloseTo(14_400, 5)
      expect(box.height).toBeCloseTo(7200, 5)
    })

    it('keeps an ordinary diagram at the resolution the user asked for', () => {
      expect(clampScaleForPdfPage({ width: 800, height: 600 }, 4)).toBe(4)
      expect(clampScaleForPdfPage({ width: 303, height: 465 }, 1)).toBe(1)
    })

    it('goes below 1x for a diagram whose page would not fit the pixel budget', () => {
      const size = { width: 6000, height: 4000 }
      const scale = clampScaleForPdfPage(size, 2)
      expect(scale).toBeLessThan(1)
      expect(size.width * scale * size.height * scale).toBeLessThanOrEqual(12_000_000)
    })
  })

  describe('canvasToPdfPage', () => {
    /** jsdom has no 2d context, so stand in for one with the pixels a canvas would hand back. */
    function fakeCanvas(width: number, height: number, rgba: number[]): HTMLCanvasElement {
      return {
        width,
        height,
        getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(rgba) }) }),
      } as unknown as HTMLCanvasElement
    }

    it('drops the alpha channel, which a PDF image has no room for', () => {
      const canvas = fakeCanvas(2, 1, [10, 20, 30, 255, 40, 50, 60, 255])
      const result = canvasToPdfPage(canvas, { width: 2, height: 1 })
      expect([...result.rgb]).toEqual([10, 20, 30, 40, 50, 60])
      expect(result.pixelWidth).toBe(2)
    })

    it('keeps the page box on the diagram size, not the rasterized size', () => {
      // 2x resolution: four times the pixels, the same page.
      const canvas = fakeCanvas(2, 2, new Array(16).fill(255))
      const result = canvasToPdfPage(canvas, { width: 800, height: 600 })
      expect(result.pixelWidth).toBe(2)
      expect({ width: result.pointWidth, height: result.pointHeight }).toEqual({
        width: 600,
        height: 450,
      })
    })
  })

  describe('buildPdfBlob', () => {
    it('refuses to write a PDF with no pages', async () => {
      await expect(buildPdfBytes([])).rejects.toThrow(/no diagrams/i)
    })

    it('hands back a blob typed as a PDF', async () => {
      const blob = await buildPdfBlob([page(2, 2)])
      expect(blob.type).toBe('application/pdf')
      expect(blob.size).toBeGreaterThan(0)
    })

    it('writes one page per diagram', async () => {
      const pdf = await pdfText([page(4, 3), page(3, 4), page(2, 2)])
      expect(pdf.startsWith('%PDF-1.4')).toBe(true)
      expect(pdf).toContain('/Type /Pages /Count 3 /Kids [4 0 R 7 0 R 10 0 R]')
      expect(pdf.match(/\/Type \/Page /g)).toHaveLength(3)
      expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true)
    })

    it('gives each page a box the size of its own diagram', async () => {
      const pdf = await pdfText([page(400, 300), page(100, 800)])
      expect(pdf).toContain('/MediaBox [0 0 300 225]')
      expect(pdf).toContain('/MediaBox [0 0 75 600]')
    })

    it('stretches the image over the whole page, so nothing is cropped or letterboxed', async () => {
      const pdf = await pdfText([page(400, 300)])
      expect(pdf).toContain('q 300 0 0 225 0 0 cm /Im0 Do Q')
      expect(pdf).toContain('/Subtype /Image /Width 400 /Height 300 /ColorSpace /DeviceRGB')
    })

    it('records an offset for every object that points at that object', async () => {
      const pdf = await pdfText([page(4, 3), page(3, 4)])

      const startxref = /startxref\n(\d+)\n%%EOF/.exec(pdf)
      expect(startxref).not.toBeNull()
      const xref = pdf.slice(Number(startxref![1]))
      expect(xref.startsWith('xref\n0 10\n')).toBe(true)

      const entries = xref.slice('xref\n0 10\n'.length).split('\n')
      // The free head entry, then one per object; each row is exactly 20 bytes.
      expect(entries[0]).toBe('0000000000 65535 f ')
      for (let object = 1; object <= 9; object += 1) {
        const row = entries[object]
        expect(row).toMatch(/^\d{10} 00000 n $/)
        expect(row).toHaveLength(19)
        expect(pdf.slice(Number(row.slice(0, 10)))).toMatch(new RegExp(`^${object} 0 obj\n`))
      }
      expect(pdf).toContain('/Size 10 /Root 1 0 R /Info 3 0 R')
    })

    it('embeds the pixels verbatim when the platform cannot deflate them', async () => {
      // jsdom has no CompressionStream, which is the fallback this asserts.
      const pdf = await pdfText([page(2, 1, [7, 8, 9])])
      expect(pdf).not.toContain('/Filter /FlateDecode')
      expect(pdf).toContain('/Length 6 >>\nstream\n\x07\x08\x09\x07\x08\x09\nendstream')
    })

    it('writes the document title as a UTF-16 string, so any script survives', async () => {
      expect(await pdfText([page(2, 2)], 'Ab')).toContain('/Title <FEFF00410062>')
      expect(await pdfText([page(2, 2)], 'διάγραμμα')).toContain('/Title <FEFF03B4')
      expect(await pdfText([page(2, 2)])).not.toContain('/Title')
    })
  })

  describe('pdfFileNameFor', () => {
    it('keeps the document name and swaps the extension', () => {
      expect(pdfFileNameFor('flow.mmd')).toBe('flow.pdf')
      expect(pdfFileNameFor('notes.with.dots.md')).toBe('notes.with.dots.pdf')
      expect(pdfFileNameFor('Untitled 1')).toBe('Untitled 1.pdf')
    })

    it('falls back to a generic name when there is nothing usable', () => {
      expect(pdfFileNameFor('')).toBe('diagram.pdf')
      expect(pdfFileNameFor('  ')).toBe('diagram.pdf')
    })
  })
})

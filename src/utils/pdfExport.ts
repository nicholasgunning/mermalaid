/**
 * PDF export: one diagram per page, for the active tab or for every open tab at once.
 *
 * Each page is the diagram rasterized at a chosen resolution and stretched over a page box the
 * size of the diagram itself — so a page is never letterboxed and nothing is ever cropped, which
 * is the same promise PNG export makes. Writing the file by hand (rather than pulling in a PDF
 * library) keeps the editor dependency-free and the output tiny: an image XObject per page, a
 * two-operator content stream, nothing else.
 */
import { tabTitle, type DiagramTab } from './documentTabs'
import { extractAllMermaidBlocks, extractMermaidCode } from './mermaidCodeBlock'
import {
  clampScaleToCanvasLimits,
  getSvgExportSize,
  prepareDiagramPngMarkup,
  rasterizeSvgToCanvas,
  type SvgExportSize,
} from './pngExport'

/**
 * CSS px → PDF points. 96 CSS px make an inch and a point is 1/72", so a diagram prints at the
 * size it has on screen, and the chosen resolution multiplier reads directly as dpi: 96 × scale.
 */
export const PDF_POINTS_PER_PX = 0.75

/** Acrobat refuses a page over 200 inches; oversized diagrams are scaled to fit instead. */
const MAX_PDF_PAGE_POINTS = 14_400

/**
 * Per-page pixel budget. The canvas limits alone allow ~268M pixels, which is 800MB of RGB held
 * in memory per page — fine for one PNG, not for a document of them.
 */
const MAX_PDF_PAGE_PIXELS = 12_000_000

export interface PdfDiagramEntry {
  /** One diagram's source, YAML front matter included. */
  code: string
  /** Where it came from; shown when a diagram cannot be rendered. */
  label: string
}

/**
 * The diagrams `tabs` contribute, in page order: every ```mermaid block of every tab, and the
 * whole document for tabs that are plain diagram source. Empty tabs contribute nothing — a blank
 * page for an untouched start screen would be noise.
 */
export function collectDiagramsFromTabs(tabs: DiagramTab[]): PdfDiagramEntry[] {
  const entries: PdfDiagramEntry[] = []
  for (const tab of tabs) {
    const title = tabTitle(tab)
    const blocks = extractAllMermaidBlocks(tab.code)
    if (blocks.length > 1) {
      blocks.forEach((block, index) => {
        if (!block.code.trim()) return
        entries.push({ code: block.code, label: `${title} (${index + 1}/${blocks.length})` })
      })
      continue
    }
    const code = extractMermaidCode(tab.code)
    if (!code.trim()) continue
    entries.push({ code, label: title })
  }
  return entries
}

/**
 * Largest multiplier at or below `scale` that fits both the canvas limits and the page budget.
 *
 * Unlike PNG export this may go below 1× for a very large diagram: the page box keeps the diagram's
 * own size either way, so a page rasterized at 0.6× is a slightly softer page, not a cropped one.
 */
export function clampScaleForPdfPage(size: SvgExportSize, scale: number): number {
  // Passing Infinity asks the canvas clamp for its own ceiling, with nothing of ours mixed in.
  const byCanvas = clampScaleToCanvasLimits(size, Number.POSITIVE_INFINITY)
  const byBudget = Math.sqrt(MAX_PDF_PAGE_PIXELS / (size.width * size.height))
  const fits = Number.isFinite(byBudget) && byBudget > 0 ? Math.min(byCanvas, byBudget) : byCanvas
  // Trimmed rather than rounded, so squaring the result cannot land back over the budget.
  const ceiling = Math.floor(fits * 1e6) / 1e6
  // Under ~0.05× nothing legible survives anyway; a floor keeps a degenerate size from yielding 0.
  return Math.max(Math.min(scale, ceiling), 0.05)
}

/** The page box for a diagram, in points, scaled down if it would exceed the format's maximum. */
export function getPdfPageBox(size: SvgExportSize): SvgExportSize {
  const width = size.width * PDF_POINTS_PER_PX
  const height = size.height * PDF_POINTS_PER_PX
  const overflow = Math.max(width, height) / MAX_PDF_PAGE_POINTS
  const shrink = overflow > 1 ? 1 / overflow : 1
  return {
    width: Math.max(3, width * shrink),
    height: Math.max(3, height * shrink),
  }
}

export interface PdfPageImage {
  /** Row-major RGB, 3 bytes per pixel. */
  rgb: Uint8Array
  pixelWidth: number
  pixelHeight: number
  /** Page box in PDF points; the image covers it exactly. */
  pointWidth: number
  pointHeight: number
}

/**
 * The canvas pixels as a page. Alpha is dropped rather than turned into an `/SMask`: every export
 * canvas is painted with the theme background first, so it is opaque by construction.
 */
export function canvasToPdfPage(canvas: HTMLCanvasElement, size: SvgExportSize): PdfPageImage {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is not available for PDF export.')
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const rgb = new Uint8Array(canvas.width * canvas.height * 3)
  for (let src = 0, dst = 0; dst < rgb.length; src += 4, dst += 3) {
    rgb[dst] = data[src]
    rgb[dst + 1] = data[src + 1]
    rgb[dst + 2] = data[src + 2]
  }
  const box = getPdfPageBox(size)
  return {
    rgb,
    pixelWidth: canvas.width,
    pixelHeight: canvas.height,
    pointWidth: box.width,
    pointHeight: box.height,
  }
}

function latin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff
  return bytes
}

/** PDF numbers have no exponent form, which `String(1e-7)` would produce. */
function num(value: number): string {
  return String(Math.round(value * 100) / 100)
}

/** A text string as UTF-16BE hex, so titles with any script survive. */
function pdfTextString(text: string): string {
  let hex = 'FEFF'
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code > 0xffff) {
      const offset = code - 0x10000
      hex += (0xd800 + (offset >> 10)).toString(16).padStart(4, '0')
      hex += (0xdc00 + (offset & 0x3ff)).toString(16).padStart(4, '0')
    } else {
      hex += code.toString(16).padStart(4, '0')
    }
  }
  return `<${hex.toUpperCase()}>`
}

function pdfDate(date: Date): string {
  const p = (value: number) => String(value).padStart(2, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  return (
    `D:${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}'${p(abs % 60)}'`
  )
}

/**
 * zlib-wrapped deflate, which is what `/FlateDecode` expects, or null where the platform has no
 * `CompressionStream` (older WebKit, jsdom). Callers then write the stream uncompressed — a bigger
 * file, still a valid one.
 */
async function deflateZlib(data: Uint8Array): Promise<Uint8Array | null> {
  const Ctor = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream
  if (!Ctor) return null
  try {
    // 'deflate' is the zlib container; 'deflate-raw' would omit the header PDF readers look for.
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new Ctor('deflate'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch (err) {
    console.error('PDF stream compression failed; writing it uncompressed.', err)
    return null
  }
}

export interface PdfMetadata {
  title?: string
}

/**
 * The bytes of a PDF of `pages`, one page per image.
 *
 * Object numbering is fixed — 1 catalog, 2 page tree, 3 info, then page/content/image triples —
 * so the cross-reference table can be written from recorded byte offsets in one pass.
 */
export async function buildPdfBytes(
  pages: PdfPageImage[],
  { title }: PdfMetadata = {},
): Promise<Uint8Array[]> {
  if (pages.length === 0) throw new Error('There are no diagrams to put in the PDF.')

  const streams = await Promise.all(pages.map((page) => deflateZlib(page.rgb)))

  const chunks: Uint8Array[] = []
  let offset = 0
  const push = (data: Uint8Array | string) => {
    const bytes = typeof data === 'string' ? latin1(data) : data
    chunks.push(bytes)
    offset += bytes.length
  }

  const offsets: number[] = []
  const object = (number: number, body: () => void) => {
    offsets[number - 1] = offset
    push(`${number} 0 obj\n`)
    body()
    push('endobj\n')
  }

  const pageNumber = (index: number) => 4 + index * 3
  const contentNumber = (index: number) => pageNumber(index) + 1
  const imageNumber = (index: number) => pageNumber(index) + 2

  push('%PDF-1.4\n')
  // Marks the file as binary for tools that sniff the first bytes.
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))

  object(1, () => push('<< /Type /Catalog /Pages 2 0 R >>\n'))

  object(2, () => {
    const kids = pages.map((_, index) => `${pageNumber(index)} 0 R`).join(' ')
    push(`<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>\n`)
  })

  object(3, () => {
    const parts = [`/Producer ${pdfTextString('Mermalaid')}`, `/CreationDate (${pdfDate(new Date())})`]
    if (title) parts.unshift(`/Title ${pdfTextString(title)}`)
    push(`<< ${parts.join(' ')} >>\n`)
  })

  pages.forEach((page, index) => {
    object(pageNumber(index), () => {
      push(
        `<< /Type /Page /Parent 2 0 R ` +
          `/MediaBox [0 0 ${num(page.pointWidth)} ${num(page.pointHeight)}] ` +
          `/Resources << /XObject << /Im0 ${imageNumber(index)} 0 R >> >> ` +
          `/Contents ${contentNumber(index)} 0 R >>\n`,
      )
    })

    object(contentNumber(index), () => {
      // Scale the unit image square to the page box; the diagram fills the page exactly.
      const content = `q ${num(page.pointWidth)} 0 0 ${num(page.pointHeight)} 0 0 cm /Im0 Do Q\n`
      push(`<< /Length ${content.length} >>\nstream\n${content}endstream\n`)
    })

    object(imageNumber(index), () => {
      const data = streams[index] ?? page.rgb
      const filter = streams[index] ? ' /Filter /FlateDecode' : ''
      push(
        `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8${filter} /Length ${data.length} >>\nstream\n`,
      )
      push(data)
      push('\nendstream\n')
    })
  })

  const xrefOffset = offset
  const size = offsets.length + 1
  push(`xref\n0 ${size}\n`)
  push('0000000000 65535 f \n')
  for (const entry of offsets) {
    // Every entry is exactly 20 bytes wide, which the format requires.
    push(`${String(entry).padStart(10, '0')} 00000 n \n`)
  }
  push(`trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`)

  return chunks
}

/** {@link buildPdfBytes} as a file ready to hand to {@link ../utils/saveFile.saveBlob}. */
export async function buildPdfBlob(pages: PdfPageImage[], metadata: PdfMetadata = {}): Promise<Blob> {
  const chunks = await buildPdfBytes(pages, metadata)
  return new Blob(chunks as BlobPart[], { type: 'application/pdf' })
}

/**
 * The `<svg>` element of a rendered diagram.
 *
 * Mermaid's output is well-formed XML, but a renderer fallback may hand back something only the
 * HTML parser accepts, so that is tried second rather than losing the page.
 */
function parseSvgMarkup(markup: string): SVGSVGElement | null {
  const xml = new DOMParser().parseFromString(markup, 'image/svg+xml')
  if (xml.getElementsByTagName('parsererror').length === 0) {
    const svg = xml.querySelector('svg')
    if (svg) return svg as SVGSVGElement
  }
  return new DOMParser().parseFromString(markup, 'text/html').querySelector('svg')
}

export interface DiagramPdfOptions {
  /** Resolution multiplier, as in PNG export; clamped per page. */
  scale: number
  /** Painted behind each page — PDF pages have no transparency. */
  background: string
  /** Renders one diagram's source to standalone SVG markup. */
  render: (code: string, plainTextLabels: boolean) => Promise<string>
  /** Called before each diagram, for the dialog's progress line. */
  onProgress?: (done: number, total: number) => void
}

export interface DiagramPdfResult {
  blob: Blob
  pageCount: number
  /** Labels of diagrams that could not be rendered; they are left out rather than blanked in. */
  skipped: string[]
}

/**
 * Renders `entries` into a PDF, one diagram per page.
 *
 * Pages are built one at a time and each canvas is released straight after: a dozen tabs at high
 * resolution is a lot of pixels to hold at once. A diagram that fails to render is skipped and
 * reported, so one bad block cannot cost the user the rest of the document.
 */
export async function renderDiagramsToPdf(
  entries: PdfDiagramEntry[],
  { scale, background, render, onProgress }: DiagramPdfOptions,
  metadata: PdfMetadata = {},
): Promise<DiagramPdfResult> {
  if (entries.length === 0) throw new Error('There are no diagrams to export.')

  const pages: PdfPageImage[] = []
  const skipped: string[] = []

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    onProgress?.(index, entries.length)
    try {
      const svg = parseSvgMarkup(await render(entry.code, false))
      const size = svg ? getSvgExportSize(svg) : null
      if (!svg || !size) {
        skipped.push(entry.label)
        continue
      }
      const prepared = await prepareDiagramPngMarkup(svg, size, () => render(entry.code, true))
      const canvas = await rasterizeSvgToCanvas(prepared.markup, {
        size: prepared.size,
        scale: clampScaleForPdfPage(prepared.size, scale),
        background,
      })
      pages.push(canvasToPdfPage(canvas, prepared.size))
      canvas.width = 0
      canvas.height = 0
    } catch (err) {
      console.error(`PDF export: could not render ${entry.label}`, err)
      skipped.push(entry.label)
    }
  }

  onProgress?.(entries.length, entries.length)
  if (pages.length === 0) {
    throw new Error('None of the diagrams could be rendered.')
  }

  return { blob: await buildPdfBlob(pages, metadata), pageCount: pages.length, skipped }
}

/** `flow.mmd` → `flow.pdf`; anything without a usable name falls back to `diagram.pdf`. */
export function pdfFileNameFor(documentName: string): string {
  const base = documentName.replace(/\.[^./\\]+$/, '').trim()
  return `${base || 'diagram'}.pdf`
}

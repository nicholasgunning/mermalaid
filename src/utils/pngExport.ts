/**
 * PNG export: rasterizing the diagram SVG itself rather than screenshotting the preview pane.
 *
 * Capturing the pane (the previous approach) produced whatever happened to be on screen — cropped
 * to the viewport, at the current pan/zoom, with the zoom toolbar baked in. Rendering from the
 * SVG's own `viewBox` instead always yields the whole diagram at a user-chosen resolution.
 */

/** Resolutions offered to the user; the multiplier applies to the diagram's intrinsic size. */
export const PNG_EXPORT_SCALES = [1, 2, 3, 4] as const
export type PngExportScale = (typeof PNG_EXPORT_SCALES)[number]

export const DEFAULT_PNG_EXPORT_SCALE: PngExportScale = 2

export const PNG_SCALE_LABELS: Record<PngExportScale, string> = {
  1: 'Standard',
  2: 'High',
  3: 'Very high',
  4: 'Ultra',
}

/**
 * Browser canvas limits. Chrome and Safari refuse a canvas wider/taller than 16384px or larger
 * than ~268M pixels; exceeding either yields a blank image rather than an error, so clamp first.
 */
const MAX_CANVAS_SIDE_PX = 16_384
const MAX_CANVAS_AREA_PX = 268_435_456

export interface SvgExportSize {
  width: number
  height: number
}

/**
 * An absolute length in px, or null for anything relative.
 *
 * Mermaid writes `width="100%"` when it sizes the diagram to its container, and `parseFloat`
 * would happily read that as 100px — a 100×100 export of a diagram of any size.
 */
function parseLengthAttribute(value: string | null): number | null {
  if (!value) return null
  const match = /^\s*([0-9]*\.?[0-9]+)(px)?\s*$/.exec(value)
  if (!match) return null
  const length = Number.parseFloat(match[1])
  return Number.isFinite(length) && length > 0 ? length : null
}

export function isValidPngExportScale(value: unknown): value is PngExportScale {
  return PNG_EXPORT_SCALES.includes(value as PngExportScale)
}

/**
 * The diagram's intrinsic size, independent of the preview's pan/zoom.
 *
 * `viewBox` is the authority: the rendered width/height follow the pane, and a measured rect is
 * multiplied by the current zoom. Falls back to the attributes, then to the measured box.
 */
export function getSvgExportSize(svg: SVGSVGElement): SvgExportSize | null {
  const viewBox = svg.getAttribute('viewBox')
  if (viewBox) {
    const parts = viewBox.split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] }
    }
  }

  const attrWidth = parseLengthAttribute(svg.getAttribute('width'))
  const attrHeight = parseLengthAttribute(svg.getAttribute('height'))
  if (attrWidth !== null && attrHeight !== null) {
    return { width: attrWidth, height: attrHeight }
  }

  const rect = svg.getBoundingClientRect?.()
  if (rect && rect.width > 0 && rect.height > 0) {
    return { width: rect.width, height: rect.height }
  }
  return null
}

/**
 * Largest multiplier at or below `scale` that still fits in a canvas.
 *
 * A request of 1× or more never comes back below 1 unless the diagram itself is past the limit.
 * A request below 1 is honoured as-is: PDF export asks for less on purpose, to keep a document's
 * worth of pages within a sane amount of memory.
 */
export function clampScaleToCanvasLimits(size: SvgExportSize, scale: number): number {
  const bySide = MAX_CANVAS_SIDE_PX / Math.max(size.width, size.height)
  const byArea = Math.sqrt(MAX_CANVAS_AREA_PX / (size.width * size.height))
  const maxScale = Math.min(bySide, byArea)
  if (!Number.isFinite(maxScale) || maxScale <= 0) return 1
  const fitted = Math.min(scale, maxScale)
  return scale < 1 ? fitted : Math.max(fitted, Math.min(1, maxScale))
}

/** Output pixel dimensions for a scale, after clamping — what the export dialog shows. */
export function getPngOutputSize(size: SvgExportSize, scale: number): SvgExportSize {
  const applied = clampScaleToCanvasLimits(size, scale)
  return {
    width: Math.max(1, Math.round(size.width * applied)),
    height: Math.max(1, Math.round(size.height * applied)),
  }
}

/**
 * A standalone copy of the diagram sized in absolute pixels.
 *
 * The live node carries `style="max-width:…"` and a percentage width from the preview pane; both
 * have to go, or the rasterized image inherits the pane's layout instead of the diagram's size.
 */
export function serializeSvgForExport(svg: SVGSVGElement, size: SvgExportSize): string {
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
  clone.setAttribute('width', String(size.width))
  clone.setAttribute('height', String(size.height))
  if (!clone.getAttribute('viewBox')) {
    clone.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`)
  }
  clone.style.removeProperty('max-width')
  clone.style.removeProperty('width')
  clone.style.removeProperty('height')
  return new XMLSerializer().serializeToString(clone)
}

function svgMarkupToDataUrl(markup: string): string {
  // A data URL keeps the canvas untainted, which a blob URL does not guarantee in every engine.
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('The diagram image could not be rasterized.'))
    img.src = src
  })
}

export interface RasterizeOptions {
  size: SvgExportSize
  scale: number
  /** Painted before the diagram; omit for a transparent PNG. */
  background?: string
}

/**
 * Draws serialized SVG markup onto an offscreen canvas at `scale`.
 *
 * Shared with PDF export, which needs the pixels rather than an encoded image, so the clamping
 * and background handling live here instead of in each exporter.
 */
export async function rasterizeSvgToCanvas(
  markup: string,
  { size, scale, background }: RasterizeOptions,
): Promise<HTMLCanvasElement> {
  const applied = clampScaleToCanvasLimits(size, scale)
  const width = Math.max(1, Math.round(size.width * applied))
  const height = Math.max(1, Math.round(size.height * applied))

  const image = await loadImage(svgMarkupToDataUrl(markup))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is not available for image export.')
  if (background) {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, width, height)
  }
  ctx.drawImage(image, 0, 0, width, height)
  return canvas
}

/** Draws serialized SVG markup onto a canvas and returns it as a PNG blob. */
export async function rasterizeSvgToPngBlob(
  markup: string,
  options: RasterizeOptions,
): Promise<Blob> {
  const canvas = await rasterizeSvgToCanvas(markup, options)

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/png')
  })
  if (!blob) throw new Error('The PNG could not be generated.')
  return blob
}

/** 4×4 red square drawn through an HTML div, i.e. only visible if foreignObject rasterizes. */
const FOREIGN_OBJECT_PROBE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4">' +
  '<foreignObject width="4" height="4">' +
  '<div xmlns="http://www.w3.org/1999/xhtml" style="width:4px;height:4px;background:#ff0000"></div>' +
  '</foreignObject></svg>'

let foreignObjectSupport: Promise<boolean> | null = null

/**
 * Whether this engine rasterizes HTML inside `<foreignObject>`, which Mermaid uses for node
 * labels. Chromium does; some WebKit builds drop the content, which would silently export a
 * diagram with no text — so callers re-render with plain SVG text labels instead.
 */
export function canRasterizeForeignObject(): Promise<boolean> {
  if (!foreignObjectSupport) {
    foreignObjectSupport = (async () => {
      try {
        const image = await loadImage(svgMarkupToDataUrl(FOREIGN_OBJECT_PROBE_SVG))
        const canvas = document.createElement('canvas')
        canvas.width = 4
        canvas.height = 4
        const ctx = canvas.getContext('2d')
        if (!ctx) return false
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, 4, 4)
        ctx.drawImage(image, 0, 0, 4, 4)
        const [r, g, b] = ctx.getImageData(2, 2, 1, 1).data
        return r > 200 && g < 80 && b < 80
      } catch {
        return false
      }
    })()
  }
  return foreignObjectSupport
}

/** Test seam: forget the cached probe result. */
export function resetForeignObjectSupportCache(): void {
  foreignObjectSupport = null
}

export interface PreparedPngMarkup {
  markup: string
  size: SvgExportSize
  /** True when labels were re-rendered because this engine cannot rasterize foreignObject. */
  usedPlainLabels: boolean
}

/**
 * Picks the markup to rasterize: the diagram exactly as previewed, or a plain-label re-render
 * on engines that would otherwise drop every label.
 *
 * `renderPlainLabels` produces the same diagram with SVG `<text>` labels. If it fails, the live
 * diagram is used anyway — a possibly text-less export still beats no export.
 */
export async function prepareDiagramPngMarkup(
  svg: SVGSVGElement,
  size: SvgExportSize,
  renderPlainLabels: () => Promise<string>,
): Promise<PreparedPngMarkup> {
  const live: PreparedPngMarkup = {
    markup: serializeSvgForExport(svg, size),
    size,
    usedPlainLabels: false,
  }

  if (svg.querySelector('foreignObject') === null) return live
  if (await canRasterizeForeignObject()) return live

  try {
    const plainSvg = await renderPlainLabels()
    const parsed = new DOMParser()
      .parseFromString(plainSvg, 'image/svg+xml')
      .querySelector('svg') as SVGSVGElement | null
    if (!parsed || parsed.querySelector('parsererror')) return live
    const plainSize = getSvgExportSize(parsed)
    if (!plainSize) return live
    return {
      markup: serializeSvgForExport(parsed, plainSize),
      size: plainSize,
      usedPlainLabels: true,
    }
  } catch (err) {
    console.error('Plain-label PNG fallback failed:', err)
    return live
  }
}

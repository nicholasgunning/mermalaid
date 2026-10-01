import {
  useEffect,
  useState,
  useRef,
  useImperativeHandle,
  forwardRef,
  type MutableRefObject,
} from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { message, open } from '@tauri-apps/plugin-dialog'
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { useTheme } from '../hooks/useTheme'
import { useToast } from '../hooks/useToast'
import { extractMermaidCode, type MermaidBlock } from '../utils/mermaidCodeBlock'
import { fixMermaidErrorWithAI, getStoredApiKey } from '../utils/aiErrorFixer'
import {
  MERMAID_THEME_IDS,
  getMermaidThemeLabel,
  getMermaidThemeOptions,
  isAppThemeDark,
  type MermaidThemeId,
} from '../utils/mermaidThemes'
import {
  parseMermaidWithConfig,
  parseMermaidConfigForOfficialRenderer,
  mapMermaidConfigToThemeOptions,
} from '../utils/mermaidYamlConfig'
import { renderOfficialMermaidPreview } from '../utils/officialMermaidPreview'
import {
  buildMermalaidAboutPreviewHtml,
  buildMermalaidInfoText,
  isMermaidAboutKeywordOnly,
} from '../utils/mermalaidInfoText'
import {
  clampScaleToCanvasLimits,
  DEFAULT_PNG_EXPORT_SCALE,
  getPngOutputSize,
  getSvgExportSize,
  isValidPngExportScale,
  PNG_EXPORT_SCALES,
  PNG_SCALE_LABELS,
  prepareDiagramPngMarkup,
  rasterizeSvgToPngBlob,
  type PngExportScale,
  type SvgExportSize,
} from '../utils/pngExport'
import {
  collectDiagramsFromTabs,
  pdfFileNameFor,
  renderDiagramsToPdf,
  type PdfDiagramEntry,
} from '../utils/pdfExport'
import { renderDiagramSvgMarkup } from '../utils/renderDiagramSvg'
import { getAppThemeCssVars } from '../utils/mermaidThemes'
import Settings from './Settings'
import ConfirmDialog from './ConfirmDialog'
import AgentBridgePanel from './AgentBridgePanel'
import { useAgentBridgeContext } from '../hooks/useAgentBridgeContext'
import type { BridgeStatus } from '../agentBridge/bridgeClient'
import { rebuildNativeAppMenu } from '../nativeAppMenu'
import { addRecentFile, recentFileLabel, removeRecentFile } from '../utils/recentFiles'
import { tabTitle, type DiagramTab, type OpenDocumentInput } from '../utils/documentTabs'
import { DIAGRAM_FILE_EXTENSIONS } from '../utils/diagramImportFiles'
import { copyPlainTextWhenReady, formatClipboardFailureMessage } from '../utils/copyToClipboard'
import {
  saveBlob,
  saveFileKind,
  toastMessageForSaveResult,
  type SaveFileAcceptType,
  type SaveFileFilter,
  type SaveFileOptions,
} from '../utils/saveFile'
import {
  applyPrivateShareFullUrlToHistory,
  assertPrivateShareUrlFits,
  buildPrivateShareUrl,
  encodePrivateShareHash,
  getPrivateShareErrorMessage,
  getShareLinkOrigin,
  PrivateShareError,
} from '../utils/privateUrlShare'
import {
  assemblePreviewUrl,
  encodePublicDiagram,
  PublicShareLinkError,
  requestPreviewSignature,
} from '../utils/publicShareLink'
import './Toolbar.css'

const PNG_SCALE_STORAGE_KEY = 'mermalaid-png-export-scale'
const PDF_SCALE_STORAGE_KEY = 'mermalaid-pdf-export-scale'

function readStoredScale(key: string): PngExportScale {
  try {
    const stored = Number(localStorage.getItem(key))
    return isValidPngExportScale(stored) ? stored : DEFAULT_PNG_EXPORT_SCALE
  } catch {
    return DEFAULT_PNG_EXPORT_SCALE
  }
}

/** PDF export covers the focused document, or every open tab in one file. */
type PdfExportScope = 'tab' | 'all'

function storeScale(key: string, scale: PngExportScale): void {
  try {
    localStorage.setItem(key, String(scale))
  } catch {
    /* ignore blocked storage */
  }
}

/** Must cover compress (up to ~1.5s wall) + importKey + encrypt (each up to 2.5s) on slow devices. */
const PRIVATE_LINK_ENCODE_TIMEOUT_MS = 10_000
const PRIVATE_LINK_BUSY_MIN_MS = 300
const PRIVATE_LINK_BUTTON_TITLE = 'Copy a private link (encrypted in the URL fragment only). The URL also appears in the address bar.'
const PREVIEW_LINK_BUTTON_TITLE = 'Copy a public preview link. Pasting it in Slack, Discord, etc. shows the rendered diagram. The diagram is readable by anyone with the link — use the private link for anything sensitive.'

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timeoutId)
        resolve(value)
      },
      (err) => {
        clearTimeout(timeoutId)
        reject(err)
      },
    )
  })
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const OPEN_FILTERS: SaveFileFilter[] = [
  { name: 'Mermaid / Text', extensions: [...DIAGRAM_FILE_EXTENSIONS] },
]

const MERMAID_ACCEPT_TYPES: SaveFileAcceptType[] = [
  {
    description: 'Mermaid / Text',
    accept: {
      'text/plain': ['.mmd', '.txt'],
      'text/markdown': ['.md', '.markdown'],
    },
  },
]

const SVG_EXPORT = saveFileKind('diagram.svg', 'SVG', 'svg', 'image/svg+xml')
const PNG_EXPORT = saveFileKind('diagram.png', 'PNG', 'png', 'image/png')
const HTML_EXPORT = saveFileKind('diagrams.html', 'HTML', 'html', 'text/html')
const ALL_TABS_PDF_NAME = 'diagrams.pdf'

function pdfExportKind(fileName: string): SaveFileOptions {
  return saveFileKind(fileName, 'PDF', 'pdf', 'application/pdf')
}

const LICENSE_INFO_TEXT = `Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)

Copyright © 2025-present Dario Novoa (highvoltag3)

You are free to:
- Share — copy and redistribute the material in any medium or format
- Adapt — remix, transform, and build upon the material

Under the following terms:
- Attribution — Give credit, provide a license link, and indicate changes.
- NonCommercial — No commercial use.
- ShareAlike — Distribute contributions under the same license.

Project license file:
https://github.com/highvoltag3/mermalaid/blob/main/LICENSE

Full license text:
https://creativecommons.org/licenses/by-nc-sa/4.0/`

interface ToolbarProps {
  code: string
  setCode: (code: string) => void
  error: string | null
  activeCode: string
  mermaidBlocks: MermaidBlock[]
  /** Tauri: path of the file last opened or saved (null = unsaved) */
  documentPathRef: MutableRefObject<string | null>
  /** Updates both the path ref and the mirrored state that drives the external-file watcher. */
  setDocumentPath: (path: string | null) => void
  /** Every open document, in tab order — PDF export can cover all of them at once. */
  tabs: DiagramTab[]
  /** Id of the focused tab, i.e. the one a single-tab export applies to. */
  activeTabId: string
  /** Opens a document in its own tab (or focuses the tab already showing that path). */
  openDocument: (input: OpenDocumentInput) => void
  /** Adds an empty tab and focuses it — what New does now that documents are tabbed. */
  newDocument: () => void
  /** Renames the active tab; used when a browser save yields a file name but no path. */
  setDocumentName: (name: string) => void
  /** Records content Mermalaid wrote to disk so its own save isn't seen as an external change. */
  onDocumentSaved?: (content: string) => void
  isMobile?: boolean
  /** Whether the AI assistant drawer is showing, so the button can read as a toggle. */
  aiChatOpen?: boolean
  onToggleAiChat?: () => void
  /** Smartphone bottom bar uses the same sheet; this toggles it. */
  showMobileActions?: boolean
  setShowMobileActions?: (open: boolean) => void
}

export interface ToolbarRef {
  handleNew: () => void
  handleOpen: () => void
  handleSave: () => void
  handleSaveAs: () => void
  handlePrint: () => void
  handleShare: () => void
  handleDuplicate: () => void
  handleEngineVersionInfo: () => void
  handleShowLicenseInfo: () => void
  /** Lets the AI assistant panel send the user to the API key field. */
  openSettings: () => void
  openPath: (path: string) => Promise<void>
  openMobileActions?: () => void
}

const AGENT_STATUS_COLOR: Record<BridgeStatus, string> = {
  disconnected: '#8b949e',
  connecting: '#d29922',
  connected: '#2ea043',
  rejected: '#d1242f',
  superseded: '#e8730c',
  error: '#d1242f',
}

const AGENT_STATUS_TITLE: Record<BridgeStatus, string> = {
  disconnected: 'AI Agent — not connected',
  connecting: 'AI Agent — connecting…',
  connected: 'AI Agent — connected',
  rejected: 'AI Agent — pairing failed',
  superseded: 'AI Agent — taken over by another tab',
  error: 'AI Agent — connection problem',
}

const Toolbar = forwardRef<ToolbarRef, ToolbarProps>(({
  code,
  setCode,
  error,
  activeCode,
  mermaidBlocks,
  tabs,
  activeTabId,
  documentPathRef,
  setDocumentPath,
  openDocument,
  newDocument,
  setDocumentName,
  onDocumentSaved,
  isMobile = false,
  aiChatOpen = false,
  onToggleAiChat,
  showMobileActions: showMobileActionsProp,
  setShowMobileActions: setShowMobileActionsProp,
}, ref) => {
  const { mermaidTheme, setMermaidTheme } = useTheme()
  const { showToast } = useToast()
  const isDark = isAppThemeDark(mermaidTheme)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const agentBridge = useAgentBridgeContext()
  const [showSettings, setShowSettings] = useState(false)
  const [showAgentPanel, setShowAgentPanel] = useState(false)
  const [showMobileActionsState, setShowMobileActionsState] = useState(false)
  const showMobileActions = showMobileActionsProp ?? showMobileActionsState
  const setShowMobileActions = setShowMobileActionsProp ?? setShowMobileActionsState
  const [isFixing, setIsFixing] = useState(false)
  const [pngExportSize, setPngExportSize] = useState<SvgExportSize | null>(null)
  const [pngExportScale, setPngExportScale] = useState<PngExportScale>(() =>
    readStoredScale(PNG_SCALE_STORAGE_KEY),
  )
  const [isExportingPng, setIsExportingPng] = useState(false)
  const [showPdfExport, setShowPdfExport] = useState(false)
  const [pdfExportScope, setPdfExportScope] = useState<PdfExportScope>('tab')
  const [pdfExportScale, setPdfExportScale] = useState<PngExportScale>(() =>
    readStoredScale(PDF_SCALE_STORAGE_KEY),
  )
  const [pdfProgress, setPdfProgress] = useState<{ done: number; total: number } | null>(null)
  const [isCopyingPrivateLink, setIsCopyingPrivateLink] = useState(false)
  const [isCopyingPreviewLink, setIsCopyingPreviewLink] = useState(false)
  const hasMultipleBlocks = mermaidBlocks.length > 1

  useEffect(() => {
    if (!isMobile) {
      setShowMobileActions(false)
    }
  }, [isMobile])

  useEffect(() => {
    if (!showMobileActions) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowMobileActions(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showMobileActions])

  const openBrowserFilePicker = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click()
      return
    }
    console.error('File input ref is not available')
    showToast('Unable to open file dialog. Please try again.', 'error')
  }

  /** New opens another tab, so nothing has to be discarded to start a second diagram. */
  const handleNew = () => {
    newDocument()
  }

  const handleOpen = async () => {
    if (isTauri()) {
      try {
        const selected = await open({
          multiple: true,
          directory: false,
          filters: OPEN_FILTERS,
        })
        const paths = (Array.isArray(selected) ? selected : [selected]).filter(
          (path): path is string => typeof path === 'string' && path.length > 0,
        )
        // Each selected file gets its own tab; the last one ends up focused.
        for (const path of paths) {
          await openPath(path)
        }
      } catch (err) {
        console.error('Open dialog error:', err)
        // Some desktop/web hybrid contexts can report Tauri=true but fail to open native dialog.
        // Fall back to browser picker so Open always does something useful.
        openBrowserFilePicker()
      }
      return
    }
    try {
      openBrowserFilePicker()
    } catch (err) {
      console.error('Error opening file dialog:', err)
      showToast('Failed to open file dialog. Please ensure your browser supports file selection.', 'error')
    }
  }

  const openPath = async (path: string) => {
    if (!isTauri()) return
    try {
      const content = await readTextFile(path)
      openDocument({ path, code: content })
      addRecentFile(path)
      await rebuildNativeAppMenu()
      showToast(`Loaded ${recentFileLabel(path)}`)
    } catch (err) {
      console.error('Read file error:', err)
      showToast('Could not read that file. It may have been moved or deleted.', 'error')
      removeRecentFile(path)
      await rebuildNativeAppMenu()
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) {
      return
    }

    const validExtensions = ['.mmd', '.txt', '.md', '.markdown']
    const fileName = file.name.toLowerCase()
    const isValid = validExtensions.some(ext => fileName.endsWith(ext))

    if (!isValid) {
      showToast(`Invalid file type. Use: ${validExtensions.join(', ')}`, 'error')
      e.target.value = ''
      return
    }

    const reader = new FileReader()
    reader.onerror = () => {
      showToast('Failed to read file. Please try again.', 'error')
      e.target.value = ''
    }

    reader.onload = (event) => {
      try {
        const content = event.target?.result as string
        if (content) {
          // Browsers give no path, so the tab is labelled with the picked file's name.
          openDocument({ code: content, name: file.name })
          showToast(`Loaded ${file.name}`)
        } else {
          showToast('File appears to be empty.', 'error')
        }
      } catch (err) {
        console.error('Error processing file:', err)
        showToast('Failed to process file content.', 'error')
      }
      e.target.value = ''
    }

    reader.readAsText(file)
  }

  const handleSave = async () => {
    if (isTauri() && documentPathRef.current) {
      try {
        await writeTextFile(documentPathRef.current, code)
        onDocumentSaved?.(code)
        showToast(`Saved ${recentFileLabel(documentPathRef.current)}`)
      } catch (err) {
        console.error('Save error:', err)
        showToast('Could not save to that location.', 'error')
      }
      return
    }
    await handleSaveAs()
  }

  const handleSaveAs = async () => {
    try {
      const result = await saveBlob(new Blob([code], { type: 'text/plain' }), {
        suggestedName: 'diagram.mmd',
        defaultPath: documentPathRef.current ?? 'diagram.mmd',
        filters: OPEN_FILTERS,
        acceptTypes: MERMAID_ACCEPT_TYPES,
      })
      if (result.outcome === 'cancelled') return
      // A browser download is a save too — it just leaves no path to write back to.
      onDocumentSaved?.(code)
      if (result.outcome === 'saved' && result.path) {
        setDocumentPath(result.path)
        addRecentFile(result.path)
        await rebuildNativeAppMenu()
      } else {
        setDocumentName(result.fileName)
      }
      const toastMsg = toastMessageForSaveResult(result, 'Saved')
      if (toastMsg) showToast(toastMsg)
    } catch (err) {
      console.error('Save As error:', err)
      showToast('Could not save file.', 'error')
    }
  }

  const handleDuplicate = async () => {
    if (!isTauri()) {
      await handleSaveAs()
      return
    }
    const base = documentPathRef.current
    const suggested =
      base && /\.(mmd|txt|md|markdown)$/i.test(base)
        ? base.replace(/(\.[^.]+)$/, '-copy$1')
        : 'diagram-copy.mmd'
    try {
      const result = await saveBlob(new Blob([code], { type: 'text/plain' }), {
        suggestedName: 'diagram-copy.mmd',
        defaultPath: suggested,
        filters: OPEN_FILTERS,
        acceptTypes: MERMAID_ACCEPT_TYPES,
      })
      if (result.outcome === 'cancelled') return
      if (result.outcome === 'saved' && result.path) {
        onDocumentSaved?.(code)
        setDocumentPath(result.path)
        addRecentFile(result.path)
        await rebuildNativeAppMenu()
        showToast(`Saved ${recentFileLabel(result.path)}`)
      }
    } catch (err) {
      console.error('Duplicate save error:', err)
      showToast('Could not save duplicate.', 'error')
    }
  }

  const handlePrint = () => {
    window.print()
  }

  const handleShare = async () => {
    const body = code.trim()
    if (!body) {
      showToast('Nothing to share yet.', 'error')
      return
    }
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Mermaid diagram', text: body })
      } else {
        await navigator.clipboard.writeText(body)
        showToast('Diagram text copied — paste it into Mail, Messages, etc.')
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      try {
        await navigator.clipboard.writeText(body)
        showToast('Diagram text copied — paste it into Mail, Messages, etc.')
      } catch {
        showToast('Sharing is not available here.', 'error')
      }
    }
  }

  const handleEngineVersionInfo = () => {
    const show = async () => {
      const text = await buildMermalaidInfoText()
      if (isTauri()) {
        await message(text, { title: 'About Mermalaid', kind: 'info' })
      } else {
        window.alert(text)
      }
    }
    void show().catch((err) => {
      console.error('Failed to show Mermalaid info:', err)
      showToast('Failed to show Mermalaid info.', 'error')
    })
  }

  const handleShowLicenseInfo = () => {
    const show = async () => {
      if (isTauri()) {
        await message(LICENSE_INFO_TEXT, { title: 'Mermalaid License', kind: 'info' })
      } else {
        window.alert(LICENSE_INFO_TEXT)
      }
    }
    void show().catch((err) => {
      console.error('Failed to show license info:', err)
      showToast('Failed to show license info.', 'error')
    })
  }

  const handleExportSVG = async () => {
    const svgElement = document.querySelector('.preview-content svg')
    if (!svgElement) {
      showToast('No diagram to export', 'error')
      return
    }

    try {
      const result = await saveBlob(
        new Blob([svgElement.outerHTML], { type: 'image/svg+xml' }),
        SVG_EXPORT,
      )
      const toastMsg = toastMessageForSaveResult(result, 'Exported')
      if (toastMsg) showToast(toastMsg)
    } catch (err) {
      console.error('SVG export error:', err)
      showToast('Failed to export SVG.', 'error')
    }
  }

  const getPreviewSvg = (): SVGSVGElement | null =>
    document.querySelector('.preview-content svg') as SVGSVGElement | null

  /** Opens the resolution chooser; the export runs from {@link runPngExport}. */
  const handleExportPNG = () => {
    const svgElement = getPreviewSvg()
    const size = svgElement ? getSvgExportSize(svgElement) : null
    if (!svgElement || !size) {
      showToast('No diagram to export', 'error')
      return
    }
    setPngExportSize(size)
  }

  /** The same diagram with SVG `<text>` labels, for engines that cannot rasterize foreignObject. */
  const renderPlainLabelSvg = () => {
    const source = activeCode.trim()
    const { code: diagramCode, config: blockConfig } = parseMermaidWithConfig(source)
    return renderOfficialMermaidPreview(
      diagramCode,
      isDark,
      blockConfig ? mapMermaidConfigToThemeOptions(blockConfig) : getMermaidThemeOptions(mermaidTheme),
      parseMermaidConfigForOfficialRenderer(source),
      { plainTextLabels: true },
    )
  }

  const runPngExport = () => {
    const svgElement = getPreviewSvg()
    const size = pngExportSize
    if (!svgElement || !size) {
      showToast('No diagram to export', 'error')
      setPngExportSize(null)
      return
    }

    setIsExportingPng(true)
    void (async () => {
      try {
        const { markup, size: exportSize } = await prepareDiagramPngMarkup(
          svgElement,
          size,
          renderPlainLabelSvg,
        )
        const blob = await rasterizeSvgToPngBlob(markup, {
          size: exportSize,
          scale: pngExportScale,
          background: getAppThemeCssVars(mermaidTheme)['--app-bg'] ?? (isDark ? '#1e1e1e' : '#ffffff'),
        })

        const result = await saveBlob(blob, PNG_EXPORT)
        setPngExportSize(null)
        const toastMsg = toastMessageForSaveResult(result, 'Exported')
        if (toastMsg) showToast(toastMsg)
      } catch (err) {
        console.error('PNG export error:', err)
        showToast(
          'Failed to export PNG: ' + (err instanceof Error ? err.message : 'Unknown error'),
          'error',
        )
      } finally {
        setIsExportingPng(false)
      }
    })()
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null
  const activeDocumentTitle = activeTab ? tabTitle(activeTab) : 'diagram'

  /** Diagrams a scope contributes, in page order. */
  const pdfDiagramsFor = (scope: PdfExportScope): PdfDiagramEntry[] =>
    collectDiagramsFromTabs(scope === 'all' ? tabs : activeTab ? [activeTab] : [])

  const activeTabPdfDiagrams = pdfDiagramsFor('tab')
  const allTabsPdfDiagrams = pdfDiagramsFor('all')
  /** With one tab open the two scopes are the same export, so the choice is not worth offering. */
  const canExportAllTabs = tabs.length > 1
  const isExportingPdf = pdfProgress !== null

  /** Opens the PDF chooser; the export runs from {@link runPdfExport}. */
  const handleExportPDF = () => {
    if (allTabsPdfDiagrams.length === 0) {
      showToast('No diagrams to export', 'error')
      return
    }
    // An empty tab would otherwise open the dialog on a scope that cannot produce a page.
    setPdfExportScope(activeTabPdfDiagrams.length > 0 || !canExportAllTabs ? 'tab' : 'all')
    setShowPdfExport(true)
  }

  const runPdfExport = () => {
    const entries = pdfDiagramsFor(pdfExportScope)
    if (entries.length === 0) {
      showToast('No diagrams to export', 'error')
      return
    }

    const defaultThemeOptions = getMermaidThemeOptions(mermaidTheme)
    const background =
      getAppThemeCssVars(mermaidTheme)['--app-bg'] ?? (isDark ? '#1e1e1e' : '#ffffff')
    const exportingAll = pdfExportScope === 'all'

    setPdfProgress({ done: 0, total: entries.length })
    void (async () => {
      try {
        const { blob, pageCount, skipped } = await renderDiagramsToPdf(
          entries,
          {
            scale: pdfExportScale,
            background,
            render: (code, plainTextLabels) =>
              renderDiagramSvgMarkup(code, { isDark, defaultThemeOptions, plainTextLabels }),
            onProgress: (done, total) => setPdfProgress({ done, total }),
          },
          { title: exportingAll ? 'Mermalaid diagrams' : activeDocumentTitle },
        )

        const result = await saveBlob(
          blob,
          pdfExportKind(exportingAll ? ALL_TABS_PDF_NAME : pdfFileNameFor(activeDocumentTitle)),
        )
        setShowPdfExport(false)
        const toastMsg = toastMessageForSaveResult(
          result,
          `Exported ${pageCount} page${pageCount === 1 ? '' : 's'} to`,
        )
        if (toastMsg) {
          showToast(
            skipped.length > 0 ? `${toastMsg} — could not render ${skipped.join(', ')}` : toastMsg,
          )
        }
      } catch (err) {
        console.error('PDF export error:', err)
        showToast(
          'Failed to export PDF: ' + (err instanceof Error ? err.message : 'Unknown error'),
          'error',
        )
      } finally {
        setPdfProgress(null)
      }
    })()
  }

  const handleCopyCode = () => {
    const plainCode = activeCode.trim() || extractMermaidCode(code)
    const codeBlock = `\`\`\`mermaid\n${plainCode}\n\`\`\``
    navigator.clipboard.writeText(codeBlock)
    showToast('Code copied to clipboard')
  }

  const handleCopyPrivateLink = async () => {
    if (isCopyingPrivateLink) return
    setIsCopyingPrivateLink(true)
    const startedAt = Date.now()
    try {
      if (!code.trim()) {
        showToast('Nothing to share yet.', 'error')
        return
      }

      const hash = await withTimeout(
        encodePrivateShareHash({ code }),
        PRIVATE_LINK_ENCODE_TIMEOUT_MS,
        'Creating the private link took too long. Please refresh and try again.',
      )
      const fullUrl = buildPrivateShareUrl(hash)
      assertPrivateShareUrlFits(fullUrl)

      // Always show the link in the address bar (intuitive fallback; replaceState does not fire hashchange).
      applyPrivateShareFullUrlToHistory(fullUrl)

      let clipboardOk = false
      try {
        await copyPlainTextWhenReady(() => Promise.resolve(fullUrl))
        clipboardOk = true
      } catch {
        clipboardOk = false
      }

      if (clipboardOk) {
        showToast(
          isTauri()
            ? 'Private link copied to clipboard.'
            : 'Private link copied to clipboard. The same URL (with #v1…) is in the address bar if you need it again.',
        )
      } else {
        showToast(
          isTauri()
            ? 'Could not copy the link to the clipboard. Try again, or restart the app if this keeps happening.'
            : 'Private link is in the address bar. Press ⌘L or Ctrl+L to focus it, then ⌘C or Ctrl+C to copy (clipboard API was blocked).',
        )
      }
    } catch (err) {
      if (err instanceof PrivateShareError) {
        showToast(getPrivateShareErrorMessage(err), 'error')
        return
      }
      console.error('[mermalaid] Copy private link failed', err)
      showToast(formatClipboardFailureMessage(err), 'error')
    } finally {
      const elapsed = Date.now() - startedAt
      if (elapsed < PRIVATE_LINK_BUSY_MIN_MS) {
        await wait(PRIVATE_LINK_BUSY_MIN_MS - elapsed)
      }
      setIsCopyingPrivateLink(false)
    }
  }

  const handleCopyPreviewLink = async () => {
    if (isCopyingPreviewLink) return
    setIsCopyingPreviewLink(true)
    try {
      if (!activeCode.trim()) {
        showToast('Nothing to share yet.', 'error')
        return
      }

      // Public (not encrypted): the diagram is readable by the server so link
      // unfurls (Slack, etc.) can render a preview. Encode the extracted diagram.
      const origin = getShareLinkOrigin()
      const serverTheme = isDark ? 'dark' : 'default'
      const c = await encodePublicDiagram(activeCode)
      // When the deployment enables signing, get a signature so /api/og accepts it.
      const signature = await requestPreviewSignature(origin, c, serverTheme)
      const url = assemblePreviewUrl(origin, c, serverTheme, signature ?? undefined)

      // Warm the render cache so the first unfurl is instant (fire-and-forget).
      void fetch(url.replace('/p?', '/api/og?'), { mode: 'no-cors' }).catch(() => {})

      let clipboardOk = false
      try {
        await copyPlainTextWhenReady(() => Promise.resolve(url))
        clipboardOk = true
      } catch {
        clipboardOk = false
      }

      showToast(
        clipboardOk
          ? 'Public preview link copied — pasting it in Slack shows the diagram.'
          : 'Could not copy the link to the clipboard. Try again.',
        clipboardOk ? 'success' : 'error',
      )
    } catch (err) {
      if (err instanceof PublicShareLinkError) {
        showToast(err.message, 'error')
        return
      }
      console.error('[mermalaid] Copy preview link failed', err)
      showToast('Could not create a preview link. Please try again.', 'error')
    } finally {
      setIsCopyingPreviewLink(false)
    }
  }

  const handleExportAllSVG = async () => {
    if (mermaidBlocks.length === 0) {
      showToast('No diagrams to export', 'error')
      return
    }

    const defaultThemeOptions = getMermaidThemeOptions(mermaidTheme)
    const svgs: string[] = []

    for (let i = 0; i < mermaidBlocks.length; i++) {
      const rawBlock = mermaidBlocks[i].code
      try {
        const { code: diagramCode } = parseMermaidWithConfig(rawBlock)
        if (isMermaidAboutKeywordOnly(diagramCode)) {
          svgs.push(await buildMermalaidAboutPreviewHtml())
          continue
        }
        svgs.push(await renderDiagramSvgMarkup(rawBlock, { isDark, defaultThemeOptions }))
      } catch (err) {
        console.error(`Failed to render block ${i + 1}:`, err)
        svgs.push(`<p>Failed to render diagram ${i + 1}</p>`)
      }
    }

    const bg = isDark ? '#1e1e1e' : '#ffffff'
    const fg = isDark ? '#e0e0e0' : '#333333'
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Mermaid Diagrams</title>
<style>body{background:${bg};color:${fg};font-family:system-ui;padding:2rem}
.diagram{margin:2rem 0;padding:1rem;border:1px solid ${isDark ? '#444' : '#ddd'};border-radius:8px}
.diagram h2{margin:0 0 1rem;font-size:1rem}
.diagram svg{max-width:100%;height:auto}
.preview-about-mermalaid{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,Monaco,Consolas,monospace;font-size:13px;line-height:1.45;margin:0}</style></head><body>
<h1>Mermaid Diagrams (${svgs.length})</h1>
${svgs.map((svg, i) => `<div class="diagram"><h2>Diagram ${i + 1}</h2>${svg}</div>`).join('\n')}
</body></html>`

    const blob = new Blob([html], { type: 'text/html' })
    try {
      const result = await saveBlob(blob, HTML_EXPORT)
      const toastMsg = toastMessageForSaveResult(result, `Exported ${svgs.length} diagrams as`)
      if (toastMsg) showToast(toastMsg)
    } catch (err) {
      console.error('Export All error:', err)
      showToast('Failed to export diagrams.', 'error')
    }
  }

  const handleAIFix = async () => {
    const apiKey = getStoredApiKey()
    if (!apiKey) {
      showToast('Add your OpenAI API key in Settings to use AI Fix.', 'error')
      setShowSettings(true)
      return
    }

    if (!error || !code.trim()) {
      showToast('No error to fix', 'error')
      return
    }

    setIsFixing(true)
    try {
      const fixedCode = await fixMermaidErrorWithAI(code, error, apiKey)
      console.log('Setting fixed code:', fixedCode)
      setCode(fixedCode)
      showToast('Code fixed! Check if the diagram renders correctly.')
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to fix code'
      console.error('AI Fix error:', err)
      showToast(`AI Fix failed: ${errorMsg}`, 'error')
    } finally {
      setIsFixing(false)
    }
  }

  useImperativeHandle(ref, () => ({
    handleNew,
    handleOpen,
    handleSave,
    handleSaveAs,
    handlePrint,
    handleShare,
    handleDuplicate,
    handleEngineVersionInfo,
    handleShowLicenseInfo,
    openSettings: () => setShowSettings(true),
    openPath,
    openMobileActions: () => setShowMobileActions(true),
  }))

  const mobileToolbar = isMobile && (
    <>
      <div className="toolbar toolbar-mobile toolbar-mobile-sticky">
        <div className="toolbar-mobile-header">
          <div className="toolbar-mobile-brand">
            <img
              className="toolbar-mobile-logo"
              src="/apple-touch-icon.png"
              width={56}
              height={56}
              alt="Mermalaid"
              loading="eager"
              decoding="async"
            />
            <div className="toolbar-mobile-title">Mermalaid</div>
          </div>
          {error && <span className="toolbar-mobile-error">Syntax error</span>}
        </div>
      </div>

      {showMobileActions && (
        <div
          className="toolbar-mobile-sheet-backdrop"
          onClick={() => setShowMobileActions(false)}
        >
          <div
            className="toolbar-mobile-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="More actions"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="toolbar-mobile-sheet-header">
              <div>
                <div className="toolbar-mobile-sheet-title">More actions</div>
                <div className="toolbar-mobile-sheet-subtitle">Everything else you need on a phone</div>
              </div>
              <button
                type="button"
                className="toolbar-btn toolbar-mobile-close-btn"
                onClick={() => setShowMobileActions(false)}
                aria-label="Close more actions"
              >
                Close
              </button>
            </div>

            <div className="toolbar-mobile-sheet-section">
              <span className="toolbar-mobile-section-label">Workspace</span>
              <div className="toolbar-mobile-action-grid">
                <button type="button" onClick={() => { void handleOpen(); setShowMobileActions(false) }} className="toolbar-btn">
                  Open
                </button>
                <button type="button" onClick={() => { void handleSave(); setShowMobileActions(false) }} className="toolbar-btn">
                  Save
                </button>
                <button type="button" onClick={() => { handleNew(); setShowMobileActions(false) }} className="toolbar-btn">
                  New
                </button>
                <button
                  type="button"
                  disabled={isCopyingPrivateLink}
                  aria-busy={isCopyingPrivateLink}
                  onClick={() => {
                    // Keep the sheet open so the user can see the busy/disabled state,
                    // then close it after the operation finishes.
                    void (async () => {
                      try {
                        await handleCopyPrivateLink()
                      } catch (e) {
                        console.error('[mermalaid] Copy private link: unexpected error', e)
                        showToast(
                          e instanceof Error ? e.message : 'Could not create a private link. Please try again.',
                          'error',
                        )
                      } finally {
                        setShowMobileActions(false)
                      }
                    })()
                  }}
                  className="toolbar-btn"
                  title={PRIVATE_LINK_BUTTON_TITLE}
                >
                  {isCopyingPrivateLink ? 'Creating link…' : 'Share'}
                </button>
                <button
                  type="button"
                  disabled={isCopyingPreviewLink}
                  aria-busy={isCopyingPreviewLink}
                  onClick={() => {
                    void (async () => {
                      try {
                        await handleCopyPreviewLink()
                      } finally {
                        setShowMobileActions(false)
                      }
                    })()
                  }}
                  className="toolbar-btn"
                  title={PREVIEW_LINK_BUTTON_TITLE}
                >
                  {isCopyingPreviewLink ? 'Creating link…' : 'Preview link'}
                </button>
                <button type="button" onClick={() => { handleCopyCode(); setShowMobileActions(false) }} className="toolbar-btn">
                  Copy Code
                </button>
                {error && (
                  <button
                    type="button"
                    onClick={() => {
                      void handleAIFix().finally(() => setShowMobileActions(false))
                    }}
                    className="toolbar-btn ai-fix-btn"
                    disabled={isFixing}
                  >
                    {isFixing ? 'Fixing…' : 'AI Fix'}
                  </button>
                )}
              </div>
            </div>

            {onToggleAiChat && (
              <div className="toolbar-mobile-sheet-section">
                <span className="toolbar-mobile-section-label">Assistant</span>
                <div className="toolbar-mobile-action-grid">
                  <button
                    type="button"
                    onClick={() => { onToggleAiChat(); setShowMobileActions(false) }}
                    className="toolbar-btn"
                  >
                    AI Chat
                  </button>
                </div>
              </div>
            )}

            <div className="toolbar-mobile-sheet-section">
              <span className="toolbar-mobile-section-label">Export</span>
              <div className="toolbar-mobile-action-grid">
                <button type="button" onClick={() => { void handleExportSVG(); setShowMobileActions(false) }} className="toolbar-btn">
                  SVG
                </button>
                <button type="button" onClick={() => { void handleExportPNG(); setShowMobileActions(false) }} className="toolbar-btn">
                  PNG
                </button>
                <button type="button" onClick={() => { handleExportPDF(); setShowMobileActions(false) }} className="toolbar-btn">
                  PDF
                </button>
                {hasMultipleBlocks && (
                  <button type="button" onClick={() => { void handleExportAllSVG(); setShowMobileActions(false) }} className="toolbar-btn">
                    Export All
                  </button>
                )}
              </div>
            </div>

            <div className="toolbar-mobile-sheet-section">
              <label className="toolbar-mobile-section-label" htmlFor="mobile-theme-select">
                Theme
              </label>
              <select
                id="mobile-theme-select"
                value={mermaidTheme}
                onChange={(e) => setMermaidTheme(e.target.value as MermaidThemeId)}
                className="toolbar-select toolbar-mobile-select"
                title="Theme (diagram + app UI)"
              >
                {MERMAID_THEME_IDS.map((id) => (
                  <option key={id} value={id}>
                    {getMermaidThemeLabel(id)}
                  </option>
                ))}
              </select>
            </div>

            <div className="toolbar-mobile-sheet-section toolbar-mobile-sheet-footer">
              <button
                type="button"
                onClick={() => {
                  setShowMobileActions(false)
                  setShowSettings(true)
                }}
                className="toolbar-btn"
              >
                Settings
              </button>
              <a
                href="https://github.com/highvoltag3/mermalaid"
                target="_blank"
                rel="noopener noreferrer"
                className="toolbar-btn"
                onClick={() => setShowMobileActions(false)}
                title="View source code on GitHub"
              >
                GitHub
              </a>
            </div>
          </div>
        </div>
      )}
    </>
  )

  const pngExportDialog = (
    <ConfirmDialog
      open={pngExportSize !== null}
      title="Export PNG"
      message="The whole diagram is exported at its full size. Pick how much detail to keep."
      confirmLabel={isExportingPng ? 'Exporting…' : 'Export PNG'}
      cancelLabel="Cancel"
      busy={isExportingPng}
      onConfirm={runPngExport}
      onCancel={() => setPngExportSize(null)}
    >
      <fieldset className="png-export-options">
        <legend className="png-export-legend">Resolution</legend>
        {PNG_EXPORT_SCALES.map((scale) => {
          const output = pngExportSize ? getPngOutputSize(pngExportSize, scale) : null
          const limited =
            pngExportSize !== null && clampScaleToCanvasLimits(pngExportSize, scale) < scale
          return (
            <label key={scale} className="png-export-option">
              <input
                type="radio"
                name="png-export-scale"
                value={scale}
                checked={pngExportScale === scale}
                disabled={isExportingPng}
                onChange={() => {
                  setPngExportScale(scale)
                  storeScale(PNG_SCALE_STORAGE_KEY, scale)
                }}
              />
              <span className="png-export-option-label">
                {PNG_SCALE_LABELS[scale]} ({scale}×)
              </span>
              {output && (
                <span className="png-export-option-size">
                  {output.width} × {output.height} px{limited ? ' (limited)' : ''}
                </span>
              )}
            </label>
          )
        })}
      </fieldset>
    </ConfirmDialog>
  )

  const pdfProgressMessage = () => {
    if (!pdfProgress) return null
    if (pdfProgress.done >= pdfProgress.total) return 'Writing the PDF…'
    return `Rendering diagram ${pdfProgress.done + 1} of ${pdfProgress.total}…`
  }

  const pdfExportDialog = (
    <ConfirmDialog
      open={showPdfExport}
      title="Export PDF"
      message={
        pdfProgressMessage() ?? 'Every diagram becomes one page, at the size it has on screen.'
      }
      confirmLabel={isExportingPdf ? 'Exporting…' : 'Export PDF'}
      cancelLabel="Cancel"
      busy={isExportingPdf}
      onConfirm={runPdfExport}
      onCancel={() => setShowPdfExport(false)}
    >
      {canExportAllTabs && (
        <fieldset className="png-export-options">
          <legend className="png-export-legend">Diagrams</legend>
          {(
            [
              ['tab', `This tab (${activeDocumentTitle})`, activeTabPdfDiagrams.length],
              ['all', `All ${tabs.length} tabs, combined`, allTabsPdfDiagrams.length],
            ] as const
          ).map(([scope, label, pages]) => (
            <label key={scope} className="png-export-option">
              <input
                type="radio"
                name="pdf-export-scope"
                value={scope}
                checked={pdfExportScope === scope}
                disabled={isExportingPdf || pages === 0}
                onChange={() => setPdfExportScope(scope)}
              />
              <span className="png-export-option-label">{label}</span>
              <span className="png-export-option-size">
                {pages === 0 ? 'no diagrams' : `${pages} page${pages === 1 ? '' : 's'}`}
              </span>
            </label>
          ))}
        </fieldset>
      )}

      <fieldset className="png-export-options">
        <legend className="png-export-legend">Resolution</legend>
        {PNG_EXPORT_SCALES.map((scale) => (
          <label key={scale} className="png-export-option">
            <input
              type="radio"
              name="pdf-export-scale"
              value={scale}
              checked={pdfExportScale === scale}
              disabled={isExportingPdf}
              onChange={() => {
                setPdfExportScale(scale)
                storeScale(PDF_SCALE_STORAGE_KEY, scale)
              }}
            />
            <span className="png-export-option-label">
              {PNG_SCALE_LABELS[scale]} ({scale}×)
            </span>
            {/* A CSS pixel is 1/96", so the multiplier is the print resolution. */}
            <span className="png-export-option-size">{96 * scale} dpi</span>
          </label>
        ))}
      </fieldset>
    </ConfirmDialog>
  )

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".mmd,.txt,.md,.markdown"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />
      {pngExportDialog}
      {pdfExportDialog}
      {isMobile ? mobileToolbar : (
        <div className="toolbar">
          <div className="toolbar-section">
            <button type="button" onClick={handleNew} className="toolbar-btn" title="New (⌘N)">
              New
            </button>
            <button type="button" onClick={handleOpen} className="toolbar-btn" title="Open (⌘O)">
              Open
            </button>
            <button type="button" onClick={handleSave} className="toolbar-btn" title="Save (⌘S)">
              Save
            </button>
          </div>

          <div className="toolbar-section">
            <button onClick={handleExportSVG} className="toolbar-btn" title={hasMultipleBlocks ? 'Export selected block as SVG' : 'Export SVG'}>
              Export SVG
            </button>
            <button onClick={handleExportPNG} className="toolbar-btn" title={hasMultipleBlocks ? 'Export selected block as PNG' : 'Export PNG'}>
              Export PNG
            </button>
            <button onClick={handleExportPDF} className="toolbar-btn" title="Export PDF — this tab, or every open tab combined, one diagram per page">
              Export PDF
            </button>
            {hasMultipleBlocks && (
              <button onClick={handleExportAllSVG} className="toolbar-btn" title="Export all mermaid blocks in a single HTML file">
                Export All
              </button>
            )}
            {onToggleAiChat && (
              <button
                type="button"
                onClick={onToggleAiChat}
                className={`toolbar-btn ${aiChatOpen ? 'active' : ''}`}
                aria-pressed={aiChatOpen}
                title="Chat with Claude about this diagram"
              >
                AI Chat
              </button>
            )}
            <button onClick={handleCopyCode} className="toolbar-btn" title="Copy Code">
              Copy Code
            </button>
            <button
              type="button"
              disabled={isCopyingPrivateLink}
              aria-busy={isCopyingPrivateLink}
              onClick={() => {
                void handleCopyPrivateLink().catch((e) => {
                  console.error('[mermalaid] Copy private link: unexpected error', e)
                  showToast(
                    e instanceof Error ? e.message : 'Could not create a private link. Please try again.',
                    'error',
                  )
                })
              }}
              className="toolbar-btn"
              title={PRIVATE_LINK_BUTTON_TITLE}
            >
              {isCopyingPrivateLink ? 'Creating link…' : 'Share'}
            </button>
            <button
              type="button"
              disabled={isCopyingPreviewLink}
              aria-busy={isCopyingPreviewLink}
              onClick={() => {
                void handleCopyPreviewLink()
              }}
              className="toolbar-btn"
              title={PREVIEW_LINK_BUTTON_TITLE}
            >
              {isCopyingPreviewLink ? 'Creating link…' : 'Preview link'}
            </button>
            {error && (
              <button
                onClick={handleAIFix}
                className="toolbar-btn ai-fix-btn"
                title="AI Fix Error (uses OpenAI)"
                disabled={isFixing}
              >
                {isFixing ? '🔄 Fixing...' : '🤖 AI Fix'}
              </button>
            )}
          </div>

          <div className="toolbar-section">
            <select
              value={mermaidTheme}
              onChange={(e) => setMermaidTheme(e.target.value as MermaidThemeId)}
              className="toolbar-select"
              title="Theme (diagram + app UI)"
            >
              {MERMAID_THEME_IDS.map((id) => (
                <option key={id} value={id}>
                  {getMermaidThemeLabel(id)}
                </option>
              ))}
            </select>
            {agentBridge?.enabled && (
              <button
                onClick={() => setShowAgentPanel(true)}
                className="toolbar-btn"
                title={AGENT_STATUS_TITLE[agentBridge.status]}
              >
                <span
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    marginRight: 6,
                    verticalAlign: 'middle',
                    background: AGENT_STATUS_COLOR[agentBridge.status],
                  }}
                  aria-hidden="true"
                />
                Agent
              </button>
            )}
            <button onClick={() => setShowSettings(true)} className="toolbar-btn" title="Settings">
              ⚙️
            </button>
          </div>

          <div className="toolbar-section toolbar-section-right">
            <a
              href="https://github.com/highvoltag3/mermalaid"
              target="_blank"
              rel="noopener noreferrer"
              className="toolbar-btn github-btn"
              title="View source code on GitHub"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
              </svg>
            </a>
          </div>
        </div>
      )}
      <Settings isOpen={showSettings} onClose={() => setShowSettings(false)} />
      <AgentBridgePanel isOpen={showAgentPanel} onClose={() => setShowAgentPanel(false)} />
    </>
  )
})

Toolbar.displayName = 'Toolbar'

export default Toolbar

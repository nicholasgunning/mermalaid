import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

/**
 * README: PDF export — the focused tab, or every open tab combined, one diagram per page.
 * The file is written by hand (no PDF library), so these tests read the structure back out of the
 * bytes: page count, page boxes, and the compressed image stream a real reader needs.
 */
test.describe('PDF export (web)', () => {
  /** Page boxes, in points, in document order. */
  function pageBoxes(file: string): { width: number; height: number }[] {
    const pdf = readFileSync(file).toString('latin1')
    return [...pdf.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((match) => ({
      width: Number(match[1]),
      height: Number(match[2]),
    }))
  }

  function pdfText(file: string): string {
    return readFileSync(file).toString('latin1')
  }

  /** The diagram's own size, which drives the size of its page. */
  async function diagramSize(page: Page): Promise<{ width: number; height: number }> {
    return page.evaluate(() => {
      const svg = document.querySelector('.preview-content svg')
      const parts = (svg?.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
      return { width: parts[2], height: parts[3] }
    })
  }

  async function exportPdf(page: Page, scope: RegExp, file: string) {
    await page.getByRole('button', { name: 'Export PDF' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Export PDF' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('radio', { name: scope }).check()
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: 'Export PDF' }).click(),
    ])
    await download.saveAs(file)
    await expect(dialog).toBeHidden()
    return download
  }

  test.beforeEach(async ({ page }) => {
    // The File System Access picker is not usable under Playwright; force the download fallback.
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, 'showSaveFilePicker')
    })
    await page.goto('/editor')
    await expect(page.locator('.preview-content svg')).toBeVisible({ timeout: 30_000 })
  })

  test('exports the focused tab as a one-page PDF the size of the diagram', async ({
    page,
  }, testInfo) => {
    const diagram = await diagramSize(page)
    const file = testInfo.outputPath('one-tab.pdf')
    const download = await exportPdf(page, /This tab/, file)

    expect(download.suggestedFilename()).toBe('Untitled 1.pdf')
    const pdf = pdfText(file)
    expect(pdf.startsWith('%PDF-')).toBe(true)
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(pdf).toContain('/Count 1')

    // 96 CSS px to the inch, 72 points to the inch.
    const boxes = pageBoxes(file)
    expect(boxes).toHaveLength(1)
    expect(boxes[0].width).toBeCloseTo(Math.round(diagram.width * 0.75 * 100) / 100, 1)
    expect(boxes[0].height).toBeCloseTo(Math.round(diagram.height * 0.75 * 100) / 100, 1)

    // Chromium has CompressionStream, so the page image must be a compressed RGB image.
    expect(pdf).toContain('/Filter /FlateDecode')
    expect(pdf).toContain('/ColorSpace /DeviceRGB')
  })

  test('combines every open tab, one diagram per page', async ({ page }, testInfo) => {
    const firstDiagram = await diagramSize(page)

    await page.getByRole('button', { name: 'New', exact: true }).click()
    await page.getByRole('button', { name: 'New diagram', exact: true }).click()
    // The preview keeps the previous diagram until the new tab's render lands; measuring before
    // that would read the first diagram's size twice.
    await expect(page.locator('.preview-content svg')).not.toContainText('Decision')
    const secondDiagram = await diagramSize(page)
    // The starter diagram is smaller than the default one, so the pages must differ in size.
    expect(secondDiagram.height).not.toBeCloseTo(firstDiagram.height, 0)

    const file = testInfo.outputPath('all-tabs.pdf')
    const download = await exportPdf(page, /All 2 tabs/, file)

    expect(download.suggestedFilename()).toBe('diagrams.pdf')
    const boxes = pageBoxes(file)
    expect(boxes).toHaveLength(2)
    expect(pdfText(file)).toContain('/Count 2')
    // Page order follows tab order, and each page keeps its own diagram's proportions.
    expect(boxes[0].height / boxes[0].width).toBeCloseTo(firstDiagram.height / firstDiagram.width, 1)
    expect(boxes[1].height / boxes[1].width).toBeCloseTo(
      secondDiagram.height / secondDiagram.width,
      1,
    )
  })

  test('gives a multi-diagram document one page per diagram', async ({ page }, testInfo) => {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Open', exact: true }).click(),
    ])
    await chooser.setFiles({
      name: 'notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(
        '# Notes\n\n```mermaid\ngraph TD\n  A-->B\n```\n\n```mermaid\ngraph LR\n  C-->D\n```\n\n```mermaid\ngraph TD\n  E-->F\n```\n',
      ),
    })
    await expect(page.locator('.preview-content svg')).toBeVisible({ timeout: 30_000 })

    const file = testInfo.outputPath('multi-block.pdf')
    const download = await exportPdf(page, /This tab/, file)

    expect(download.suggestedFilename()).toBe('notes.pdf')
    expect(pageBoxes(file)).toHaveLength(3)
  })

  test('shows how many pages each choice produces, and remembers the resolution', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'New', exact: true }).click()
    await page.getByRole('button', { name: 'New diagram', exact: true }).click()

    await page.getByRole('button', { name: 'Export PDF' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Export PDF' })
    await expect(dialog.getByRole('radio', { name: /This tab/ })).toBeChecked()
    await expect(dialog.getByRole('radio', { name: /This tab/ })).toHaveAccessibleName(/1 page/)
    await expect(dialog.getByRole('radio', { name: /All 2 tabs/ })).toHaveAccessibleName(/2 pages/)

    await dialog.getByRole('radio', { name: /Ultra/ }).check()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()

    await page.reload()
    await expect(page.locator('.preview-content svg')).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Export PDF' }).first().click()
    await expect(dialog.getByRole('radio', { name: /Ultra/ })).toBeChecked()
  })

  test('offers only the combined export while the focused tab is empty', async ({ page }) => {
    await page.getByRole('button', { name: 'New', exact: true }).click()
    await expect(page.getByRole('button', { name: 'New diagram', exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Export PDF' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Export PDF' })
    await expect(dialog.getByRole('radio', { name: /This tab/ })).toBeDisabled()
    await expect(dialog.getByRole('radio', { name: /All 2 tabs/ })).toBeChecked()
  })
})

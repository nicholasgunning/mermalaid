import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

/**
 * README: PNG export captures the whole diagram at a chosen resolution.
 * The old export screenshotted the preview pane, so it was cropped to the viewport, followed the
 * current zoom and included the zoom toolbar — these tests pin the diagram-sized behaviour.
 */
test.describe('PNG export (web)', () => {
  /** Width/height from the PNG's IHDR chunk. */
  function pngSize(file: string): { width: number; height: number } {
    const buffer = readFileSync(file)
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }

  /** The diagram's own size, which the export must match (times the chosen resolution). */
  async function diagramSize(page: Page): Promise<{ width: number; height: number }> {
    return page.evaluate(() => {
      const svg = document.querySelector('.preview-content svg')
      const parts = (svg?.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
      return { width: parts[2], height: parts[3] }
    })
  }

  async function exportPng(page: Page, option: RegExp, file: string) {
    await page.getByRole('button', { name: 'Export PNG' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Export PNG' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('radio', { name: option }).check()
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: 'Export PNG' }).click(),
    ])
    expect(download.suggestedFilename()).toBe('diagram.png')
    await download.saveAs(file)
    await expect(dialog).toBeHidden()
    return pngSize(file)
  }

  test.beforeEach(async ({ page }) => {
    // The File System Access picker is not usable under Playwright; force the download fallback.
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, 'showSaveFilePicker')
    })
    await page.goto('/editor')
    await expect(page.locator('.preview-content svg')).toBeVisible({ timeout: 30_000 })
  })

  test('exports the diagram at its own size, and scales with the chosen resolution', async ({
    page,
  }, testInfo) => {
    const diagram = await diagramSize(page)
    expect(diagram.width).toBeGreaterThan(0)

    const standard = await exportPng(page, /Standard/, testInfo.outputPath('1x.png'))
    expect(standard.width).toBe(Math.round(diagram.width))
    expect(standard.height).toBe(Math.round(diagram.height))

    const ultra = await exportPng(page, /Ultra/, testInfo.outputPath('4x.png'))
    expect(ultra.width).toBe(Math.round(diagram.width * 4))
    expect(ultra.height).toBe(Math.round(diagram.height * 4))
  })

  test('ignores the preview zoom, so the image is never cropped to the viewport', async ({
    page,
  }, testInfo) => {
    const before = await exportPng(page, /High/, testInfo.outputPath('before-zoom.png'))

    await page.getByRole('button', { name: 'Zoom in' }).click()
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await page.waitForTimeout(400)

    const after = await exportPng(page, /High/, testInfo.outputPath('after-zoom.png'))
    expect(after).toEqual(before)
  })

  test('shows the output dimensions for each resolution and remembers the choice', async ({
    page,
  }) => {
    const diagram = await diagramSize(page)
    await page.getByRole('button', { name: 'Export PNG' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Export PNG' })

    await expect(dialog.getByRole('radio', { name: /High/ })).toBeChecked()
    await expect(dialog).toContainText(
      `${Math.round(diagram.width * 3)} × ${Math.round(diagram.height * 3)} px`,
    )

    await dialog.getByRole('radio', { name: /Very high/ }).check()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()

    await page.reload()
    await expect(page.locator('.preview-content svg')).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Export PNG' }).first().click()
    await expect(dialog.getByRole('radio', { name: /Very high/ })).toBeChecked()
  })
})

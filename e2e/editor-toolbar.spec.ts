import { expect, test } from '@playwright/test'

/**
 * README: keyboard shortcuts (⌘/Ctrl+N), Save, SVG export, Copy Code, themes.
 * Runs against web build only (no Tauri dialogs).
 */
test.describe('Editor toolbar (web)', () => {
  test.beforeEach(async ({ page }) => {
    // File System Access save picker is not usable under Playwright. Force the
    // anchor-download fallback so Save / Export still emit download events.
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, 'showSaveFilePicker')
    })
    await page.goto('/editor')
    await expect(page.locator('.preview-svg-host')).toBeVisible({ timeout: 30_000 })
  })

  test('Copy Code puts fenced mermaid in the clipboard', async ({ page }) => {
    await page.getByRole('button', { name: 'Copy Code' }).click()
    await expect(page.getByText('Code copied to clipboard')).toBeVisible()

    const clip = await page.evaluate(() => navigator.clipboard.readText())
    expect(clip.trimStart()).toMatch(/^```mermaid\s*\n/)
    expect(clip).toContain('graph TD')
    expect(clip.trimEnd()).toMatch(/```\s*$/)
  })

  test('Save downloads diagram.mmd', async ({ page }) => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Save' }).click(),
    ])
    expect(download.suggestedFilename()).toBe('diagram.mmd')
    await expect(page.getByText('Saved diagram.mmd')).toBeVisible()
  })

  test('Export SVG downloads diagram.svg', async ({ page }) => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export SVG' }).click(),
    ])
    expect(download.suggestedFilename()).toBe('diagram.svg')
    await expect(page.getByText('Exported diagram.svg')).toBeVisible()
  })

  test('theme select toggles app dark class for github-dark', async ({ page }) => {
    await page.locator('select.toolbar-select').selectOption('github-dark')
    await expect(page.locator('.app.app-theme-dark')).toBeVisible()
    await page.locator('select.toolbar-select').selectOption('github-light')
    await expect(page.locator('.app.app-theme-light')).toBeVisible()
  })

  test('Ctrl+N opens an empty tab offering both ways to fill it', async ({ page }) => {
    const tabs = page.getByRole('tablist', { name: 'Open diagrams' }).getByRole('tab')
    await expect(tabs).toHaveCount(1)

    // Nothing is discarded any more, so New needs no confirmation.
    await page.keyboard.press('Control+N')

    await expect(tabs).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'New diagram', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open .mmd file…', exact: true })).toBeVisible()
    await expect(page.locator('.error-indicator')).toHaveCount(0)
  })
})

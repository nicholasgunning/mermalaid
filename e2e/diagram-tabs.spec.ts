import { expect, test, type Page } from '@playwright/test'

/**
 * README: multiple diagram tabs — keep several `.mmd` documents open and switch between them.
 * Runs against the web build only (no Tauri file dialogs).
 */
test.describe('Diagram tabs (web)', () => {
  const tabs = (page: Page) =>
    page.getByRole('tablist', { name: 'Open diagrams' }).getByRole('tab')

  /** Monaco only renders the visible lines, so assert on the editor's view-lines. */
  const editorText = (page: Page) => page.locator('.editor-monaco-host .view-lines')

  test.beforeEach(async ({ page }) => {
    // The File System Access picker is not usable under Playwright; force the download fallback.
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, 'showSaveFilePicker')
    })
    await page.goto('/editor')
    await expect(page.locator('.preview-svg-host')).toBeVisible({ timeout: 30_000 })
  })

  test('New adds a tab, and each tab keeps its own diagram', async ({ page }) => {
    await expect(tabs(page)).toHaveCount(1)
    await expect(tabs(page).first()).toHaveAttribute('aria-selected', 'true')
    await expect(editorText(page)).toContainText('Decision')

    await page.getByRole('button', { name: 'New', exact: true }).click()

    await expect(tabs(page)).toHaveCount(2)
    await expect(page.getByRole('tab', { name: /^Untitled 2/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    // The new tab starts from the empty-diagram seed, not the first tab's content.
    await expect(editorText(page)).toContainText('A[Start] --> B[End]')
    await expect(editorText(page)).not.toContainText('Decision')

    await page.getByRole('tab', { name: 'Untitled 1' }).click()
    await expect(editorText(page)).toContainText('Decision')

    await page.getByRole('tab', { name: /^Untitled 2/ }).click()
    await expect(editorText(page)).toContainText('A[Start] --> B[End]')
  })

  test('an unsaved tab is marked, and only closes once that is confirmed', async ({ page }) => {
    await page.getByRole('button', { name: 'New', exact: true }).click()
    await expect(tabs(page)).toHaveCount(2)

    await editorText(page).click()
    await page.keyboard.type('\n%% work in progress')
    await expect(editorText(page)).toContainText('work in progress')
    await expect(page.getByRole('tab', { name: /^Untitled 2/ })).toContainText('unsaved changes')

    // Keep editing: the tab and its edits stay put.
    await page.getByRole('button', { name: /^Close Untitled 2/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Unsaved changes' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Keep editing' }).click()
    await expect(dialog).toBeHidden()
    await expect(tabs(page)).toHaveCount(2)
    await expect(editorText(page)).toContainText('work in progress')

    // Escape is the same answer as Keep editing.
    await page.getByRole('button', { name: /^Close Untitled 2/ }).click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(tabs(page)).toHaveCount(2)

    await page.getByRole('button', { name: /^Close Untitled 2/ }).click()
    await dialog.getByRole('button', { name: 'Close without saving' }).click()
    await expect(tabs(page)).toHaveCount(1)
    await expect(editorText(page)).toContainText('Decision')
  })

  test('saving names the tab after the file and clears the unsaved marker', async ({ page }) => {
    await editorText(page).click()
    await page.keyboard.type('\n%% about to save')
    await expect(page.getByRole('tab', { name: /^Untitled 1/ })).toContainText('unsaved changes')

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Save', exact: true }).click(),
    ])
    expect(download.suggestedFilename()).toBe('diagram.mmd')

    await expect(tabs(page)).toHaveCount(1)
    await expect(tabs(page).first()).toHaveText('diagram.mmd')
  })

  test('open tabs survive a reload', async ({ page }) => {
    await page.getByRole('button', { name: 'New', exact: true }).click()
    await expect(tabs(page)).toHaveCount(2)

    // Autosave is debounced; reload only once both tabs have reached storage.
    await page.waitForFunction(() => {
      const raw = localStorage.getItem('mermalaid-tabs')
      if (!raw) return false
      return (JSON.parse(raw).tabs?.length ?? 0) === 2
    })
    await page.reload()

    await expect(page.locator('.preview-svg-host')).toBeVisible({ timeout: 30_000 })
    await expect(tabs(page)).toHaveCount(2)
    await expect(tabs(page).nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(editorText(page)).toContainText('A[Start] --> B[End]')
  })
})

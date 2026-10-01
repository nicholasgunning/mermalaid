/**
 * README § AI Assistant — the API key is kept in this browser so it is typed once.
 *
 * These pin the part that is easy to regress: the key is written as it is typed, so no way of
 * leaving the dialog can throw it away, and the dialog says whether it actually landed.
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings'
import { ThemeProvider } from '../contexts/ThemeContext'

const KEY = 'sk-ant-api03-abcdefghijklmnop'

function renderSettings(isOpen = true, onClose = vi.fn()) {
  const result = render(
    <ThemeProvider>
      <Settings isOpen={isOpen} onClose={onClose} />
    </ThemeProvider>,
  )
  const rerender = (open: boolean) =>
    result.rerender(
      <ThemeProvider>
        <Settings isOpen={open} onClose={onClose} />
      </ThemeProvider>,
    )
  return { ...result, rerender, onClose }
}

const anthropicField = () => screen.getByLabelText('Anthropic API Key')

describe('Settings', () => {
  beforeEach(() => localStorage.clear())

  afterEach(() => {
    // This project does not enable Vitest globals, so RTL's auto-cleanup is not installed.
    cleanup()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('keeps the key as it is typed, with no Save to remember', async () => {
    const user = userEvent.setup()
    renderSettings()

    await user.type(anthropicField(), KEY)

    expect(localStorage.getItem('anthropic-api-key')).toBe(KEY)
    expect(screen.getByText(/Saved in this browser/)).toBeInTheDocument()
  })

  it('still has the key after the dialog is closed and reopened', async () => {
    const user = userEvent.setup()
    const { rerender } = renderSettings()

    await user.type(anthropicField(), KEY)
    // Closed with the × rather than a Save button — the old flow lost the key here.
    await user.click(screen.getByRole('button', { name: 'Close settings' }))
    rerender(false)
    rerender(true)

    expect(anthropicField()).toHaveValue(KEY)
    expect(screen.getByText(/Saved in this browser/)).toBeInTheDocument()
  })

  it('loads a key stored by an earlier session', () => {
    localStorage.setItem('anthropic-api-key', KEY)
    renderSettings()

    expect(anthropicField()).toHaveValue(KEY)
    expect(screen.getByText(/Saved in this browser/)).toBeInTheDocument()
  })

  it('clears the key on request, and remembers that it is gone', async () => {
    const user = userEvent.setup()
    localStorage.setItem('anthropic-api-key', KEY)
    renderSettings()

    await user.click(screen.getAllByRole('button', { name: 'Clear' })[0])

    expect(localStorage.getItem('anthropic-api-key')).toBeNull()
    expect(anthropicField()).toHaveValue('')
    expect(screen.queryByText(/Saved in this browser/)).not.toBeInTheDocument()
  })

  it('says so when the browser refuses to store the key, instead of losing it quietly', async () => {
    const user = userEvent.setup()
    // Only this key is blocked: the theme and the rest of the app keep their own storage working.
    const realSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === 'anthropic-api-key') throw new DOMException('quota', 'QuotaExceededError')
      realSetItem.call(this, key, value)
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    renderSettings()
    await user.type(anthropicField(), KEY)

    expect(screen.getByText(/would not store the key/i)).toBeInTheDocument()
  })

  it('warns about a key that is not shaped like an Anthropic one', async () => {
    const user = userEvent.setup()
    renderSettings()

    await user.type(anthropicField(), 'sk-proj-this-is-an-openai-key')

    expect(screen.getByText(/keys start with/i)).toBeInTheDocument()
  })
})

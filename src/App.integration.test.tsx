import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import * as privateUrlShare from './utils/privateUrlShare'

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: async () => [] as string[],
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
}))

vi.mock('./nativeAppMenu', () => ({
  initNativeAppMenu: async () => {},
  setNativeMenuHandlerSource: () => {},
}))

vi.mock('./hooks/useUpdateCheck', () => ({
  useUpdateCheck: () => ({ update: null, dismiss: () => {} }),
}))

vi.mock('./utils/privateUrlShare', async () => {
  const actual = await vi.importActual<typeof import('./utils/privateUrlShare')>('./utils/privateUrlShare')
  return {
    ...actual,
    encodePrivateShareHash: vi.fn(actual.encodePrivateShareHash),
  }
})

vi.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: function MonacoEditorMock({
    value,
    onChange,
  }: {
    value?: string
    onChange?: (value: string) => void
  }) {
    return (
      <>
        <div data-testid="monaco-editor-mock">{value}</div>
        {/* Editable stand-in so tests can change a document the way typing would. */}
        <textarea
          data-testid="monaco-editor-input"
          value={value ?? ''}
          onChange={(event) => onChange?.(event.target.value)}
        />
      </>
    )
  },
  loader: {
    init: async () => ({
      languages: {
        register: () => {},
        setMonarchTokensProvider: () => {},
        setLanguageConfiguration: () => {},
      },
    }),
  },
}))

describe('App (web)', () => {
  const setViewportWidth = (width: number) => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: width,
    })
    window.dispatchEvent(new Event('resize'))
  }

  beforeEach(() => {
    localStorage.clear()
    setViewportWidth(1280)
    vi.restoreAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders landing with editor entry point on /', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(screen.getAllByRole('link', { name: /go to editor/i }).length).toBeGreaterThan(0)
      expect(screen.getAllByRole('link', { name: /download for mac/i }).length).toBeGreaterThan(0)
      expect(screen.getAllByRole('link', { name: /view on github/i }).length).toBeGreaterThan(0)
    })
  })

  it('renders editor shell on /editor', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/editor']}>
        <App />
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(container.querySelector('.toolbar')).toBeTruthy()
      expect(container.querySelector('.editor-container')).toBeTruthy()
      expect(container.querySelector('.preview-container')).toBeTruthy()
    })
  })

  it('switches between preview and editor in smartphone mode', async () => {
    setViewportWidth(390)
    const user = userEvent.setup()
    const { container } = render(
      <MemoryRouter initialEntries={['/editor']}>
        <App />
      </MemoryRouter>,
    )
    const queries = within(container)

    await waitFor(() => {
      expect(queries.getByRole('tab', { name: 'Code' })).toBeInTheDocument()
      expect(queries.getByRole('tab', { name: 'Preview' })).toBeInTheDocument()
      expect(container.querySelector('.toolbar-mobile')).toBeTruthy()
      expect(container.querySelector('.preview-container')).toBeTruthy()
      expect(container.querySelector('.editor-container')).toBeFalsy()
    })

    await user.click(queries.getByRole('tab', { name: 'Code' }))

    await waitFor(() => {
      expect(container.querySelector('.editor-container')).toBeTruthy()
      expect(container.querySelector('.preview-container')).toBeFalsy()
      expect(queries.getByTestId('monaco-editor-mock')).toHaveTextContent('graph TD')
    })
  })

  it('opens the compact mobile actions sheet on smartphones', async () => {
    setViewportWidth(412)
    const user = userEvent.setup()

    const { container } = render(
      <MemoryRouter initialEntries={['/editor']}>
        <App />
      </MemoryRouter>,
    )
    const queries = within(container)

    await waitFor(() => {
      expect(queries.getByRole('button', { name: 'More' })).toBeInTheDocument()
    })

    await user.click(queries.getByRole('button', { name: 'More' }))

    await waitFor(() => {
      expect(queries.getByRole('dialog', { name: 'More actions' })).toBeInTheDocument()
      expect(queries.getByRole('button', { name: 'Copy Code' })).toBeInTheDocument()
      expect(queries.getByRole('button', { name: 'SVG' })).toBeInTheDocument()
      expect(queries.getByLabelText('Theme')).toBeInTheDocument()
    })
  })

  it('opens a second diagram tab and keeps each tab’s code separate', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <MemoryRouter initialEntries={['/editor']}>
        <App />
      </MemoryRouter>,
    )
    const queries = within(container)

    const tabList = await waitFor(() => queries.getByRole('tablist', { name: 'Open diagrams' }))
    expect(within(tabList).getAllByRole('tab')).toHaveLength(1)

    await user.click(queries.getByRole('button', { name: 'New' }))

    await waitFor(() => {
      expect(within(tabList).getAllByRole('tab')).toHaveLength(2)
      expect(within(tabList).getByRole('tab', { name: 'Untitled 2' })).toHaveAttribute(
        'aria-selected',
        'true',
      )
      // A new tab is an empty workspace offering both ways to fill it.
      expect(queries.getByTestId('monaco-editor-mock')).toHaveTextContent('')
      expect(queries.getByRole('button', { name: 'New diagram' })).toBeInTheDocument()
      expect(queries.getByRole('button', { name: 'Open .mmd file…' })).toBeInTheDocument()
    })

    await user.click(within(tabList).getByRole('tab', { name: 'Untitled 1' }))

    await waitFor(() => {
      expect(queries.getByTestId('monaco-editor-mock')).toHaveTextContent('B{Decision}')
    })
  })

  it('starts a diagram in the empty tab without opening another one', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <MemoryRouter initialEntries={['/editor']}>
        <App />
      </MemoryRouter>,
    )
    const queries = within(container)

    await waitFor(() => expect(queries.getByRole('button', { name: 'New' })).toBeInTheDocument())
    await user.click(queries.getByRole('button', { name: 'New' }))

    const tabList = queries.getByRole('tablist', { name: 'Open diagrams' })
    await waitFor(() => expect(within(tabList).getAllByRole('tab')).toHaveLength(2))

    await user.click(await screen.findByRole('button', { name: 'New diagram' }))

    await waitFor(() => {
      expect(queries.getByTestId('monaco-editor-mock')).toHaveTextContent('A[Start] --> B[End]')
      expect(queries.queryByRole('button', { name: 'New diagram' })).not.toBeInTheDocument()
    })
    // Filled in place: still two tabs, still the same one focused, still named Untitled 2.
    expect(within(tabList).getAllByRole('tab')).toHaveLength(2)
    expect(within(tabList).getByRole('tab', { name: 'Untitled 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('opens a file into the empty tab from its start screen', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <MemoryRouter initialEntries={['/editor']}>
        <App />
      </MemoryRouter>,
    )
    const queries = within(container)

    await waitFor(() => expect(queries.getByRole('button', { name: 'New' })).toBeInTheDocument())
    await user.click(queries.getByRole('button', { name: 'New' }))

    const tabList = queries.getByRole('tablist', { name: 'Open diagrams' })
    await waitFor(() => expect(within(tabList).getAllByRole('tab')).toHaveLength(2))

    // The start screen's Open goes through the same file input the toolbar uses.
    await user.click(await screen.findByRole('button', { name: 'Open .mmd file…' }))
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(
      fileInput,
      new File(['graph LR\n  Opened-->File'], 'opened.mmd', { type: 'text/plain' }),
    )

    await waitFor(() => {
      expect(queries.getByTestId('monaco-editor-mock')).toHaveTextContent('Opened-->File')
    })
    // The file filled the empty tab and named it, rather than opening a third tab.
    expect(within(tabList).getAllByRole('tab')).toHaveLength(2)
    expect(within(tabList).getByRole('tab', { name: 'opened.mmd' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('closes a diagram tab from the tab bar', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <MemoryRouter initialEntries={['/editor']}>
        <App />
      </MemoryRouter>,
    )
    const queries = within(container)

    await waitFor(() => expect(queries.getByRole('button', { name: 'New' })).toBeInTheDocument())
    await user.click(queries.getByRole('button', { name: 'New' }))

    const tabList = queries.getByRole('tablist', { name: 'Open diagrams' })
    await waitFor(() => expect(within(tabList).getAllByRole('tab')).toHaveLength(2))

    await user.click(queries.getByRole('button', { name: 'Close Untitled 2' }))

    await waitFor(() => {
      expect(within(tabList).getAllByRole('tab')).toHaveLength(1)
      expect(within(tabList).getByRole('tab', { name: 'Untitled 1' })).toHaveAttribute(
        'aria-selected',
        'true',
      )
    })
  })

  it('only closes a tab with unsaved changes once that is confirmed', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <MemoryRouter initialEntries={['/editor']}>
        <App />
      </MemoryRouter>,
    )
    const queries = within(container)

    await waitFor(() => expect(queries.getByRole('button', { name: 'New' })).toBeInTheDocument())
    await user.click(queries.getByRole('button', { name: 'New' }))

    const tabList = queries.getByRole('tablist', { name: 'Open diagrams' })
    await waitFor(() => expect(within(tabList).getAllByRole('tab')).toHaveLength(2))

    await user.type(queries.getByTestId('monaco-editor-input'), '\n%% unsaved work')
    await waitFor(() =>
      expect(within(tabList).getByRole('tab', { name: /unsaved changes/i })).toBeInTheDocument(),
    )

    // Cancelling leaves the tab and its edits exactly where they were.
    await user.click(queries.getByRole('button', { name: 'Close Untitled 2' }))
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' })
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Unsaved changes' })).not.toBeInTheDocument()
    })
    expect(within(tabList).getAllByRole('tab')).toHaveLength(2)
    expect(queries.getByTestId('monaco-editor-mock')).toHaveTextContent('unsaved work')

    // Confirming discards them.
    await user.click(queries.getByRole('button', { name: 'Close Untitled 2' }))
    const reopened = await screen.findByRole('dialog', { name: 'Unsaved changes' })
    await user.click(within(reopened).getByRole('button', { name: 'Close without saving' }))

    await waitFor(() => {
      expect(within(tabList).getAllByRole('tab')).toHaveLength(1)
      expect(queries.getByTestId('monaco-editor-mock')).toHaveTextContent('B{Decision}')
    })
  })

  it('restores every open tab after a reload', async () => {
    const user = userEvent.setup()
    const first = render(
      <MemoryRouter initialEntries={['/editor']}>
        <App />
      </MemoryRouter>,
    )

    await waitFor(() =>
      expect(within(first.container).getByRole('button', { name: 'New' })).toBeInTheDocument(),
    )
    await user.click(within(first.container).getByRole('button', { name: 'New' }))
    await waitFor(() =>
      expect(
        within(within(first.container).getByRole('tablist', { name: 'Open diagrams' })).getAllByRole(
          'tab',
        ),
      ).toHaveLength(2),
    )

    // Autosave is debounced; give it time before tearing the app down.
    await waitFor(() => expect(localStorage.getItem('mermalaid-tabs')).toBeTruthy())
    cleanup()

    const second = render(
      <MemoryRouter initialEntries={['/editor']}>
        <App />
      </MemoryRouter>,
    )
    await waitFor(() => {
      const tabs = within(
        within(second.container).getByRole('tablist', { name: 'Open diagrams' }),
      ).getAllByRole('tab')
      expect(tabs.map((tab) => tab.textContent)).toEqual(['Untitled 1', 'Untitled 2'])
    })
  })

  it('shows the mobile Share button as busy while creating a private link', async () => {
    setViewportWidth(412)
    const user = userEvent.setup()

    const encodePrivateShareHashMock = vi
      .mocked(privateUrlShare.encodePrivateShareHash)
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve('#v1.mock-link'), 50)
          }),
      )

    render(
      <MemoryRouter initialEntries={['/editor']}>
        <App />
      </MemoryRouter>,
    )

    const moreButton = await screen.findByRole('button', { name: 'More' })
    await user.click(moreButton)

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'More actions' })).toBeInTheDocument()
    })

    const shareButton = await screen.findByRole('button', { name: 'Share' })
    await user.click(shareButton)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Creating link…' })).toBeDisabled()
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Share' })).not.toBeDisabled()
    })

    expect(encodePrivateShareHashMock).toHaveBeenCalled()
  })
})

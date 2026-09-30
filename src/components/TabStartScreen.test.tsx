import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TabStartScreen from './TabStartScreen'
import { recentFileLabel } from '../utils/recentFiles'

describe('TabStartScreen', () => {
  // This project does not enable Vitest globals, so RTL's auto-cleanup is not installed.
  afterEach(() => {
    cleanup()
  })

  const actions = () => ({ onNewDiagram: vi.fn(), onOpenFile: vi.fn() })

  it('offers both ways to fill the tab', async () => {
    const user = userEvent.setup()
    const { onNewDiagram, onOpenFile } = actions()
    render(<TabStartScreen onNewDiagram={onNewDiagram} onOpenFile={onOpenFile} />)

    await user.click(screen.getByRole('button', { name: 'New diagram' }))
    expect(onNewDiagram).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: 'Open .mmd file…' }))
    expect(onOpenFile).toHaveBeenCalledOnce()
  })

  it('lists recent files by name and opens the one picked', async () => {
    const user = userEvent.setup()
    const onOpenRecent = vi.fn()
    render(
      <TabStartScreen
        {...actions()}
        recentPaths={['/Users/me/diagrams/flow.mmd', '/Users/me/notes/arch.md']}
        onOpenRecent={onOpenRecent}
        fileLabel={recentFileLabel}
      />,
    )

    const recent = screen.getByRole('button', { name: 'flow.mmd' })
    expect(recent).toHaveAttribute('title', '/Users/me/diagrams/flow.mmd')
    expect(screen.getByRole('button', { name: 'arch.md' })).toBeInTheDocument()

    await user.click(recent)
    expect(onOpenRecent).toHaveBeenCalledWith('/Users/me/diagrams/flow.mmd')
  })

  it('leaves out the recent files section when there is nothing to list', () => {
    const { rerender } = render(<TabStartScreen {...actions()} recentPaths={[]} onOpenRecent={vi.fn()} />)
    expect(screen.queryByText('Recent files')).not.toBeInTheDocument()

    // Also hidden on the web, where there is no handler to reopen a path with.
    rerender(<TabStartScreen {...actions()} recentPaths={['/a.mmd']} />)
    expect(screen.queryByText('Recent files')).not.toBeInTheDocument()
  })

  it('points at the editor differently on a phone, where it is behind a tab', () => {
    const { rerender } = render(<TabStartScreen {...actions()} />)
    expect(screen.getByText(/drop a file here/i)).toBeInTheDocument()

    rerender(<TabStartScreen {...actions()} isMobile />)
    expect(screen.getByText(/switch to Code/i)).toBeInTheDocument()
  })
})

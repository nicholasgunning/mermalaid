import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import TabBar from './TabBar'
import { createTab, type DiagramTab } from '../utils/documentTabs'

/** Three equal 100px tabs laid out from x=0, so drop targets are predictable. */
const TAB_WIDTH = 100

function tabsFixture(): DiagramTab[] {
  return [
    createTab({ name: 'One', code: 'a' }),
    createTab({ name: 'Two', code: 'b' }),
    createTab({ name: 'Three', code: 'c' }),
  ]
}

/** jsdom lays nothing out: hand the drop-target maths the geometry it would measure in a browser. */
function stubStripGeometry() {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const index = Number(this.getAttribute('data-test-index') ?? 0)
    const left = index * TAB_WIDTH
    return {
      x: left,
      y: 0,
      left,
      right: left + TAB_WIDTH,
      top: 0,
      bottom: 30,
      width: TAB_WIDTH,
      height: 30,
      toJSON: () => ({}),
    } as DOMRect
  }
}

function renderBar(tabs: DiagramTab[], overrides: Partial<Parameters<typeof TabBar>[0]> = {}) {
  const props = {
    tabs,
    activeId: tabs[0].id,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onNew: vi.fn(),
    onSelectRelative: vi.fn(),
    onReorder: vi.fn(),
    ...overrides,
  }
  const result = render(<TabBar {...props} />)
  // Tag the rendered tabs so the stubbed rects line up with the strip order.
  result.container
    .querySelectorAll('[data-tab-id]')
    .forEach((element, index) => element.setAttribute('data-test-index', String(index)))
  return { ...result, props }
}

/** Press on a tab, move the pointer to `toX`, and release — the whole drag gesture. */
function drag(tab: HTMLElement, fromX: number, toX: number, release = true) {
  fireEvent.pointerDown(tab, { pointerId: 1, button: 0, clientX: fromX, pointerType: 'mouse' })
  fireEvent.pointerMove(window, { pointerId: 1, clientX: toX })
  if (release) fireEvent.pointerUp(window, { pointerId: 1, clientX: toX })
}

describe('TabBar reordering', () => {
  const originalRect = Element.prototype.getBoundingClientRect

  afterEach(() => {
    cleanup()
    Element.prototype.getBoundingClientRect = originalRect
  })

  it('moves a dragged tab to the position it was dropped on', () => {
    stubStripGeometry()
    const tabs = tabsFixture()
    const { container, props } = renderBar(tabs)
    const first = container.querySelectorAll<HTMLElement>('[data-tab-id]')[0]

    // Past the midpoint of the third tab: the tab lands last.
    drag(first, 10, 260)

    expect(props.onReorder).toHaveBeenCalledWith(tabs[0].id, 2)
  })

  it('leaves the order alone for a click, and selects instead', () => {
    stubStripGeometry()
    const tabs = tabsFixture()
    const { container, props } = renderBar(tabs)
    const third = container.querySelectorAll<HTMLElement>('[data-tab-id]')[2]

    drag(third, 250, 252)
    fireEvent.click(screen.getByRole('tab', { name: /Three/ }))

    expect(props.onReorder).not.toHaveBeenCalled()
    expect(props.onSelect).toHaveBeenCalledWith(tabs[2].id)
  })

  it('does not select the tab that was only dragged', () => {
    stubStripGeometry()
    const tabs = tabsFixture()
    const { container, props } = renderBar(tabs)
    const first = container.querySelectorAll<HTMLElement>('[data-tab-id]')[0]

    drag(first, 10, 160)
    fireEvent.click(screen.getByRole('tab', { name: /One/ }))

    expect(props.onReorder).toHaveBeenCalledWith(tabs[0].id, 1)
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it('abandons a drag on Escape', () => {
    stubStripGeometry()
    const tabs = tabsFixture()
    const { container, props } = renderBar(tabs)
    const first = container.querySelectorAll<HTMLElement>('[data-tab-id]')[0]

    drag(first, 10, 260, false)
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Escape' })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 260 })

    expect(props.onReorder).not.toHaveBeenCalled()
  })

  it('still selects a tab on the press after a drag', () => {
    stubStripGeometry()
    const tabs = tabsFixture()
    const { container, props } = renderBar(tabs)
    const cells = container.querySelectorAll<HTMLElement>('[data-tab-id]')

    drag(cells[0], 10, 260)
    expect(props.onReorder).toHaveBeenCalledWith(tabs[0].id, 2)

    // The gesture's own click is swallowed; the next press is an ordinary click again.
    drag(cells[1], 150, 150)
    fireEvent.click(screen.getByRole('tab', { name: /Two/ }))
    expect(props.onSelect).toHaveBeenCalledWith(tabs[1].id)
  })

  it('selects a tab whose press wobbled without moving it', () => {
    stubStripGeometry()
    const tabs = tabsFixture()
    const { container, props } = renderBar(tabs)
    const cells = container.querySelectorAll<HTMLElement>('[data-tab-id]')

    // Past the drag threshold, but not past any midpoint: nothing moves, so it is still a click.
    drag(cells[2], 220, 230)
    fireEvent.click(screen.getByRole('tab', { name: /Three/ }))

    expect(props.onReorder).not.toHaveBeenCalled()
    expect(props.onSelect).toHaveBeenCalledWith(tabs[2].id)
  })

  it('reorders the focused tab with Alt+Arrow and still steps with plain arrows', () => {
    const tabs = tabsFixture()
    const { props } = renderBar(tabs, { activeId: tabs[1].id })
    const tablist = screen.getByRole('tablist')

    fireEvent.keyDown(tablist, { key: 'ArrowRight', altKey: true })
    expect(props.onReorder).toHaveBeenCalledWith(tabs[1].id, 2)

    fireEvent.keyDown(tablist, { key: 'ArrowLeft', altKey: true })
    expect(props.onReorder).toHaveBeenCalledWith(tabs[1].id, 0)

    fireEvent.keyDown(tablist, { key: 'ArrowRight' })
    expect(props.onSelectRelative).toHaveBeenCalledWith(1)
  })

  it('does not drag past the ends with Alt+Arrow', () => {
    const tabs = tabsFixture()
    const { props } = renderBar(tabs, { activeId: tabs[0].id })

    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft', altKey: true })
    expect(props.onReorder).not.toHaveBeenCalled()
  })

  it('ignores touch presses so the strip can still be scrolled', () => {
    stubStripGeometry()
    const tabs = tabsFixture()
    const { container, props } = renderBar(tabs)
    const first = container.querySelectorAll<HTMLElement>('[data-tab-id]')[0]

    fireEvent.pointerDown(first, { pointerId: 1, button: 0, clientX: 10, pointerType: 'touch' })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 260 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 260 })

    expect(props.onReorder).not.toHaveBeenCalled()
  })
})

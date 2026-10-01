import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearAnthropicKey,
  getStoredAnthropicKey,
  isLikelyAnthropicKey,
  storeAnthropicKey,
  subscribeToAnthropicKey,
} from './anthropicKey'

const KEY = 'sk-ant-api03-abcdefghijklmnop'

describe('anthropicKey', () => {
  afterEach(() => localStorage.clear())

  it('round-trips the key, trimmed', () => {
    storeAnthropicKey(`  ${KEY}  `)
    expect(getStoredAnthropicKey()).toBe(KEY)
    expect(localStorage.getItem('anthropic-api-key')).toBe(KEY)
  })

  it('treats no key and a blank key the same', () => {
    expect(getStoredAnthropicKey()).toBeNull()
    storeAnthropicKey('   ')
    expect(getStoredAnthropicKey()).toBeNull()
  })

  it('clears the key', () => {
    storeAnthropicKey(KEY)
    clearAnthropicKey()
    expect(getStoredAnthropicKey()).toBeNull()
  })

  it('reports whether the key actually landed, rather than failing silently', () => {
    expect(storeAnthropicKey(KEY)).toBe(true)

    const realSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === 'anthropic-api-key') throw new DOMException('blocked', 'SecurityError')
      realSetItem.call(this, key, value)
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(storeAnthropicKey('sk-ant-another-key-1234567')).toBe(false)
    vi.restoreAllMocks()
  })

  it('tells watchers when the key changes, so a panel elsewhere notices', () => {
    const seen: (string | null)[] = []
    const unsubscribe = subscribeToAnthropicKey((apiKey) => seen.push(apiKey))

    storeAnthropicKey(KEY)
    clearAnthropicKey()
    unsubscribe()
    storeAnthropicKey(KEY)

    expect(seen).toEqual([KEY, null])
  })

  it('catches the paste mistakes worth catching before a request is spent', () => {
    expect(isLikelyAnthropicKey(KEY)).toBe(true)
    expect(isLikelyAnthropicKey(` ${KEY} `)).toBe(true)
    // An OpenAI key, and a truncated copy.
    expect(isLikelyAnthropicKey('sk-proj-abcdefghijklmnopqrst')).toBe(false)
    expect(isLikelyAnthropicKey('sk-ant-')).toBe(false)
    expect(isLikelyAnthropicKey('')).toBe(false)
  })
})

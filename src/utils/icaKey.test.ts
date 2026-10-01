import { afterEach, describe, expect, it } from 'vitest'
import {
  clearIcaKey,
  clearIcaModel,
  DEFAULT_ICA_MODEL,
  getStoredIcaKey,
  getStoredIcaModel,
  isLikelyIcaKey,
  resolveIcaModel,
  storeIcaKey,
  storeIcaModel,
} from './icaKey'

const KEY = 'sk-c1fa2a765fac441fb6e61eb2c68b69d8'

describe('icaKey', () => {
  afterEach(() => localStorage.clear())

  it('round-trips the key, trimmed', () => {
    storeIcaKey(`  ${KEY}  `)
    expect(getStoredIcaKey()).toBe(KEY)
    clearIcaKey()
    expect(getStoredIcaKey()).toBeNull()
  })

  it('accepts an OpenAI-style token, which is what ICA issues', () => {
    expect(isLikelyIcaKey(KEY)).toBe(true)
    expect(isLikelyIcaKey('sk-ant-api03-abcdefghijklmnop')).toBe(true)
    expect(isLikelyIcaKey('not-a-key')).toBe(false)
    expect(isLikelyIcaKey('sk-short')).toBe(false)
  })

  describe('the model the assistant talks to', () => {
    it('defaults to Claude Opus 5 under chat-models, so a key alone is enough', () => {
      expect(getStoredIcaModel()).toBeNull()
      expect(resolveIcaModel()).toEqual({ namespace: 'chat-models', model: 'claude-opus-5' })
      expect(resolveIcaModel()).toEqual(DEFAULT_ICA_MODEL)
    })

    it('uses an explicit choice over the default', () => {
      storeIcaModel({ namespace: 'agents', model: '45cf3427-d476-4597-b30e-84d099701e96' })
      expect(resolveIcaModel()).toEqual({
        namespace: 'agents',
        model: '45cf3427-d476-4597-b30e-84d099701e96',
      })
    })

    it('returns to the default once a choice is cleared', () => {
      storeIcaModel({ namespace: 'agents', model: 'some-agent' })
      clearIcaModel()
      expect(resolveIcaModel()).toEqual(DEFAULT_ICA_MODEL)
    })

    it('falls back rather than trusting a stored value that no longer makes sense', () => {
      localStorage.setItem('ica-model-choice', 'not json')
      expect(resolveIcaModel()).toEqual(DEFAULT_ICA_MODEL)

      localStorage.setItem('ica-model-choice', JSON.stringify({ namespace: 'agents' }))
      expect(resolveIcaModel()).toEqual(DEFAULT_ICA_MODEL)

      // An unknown namespace keeps the model but comes back under the default namespace.
      localStorage.setItem(
        'ica-model-choice',
        JSON.stringify({ namespace: 'made-up', model: 'mystery' }),
      )
      expect(resolveIcaModel()).toEqual({ namespace: 'chat-models', model: 'mystery' })
    })
  })
})

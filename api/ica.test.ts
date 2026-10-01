import { describe, it, expect, afterEach, vi } from 'vitest'
import handler, { isAllowedIcaPath } from './ica.js'

const UPSTREAM = 'https://api.servicesessentials.ibm.com/v1'

function request(
  path: string,
  init: { method?: string; auth?: string | null; body?: string } = {},
): Request {
  const url = `https://mermalaid.com/api/ica?path=${encodeURIComponent(path)}`
  return new Request(url, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.auth === null ? {} : { Authorization: init.auth ?? 'Bearer sk-ica-test' }),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('isAllowedIcaPath', () => {
  it('allows listing and chatting in each ICA namespace', () => {
    for (const namespace of ['assistants', 'agents', 'digital-workforce', 'chat-models']) {
      expect(isAllowedIcaPath(namespace)).toBe(true)
      expect(isAllowedIcaPath(`${namespace}/models`)).toBe(true)
      expect(isAllowedIcaPath(`${namespace}/chat/completions`)).toBe(true)
    }
  })

  it('is not a general-purpose proxy into the IBM API', () => {
    expect(isAllowedIcaPath('files')).toBe(false)
    expect(isAllowedIcaPath('chat-models/../files')).toBe(false)
    expect(isAllowedIcaPath('/chat-models')).toBe(false)
    expect(isAllowedIcaPath('chat-models/chat/completions/extra')).toBe(false)
    expect(isAllowedIcaPath('')).toBe(false)
  })
})

describe('ica proxy handler', () => {
  it('answers a preflight, since the editor calls this cross-origin from the desktop app', async () => {
    const res = await handler(new Request('https://mermalaid.com/api/ica', { method: 'OPTIONS' }))
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization')
  })

  it('forwards the caller’s own key to IBM and adds nothing of its own', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await handler(request('chat-models'))

    expect(res.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${UPSTREAM}/chat-models`)
    expect(init.headers.Authorization).toBe('Bearer sk-ica-test')
    // Nothing else is bolted on: the request carries the user's credential, not the deployment's.
    expect(Object.keys(init.headers).sort()).toEqual(['Accept', 'Authorization'])
  })

  it('passes a chat completion body through and streams the answer back', async () => {
    const body = new ReadableStream()
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await handler(
      request('chat-models/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'm', messages: [] }),
      }),
    )

    expect(fetchMock.mock.calls[0][1].body).toBe('{"model":"m","messages":[]}')
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses a path outside the allow-list without calling IBM', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await handler(request('files/secret'))

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a request with no credentials of its own to forward', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await handler(request('chat-models', { auth: null }))

    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports IBM’s own status rather than flattening it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"bad key"}', { status: 401 })))

    const res = await handler(request('chat-models'))

    expect(res.status).toBe(401)
    expect(await res.text()).toContain('bad key')
  })

  it('reports an unreachable upstream without logging the request', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const res = await handler(request('chat-models'))

    expect(res.status).toBe(502)
    const logged = error.mock.calls.flat().join(' ')
    expect(logged).not.toContain('sk-ica-test')
  })

  it('rejects methods the ICA endpoints do not use', async () => {
    const res = await handler(request('chat-models', { method: 'DELETE' }))
    expect(res.status).toBe(405)
  })
})

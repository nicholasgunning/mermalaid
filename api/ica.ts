/**
 * IBM Consulting Advantage proxy: ALL /api/ica?path=<upstream path>
 *
 * The ICA API sends no `Access-Control-Allow-Origin`, so a browser blocks every direct call to it —
 * unlike Anthropic, which has an opt-in header for exactly this. This forwards the request instead.
 *
 * What it does with the caller's credentials: the `Authorization` header is passed through to IBM
 * and nothing else. The key is never stored, never logged (not even on error), and no key of the
 * deployment's own is added — a request without one gets IBM's 401, as it should. The upstream path
 * is allow-listed so this cannot be used as a general-purpose proxy into the IBM API.
 */
import { isRateLimited } from './_lib/rateLimit.js'

const ICA_BASE_URL = 'https://api.servicesessentials.ibm.com/v1'

/** The four chat namespaces from the ICA docs, which share one request/response shape. */
const NAMESPACE = '(?:assistants|agents|digital-workforce|chat-models)'

/** Only what the editor actually calls: list the models in a namespace, and chat with one. */
const ALLOWED_PATHS = [
  new RegExp(`^${NAMESPACE}$`),
  new RegExp(`^${NAMESPACE}/models$`),
  new RegExp(`^${NAMESPACE}/chat/completions$`),
]

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  })
}

export function isAllowedIcaPath(path: string): boolean {
  // A leading slash or any traversal would escape the allow-list's intent.
  if (!path || path.startsWith('/') || path.includes('..')) return false
  return ALLOWED_PATHS.some((pattern) => pattern.test(path))
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405)
  }
  if (await isRateLimited(req)) return json({ error: 'rate_limited' }, 429)

  const path = new URL(req.url).searchParams.get('path') ?? ''
  if (!isAllowedIcaPath(path)) return json({ error: 'path_not_allowed', path }, 400)

  const authorization = req.headers.get('authorization')
  if (!authorization) return json({ error: 'missing_authorization' }, 401)

  let upstream: Response
  try {
    upstream = await fetch(`${ICA_BASE_URL}/${path}`, {
      method: req.method,
      headers: {
        Authorization: authorization,
        Accept: req.headers.get('accept') ?? 'application/json',
        ...(req.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: req.method === 'POST' ? await req.text() : undefined,
    })
  } catch (err) {
    // The message, never the request: a thrown fetch error must not echo the key back in a log.
    console.error('[mermalaid] ICA proxy could not reach IBM:', (err as Error)?.message)
    return json({ error: 'upstream_unreachable' }, 502)
  }

  // The body is streamed through untouched so server-sent chat completions arrive as they are
  // generated rather than after the whole answer is buffered here.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      'Cache-Control': 'no-store',
      ...CORS,
    },
  })
}

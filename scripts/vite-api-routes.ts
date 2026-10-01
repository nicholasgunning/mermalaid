/**
 * Serves the `api/` route handlers from the Vite dev server.
 *
 * Those handlers are web-standard `(Request) => Response` functions that Vercel runs in production,
 * and `vite` on its own knows nothing about them: a `GET /api/ica` is answered with the handler's
 * own transpiled source and a `POST` with a bare 404, which reads to the caller as an upstream
 * failure rather than a missing route. This mounts them instead, so the ICA proxy — the one route
 * the editor cannot do without, since the IBM API sends no CORS headers — works under `npm run dev`
 * without `vercel dev`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Plugin, ViteDevServer } from 'vite'

/** `/api/ica` → `api/ica.ts`, `/api/slack/commands` → `api/slack/commands.ts`. */
function resolveHandlerFile(root: string, pathname: string): string | null {
  const route = pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '')
  if (!route) return null
  const segments = route.split('/')
  // `_lib` is shared code and `*.test` is a test file: neither is a route, and `..` escapes `api/`.
  if (segments.some((s) => !s || s.startsWith('_') || s.startsWith('.') || s.endsWith('.test'))) {
    return null
  }
  for (const candidate of [`${route}.ts`, path.join(route, 'index.ts')]) {
    const file = path.join(root, 'api', candidate)
    if (existsSync(file)) return file
  }
  return null
}

/** The Node request as the handlers see it: a web `Request` with the body already attached. */
async function toWebRequest(req: IncomingMessage, host: string): Promise<Request> {
  const method = req.method ?? 'GET'
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one)
  }

  let body: ArrayBuffer | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    // An ArrayBuffer rather than the Buffer itself: `Buffer.concat` can hand back a pooled view, so
    // the bytes are copied out at their own offset before being handed to `Request`.
    const joined = Buffer.concat(chunks)
    body = joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.byteLength) as ArrayBuffer
  }

  return new Request(new URL(req.url ?? '/', `http://${host}`), { method, headers, body })
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, name) => res.setHeader(name, value))
  if (!response.body) {
    res.end()
    return
  }
  // Streamed through chunk by chunk so server-sent chat completions still arrive progressively.
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(Buffer.from(value))
  }
  res.end()
}

export function apiRoutes(): Plugin {
  return {
    name: 'mermalaid:api-routes',
    apply: 'serve',
    // Called in the hook body rather than from a returned function so this runs *before* Vite's own
    // middlewares, which would otherwise serve `api/ica.ts` to a GET as a JavaScript module.
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
        if (!pathname.startsWith('/api/')) return next()

        const file = resolveHandlerFile(server.config.root, pathname)
        if (!file) return next()

        try {
          const module = await server.ssrLoadModule(file)
          const handler = module.default as ((req: Request) => Promise<Response>) | undefined
          if (typeof handler !== 'function') return next()
          await writeWebResponse(res, await handler(await toWebRequest(req, req.headers.host ?? 'localhost')))
        } catch (err) {
          server.config.logger.error(`[api] ${pathname} failed: ${(err as Error)?.message}`)
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'handler_failed', message: (err as Error)?.message }))
        }
      })
    },
  }
}

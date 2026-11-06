import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'

// Only fixed translation providers are allowed. No credentials or request bodies are logged.
export function translationProxy(): Plugin {
  const handle = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url !== '/api/translate') return next()
    const origin = req.headers.origin
    if (req.method !== 'POST' || !origin || origin !== `http://${req.headers.host}` || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '') || !req.headers['content-type']?.startsWith('application/json')) { res.writeHead(403).end(); return }
    try {
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 12000) { res.writeHead(413).end(); return } }
      const { provider, text, target, key } = JSON.parse(body)
      if (!['google', 'deepl-free', 'deepl-pro'].includes(provider) || typeof text !== 'string' || !text.trim() || text.length > 2000 || typeof key !== 'string' || !key || key.length > 500 || typeof target !== 'string' || !/^[a-zA-Z-]{2,12}$/.test(target)) { res.writeHead(400).end(); return }
      const google = provider === 'google'
      const url = google ? 'https://translation.googleapis.com/language/translate/v2' : `https://${provider === 'deepl-free' ? 'api-free' : 'api'}.deepl.com/v2/translate`
      const upstream = await fetch(url, { method: 'POST', headers: google ? { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key } : { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${key}` }, body: JSON.stringify(google ? { q: text, target, format: 'text' } : { text: [text], target_lang: target.toUpperCase() }), signal: AbortSignal.timeout(20000) })
      if (!upstream.ok) { res.writeHead(upstream.status).end(); return }
      const data: any = await upstream.json()
      const translation = google ? data.data?.translations?.[0]?.translatedText : data.translations?.[0]?.text
      if (typeof translation !== 'string') { res.writeHead(502).end(); return }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ translation }))
    } catch { if (!res.headersSent) res.writeHead(502).end() }
  }
  return { name: 'local-translation-proxy', configureServer(server) { server.middlewares.use(handle) }, configurePreviewServer(server) { server.middlewares.use(handle) } }
}

import type { Plugin, ViteDevServer, PreviewServer } from 'vite'
import type { IncomingMessage } from 'node:http'
import { BookCache } from './server/book-cache'
import { downloadOnline } from './server/remote-books'

async function body(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = []; let bytes = 0
  for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw new Error('请求内容超过大小限制。'); chunks.push(Buffer.from(chunk)) }
  return Buffer.concat(chunks)
}
export function libraryProxy(): Plugin {
  function install(server: ViteDevServer | PreviewServer) {
    const cache = new BookCache(server.config.root)
    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/api/reader/')) return next()
      if (req.method !== 'POST' || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '') || req.headers.origin !== `http://${req.headers.host}` || req.headers['x-reader-library'] !== '1') { res.writeHead(403).end(); return }
      const json = (status: number, value: unknown) => res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(value))
      try {
        const read = /^\/api\/reader\/cache\/read\/([a-f0-9]{64})$/.exec(req.url)
        if (read) { await body(req, 1000); const data = await cache.get(read[1]); if (!data) { json(404, { error: '没有缓存。' }); return }; res.writeHead(200, { 'Content-Type': 'application/epub+zip', 'Cache-Control': 'no-store' }).end(data); return }
        const match = /^\/api\/reader\/cache\/book\/([a-f0-9]{64})$/.exec(req.url)
        if (match) { await cache.put(match[1], await body(req, 50_000_000)); json(200, { saved: true }); return }
        if (!req.headers['content-type']?.startsWith('application/json')) { json(400, { error: '请求格式无效。' }); return }
        const data = JSON.parse((await body(req, 12000)).toString('utf8'))
        if (req.url === '/api/reader/cache/status') { json(200, await cache.status()); return }
        if (req.url === '/api/reader/cache/directory') { json(200, await cache.setDirectory(data.directory)); return }
        if (req.url === '/api/reader/cache/clear') { json(200, await cache.clear()); return }
        if (req.url === '/api/reader/online') {
          if (!['epub', 'catalog'].includes(data.kind)) { json(400, { error: '不支持的书源格式。' }); return }
          const result = await downloadOnline(data.url, data.kind)
          res.writeHead(200, { 'Content-Type': data.kind === 'epub' ? 'application/epub+zip' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Book-URL': result.url }).end(result.data); return
        }
        json(404, { error: '操作不存在。' })
      } catch (error) { if (!res.headersSent) json(400, { error: error instanceof Error && !('code' in error) ? error.message : '无法完成操作，请检查地址、网络或文件夹权限。' }) }
    })
  }
  return { name: 'reader-library', configureServer: install, configurePreviewServer: install }
}

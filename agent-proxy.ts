import type { Plugin, ViteDevServer, PreviewServer } from 'vite'
import { randomBytes, randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { CodexService } from './server/codex-service'

export function agentProxy(): Plugin {
  function install(server: ViteDevServer | PreviewServer) {
    const service = new CodexService(server.config.root)
    const tickets = new Map<string, { owner: string; expires: number }>()
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 256000, handleProtocols: () => 'reader-agent' })
    const sameOrigin = (req: import('node:http').IncomingMessage) => /^127\.0\.0\.1:\d+$/.test(req.headers.host || '') && req.headers.origin === `http://${req.headers.host}`
    server.middlewares.use((req, res, next) => {
      if (req.url !== '/api/agent/bootstrap') return next()
      if (req.method !== 'POST' || !sameOrigin(req) || req.headers['x-reader-agent'] !== '1') { res.writeHead(403).end(); return }
      const now = Date.now()
      for (const [key, ticket] of tickets) if (ticket.expires < now) tickets.delete(key)
      if (tickets.size >= 100) { res.writeHead(429).end(); return }
      const token = randomBytes(32).toString('hex')
      tickets.set(token, { owner: randomUUID(), expires: now + 30000 })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ token }))
    })
    server.httpServer?.on('upgrade', (req, socket, head) => {
      if (req.url !== '/api/agent/socket') return
      const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map(x => x.trim())
      const token = protocols.find(x => /^[a-f0-9]{64}$/.test(x)) || ''
      const ticket = tickets.get(token); tickets.delete(token)
      if (!sameOrigin(req) || !protocols.includes('reader-agent') || !ticket || ticket.expires < Date.now()) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return }
      sockets.handleUpgrade(req, socket, head, ws => {
        const owner = ticket.owner
        const send = (data: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)) }
        ws.on('message', async raw => {
          let id: number | undefined
          try {
            const message = JSON.parse(raw.toString())
            id = message.id
            if (!Number.isSafeInteger(id) || (id as number) < 1) throw new Error('消息标识无效。')
            const p = message.params || {}
            let result: unknown
            if (message.method === 'connect') result = await service.connect(p.binary)
            else if (message.method === 'login') result = await service.login()
            else if (message.method === 'run') result = { text: await service.run(owner, String(id), p, event => send({ requestId: id, event })) }
            else if (message.method === 'tool') { service.toolResult(owner, String(p.requestId), p.callId, p.result); result = {} }
            else if (message.method === 'cancel') { service.cancel(owner, String(p.requestId)); result = {} }
            else throw new Error('阅读器不支持该连接操作。')
            send({ id, result })
          } catch (error) { send({ id, error: error instanceof Error ? error.message : '本机 Agent 连接失败。' }) }
        })
        ws.on('close', () => service.cancel(owner))
        ws.on('error', () => service.cancel(owner))
      })
    })
    server.httpServer?.once('close', () => { for (const ws of sockets.clients) ws.terminate(); sockets.close(); service.close() })
  }
  return { name: 'reader-local-agent', configureServer: install, configurePreviewServer: install }
}

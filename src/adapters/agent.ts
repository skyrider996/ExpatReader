import type { AgentChoice, AgentEvent, AgentStatus } from '../core/agent'
import { ref } from 'vue'

export const agentRunning = ref(false)

type Pending = { resolve: (data: any) => void; reject: (error: Error) => void; event?: (event: AgentEvent) => void; timer: ReturnType<typeof setTimeout> }
export class AgentClient {
  onDisconnect: () => void = () => {}
  private socket: WebSocket | null = null
  private opening: Promise<void> | null = null
  private counter = 0
  private pending = new Map<number, Pending>()
  private async open() {
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (this.opening) return this.opening
    this.opening = (async () => {
      const response = await fetch('/api/agent/bootstrap', { method: 'POST', credentials: 'omit', headers: { 'X-Reader-Agent': '1' } })
      if (!response.ok) throw new Error('本机连接服务不可用，请重新启动阅读器。')
      const { token } = await response.json()
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://${location.host}/api/agent/socket`, ['reader-agent', token])
        const timer = setTimeout(() => { ws.close(); reject(new Error('连接本机服务超时。')) }, 10000)
        ws.onopen = () => { clearTimeout(timer); this.socket = ws; resolve() }
        ws.onerror = () => { clearTimeout(timer); reject(new Error('无法连接本机服务，请重新启动阅读器。')) }
        ws.onmessage = message => {
          let data: any
          try { data = JSON.parse(message.data) } catch { return }
          if (data.event) { this.pending.get(data.requestId)?.event?.(data.event); return }
          const pending = this.pending.get(data.id)
          if (!pending) return
          clearTimeout(pending.timer); this.pending.delete(data.id)
          if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data.result)
        }
        ws.onclose = () => {
          clearTimeout(timer)
          if (this.socket === ws) this.socket = null
          for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('本机 Agent 连接已断开，请刷新连接。')) }
          this.pending.clear()
          this.onDisconnect()
          reject(new Error('本机 Agent 连接已关闭。'))
        }
      })
    })().finally(() => { this.opening = null })
    return this.opening
  }
  private send(method: string, params: unknown, options: { event?: (event: AgentEvent) => void; timeout?: number; started?: (id: number) => void } = {}) {
    const id = ++this.counter
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('本机 Agent 请求超时，请刷新连接。')) }, options.timeout || 60000)
      this.pending.set(id, { resolve, reject, timer, event: options.event })
      try {
        if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('请先连接本机 Codex。')
        this.socket.send(JSON.stringify({ id, method, params })); options.started?.(id)
      } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e) }
    })
  }
  async connect(binary = ''): Promise<AgentStatus> { await this.open(); return this.send('connect', { binary: binary || undefined }) }
  async login(): Promise<{ url: string }> { await this.open(); return this.send('login', {}) }
  async run(input: { sessionId: string; bookId: string; identity: string; choice: AgentChoice; prompt: string; temporary?: boolean }, signal: AbortSignal, event: (event: AgentEvent) => void, tool: (name: string, args: unknown) => Promise<unknown>) {
    signal.throwIfAborted()
    if (agentRunning.value) throw new Error('本机 Codex 正在回答其他问题，请稍后重试。')
    agentRunning.value = true
    let requestId = 0
    let queue = Promise.resolve()
    const cancel = () => { if (requestId) void this.send('cancel', { requestId }, { timeout: 10000 }).catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      await this.open(); signal.throwIfAborted()
      const response = await this.send('run', input, { timeout: 315000, started: id => { requestId = id; if (signal.aborted) cancel() }, event: data => {
        if (signal.aborted) return
        event(data)
        if (data.type === 'tool') queue = queue.then(async () => {
          if (signal.aborted) return
          let result: unknown
          try { result = await tool(data.name, data.args) } catch (e) { result = { error: e instanceof Error ? e.message : '书籍查阅失败。' } }
          if (!signal.aborted) await this.send('tool', { requestId, callId: data.callId, result })
        }).catch(() => cancel())
      } })
      signal.throwIfAborted()
      return response.text as string
    } finally { signal.removeEventListener('abort', cancel); agentRunning.value = false }
  }
  close() { this.socket?.close() }
}
export const agentClient = new AgentClient()

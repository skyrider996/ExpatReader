import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'

export class CodexRpc {
  private child: ChildProcessWithoutNullStreams | null = null
  private reader: Interface | null = null
  private counter = 0
  private pending = new Map<number, { resolve: (data: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  onMessage: (message: any) => void = () => {}
  onClose: () => void = () => {}
  async start(binary: string, args: string[], cwd: string) {
    if (this.child) throw new Error('连接已启动。')
    const env = { ...process.env }
    // Subscription connections use Codex's managed login, never inherited API
    // credentials or an environment-supplied inference endpoint. Keep runtime
    // permission/sandbox variables and CODEX_HOME unchanged.
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN']) delete env[key]
    const child = spawn(binary, ['app-server', '--listen', 'stdio://', ...args], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.reader = createInterface({ input: child.stdout })
    this.reader.on('line', line => {
      if (line.length > 4_000_000) { this.close(); return }
      try {
        const data = JSON.parse(line)
        if (data.method) this.onMessage(data)
        else {
          const call = this.pending.get(data.id)
          if (!call) return
          clearTimeout(call.timer); this.pending.delete(data.id)
          // Provider error bodies can contain private context. Keep them off the web channel.
          if (data.error) call.reject(new Error(`Codex 请求失败（${data.error.code ?? '协议错误'}），请检查登录、模型或版本。`))
          else call.resolve(data.result)
        }
      } catch { /* Ignore non-protocol output. */ }
    })
    child.stderr.resume()
    child.once('error', () => this.fail(new Error('无法启动 Codex，请检查可执行文件路径。')))
    child.once('exit', () => { this.fail(new Error('Codex 连接已关闭，请重新连接。')); this.onClose() })
    const result = await this.request('initialize', { clientInfo: { name: 'expatreader', title: 'ExpatReader', version: '0.2.0' }, capabilities: { experimentalApi: true } })
    this.send({ method: 'initialized' })
    return result
  }
  send(data: unknown) {
    if (!this.child || !this.child.stdin.writable) throw new Error('Codex 未连接。')
    this.child.stdin.write(JSON.stringify(data) + '\n')
  }
  request(method: string, params: unknown = {}, timeout = 15000): Promise<any> {
    const id = ++this.counter
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex 连接请求超时，请重试。')) }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try { this.send({ method, id, params }) } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e) }
    })
  }
  respond(id: number | string, result: unknown) { this.send({ id, result }) }
  private fail(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }
  close() {
    this.reader?.close(); this.reader = null
    const child = this.child; this.child = null
    child?.kill()
    this.fail(new Error('Codex 连接已关闭。'))
  }
}

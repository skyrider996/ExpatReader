import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { CodexRpc } from './codex-rpc.ts'
import { catalogFingerprint, configArgs, pickerModels, readingCatalog, readingOverrides, READING_INSTRUCTIONS } from './codex-policy.ts'
import { bookTools } from '../src/core/assistant.ts'
import { validateChoice, type AgentChoice, type AgentEvent, type AgentStatus } from '../src/core/agent.ts'

type SavedThread = { threadId: string; policy: string }
type PendingTool = { ids: (number | string)[]; fingerprint: string; timer?: ReturnType<typeof setTimeout>; result?: unknown }
interface ActiveTurn {
  owner: string; requestId: string; threadId: string; turnId: string | null; emit: (event: AgentEvent) => void
  tools: Map<string, PendingTool>; calls: number; allowedTools: boolean; text: string
  items: Map<string, string>; lastItem: string; total: ReturnType<typeof setTimeout>; idle?: ReturnType<typeof setTimeout>
  complete: (text: string) => void; fail: (error: Error) => void
  cancelled?: boolean; terminal?: boolean; stop?: Promise<void>; stopped?: () => void
  starting?: Promise<any>
  buffered: any[]
}
export class CodexService {
  private rpc: CodexRpc | null = null
  private status: AgentStatus | null = null
  private connecting: Promise<AgentStatus> | null = null
  private active: ActiveTurn | null = null
  private binary = ''
  private policy = ''
  private threads: Record<string, SavedThread> = {}
  private loaded = false
  private work: string
  private runtime: string
  constructor(root: string) {
    this.work = path.join(root, '.cache', 'reader-agent', 'work')
    this.runtime = path.join(root, '.cache', 'reader-agent')
  }
  private async findBinary(preferred?: string) {
    if (preferred) {
      if (!path.isAbsolute(preferred) || !/^codex(?:\.exe)?$/i.test(path.basename(preferred))) throw new Error('请选择 Codex 可执行文件的绝对路径（codex.exe）。')
      return preferred
    }
    try { await promisify(execFile)('codex', ['--version'], { windowsHide: true, timeout: 10000 }); return 'codex' } catch { /* desktop installation fallback */ }
    const folder = path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin')
    if (process.platform === 'win32') {
      const versions = await readdir(folder).catch(() => [])
      for (const version of versions.reverse()) {
        const file = path.join(folder, version, 'codex.exe')
        try { await promisify(execFile)(file, ['--version'], { windowsHide: true, timeout: 10000 }); return file } catch { /* try PATH */ }
      }
    }
    return 'codex'
  }
  connect(preferred?: string): Promise<AgentStatus> {
    if (this.active) return Promise.reject(new Error('请等待当前回答结束后再刷新连接。'))
    if (this.connecting) return this.connecting
    this.connecting = this.open(preferred).catch(error => { const rpc = this.rpc; this.rpc = null; rpc?.close(); this.status = null; throw error }).finally(() => { this.connecting = null })
    return this.connecting
  }
  private async startRpc(args: Record<string, unknown>) {
    const rpc = new CodexRpc()
    this.rpc = rpc
    rpc.onMessage = message => this.handle(message)
    rpc.onClose = () => { if (this.rpc === rpc) { this.status = null; this.abortActive('Codex 连接已断开，请重新连接。') } }
    await rpc.start(this.binary, configArgs(args), this.work)
    return rpc
  }
  private async open(preferred?: string): Promise<AgentStatus> {
    this.status = null; this.rpc?.close(); this.rpc = null
    await mkdir(this.work, { recursive: true })
    this.binary = await this.findBinary(preferred)
    const versionOutput = await promisify(execFile)(this.binary, ['--version'], { windowsHide: true, timeout: 10000 }).catch(() => { throw new Error('未检测到 Codex，请先安装，或填写 codex.exe 的绝对路径。') })
    const version = /codex-cli\s+(\S+)/.exec(versionOutput.stdout)?.[1] || ''
    // Native tool metadata and flags were checked against this protocol family.
    if (version !== '0.167.0-alpha.3.2') throw new Error(`Codex ${version || '版本未知'} 尚未验证阅读 Chat 隔离；当前实测版本为 0.167.0-alpha.3.2。请更新阅读器的兼容适配。`)
    const base = { ...readingOverrides(), log_dir: path.join(this.runtime, 'logs'), sqlite_home: this.runtime }
    const instructionFile = path.join(this.runtime, 'reading-instructions.txt')
    await writeFile(instructionFile, READING_INSTRUCTIONS, 'utf8')
    base['model_instructions_file' as keyof typeof base] = instructionFile
    const rpc = await this.startRpc(base)
    const auth = await rpc.request('account/read', { refreshToken: false })
    const account = auth.account
    if (!account || account.type !== 'chatgpt') {
      return this.status = { state: 'login', identity: '', version, accountLabel: account?.type === 'apiKey' ? 'API 密钥登录' : '未使用 ChatGPT 登录', models: [], message: account?.type === 'apiKey' ? '当前为按量计费的 API 登录。请在 Codex 中改用 ChatGPT 登录后刷新；阅读器不会自动切换计费。' : '请登录 Codex 的 ChatGPT 账号后刷新连接。' }
    }
    const identity = await this.readIdentity(rpc, auth)
    const config = (await rpc.request('config/read', { includeLayers: false, cwd: this.work })).config
    if (config.model_provider !== 'openai') throw new Error('当前连接不是官方 OpenAI 提供方，订阅模式已停用。')
    const list: any[] = []; const cursors = new Set<string>(); let cursor: string | null = null
    do {
      const page = await rpc.request('model/list', { includeHidden: false, limit: 50, cursor })
      list.push(...page.data); cursor = page.nextCursor
      if (cursor && cursors.has(cursor)) throw new Error('模型列表分页无效，请重连。')
      if (cursor) cursors.add(cursor)
      if (list.length > 1000) throw new Error('模型列表过大。')
    } while (cursor)
    const models = pickerModels(list)
    if (!models.length) throw new Error('当前订阅没有返回可选模型，请检查账号后刷新。')
    let rateLimits: AgentStatus['rateLimits']
    try {
      const limits = (await rpc.request('account/rateLimits/read')).rateLimits
      rateLimits = [limits?.primary, limits?.secondary].filter(Boolean).map((x: any) => ({ usedPercent: x.usedPercent, resetsAt: x.resetsAt }))
    } catch { /* Rate limit reporting is optional. */ }
    const codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex')
    let cache: any
    for (const name of ['models_cache.expatreader.json', 'models_cache.json', 'models_cache.codex_work_desktop.json']) {
      try {
        const candidate = JSON.parse(await readFile(path.join(codexHome, name), 'utf8'))
        if (models.every(m => candidate.models?.some((entry: any) => entry.slug === m.model))) { cache = candidate; break }
      } catch { /* Try the next metadata cache, never authentication files. */ }
    }
    const catalog = readingCatalog(cache || {})
    const catalogFile = path.join(this.runtime, 'reading-models.json')
    await writeFile(catalogFile, JSON.stringify(catalog), 'utf8')
    const overrides = { ...base, ...readingOverrides(Object.keys(config.mcp_servers || {})), model_catalog_json: catalogFile }
    this.policy = catalogFingerprint({ catalog, overrides, version })
    this.rpc = null; rpc.close()
    const safeRpc = await this.startRpc(overrides)
    const effective = await safeRpc.request('config/read', { includeLayers: true, cwd: this.work })
    this.verifyPolicy(effective)
    const profiles = await safeRpc.request('permissionProfile/list', { limit: 100 })
    if (!profiles.data.some((p: any) => p.id === 'reader' && p.allowed)) throw new Error('当前 Codex 不允许阅读专用权限配置，连接已停用。')
    const safeAuth = await safeRpc.request('account/read', { refreshToken: false })
    if (safeAuth.account?.type !== 'chatgpt') throw new Error('Codex 登录状态已改变，请重新连接。')
    if (!this.loaded) {
      try { this.threads = JSON.parse(await readFile(path.join(this.runtime, 'threads.json'), 'utf8')) } catch { this.threads = {} }
      this.loaded = true
    }
    return this.status = { state: 'ready', identity, version, accountLabel: `${account.workspaceName || account.email || 'ChatGPT'} · ${account.planType || '订阅'}`, models, message: 'Chat · 阅读对话，仅开放书籍查阅工具', rateLimits }
  }
  private async readIdentity(rpc: CodexRpc, auth: any) {
    if (auth.account?.type !== 'chatgpt') throw new Error('请使用 ChatGPT 订阅登录。')
    const sessions = await rpc.request('accountSession/list', { refreshWorkspaceMetadata: false })
    const current = sessions.sessions.find((s: any) => s.sessionId === sessions.activeSessionId)
    const identity = current ? [current.userId, current.selectedWorkspaceAccountId, current.sessionId] : [auth.account.email, auth.account.workspaceName, auth.workspaceRouting]
    if (!current && !auth.account.email) throw new Error('无法确认订阅账号身份，请重新登录 Codex。')
    return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  }
  private verifyPolicy(response: any) {
    const config = response.config
    for (const [key, value] of Object.entries(readingOverrides())) {
      if (value !== false || !/^(features|agents|tools|skills)\./.test(key)) continue
      const read = (config: any) => key.split('.').reduce((value: any, part) => value?.[part], config)
      let actual = read(config)
      // The 0.167 ConfigRead projection only exposes tools.web_search. Verify
      // the other tools switches in their applied session-flags layer instead.
      if (key.startsWith('tools.')) {
        const flags = response.layers?.find((layer: any) => layer.name?.type === 'sessionFlags' && !layer.disabledReason)
        actual = read(flags?.config)
        if (response.layers?.some((layer: any) => !layer.disabledReason && /mdm|managed/i.test(layer.name?.type || '') && read(layer.config) === true)) actual = true
      }
      if (actual !== false && actual?.enabled !== false) throw new Error('当前 Codex 未能关闭执行工具，阅读 Chat 已停用。')
    }
    if (Object.values(config.mcp_servers || {}).some((server: any) => server.enabled !== false) || config.model_provider !== 'openai') throw new Error('当前 Codex 含阅读 Chat 以外的连接，已停止。')
  }
  async login() {
    if (this.active || this.connecting) throw new Error('当前连接忙碌。')
    if (!this.rpc) await this.connect()
    if (this.status?.state === 'ready') throw new Error('已经登录 ChatGPT，可直接刷新模型列表。')
    const result = await this.rpc!.request('account/login/start', { type: 'chatgpt' })
    const url = new URL(result.authUrl)
    if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com', 'auth0.openai.com'].includes(url.hostname)) throw new Error('登录链接来源未识别，请在 Codex 中登录。')
    return { url: url.href }
  }
  async run(owner: string, requestId: string, input: { sessionId: string; bookId: string; identity: string; choice: AgentChoice; prompt: string; temporary?: boolean }, emit: (event: AgentEvent) => void) {
    if (this.active || this.connecting) throw new Error('Codex 正在处理其他请求，请稍后重试。')
    const status = this.status, rpc = this.rpc
    if (!status || status.state !== 'ready' || !rpc || status.identity !== input.identity) throw new Error('账号或连接已改变，请重新连接后提问。')
    validateChoice(status.models, input.choice)
    if (!/^[a-f0-9]{64}$/.test(input.bookId) || !/^[a-f0-9-]{36}$/i.test(input.sessionId) || typeof input.prompt !== 'string' || input.prompt.length > 45000) throw new Error('阅读会话或问题格式无效。')
    const key = `${status.identity}:${input.bookId}:${input.sessionId}`
    let resolve!: (text: string) => void, reject!: (error: Error) => void
    const result = new Promise<string>((yes, no) => { resolve = yes; reject = no })
    // Install the guard before any awaited protocol operation.
    const active: ActiveTurn = { owner, requestId, threadId: '', turnId: null, emit, tools: new Map(), calls: 0, allowedTools: !input.temporary, text: '', items: new Map(), buffered: [], lastItem: '', complete: resolve, fail: reject, total: setTimeout(() => this.abortActive('本轮超过五分钟，已停止等待。'), 300000) }
    this.active = active; this.touch(active)
    void (async () => {
      try {
        const account = await rpc.request('account/read', { refreshToken: false })
        if (await this.readIdentity(rpc, account) !== status.identity) { this.status = null; throw new Error('订阅账号已改变，请刷新连接后新建对话。') }
        const common = { model: input.choice.model, modelProvider: 'openai', cwd: this.work, runtimeWorkspaceRoots: [this.work], approvalPolicy: 'never', permissions: 'reader', baseInstructions: READING_INSTRUCTIONS, developerInstructions: READING_INSTRUCTIONS, config: { ...(input.choice.effort ? { model_reasoning_effort: input.choice.effort } : {}), web_search: 'disabled' } }
        const saved = input.temporary ? undefined : this.threads[key]
        let thread: any
        if (saved) {
          if (saved.policy !== this.policy) throw new Error('阅读策略或 Codex 版本已更新，请新建对话；原对话记录仍保留。')
          thread = await rpc.request('thread/resume', { ...common, threadId: saved.threadId, excludeTurns: true })
        } else {
          thread = await rpc.request('thread/start', { ...common, ephemeral: !!input.temporary, dynamicTools: input.temporary ? [] : [{ type: 'namespace', name: 'reader_book', description: '只读查阅当前书籍；不移动页面、不访问电脑文件。', tools: bookTools.map(t => ({ type: 'function', name: t.function.name, description: t.function.description, inputSchema: t.function.parameters })) }] })
        }
        if (this.active !== active) return
        if (thread.modelProvider !== 'openai' || thread.model !== input.choice.model || thread.activePermissionProfile?.id !== 'reader' || thread.approvalPolicy !== 'never' || thread.sandbox?.networkAccess !== false) throw new Error('Codex 返回的模型或阅读权限与选择不一致，已停止。')
        active.threadId = thread.thread.id
        if (!input.temporary) {
          this.threads[key] = { threadId: active.threadId, policy: this.policy }
          await writeFile(path.join(this.runtime, 'threads.json'), JSON.stringify(this.threads), 'utf8')
        }
        if (this.active !== active || active.cancelled) return
        active.starting = rpc.request('turn/start', { threadId: active.threadId, input: [{ type: 'text', text: input.prompt }], model: input.choice.model, effort: input.choice.effort, serviceTierForTurn: 'default', collaborationMode: { mode: 'default', settings: { model: input.choice.model, reasoning_effort: input.choice.effort, developer_instructions: READING_INSTRUCTIONS } }, approvalPolicy: 'never', permissions: 'reader' })
        const turn = await active.starting
        if (this.active !== active) { await rpc.request('turn/interrupt', { threadId: active.threadId, turnId: turn.turn.id }).catch(() => {}); return }
        active.turnId = turn.turn.id
        for (const message of active.buffered.splice(0)) this.handle(message)
      } catch (e) { if (this.active === active) this.abortActive(e instanceof Error ? e.message : 'Codex 请求失败。') }
    })()
    try { return await result } finally {
      clearTimeout(active.total); clearTimeout(active.idle)
      for (const pending of active.tools.values()) clearTimeout(pending.timer)
      await active.stop
      if (this.active === active) this.active = null
      if (input.temporary && active.threadId) void rpc.request('thread/unsubscribe', { threadId: active.threadId }).catch(() => {})
    }
  }
  private touch(active: ActiveTurn) { clearTimeout(active.idle); active.idle = setTimeout(() => this.abortActive('Codex 长时间无响应，已停止等待，请检查连接。'), 120000) }
  private handle(message: any) {
    const active = this.active, p = message.params || {}
    if (!active) { if (message.id !== undefined) this.rpc?.send({ id: message.id, error: { code: -32601, message: 'Reading session not active' } }); return }
    if (p.threadId !== active.threadId || (p.turnId && active.turnId && p.turnId !== active.turnId)) {
      if (message.id !== undefined) this.rpc?.send({ id: message.id, error: { code: -32602, message: 'Reading session mismatch' } })
      return
    }
    // Resume can replay previous-turn usage/status notifications. Only the
    // turn/start response identifies this turn; buffer early events until then.
    if (!active.turnId) {
      if (active.starting) {
        if (active.buffered.length >= 500) { this.abortActive('Codex 启动事件过多，已停止本轮。'); return }
        active.buffered.push(message)
      } else if (message.id !== undefined) this.rpc?.send({ id: message.id, error: { code: -32602, message: 'Reading turn not started' } })
      return
    }
    if (active.cancelled) {
      if (message.method === 'turn/completed' && p.turn?.id === active.turnId) active.stopped?.()
      else if (message.id !== undefined) this.rpc?.send({ id: message.id, error: { code: -32601, message: 'Reading turn cancelled' } })
      return
    }
    this.touch(active)
    if (message.id !== undefined) {
      if (message.method !== 'item/tool/call' || !active.allowedTools || p.namespace !== 'reader_book' || !bookTools.some(t => t.function.name === p.tool)) {
        this.rpc?.send({ id: message.id, error: { code: -32601, message: 'Only reader_book tools are allowed' } })
        this.abortActive('阅读 Chat 拒绝了书籍查阅以外的操作。'); return
      }
      const fingerprint = JSON.stringify([p.tool, p.arguments])
      const previous = active.tools.get(p.callId)
      if (previous) {
        if (previous.fingerprint !== fingerprint) { this.abortActive('工具调用标识冲突。'); return }
        if (previous.result) this.rpc?.respond(message.id, previous.result)
        else previous.ids.push(message.id)
        return
      }
      if (++active.calls > 8) { this.rpc?.respond(message.id, { success: false, contentItems: [{ type: 'inputText', text: '书籍读取预算已用完。' }] }); this.abortActive('助手超出八次查阅上限，请缩小问题范围。'); return }
      const pending: PendingTool = { ids: [message.id], fingerprint, timer: setTimeout(() => this.abortActive('页面查阅原文超时，已取消本轮。'), 30000) }
      active.tools.set(p.callId, pending)
      active.emit({ type: 'tool', callId: p.callId, name: p.tool, args: p.arguments })
    } else if (message.method === 'item/agentMessage/delta') {
      const text = (active.items.get(p.itemId) || '') + p.delta
      if (text.length > 200000) { this.abortActive('回答超过长度限制。'); return }
      active.items.set(p.itemId, text); active.lastItem = p.itemId
      active.emit({ type: 'delta', text })
    } else if (message.method === 'item/completed' && p.item?.type === 'agentMessage') {
      active.items.set(p.item.id, p.item.text)
      if (p.item.phase !== 'commentary' || !active.text) active.text = p.item.text
    } else if (message.method === 'thread/tokenUsage/updated' && p.tokenUsage?.last) {
      const usage = p.tokenUsage.last
      active.emit({ type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens })
    } else if (message.method === 'item/started' && ['commandExecution', 'fileChange', 'mcpToolCall', 'collabAgentToolCall', 'webSearch', 'imageGeneration'].includes(p.item?.type)) {
      // Defense in depth; native tools have already been removed from the catalog.
      this.abortActive('检测到阅读 Chat 以外的工具，已停止连接。'); this.rpc?.close(); this.status = null
    } else if (message.method === 'turn/completed') {
      if (active.turnId && p.turn.id !== active.turnId) return
      active.terminal = true
      if (p.turn.status === 'completed') {
        const text = active.text || active.items.get(active.lastItem) || ''
        if (text.trim()) active.complete(text); else active.fail(new Error('Codex 没有返回完整回答。'))
      } else active.fail(new Error(p.turn.status === 'interrupted' ? '请求已取消。' : 'Codex 生成失败，请检查订阅额度、模型或登录后重试。'))
    }
  }
  toolResult(owner: string, requestId: string, callId: string, result: unknown) {
    const active = this.active
    if (!active || active.owner !== owner || active.requestId !== requestId) throw new Error('该轮次已经结束。')
    const pending = active.tools.get(callId)
    if (!pending || pending.result) return
    const text = JSON.stringify(result)
    if (text.length > 200000) throw new Error('原文返回超过大小限制。')
    clearTimeout(pending.timer)
    const response = { contentItems: [{ type: 'inputText', text }], success: !(result as any)?.error }
    pending.result = response
    for (const id of pending.ids) this.rpc?.respond(id, response)
    this.touch(active)
  }
  cancel(owner: string, requestId?: string) {
    if (this.active?.owner === owner && (!requestId || requestId === this.active.requestId)) this.abortActive('请求已取消，正在通知 Codex 停止。')
  }
  private abortActive(message: string) {
    const active = this.active
    if (!active || active.cancelled || active.terminal) return
    active.cancelled = true
    const getTurnId = active.turnId ? Promise.resolve(active.turnId) : active.starting?.then(result => result.turn.id as string)
    if (active.threadId && getTurnId && this.rpc) {
      const rpc = this.rpc
      const stopped = new Promise<void>(resolve => { active.stopped = resolve })
      let timer: ReturnType<typeof setTimeout>
      active.stop = Promise.race([
        getTurnId.then(turnId => { active.turnId = turnId; return rpc.request('turn/interrupt', { threadId: active.threadId, turnId }, 5000) }).then(() => stopped),
        new Promise<void>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('停止确认超时。')), 5000) }),
      ]).catch(() => { rpc.close(); if (this.rpc === rpc) this.status = null }).finally(() => clearTimeout(timer))
    }
    for (const pending of active.tools.values()) if (!pending.result) for (const id of pending.ids) {
      try { this.rpc?.respond(id, { success: false, contentItems: [{ type: 'inputText', text: '阅读请求已结束。' }] }) } catch { /* disconnected */ }
    }
    active.fail(new Error(message))
  }
  close() { this.abortActive('阅读器服务已关闭。'); this.rpc?.close(); this.rpc = null; this.status = null }
}

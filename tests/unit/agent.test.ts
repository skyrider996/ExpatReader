import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { describe, expect, it, vi } from 'vitest'
import { catalogFingerprint, pickerModels, readingCatalog, readingOverrides } from '../../server/codex-policy'
import { selectEffort, validateChoice, type AgentModel } from '../../src/core/agent'
import { BookToolSession, verifiedAnswer } from '../../src/core/assistant'
import { ReaderDB } from '../../src/core/storage'
import { exportBackup } from '../../src/core/backup'
import { db } from '../../src/core/storage'
import { askAgentBook, newAgentSession, deleteAgentSession } from '../../src/core/agent-reading'
import { agentClient } from '../../src/adapters/agent'
import { CodexService } from '../../server/codex-service'
import type { ContentService } from '../../src/core/content'

const model: AgentModel = { id: 'picker-id', model: 'actual-model', displayName: 'Example', description: '', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }, { reasoningEffort: 'medium', description: 'Default' }] }
describe('subscription choices and reading capabilities', () => {
  it('keeps supported effort and changes invalid effort to the new model default', () => {
    expect(selectEffort(model, 'low')).toBe('low')
    expect(selectEffort(model, 'max')).toBe('medium')
    expect(validateChoice([model], { model: 'actual-model', effort: 'low', mode: 'chat' })).toBe(model)
    expect(() => validateChoice([model], { model: 'picker-id', effort: 'low', mode: 'chat' })).toThrow('模型列表')
    expect(() => validateChoice([model], { model: 'actual-model', effort: 'high', mode: 'chat' })).toThrow('推理强度')
  })
  it('does not turn catalog-wide enums or Ultra into executable reading options', () => {
    const options = pickerModels([{ ...model, hidden: false, supportedReasoningEfforts: [...model.supportedReasoningEfforts, { reasoningEffort: 'ultra', description: 'Multi-agent' }] }, { ...model, hidden: true }])
    expect(options).toHaveLength(1)
    expect(options[0]!.supportedReasoningEfforts.map(x => x.reasoningEffort)).toEqual(['low', 'medium', 'ultra'])
    expect(() => validateChoice(options, { model: model.model, effort: 'ultra', mode: 'chat' })).toThrow('推理强度')
  })
  it('removes execution capabilities without changing the original Codex model catalog', () => {
    const source = { models: [{ slug: 'example', shell_type: 'unified_exec', apply_patch_tool_type: 'freeform', experimental_supported_tools: ['clock', 'test_sync_tool'], tool_mode: 'code_mode_only' }] }
    const reading = readingCatalog(source)
    expect(source.models[0]!.shell_type).toBe('unified_exec')
    expect(reading.models[0]).toMatchObject({ shell_type: 'disabled', apply_patch_tool_type: null, experimental_supported_tools: [], node_repl_disabled: true, tool_mode: 'direct' })
    const policy = readingOverrides(['my_tools'])
    expect(policy).toMatchObject({ 'features.shell_tool': false, 'features.apps': false, 'features.hooks': false, 'agents.enabled': false, 'mcp_servers.my_tools.enabled': false, 'permissions.reader.network.enabled': false })
    expect(() => readingOverrides(['un.safe'])).toThrow('配置名称')
    expect(() => readingCatalog({})).toThrow('模型能力缓存')
    expect(catalogFingerprint({ a: 1, b: { x: 1, y: 2 } })).toBe(catalogFingerprint({ b: { y: 2, x: 1 }, a: 1 }))
  })
})

it('counts selected text in the shared reading budget and never validates earlier-turn citations', async () => {
  const bookId = 'a'.repeat(64)
  const locator = { bookId, section: 0, cfi: 'epubcfi(/6/2!/4/2/1:0)', quote: 'garden', prefix: '', suffix: '' }
  const content = { bookId, book: { sections: [{}] }, readSection: async () => ({ passages: [{ id: 'p1', text: 'garden', locator, chapter: 'One' }], nextOffset: null }) } as unknown as ContentService
  const session = new BookToolSession(content, { searchBook: async () => { throw new Error('not used') } }, 10)
  session.addContext('selected text')
  await session.execute('readSection', { section: 0 })
  expect(session.characters).toBe('selected textgarden'.length)
  expect(verifiedAnswer('Old [R1], current [R11], fake [R999].', session).citations.map(x => x.id)).toEqual(['R11'])
  expect(verifiedAnswer('Old [R1], current [R11].', session).text).toContain('Old [未验证引用]')
  session.addContext('x'.repeat(30000))
  expect(await session.execute('readSection', { section: 0 })).toHaveProperty('error')
  expect(session.characters).toBe(30000)
})

it('upgrades the old book database without losing records or leaking chats into v1 backups', async () => {
  const name = `agent-migration-${crypto.randomUUID()}`
  const old = new Dexie(name)
  old.version(1).stores({ books: 'id, openedAt', progress: 'bookId', annotations: 'id, bookId, updatedAt', learning: 'id, bookId, updatedAt' })
  await old.table('books').put({ id: 'a'.repeat(64), title: 'Book', filename: 'book.epub', openedAt: 1 })
  old.close()
  const db = new ReaderDB(name)
  try {
    expect(await db.books.count()).toBe(1)
    await db.agentSessions.put({ id: 'session', bookId: 'a'.repeat(64), identity: 'identity', provider: 'codex', title: 'Chat', choice: { model: model.model, effort: 'low', mode: 'chat' }, nextCitation: 1, updatedAt: 1 })
    expect(await db.agentSessions.count()).toBe(1)
    const backup = await exportBackup(db)
    expect(backup).not.toContain('agentSessions')
    expect(backup).not.toContain('identity')
    expect(JSON.parse(backup).version).toBe(1)
  } finally { await db.delete() }
})

it('reserves citations from cancelled reads before resuming from a stale browser session', async () => {
  const bookId = 'a'.repeat(64), choice = { model: model.model, effort: 'low', mode: 'chat' as const }
  const session = await newAgentSession(bookId, 'test', choice), controller = new AbortController()
  const locator = { bookId, section: 0, cfi: 'epubcfi(/6/2!/4/2/1:0)', quote: 'garden', prefix: '', suffix: '' }
  const content = { bookId, book: { sections: [{}] }, readSection: async () => ({ passages: [{ id: 'p1', text: 'garden', locator, chapter: 'One' }], nextOffset: null }) } as unknown as ContentService
  const search = { searchBook: async () => { throw new Error('not used') } }
  const run = vi.spyOn(agentClient, 'run')
  try {
    run.mockImplementationOnce(async (_input, _signal, _event, tool) => { await tool('readSection', { section: 0 }); controller.abort(); throw new Error('cancelled') })
    await expect(askAgentBook({ content, search, session: { ...session }, choice, question: 'First', selection: '', signal: controller.signal, update: () => {} })).rejects.toThrow('cancelled')
    expect(await db.agentMessages.where('sessionId').equals(session.id).count()).toBe(0)
    run.mockImplementationOnce(async (_input, _signal, _event, tool) => {
      const result = await tool('readSection', { section: 0 }) as any
      expect(result.passages[0].citation).toBe('R2')
      return 'Read again [R2]. Old [R1].'
    })
    const message = await askAgentBook({ content, search, session: { ...session }, choice, question: 'Second', selection: '', signal: new AbortController().signal, update: () => {} })
    expect(message.answer.citations.map(c => c.id)).toEqual(['R2'])
    expect(message.answer.text).toContain('Old [未验证引用]')
  } finally { run.mockRestore(); await deleteAgentSession(session.id) }
})

function runtimeHarness(start: (runtime: any) => Promise<any>) {
  const service = new CodexService(process.cwd()), runtime = service as any
  runtime.status = { state: 'ready', identity: 'identity', models: [model] }
  const identity = vi.spyOn(runtime, 'readIdentity').mockResolvedValue('identity')
  runtime.rpc = {
    close: vi.fn(), send: vi.fn(), respond: vi.fn(),
    request: vi.fn(async (method: string) => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'thread/start') return { thread: { id: 'thread' }, model: model.model, modelProvider: 'openai', activePermissionProfile: { id: 'reader' }, approvalPolicy: 'never', sandbox: { networkAccess: false } }
      if (method === 'turn/start') return start(runtime)
      if (method === 'turn/interrupt') queueMicrotask(() => runtime.handle({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'current', status: 'interrupted' } } }))
      return {}
    }),
  }
  const input = { sessionId: crypto.randomUUID(), bookId: 'a'.repeat(64), identity: 'identity', choice: { model: model.model, effort: 'low', mode: 'chat' as const }, prompt: 'Example', temporary: true }
  return { service, runtime, input, identity }
}

it('ignores replayed earlier-turn events while preserving events arriving before the start response', async () => {
  const { service, runtime, input, identity } = runtimeHarness(async runtime => {
    await Promise.resolve()
    runtime.handle({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread', turnId: 'previous', tokenUsage: { last: { inputTokens: 999, outputTokens: 999 } } } })
    runtime.handle({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'current', itemId: 'answer', delta: 'Current answer' } })
    setTimeout(() => {
      runtime.handle({ method: 'item/completed', params: { threadId: 'thread', turnId: 'current', item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'Current answer' } } })
      runtime.handle({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'current', status: 'completed' } } })
    }, 0)
    return { turn: { id: 'current' } }
  })
  const events: any[] = []
  try {
    expect(await service.run('owner', '1', input, event => events.push(event))).toBe('Current answer')
    expect(events).toContainEqual({ type: 'delta', text: 'Current answer' })
    expect(events.some(e => e.type === 'usage')).toBe(false)
    expect(runtime.active).toBeNull()
  } finally { service.close(); identity.mockRestore() }
})

it('keeps the connection busy until a cancelled in-flight turn/start is interrupted', async () => {
  let resolve!: (data: any) => void, started = false
  const { service, runtime, input, identity } = runtimeHarness(() => { started = true; return new Promise(yes => { resolve = yes }) })
  try {
    const pending = service.run('owner', '1', input, () => {})
    const cancelled = expect(pending).rejects.toThrow('取消')
    await vi.waitFor(() => expect(started).toBe(true))
    service.cancel('owner', '1')
    await expect(service.run('owner', '2', input, () => {})).rejects.toThrow('其他请求')
    resolve({ turn: { id: 'current' } })
    await cancelled
    expect(runtime.active).toBeNull()
    expect(runtime.rpc.close).not.toHaveBeenCalled()
  } finally { service.close(); identity.mockRestore() }
})

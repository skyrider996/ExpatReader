import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReaderDB } from '../../src/core/storage'
import { exportBackup, importBackup, parseBackup } from '../../src/core/backup'
import { PassageIndex } from '../../src/core/search-index'
import { askBook, BookToolSession } from '../../src/core/assistant'
import { endpointURL, explainSelection, modelClient, type Complete } from '../../src/adapters/model'
import type { ContentService } from '../../src/core/content'
import type { Annotation, Locator, Passage } from '../../src/core/types'

const bookId = 'a'.repeat(64)
const location: Locator = { bookId, section: 0, cfi: 'epubcfi(/6/2!/4/2/1:0)', quote: 'Original text', prefix: '', suffix: '' }
const passage: Passage = { id: 'p1', bookId, section: 0, ordinal: 0, chapter: 'Chapter one', text: 'Original text in the quiet garden. 中文检索保留语境。', locator: location }
const annotation: Annotation = { id: 'note1', bookId, locator: location, chapter: 'Chapter one', note: 'My note', createdAt: 1, updatedAt: 2 }
const databases: ReaderDB[] = []
const database = () => { const d = new ReaderDB(`test-${crypto.randomUUID()}`); databases.push(d); return d }
afterEach(async () => { for (const d of databases.splice(0)) await d.delete(); vi.unstubAllGlobals() })

describe('record backups', () => {
  it('restores missing-book records, preserves newer edits and is idempotent', async () => {
    const source = database(), target = database()
    await source.annotations.put(annotation)
    await source.learning.put({ ...annotation, explanation: '语境解释', targetLanguage: 'zh', id: 'learn1' })
    await source.progress.put({ bookId, locator: location, updatedAt: 2 })
    const backup = await exportBackup(source)
    expect(backup).not.toContain('apiKey')
    expect(await importBackup(backup, target)).toEqual({ changed: 3, missingBooks: 1 })
    expect(await importBackup(backup, target)).toEqual({ changed: 0, missingBooks: 1 })
    await target.annotations.update('note1', { note: 'Newer edit', updatedAt: 9 })
    await importBackup(backup, target)
    expect((await target.annotations.get('note1'))?.note).toBe('Newer edit')
  })
  it('rejects malformed versions and cross-book records before writing', async () => {
    const source = database(), target = database()
    await source.annotations.put(annotation)
    const value = JSON.parse(await exportBackup(source))
    value.annotations[0].locator.bookId = 'b'.repeat(64)
    await expect(importBackup(JSON.stringify(value), target)).rejects.toThrow('不一致')
    expect(await target.annotations.count()).toBe(0)
    expect(() => parseBackup(JSON.stringify({ ...value, version: 99 }))).toThrow('版本')
  })
  it('rolls back all changes on conflicting IDs', async () => {
    const source = database(), target = database()
    await source.annotations.bulkPut([{ ...annotation, id: 'first' }, annotation])
    await target.annotations.put({ ...annotation, locator: { ...location, cfi: 'epubcfi(/6/2!/4/4/1:0)' } })
    await expect(importBackup(await exportBackup(source), target)).rejects.toThrow('冲突')
    expect(await target.annotations.count()).toBe(1)
    expect(await target.annotations.get('first')).toBeUndefined()
  })
})

it('finds English and Chinese while preserving distinct repeated locations', () => {
  const index = new PassageIndex()
  index.add([passage, { ...passage, id: 'p2', locator: { ...location, cfi: 'different' } }])
  expect(index.search('quiet')).toHaveLength(2)
  expect(index.search('中文')).toHaveLength(2)
  expect(index.search('notInBook')).toHaveLength(0)
})

const content = {
  bookId, book: { sections: [{}, {}] },
  getOutline: vi.fn(() => [{ section: 0, label: 'Chapter one' }]),
  readPassage: vi.fn(async () => [passage]),
  readSection: vi.fn(async () => ({ passages: [passage], nextOffset: null })),
} as unknown as ContentService
const search = { searchBook: vi.fn(async () => ({ results: [{ ...passage, score: 1 }], complete: true, indexedSections: 2, totalSections: 2 })) }
const tool = (name: string, args: object) => ({ role: 'assistant' as const, content: null, tool_calls: [{ id: crypto.randomUUID(), type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] })

describe('AI book tools', () => {
  it('shares search and content services, validates references and never grants navigation', async () => {
    const responses = [tool('searchBook', { query: 'quiet' }), tool('readPassage', { passageId: 'p1' }), { role: 'assistant' as const, content: '依据 [R1]；虚构 [R999]。' }]
    const complete: Complete = vi.fn(async () => responses.shift()!)
    const answer = await askBook(complete, content, search, 'Why?', new AbortController().signal, () => {})
    expect(search.searchBook).toHaveBeenCalledWith(bookId, 'quiet', { limit: 5 })
    expect(answer.citations.map(c => c.id)).toEqual(['R1'])
    expect(answer.text).toContain('[未验证引用]')
    expect(answer.characters).toBe(passage.text.length * 2)
    await expect(new BookToolSession(content, search).execute('navigateTo', {})).rejects.toThrow('只能读取')
  })
  it('enforces the tool-call limit even when the model asks to continue', async () => {
    const complete: Complete = async (_messages, tools) => tools ? tool('getOutline', {}) : { role: 'assistant', content: '证据不足。' }
    const answer = await askBook(complete, content, search, 'Why?', new AbortController().signal, () => {})
    expect(answer.calls).toBe(8); expect(answer.limited).toBe(true)
  })
  it('enforces the character budget for long passages', async () => {
    const longContent = { ...content, readSection: async () => ({ passages: [{ ...passage, text: 'x'.repeat(20000) }], nextOffset: 1 }) } as unknown as ContentService
    const session = new BookToolSession(longContent, search)
    await session.execute('readSection', { section: 0 })
    await session.execute('readSection', { section: 0 })
    expect(session.characters).toBe(30000)
    expect(await session.execute('readSection', { section: 0 })).toHaveProperty('error')
  })
  it('requires a known passage and valid argument types', async () => {
    const session = new BookToolSession(content, search)
    await expect(session.execute('readPassage', { passageId: 'invented' })).rejects.toThrow('片段 ID')
    await expect(session.execute('readSection', { section: -1 })).rejects.toThrow('章节')
  })
  it('cancels before making a request', async () => {
    const complete = vi.fn(), controller = new AbortController(); controller.abort()
    await expect(askBook(complete, content, search, 'Why?', controller.signal, () => {})).rejects.toThrow()
    expect(complete).not.toHaveBeenCalled()
  })
})

describe('model transport', () => {
  it('accepts HTTPS and local endpoints but rejects embedded credentials', () => {
    expect(endpointURL('https://model.test/v1/')).toBe('https://model.test/v1/chat/completions')
    expect(endpointURL('http://127.0.0.1:9000/v1')).toContain('/chat/completions')
    expect(() => endpointURL('https://secret@model.test')).toThrow('登录')
    expect(() => endpointURL('http://model.test')).toThrow('HTTPS')
  })
  it('restricts the agent mode to an explicitly ported loopback HTTP endpoint', async () => {
    expect(() => modelClient({ mode: 'agent', endpoint: 'https://model.test/v1', model: 'agent', apiKey: '' })).toThrow('本地 Agent')
    expect(() => modelClient({ mode: 'agent', endpoint: 'http://127.0.0.1/v1', model: 'agent', apiKey: '' })).toThrow('本地 Agent')
    const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const complete = modelClient({ mode: 'agent', endpoint: 'http://127.0.0.1:8765/v1', model: 'agent', apiKey: '' })
    expect((await complete([{ role: 'user', content: 'hello' }])).content).toBe('ok')
    expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:8765/v1/chat/completions')
  })
  it('reports failed HTTP without exposing response bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('secret provider detail', { status: 401 })))
    const complete = modelClient({ endpoint: 'https://model.test/v1', model: 'test', apiKey: 'test-only' })
    await expect(complete([{ role: 'user', content: 'hello' }])).rejects.toThrow('HTTP 401')
  })
  it('rejects empty explanations and forwards context only on explicit requests', async () => {
    const complete: Complete = vi.fn(async () => ({ role: 'assistant' as const, content: '' }))
    await expect(explainSelection(complete, 'word', 'context', new AbortController().signal)).rejects.toThrow('未获得')
  })
})


import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import Dexie from 'dexie'
import { ReaderDB } from '../../src/core/storage'
import { PassageIndex } from '../../src/core/search-index'
import { SEARCH_CACHE_VERSION, clearSearchCache, readSearchCache, writeSearchCache } from '../../src/core/search-cache'
import type { Passage } from '../../src/core/types'
const stores: ReaderDB[] = []
function database() { const store = new ReaderDB(`search-test-${crypto.randomUUID()}`); stores.push(store); return store }
afterEach(async () => { for (const store of stores.splice(0)) await store.delete() })
const bookId = 'a'.repeat(64)
const passage: Passage = { id: 'p1', bookId, section: 1, ordinal: 0, chapter: '第二章', text: 'The quiet garden. 中文原文。', locator: { bookId, section: 1, cfi: 'epubcfi(/6/4!/4/2/1:0)', quote: 'The quiet garden. 中文原文。', prefix: 'before', suffix: 'after' } }

describe('persistent search indexes', () => {
  it('upgrades an existing v2 database without altering notes or reading progress', async () => {
    const name = `search-test-${crypto.randomUUID()}`, old = new Dexie(name)
    old.version(1).stores({ books: 'id, openedAt', progress: 'bookId', annotations: 'id, bookId, updatedAt', learning: 'id, bookId, updatedAt' })
    old.version(2).stores({ agentSessions: 'id, [bookId+identity], updatedAt', agentMessages: 'id, sessionId, createdAt' })
    try {
      await old.table('annotations').put({ id: 'existing-note', bookId, locator: passage.locator, chapter: '第二章', note: 'existing content', createdAt: 1, updatedAt: 1 })
      await old.table('progress').put({ bookId, locator: passage.locator, updatedAt: 2 })
    } finally { old.close() }
    const upgraded = new ReaderDB(name); stores.push(upgraded)
    expect((await upgraded.annotations.get('existing-note'))?.note).toBe('existing content')
    expect((await upgraded.progress.get(bookId))?.locator).toEqual(passage.locator)
    expect(await upgraded.searchIndexes.count()).toBe(0)
  })
  it('restores rankings, original locators and multilingual search without retokenizing the book', async () => {
    const store = database(), index = new PassageIndex()
    index.add([passage, { ...passage, id: 'p2', locator: { ...passage.locator, cfi: 'other-location' } }])
    const { epoch } = await readSearchCache(bookId, 2, store)
    expect(await writeSearchCache(bookId, 2, index.serialize(), epoch, store)).toBe(true)
    const loaded = await readSearchCache(bookId, 2, store), restored = new PassageIndex()
    restored.restore(loaded.cached!.index)
    expect(restored.search('quiet')).toEqual(index.search('quiet'))
    expect(restored.search('中文')).toEqual(index.search('中文'))
    expect(restored.search('quiet')[0].locator.prefix).toBe('before')
    expect(await readSearchCache('b'.repeat(64), 2, store)).toMatchObject({ cached: null })
    expect(await readSearchCache(bookId, 3, store)).toMatchObject({ cached: null })
    await store.searchIndexes.update(bookId, { version: SEARCH_CACHE_VERSION - 1 })
    expect(await readSearchCache(bookId, 2, store)).toMatchObject({ cached: null })
  })
  it('does not restore cleared indexes from an in-flight build or remove personal records', async () => {
    const store = database(), index = new PassageIndex(); index.add([passage])
    const { epoch } = await readSearchCache(bookId, 2, store)
    await writeSearchCache(bookId, 2, index.serialize(), epoch, store)
    await store.annotations.put({ id: 'note', bookId, locator: passage.locator, chapter: passage.chapter, note: 'keep my note', createdAt: 1, updatedAt: 1 })
    await clearSearchCache(store)
    expect(await store.searchIndexes.count()).toBe(0)
    expect(await writeSearchCache(bookId, 2, index.serialize(), epoch, store)).toBe(false)
    const next = await readSearchCache(bookId, 2, store)
    expect(next.epoch).not.toBe(epoch)
    expect(await writeSearchCache(bookId, 2, index.serialize(), next.epoch, store)).toBe(true)
    expect((await store.annotations.get('note'))?.note).toBe('keep my note')
  })
})

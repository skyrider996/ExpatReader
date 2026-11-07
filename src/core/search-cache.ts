import { db, type ReaderDB } from './storage'

// Bump when extraction, locator semantics or index/tokenizer options change.
export const SEARCH_CACHE_VERSION = 1
export interface CachedSearchIndex { bookId: string; version: number; totalSections: number; index: string; createdAt: number }
export async function readSearchCache(bookId: string, totalSections: number, store: ReaderDB = db) {
  return store.transaction('r', store.searchIndexes, store.cacheState, async () => {
    const epoch = (await store.cacheState.get('search'))?.epoch || '0'
    const cached = await store.searchIndexes.get(bookId)
    return { epoch, cached: cached?.version === SEARCH_CACHE_VERSION && cached.totalSections === totalSections && typeof cached.index === 'string' ? cached : null }
  })
}
export async function writeSearchCache(bookId: string, totalSections: number, index: string, epoch: string, store: ReaderDB = db) {
  return store.transaction('rw', store.searchIndexes, store.cacheState, async () => {
    // A build begun before Clear Cache must not recreate the just-cleared data.
    if (((await store.cacheState.get('search'))?.epoch || '0') !== epoch) return false
    await store.searchIndexes.put({ bookId, version: SEARCH_CACHE_VERSION, totalSections, index, createdAt: Date.now() })
    return true
  })
}
export async function clearSearchCache(store: ReaderDB = db) {
  await store.transaction('rw', store.searchIndexes, store.cacheState, async () => {
    await store.searchIndexes.clear()
    await store.cacheState.put({ key: 'search', epoch: crypto.randomUUID() })
  })
}

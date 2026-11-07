import { PassageIndex } from '../core/search-index'
import { readSearchCache, writeSearchCache } from '../core/search-cache'
const index = new PassageIndex()
let epoch = '0', bookId = '', totalSections = 0
self.onmessage = async event => {
  const { id, type, passages, query, section, limit } = event.data
  try {
    let data: unknown
    if (type === 'restore') {
      bookId = event.data.bookId; totalSections = event.data.totalSections
      let restored = false
      try {
        const cache = await readSearchCache(bookId, totalSections); epoch = cache.epoch
        if (cache.cached) { index.restore(cache.cached.index); restored = true }
      } catch { /* Cache corruption, storage denial or quota must not disable search. */ }
      data = { restored }
    } else if (type === 'save') {
      try { data = { cached: await writeSearchCache(bookId, totalSections, index.serialize(), epoch) } }
      catch { data = { cached: false } }
    } else if (type === 'add') data = index.add(passages)
    else if (type === 'search') data = index.search(query, section, limit)
    else throw new Error('未知的检索操作。')
    self.postMessage({ id, data })
  } catch (e) { self.postMessage({ id, error: e instanceof Error ? e.message : String(e) }) }
}

import { PassageIndex } from '../core/search-index'
const index = new PassageIndex()
self.onmessage = event => {
  const { id, type, passages, query, section, limit } = event.data
  try {
    const data = type === 'add' ? index.add(passages) : index.search(query, section, limit)
    self.postMessage({ id, data })
  } catch (e) { self.postMessage({ id, error: e instanceof Error ? e.message : String(e) }) }
}

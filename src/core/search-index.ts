import MiniSearch from 'minisearch'
import type { Passage, SearchHit } from './types'

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
export const tokenize = (text: string) => Array.from(segmenter.segment(text.toLowerCase())).filter(x => x.isWordLike).map(x => x.segment)
const options = { fields: ['text', 'chapter'], storeFields: ['bookId', 'section', 'ordinal', 'chapter', 'text', 'locator'], tokenize }
export class PassageIndex {
  private index = new MiniSearch<Passage>(options)
  serialize() { return JSON.stringify(this.index) }
  restore(json: string) { this.index = MiniSearch.loadJSON<Passage>(json, options) }
  add(passages: Passage[]) { this.index.addAll(passages) }
  search(query: string, section?: number, limit = 20): SearchHit[] {
    if (!query.trim()) return []
    return this.index.search(query, { prefix: true, fuzzy: .15, combineWith: 'AND', filter: section === undefined ? undefined : result => result.section === section })
      .slice(0, Math.min(50, Math.max(1, limit))).map(x => ({ id: x.id, bookId: x.bookId, section: x.section, ordinal: x.ordinal, chapter: x.chapter, text: x.text, locator: x.locator, score: x.score }))
  }
}

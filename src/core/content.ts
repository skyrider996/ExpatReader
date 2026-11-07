import { LocationAdapter, isUI } from '../adapters/location'
import type { OutlineItem, Passage, Locator } from './types'
import { readingSlice } from './reading-tasks'

const BLOCKS = 'p,li,blockquote,dd,dt,h1,h2,h3,h4,h5,h6,pre,td,th,div,section,article,body'
export class ContentService {
  private sections = new Map<number, Promise<Passage[]>>()
  private background = new Set<number>()
  private lifecycle = new AbortController()
  readonly outline: OutlineItem[] = []
  constructor(readonly bookId: string, readonly book: any, readonly locations: LocationAdapter) {
    const firstHref = (item: any): string => typeof item.href === 'string' && item.href ? item.href : (item.subitems ?? []).map(firstHref).find(Boolean) ?? ''
    const flatten = (items: any[], depth = 0) => items.forEach(item => {
      const href = firstHref(item)
      const section = href ? book.resolveHref(href)?.index ?? 0 : 0
      this.outline.push({ label: String(item.label ?? '未命名章节'), href, section, depth })
      flatten(item.subitems ?? [], depth + 1)
    })
    flatten(book.toc ?? [])
    if (!this.outline.length) book.sections.forEach((_: unknown, section: number) => this.outline.push({ label: `第 ${section + 1} 节`, href: '', section, depth: 0 }))
  }
  getOutline(bookId = this.bookId) { this.assertBook(bookId); return this.outline.map(x => ({ ...x })) }
  assertBook(id: string) { if (id !== this.bookId) throw new Error('请求不属于当前书籍。') }
  title(section: number) { return this.outline.find(x => x.section === section)?.label ?? `第 ${section + 1} 节` }
  async document(section: number): Promise<Document> {
    if (!Number.isInteger(section) || !this.book.sections[section]) throw new Error('无效的章节。')
    return this.book.sections[section].createDocument()
  }
  getSection(section: number, options: { background?: boolean } = {}): Promise<Passage[]> {
    if (this.lifecycle.signal.aborted) return Promise.reject(this.lifecycle.signal.reason)
    if (!options.background) this.background.delete(section)
    if (!this.sections.has(section)) {
      if (options.background) this.background.add(section)
      const request = this.extract(section).catch(e => { this.sections.delete(section); throw e })
      this.sections.set(section, request)
    }
    return this.sections.get(section)!
  }
  private async extract(section: number): Promise<Passage[]> {
    const signal = this.lifecycle.signal
    let deadline = await readingSlice(signal, this.background.has(section))
    const doc = await this.document(section)
    signal.throwIfAborted()
    const root = doc.body ?? doc.documentElement
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: node => {
      const parent = node.parentElement
      return isUI(node) || parent?.closest('script,style,noscript') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    } })
    const groups: { nodes: Text[]; start: number; end: number }[] = []
    const text: string[] = []
    let offset = 0
    let previous: Element | null = null
    let node: Node | null
    while ((node = walker.nextNode())) {
      const value = node.textContent || ''
      text.push(value)
      if (value.trim() && !node.parentElement?.closest('nav,[hidden]')) {
        const block = node.parentElement?.closest(BLOCKS) ?? root
        if (previous !== block) groups.push({ nodes: [], start: offset, end: offset })
        groups.at(-1)!.nodes.push(node as Text); groups.at(-1)!.end = offset + value.length; previous = block
      }
      offset += value.length
      if (performance.now() >= deadline) deadline = await readingSlice(signal, this.background.has(section))
    }
    // Context offsets refer to all original body text, including whitespace and
    // excluded navigation, exactly as LocationAdapter.capture/resolve do.
    const original = text.join(''), passages: Passage[] = []
    for (const [ordinal, { nodes, start, end }] of groups.entries()) {
      if (performance.now() >= deadline) deadline = await readingSlice(signal, this.background.has(section))
      const range = doc.createRange()
      range.setStart(nodes[0], 0); range.setEnd(nodes.at(-1)!, nodes.at(-1)!.length)
      const locator = this.locations.capture(section, range, { prefix: original.slice(Math.max(0, start - 40), start), suffix: original.slice(end, end + 40) })
      passages.push({ id: `${this.bookId}:${section}:${ordinal}`, bookId: this.bookId, section, ordinal,
        chapter: this.title(section), text: locator.quote, locator })
    }
    return passages
  }
  dispose() { this.lifecycle.abort(); this.sections.clear(); this.background.clear() }
  async readPassage(bookId: string, locator: Locator, options: { before?: number; after?: number; maxChars?: number } = {}) {
    this.assertBook(bookId)
    const doc = await this.document(locator.section)
    const selected = this.locations.resolve(doc, locator)
    const passages = await this.getSection(locator.section)
    const ordinal = passages.findIndex(p => {
      const candidate = this.locations.range(doc, p.locator.cfi)
      return candidate.compareBoundaryPoints(Range.START_TO_START, selected) <= 0 && candidate.compareBoundaryPoints(Range.END_TO_END, selected) >= 0
    })
    if (ordinal < 0) return [{ id: `selection:${locator.cfi}`, text: locator.quote.slice(0, options.maxChars ?? 6000), chapter: this.title(locator.section), locator }]
    const before = Math.min(3, Math.max(0, options.before ?? 1)), after = Math.min(3, Math.max(0, options.after ?? 1))
    let remaining = Math.min(12000, Math.max(1, options.maxChars ?? 6000))
    const result = []
    for (const passage of passages.slice(Math.max(0, ordinal - before), ordinal + after + 1)) {
      if (remaining <= 0) break
      const text = passage.text.slice(0, remaining)
      result.push({ ...passage, text, truncated: text.length < passage.text.length })
      remaining -= text.length
    }
    return result
  }
  async readSection(bookId: string, section: number, options: { offset?: number; maxChars?: number } = {}) {
    this.assertBook(bookId)
    const passages = await this.getSection(section)
    let offset = Math.max(0, Math.floor(options.offset ?? 0))
    let remaining = Math.min(12000, Math.max(1, options.maxChars ?? 6000))
    const result = []
    // Character cursor includes one virtual separator between passages; it can resume within long paragraphs.
    let start = 0, cursor = offset
    for (const p of passages) {
      const end = start + p.text.length + 1
      if (offset < end && remaining > 0) {
        const from = Math.max(0, offset - start)
        const text = p.text.slice(from, from + remaining)
        if (text) result.push({ ...p, text, truncated: from > 0 || text.length < p.text.length })
        remaining -= text.length
        cursor = start + from + text.length
        if (cursor >= end - 1) cursor = end
        offset = cursor
      }
      start = end
    }
    return { passages: result, nextOffset: cursor < start ? cursor : null }
  }
}

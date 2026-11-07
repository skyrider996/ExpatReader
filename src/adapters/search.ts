import type { ContentService } from '../core/content'
import { readingSlice } from '../core/reading-tasks'
import type { SearchResponse } from '../core/types'

export class SearchService {
  private worker: Worker | null = null
  private pending = new Map<number, { resolve: (data: any) => void; reject: (error: Error) => void }>()
  private sequence = 0
  private disposed = false
  private failure: Error | null = null
  private lifecycle = new AbortController()
  private initialized: Promise<void> | null = null
  private building: Promise<void> | null = null
  private wake: (() => void) | null = null
  private urgent = false
  indexedSections = 0
  complete = false
  restoredFromCache = false
  readonly totalSections: number
  constructor(readonly content: ContentService) { this.totalSections = content.book.sections.length }
  private fail(error: Error) { this.failure = error; for (const p of this.pending.values()) p.reject(error); this.pending.clear() }
  private request(type: string, args: object = {}) {
    if (this.disposed) return Promise.reject(new Error('书籍已关闭。'))
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.sequence
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.worker!.postMessage({ id, type, ...args }) } catch (e) { this.pending.delete(id); reject(e) }
    })
  }
  private initialize() {
    if (!this.initialized) this.initialized = (async () => {
      this.lifecycle.signal.throwIfAborted()
      this.worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = ({ data }) => {
        const pending = this.pending.get(data.id); this.pending.delete(data.id)
        if (data.error) pending?.reject(new Error(data.error)); else pending?.resolve(data.data)
      }
      this.worker.onerror = () => this.fail(new Error('检索工作线程发生错误，请重新打开书籍。'))
      const result = await this.request('restore', { bookId: this.content.bookId, totalSections: this.totalSections })
      if (result.restored) { this.restoredFromCache = true; this.complete = true; this.indexedSections = this.totalSections }
    })()
    return this.initialized
  }
  private settleReading() {
    return new Promise<void>(resolve => {
      const signal = this.lifecycle.signal
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); this.wake = null; resolve() }
      const timer = setTimeout(done, 600)
      this.wake = done; signal.addEventListener('abort', done, { once: true })
      if (signal.aborted) done()
    })
  }
  build(update: (done: number, total: number) => void) {
    if (!this.building) this.building = this.populate(update)
    return this.building
  }
  private async populate(update: (done: number, total: number) => void) {
    await this.settleReading()
    if (this.disposed) return
    await readingSlice(this.lifecycle.signal, !this.urgent)
    await this.initialize()
    if (this.disposed) return
    update(this.indexedSections, this.totalSections)
    if (this.complete) return
    for (let section = 0; section < this.totalSections; section++) {
      if (this.disposed) return
      const passages = await this.content.getSection(section, { background: !this.urgent })
      for (let offset = 0; offset < passages.length; offset += 40) {
        if (this.disposed) return
        await this.request('add', { passages: passages.slice(offset, offset + 40) })
        await readingSlice(this.lifecycle.signal, !this.urgent)
      }
      this.indexedSections++
      if (this.indexedSections < this.totalSections) update(this.indexedSections, this.totalSections)
    }
    if (this.disposed) return
    this.complete = true
    await this.request('save')
    if (!this.disposed) update(this.indexedSections, this.totalSections)
  }
  async searchBook(bookId: string, query: string, options: { section?: number; limit?: number } = {}): Promise<SearchResponse> {
    this.content.assertBook(bookId)
    this.urgent = true
    if (!this.building) void this.build(() => {})
    this.wake?.()
    await this.initialize()
    if (!this.complete) await this.building
    const results = await this.request('search', { query, ...options })
    return { results, complete: this.complete, indexedSections: this.indexedSections, totalSections: this.totalSections }
  }
  dispose() { this.disposed = true; this.lifecycle.abort(); this.worker?.terminate(); this.fail(new Error('书籍已关闭。')) }
}

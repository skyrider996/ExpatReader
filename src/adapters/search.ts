import type { ContentService } from '../core/content'
import type { SearchResponse } from '../core/types'

export class SearchService {
  private worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' })
  private pending = new Map<number, { resolve: (data: any) => void; reject: (error: Error) => void }>()
  private sequence = 0
  private disposed = false
  indexedSections = 0
  complete = false
  readonly totalSections: number
  constructor(readonly content: ContentService) {
    this.totalSections = content.book.sections.length
    this.worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id)
      this.pending.delete(data.id)
      if (data.error) pending?.reject(new Error(data.error)); else pending?.resolve(data.data)
    }
    this.worker.onerror = () => this.fail(new Error('检索工作线程发生错误，请重新打开书籍。'))
  }
  private fail(error: Error) { for (const p of this.pending.values()) p.reject(error); this.pending.clear() }
  private request(type: string, args: object) {
    if (this.disposed) return Promise.reject(new Error('书籍已关闭。'))
    const id = ++this.sequence
    return new Promise<any>((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, type, ...args }) })
  }
  async build(update: (done: number, total: number) => void) {
    for (let section = 0; section < this.totalSections; section++) {
      if (this.disposed) return
      const passages = await this.content.getSection(section)
      if (this.disposed) return
      await this.request('add', { passages })
      this.indexedSections++
      update(this.indexedSections, this.totalSections)
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    this.complete = true
  }
  async searchBook(bookId: string, query: string, options: { section?: number; limit?: number } = {}): Promise<SearchResponse> {
    this.content.assertBook(bookId)
    const results = await this.request('search', { query, ...options })
    return { results, complete: this.complete, indexedSections: this.indexedSections, totalSections: this.totalSections }
  }
  dispose() { this.disposed = true; this.worker.terminate(); this.fail(new Error('书籍已关闭。')) }
}

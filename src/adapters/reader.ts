import { makeBook } from 'foliate-js/view.js'
import { Overlayer } from 'foliate-js/overlayer.js'
import { LocationAdapter, UI_ATTRIBUTE, isUI } from './location'
import { ContentService } from '../core/content'
import type { Annotation, LearningRecord, Locator } from '../core/types'
import { defaultPreferences, themeColors, type ReadingPreferences } from '../core/preferences'
import { highlightColor, type HighlightColor } from '../core/highlights'

export interface ReadingPosition { fraction: number; section: number; total: number; href: string }
export interface SelectionBounds { left: number; right: number; top: number; bottom: number }
type Callbacks = { selection: (locator: Locator, bounds?: SelectionBounds, annotationId?: string) => void; dismissSelection?: () => void; relocate: (locator: Locator, chapter: string, position: ReadingPosition) => void; error: (e: unknown) => void; escape?: () => void; action?: (action: "dictionary" | "ai" | "menu", locator: Locator) => void; mark?: (locator: Locator) => void }
export class ReaderAdapter {
  readonly locations: LocationAdapter
  readonly content: ContentService
  readonly view: any = document.createElement('foliate-view')
  private lifecycle = new AbortController()
  private queue = Promise.resolve()
  private annotations: Annotation[] = []
  private learning: LearningRecord[] = []
  private learningMode = false
  private preferences: ReadingPreferences = { ...defaultPreferences }
  private disposed = false
  private overlayTimer?: ReturnType<typeof setTimeout>
  private rendered = new Set<string>()
  lastLocation: Locator | null = null
  private constructor(readonly bookId: string, readonly book: any, private callbacks: Callbacks) {
    this.locations = new LocationAdapter(bookId, book)
    this.content = new ContentService(bookId, book, this.locations)
    this.locations.install(this.view)
    const on = (name: string, fn: (event: any) => void) => this.view.addEventListener(name, fn, { signal: this.lifecycle.signal })
    on('load', ({ detail: { doc, index } }) => {
      const selection = () => {
        if (this.disposed) return
        const selected = doc.defaultView.getSelection() as Selection
        if (!selected?.rangeCount || selected.isCollapsed) { this.callbacks.dismissSelection?.(); return }
        const range = selected.getRangeAt(0)
        if (!range.toString().trim()) return
        try {
          if (range.toString().length > 5000) throw new Error('请选择不超过 5,000 字符的词句。')
          const frame = doc.defaultView.frameElement as HTMLIFrameElement | null
          const frameRect = frame?.getBoundingClientRect(), viewport = this.view.getBoundingClientRect()
          const scaleX = frame && frameRect ? frameRect.width / (frame.clientWidth || frameRect.width) : 1
          const scaleY = frame && frameRect ? frameRect.height / (frame.clientHeight || frameRect.height) : 1
          const rects = Array.from(range.getClientRects(), rect => ({ left: (frameRect?.left || 0) + rect.left * scaleX, right: (frameRect?.left || 0) + rect.right * scaleX, top: (frameRect?.top || 0) + rect.top * scaleY, bottom: (frameRect?.top || 0) + rect.bottom * scaleY }))
          const visible = rects.filter(rect => rect.bottom > viewport.top && rect.top < viewport.bottom && rect.right > viewport.left && rect.left < viewport.right)
          const locator = this.locations.capture(index, range)
          this.callbacks.selection(locator, visible.at(-1), this.highlightAt(doc, locator))
        } catch (e) { this.callbacks.error(e) }
      }
      doc.addEventListener('pointerup', selection, { signal: this.lifecycle.signal })
      doc.addEventListener('keyup', selection, { signal: this.lifecycle.signal })
      doc.addEventListener('selectionchange', () => { if (doc.defaultView.getSelection()?.isCollapsed) this.callbacks.dismissSelection?.() }, { signal: this.lifecycle.signal })
      doc.addEventListener('scroll', () => this.callbacks.dismissSelection?.(), { signal: this.lifecycle.signal, capture: true })
      doc.addEventListener('contextmenu', (event: MouseEvent) => {
        const selection = doc.defaultView.getSelection() as Selection
        if (!selection?.rangeCount || selection.isCollapsed) return
        try { const locator = this.locations.capture(index, selection.getRangeAt(0)); event.preventDefault(); this.callbacks.action?.('menu', locator) } catch (e) { this.callbacks.error(e) }
      }, { signal: this.lifecycle.signal })
      doc.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.ctrlKey && event.altKey && ['d', 'a'].includes(event.key.toLowerCase())) {
          const selection = doc.defaultView.getSelection() as Selection
          if (selection?.rangeCount && !selection.isCollapsed) {
            event.preventDefault()
            try { this.callbacks.action?.(event.key.toLowerCase() === 'd' ? 'dictionary' : 'ai', this.locations.capture(index, selection.getRangeAt(0))) } catch (e) { this.callbacks.error(e) }
          }
          return
        }
        if (event.key === 'Escape') { this.callbacks.escape?.(); return }
        if ((event.target as Element)?.closest('input,textarea,select,[contenteditable]')) return
        if (event.altKey || event.ctrlKey || event.metaKey || !doc.defaultView.getSelection()?.isCollapsed) return
        if (['ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp'].includes(event.key)) {
          event.preventDefault(); void this.page(['ArrowRight', 'PageDown'].includes(event.key) ? 1 : -1).catch(this.callbacks.error)
        }
      }, { signal: this.lifecycle.signal })
      this.paintLearning(doc, index)
    })
    on('relocate', ({ detail }) => {
      this.callbacks.dismissSelection?.()
      if (this.disposed || !detail.range) return
      try {
        const index = this.book.resolveCFI(detail.cfi).index
        const range = detail.range.cloneRange() as Range
        range.collapse(true)
        if (isUI(range.startContainer)) return
        const locator = this.locations.capture(index, range)
        this.lastLocation = locator
        this.callbacks.relocate(locator, detail.tocItem?.label || this.content.title(index), {
          fraction: Number.isFinite(detail.fraction) ? Math.max(0, Math.min(1, detail.fraction)) : 0,
          section: index, total: this.book.sections.length, href: detail.tocItem?.href ?? '',
        })
      } catch { /* Transient layout ranges are not persisted; retain last valid original location. */ }
    })
    on('create-overlay', () => {
      this.rendered.clear()
      clearTimeout(this.overlayTimer)
      this.overlayTimer = setTimeout(() => { if (!this.disposed) void this.paintHighlights().catch(this.callbacks.error) }, 0)
    })
    on('draw-annotation', ({ detail }) => {
      if (detail.annotation.learning) detail.draw(Overlayer.underline, { color: '#6595cf', width: 2 })
      else detail.draw(Overlayer.highlight, { color: highlightColor(detail.annotation.color).value })
    })
    on('show-annotation', ({ detail }) => {
      if (detail.range?.startContainer.ownerDocument?.defaultView?.getSelection()?.isCollapsed === false) return
      const record = this.learning.find(x => x.locator.cfi === detail.value); if (record) this.callbacks.mark?.(record.locator)
    })
    on('external-link', (event) => { event.preventDefault(); this.callbacks.error(new Error('书内外部链接未打开，请在需要时复制地址。')) })
  }
  static async create(bookId: string, file: File, callbacks: Callbacks) {
    if (!file.name.toLowerCase().endsWith('.epub')) throw new Error('首版支持 EPUB 文件。')
    const book = await makeBook(file)
    if (book.rendition?.layout === 'pre-paginated') { book.destroy?.(); throw new Error('首版仅支持可重排 EPUB。') }
    if (!book.sections?.length) { book.destroy?.(); throw new Error('书籍没有可读章节。') }
    return new ReaderAdapter(bookId, book, callbacks)
  }
  get title() { return typeof this.book.metadata?.title === 'string' ? this.book.metadata.title : Object.values(this.book.metadata?.title ?? {})[0] as string || '未命名书籍' }
  get author(): string {
    const authors = this.book.metadata?.author
    const name = (value: any): string => typeof value === 'string' ? value : typeof value?.name === 'string' ? value.name : ''
    return (Array.isArray(authors) ? authors.map(name) : [name(authors)]).filter(Boolean).join('、')
  }
  async cover(): Promise<Blob | undefined> {
    try {
      const blob = await this.book.getCover?.()
      // Only raster images are displayed in the library; book markup stays in the reader.
      return blob && /^image\/(png|jpeg|webp|gif|avif)$/.test(blob.type) && blob.size <= 5_000_000 ? blob : undefined
    } catch { return undefined }
  }
  async mount(host: HTMLElement, progress?: Locator, records?: { annotations: Annotation[]; learning: LearningRecord[] }) {
    if (records) { this.annotations = records.annotations; this.learning = records.learning }
    host.append(this.view)
    await this.view.open(this.book)
    this.style()
    if (progress) {
      try { await this.navigateTo(progress); return } catch (e) { this.callbacks.error(e) }
    }
    await this.view.init({ showTextStart: true })
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.queue.then(async () => { if (!this.disposed) await work() })
    this.queue = result.catch(() => {})
    return result
  }
  async navigateTo(locator: Locator) {
    const doc = await this.content.document(locator.section)
    this.locations.resolve(doc, locator)
    return this.enqueue(async () => {
      await this.view.renderer.goTo({ index: locator.section, anchor: (rendered: Document) => this.locations.resolve(rendered, locator) })
    })
  }
  chapter(section: number, href?: string) { return this.enqueue(async () => { await this.view.goTo(href || section) }) }
  page(direction: number) { return this.enqueue(async () => { await (direction > 0 ? this.view.next() : this.view.prev()) }) }
  goToFraction(fraction: number) {
    if (!Number.isFinite(fraction)) return Promise.reject(new Error('阅读进度无效。'))
    return this.enqueue(async () => { await this.view.goToFraction(Math.max(0, Math.min(1, fraction))) })
  }
  private style() {
    const p = this.preferences, colors = themeColors(p)
    const font = p.font === 'serif' ? 'Georgia,"Noto Serif CJK SC","Songti SC",SimSun,serif' : 'system-ui,"Microsoft YaHei",sans-serif'
    this.view.renderer.setAttribute('flow', p.flow)
    this.view.renderer.setAttribute('max-column-count', String(p.columns))
    this.view.renderer.setAttribute('max-inline-size', `${p.width}px`)
    this.view.renderer.setAttribute('margin', '24px')
    this.view.renderer.setStyles(`html { font-size: ${p.fontSize}px !important; color-scheme: ${p.theme === 'dark' ? 'dark' : 'light'}; --theme-bg-color:${colors.background}; } body { color: ${colors.foreground}!important; background: ${colors.background}!important; } ${p.font === 'publisher' ? '' : `body,p,li,blockquote,h1,h2,h3,h4 {font-family:${font}!important;}`} p,li,blockquote { line-height: ${p.lineHeight}!important; } ${p.theme === 'dark' || p.theme === 'custom' ? 'body :not(img):not(svg):not(svg *) { color:inherit!important; background-color:transparent!important; } a {text-decoration:underline;}' : ''} [${UI_ATTRIBUTE}] { display:block!important; font: 0.83rem/1.7 system-ui!important; color:${p.theme === 'dark' ? '#bad4c2' : '#39685b'}!important; background:${p.theme === 'dark' ? '#29362e' : '#eef4ed'}!important; padding:8px 12px!important; margin:6px 0 14px!important; border-left:2px solid #93b39e!important; text-indent:0!important; white-space:pre-wrap!important; break-inside:avoid; user-select:none; }`)
  }
  async configure(options: Partial<ReadingPreferences> & { learning?: boolean }) {
    return this.enqueue(async () => {
      const anchor = this.lastLocation
      const { learning, ...preferences } = options
      this.preferences = { ...this.preferences, ...preferences }
      this.learningMode = learning ?? this.learningMode
      this.style()
      for (const { doc, index } of this.view.renderer.getContents()) this.paintLearning(doc, index)
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      if (anchor) await this.view.renderer.goTo({ index: anchor.section, anchor: (doc: Document) => this.locations.resolve(doc, anchor) })
      await this.paintHighlights()
    })
  }
  async setRecords(annotations: Annotation[], learning: LearningRecord[]) {
    this.annotations = annotations; this.learning = learning
    return this.enqueue(async () => {
      for (const { doc, index } of this.view.renderer.getContents()) this.paintLearning(doc, index)
      await this.paintHighlights()
    })
  }
  private paintLearning(doc: Document, _section: number) {
    doc.querySelectorAll(`[${UI_ATTRIBUTE}]`).forEach(node => node.remove())
  }
  private highlightAt(doc: Document, locator: Locator) {
    const candidates = this.annotations.filter(item => item.highlighted !== false && item.locator.section === locator.section && item.locator.quote.includes(locator.quote))
    const exact = candidates.find(item => item.locator.cfi === locator.cfi && item.locator.quote === locator.quote && item.locator.prefix === locator.prefix && item.locator.suffix === locator.suffix)
    if (exact || !candidates.length) return exact?.id
    // A sub-selection can manage its enclosing highlight, but a partial overlap
    // across the highlight boundary must not remove an unrelated mark.
    const selected = this.locations.range(doc, locator.cfi)
    for (const item of candidates.sort((a, b) => a.locator.quote.length - b.locator.quote.length || b.createdAt - a.createdAt)) {
      try {
        const marked = this.locations.range(doc, item.locator.cfi)
        if (marked.compareBoundaryPoints(Range.START_TO_START, selected) > 0 || marked.compareBoundaryPoints(Range.END_TO_END, selected) < 0) continue
        this.locations.resolve(doc, item.locator)
        return item.id
      } catch { /* An invalid stored anchor cannot match the current selection. */ }
    }
  }
  private async paintHighlights() {
    const contents = this.view.renderer?.getContents() ?? []
    const items = new Map<string, { locator: Locator; learning: boolean; color?: HighlightColor }>()
    for (const { locator } of this.learning) items.set(locator.cfi, { locator, learning: true })
    for (const { locator, color, highlighted } of this.annotations) if (highlighted !== false) items.set(locator.cfi, { locator, color, learning: false })
    const desired = new Set(items.keys())
    for (const value of this.rendered) if (!desired.has(value)) await this.view.deleteAnnotation({ value })
    for (const annotation of items.values()) {
      const current = contents.find((x: any) => x.index === annotation.locator.section)
      if (!current) continue
      this.locations.resolve(current.doc, annotation.locator)
      await this.view.addAnnotation({ value: annotation.locator.cfi, learning: annotation.learning, color: annotation.color })
    }
    this.rendered = desired
  }
  async dispose() {
    this.disposed = true
    this.content.dispose()
    this.lifecycle.abort(); clearTimeout(this.overlayTimer)
    await this.queue
    this.view.close(); this.view.remove(); this.book.destroy?.()
  }
}

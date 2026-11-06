import * as CFI from 'foliate-js/epubcfi.js'
import type { Locator } from '../core/types'

export const UI_ATTRIBUTE = 'data-reader-ui'
export function originalFilter(node: Node) {
  return node.nodeType === 1 && (node as Element).hasAttribute(UI_ATTRIBUTE) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
}
export function isUI(node: Node) { return !!(node.nodeType === 1 ? node as Element : node.parentElement)?.closest(`[${UI_ATTRIBUTE}]`) }
export function sourceText(root: Node): string {
  if (root.nodeType === 3) return isUI(root) ? '' : root.textContent ?? ''
  if (isUI(root) || (root.nodeType === 1 && (root as Element).matches('script,style,noscript'))) return ''
  return Array.from(root.childNodes, sourceText).join('')
}
export function sourceRangeText(range: Range) { return sourceText(range.cloneContents()) }

function textBoundaries(input: Range): Range {
  if (input.startContainer.nodeType === 3 && input.endContainer.nodeType === 3) return input
  const doc = input.startContainer.ownerDocument!
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let node: Node | null
  while ((node = walker.nextNode())) {
    if (isUI(node) || node.parentElement?.closest('script,style')) continue
    if (input.collapsed) {
      if (input.comparePoint(node, (node as Text).length) >= 0) {
        const range = doc.createRange(); range.setStart(node, 0); range.collapse(true); return range
      }
    } else if (input.intersectsNode(node) && !(input.startContainer === node && input.startOffset === (node as Text).length)
      && !(input.endContainer === node && input.endOffset === 0)) nodes.push(node as Text)
  }
  if (!nodes.length) return input
  const range = doc.createRange(), first = nodes[0], last = nodes.at(-1)!
  range.setStart(first, input.startContainer === first ? input.startOffset : 0)
  range.setEnd(last, input.endContainer === last ? input.endOffset : last.length)
  return range
}

export class LocationAdapter {
  constructor(readonly bookId: string, readonly book: any) {}
  cfi(section: number, range?: Range) {
    const base = this.book.sections[section].cfi ?? CFI.fake.fromIndex(section)
    return range ? CFI.joinIndir(base, CFI.fromRange(textBoundaries(range), originalFilter)) : base
  }
  range(doc: Document, cfi: string): Range {
    const parts = CFI.parse(cfi)
    ;(parts.parent ?? parts).shift()
    return CFI.toRange(doc, parts, originalFilter)
  }
  capture(section: number, range: Range): Locator {
    if (isUI(range.startContainer) || isUI(range.endContainer)) throw new Error('请选择原文，不包含解释区域。')
    range = textBoundaries(range)
    const quote = range.toString()
    if (quote !== sourceRangeText(range)) throw new Error('选区包含解释或非正文内容，请缩小选区。')
    const doc = range.startContainer.ownerDocument!
    const before = doc.createRange(); before.selectNodeContents(doc.body); before.setEnd(range.startContainer, range.startOffset)
    const after = doc.createRange(); after.selectNodeContents(doc.body); after.setStart(range.endContainer, range.endOffset)
    return { bookId: this.bookId, section, cfi: this.cfi(section, range), quote,
      prefix: sourceRangeText(before).slice(-40), suffix: sourceRangeText(after).slice(0, 40) }
  }
  resolve(doc: Document, locator: Locator): Range {
    if (locator.bookId !== this.bookId || !this.book.sections[locator.section]) throw new Error('位置不属于当前书籍。')
    const range = this.range(doc, locator.cfi)
    if (sourceRangeText(range) !== locator.quote) throw new Error('原文位置校验失败，已停止跳转。')
    const fresh = this.capture(locator.section, range)
    if (fresh.prefix !== locator.prefix || fresh.suffix !== locator.suffix) throw new Error('原文上下文校验失败，已停止跳转。')
    return range
  }
  install(view: any) {
    const resolve = this.book.resolveCFI.bind(this.book)
    // Instance-level adapter: upstream files remain untouched. Both directions use the same filter.
    this.book.resolveCFI = (cfi: string) => {
      const { index } = resolve(cfi)
      return { index, anchor: (doc: Document) => this.range(doc, cfi) }
    }
    view.getCFI = (section: number, range?: Range) => {
      if (range && (isUI(range.startContainer) || isUI(range.endContainer))) {
        const safe = range.cloneRange()
        for (const end of [false, true]) {
          const node = end ? safe.endContainer : safe.startContainer
          const card = (node.nodeType === 1 ? node as Element : node.parentElement)?.closest(`[${UI_ATTRIBUTE}]`)
          if (card) { if (end) safe.setEndBefore(card); else safe.setStartBefore(card) }
        }
        return this.cfi(section, safe)
      }
      return this.cfi(section, range)
    }
  }
}

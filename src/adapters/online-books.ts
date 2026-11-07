export interface OnlineBook { title: string; author: string; url: string }
export interface CatalogLink { title: string; url: string }
export interface Catalog { title: string; books: OnlineBook[]; navigation: CatalogLink[]; next?: string }
export interface BookSource { name: string; url: string }
const epubType = 'application/epub+zip'
function linkURL(value: unknown, base: string): string {
  if (typeof value !== 'string') return ''
  try { const url = new URL(value, base || undefined); return url.protocol === 'https:' && !url.username && !url.password ? url.href : '' } catch { return '' }
}
const relations = (value: unknown): string[] => Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\s+/) : []
function downloadable(rel: unknown) { const list = relations(rel); return !list.length || list.some(value => ['http://opds-spec.org/acquisition', 'http://opds-spec.org/acquisition/open-access', 'download'].includes(value)) }
export function parseCatalog(text: string, base: string): Catalog {
  if (text.length > 3_000_000) throw new Error('书源目录过大。')
  const result: Catalog = { title: '在线书源', books: [], navigation: [] }
  if (text.trimStart().startsWith('{')) {
    const data = JSON.parse(text)
    if (!Array.isArray(data.publications) && !Array.isArray(data.navigation) && !Array.isArray(data.groups)) throw new Error('这个地址不是可识别的 OPDS 目录。')
    result.title = typeof data.metadata?.title === 'string' ? data.metadata.title : result.title
    const add = (group: any) => {
      for (const item of (Array.isArray(group.publications) ? group.publications : []).slice(0, 500)) {
        const link = (Array.isArray(item.links) ? item.links : []).find((link: any) => link.type?.split(';')[0] === epubType && downloadable(link.rel) && linkURL(link.href, base))
        if (!link) continue
        const authors = item.metadata?.author
        const name = (author: any): string => typeof author === 'string' ? author : typeof author?.name === 'string' ? author.name : ''
        result.books.push({ title: typeof item.metadata?.title === 'string' ? item.metadata.title : '未命名书籍', author: (Array.isArray(authors) ? authors : [authors]).map(name).filter(Boolean).join('、'), url: linkURL(link.href, base) })
      }
      for (const link of (Array.isArray(group.navigation) ? group.navigation : []).slice(0, 500)) {
        const url = linkURL(link.href, base)
        if (url && /opds|atom|json|xml/.test(link.type || 'opds')) result.navigation.push({ title: typeof link.title === 'string' ? link.title : '浏览目录', url })
      }
    }
    add(data); for (const group of (Array.isArray(data.groups) ? data.groups : []).slice(0, 100)) add(group)
    const next = (Array.isArray(data.links) ? data.links : []).find((link: any) => relations(link.rel).includes('next'))
    result.next = linkURL(next?.href, base) || undefined
  } else {
    const doc = new DOMParser().parseFromString(text, 'application/xml')
    if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'feed') throw new Error('这个地址不是可识别的 OPDS 目录。')
    const children = (element: Element, name: string) => Array.from(element.children).filter(child => child.localName === name)
    const content = (element: Element, name: string) => children(element, name)[0]?.textContent?.trim() || ''
    const resolve = (element: Element) => {
      const chain: Element[] = []; for (let node: Element | null = element; node; node = node.parentElement) chain.unshift(node)
      let href = base
      for (const node of chain) { const value = node.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'base'); if (value) href = linkURL(value, href) || href }
      return linkURL(element.getAttribute('href'), href)
    }
    result.title = content(doc.documentElement, 'title') || result.title
    for (const entry of children(doc.documentElement, 'entry').slice(0, 500)) {
      const links = children(entry, 'link'), title = content(entry, 'title') || '未命名书籍'
      const acquisition = links.find(link => link.getAttribute('type')?.split(';')[0] === epubType && downloadable(link.getAttribute('rel')) && resolve(link))
      if (acquisition) result.books.push({ title, author: children(entry, 'author').map(author => content(author, 'name')).join('、'), url: resolve(acquisition) })
      else { const link = links.find(link => /atom|opds/.test(link.getAttribute('type') || '') && resolve(link)); if (link) result.navigation.push({ title, url: resolve(link) }) }
    }
    const next = children(doc.documentElement, 'link').find(link => relations(link.getAttribute('rel')).includes('next'))
    result.next = next ? resolve(next) || undefined : undefined
  }
  result.books = result.books.slice(0, 500); result.navigation = result.navigation.slice(0, 500)
  return result
}
export async function onlineRequest(url: string, kind: 'epub' | 'catalog', signal: AbortSignal) {
  const response = await fetch('/api/reader/online', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reader-Library': '1' }, body: JSON.stringify({ url, kind }), signal })
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || `书源请求失败（HTTP ${response.status}）。`) }
  return response
}
export async function onlineFile(url: string, signal: AbortSignal) {
  const response = await onlineRequest(url, 'epub', signal)
  const blob = await response.blob()
  if (blob.size > 50_000_000) throw new Error('在线 EPUB 超过 50 MB。')
  const original = new URL(response.headers.get('X-Book-URL') || url)
  let name = '在线书籍.epub'
  try { name = decodeURIComponent(original.pathname.split('/').at(-1) || name).replace(/[\\/:*?"<>|]/g, '_') } catch { /* retain fallback */ }
  if (!name.toLowerCase().endsWith('.epub')) name += '.epub'
  return new File([blob], name, { type: epubType })
}
export function loadSources(): BookSource[] {
  try { const data = JSON.parse(localStorage.getItem('reader-book-sources') || '[]'); return Array.isArray(data) ? data.filter(item => typeof item?.name === 'string' && item.name.length < 200 && linkURL(item?.url, '')).slice(0, 50) : [] } catch { return [] }
}

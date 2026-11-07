import { db, type ReaderDB } from './storage'
import type { Annotation, LearningRecord, Locator, Progress } from './types'
import { isHighlightColor } from './highlights'

interface Backup { format: 'incremental-reader'; version: 1; exportedAt: number; books: { id: string; title: string; filename: string }[]; annotations: Annotation[]; learning: LearningRecord[]; progress: Progress[] }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('备份对象格式错误。')
  return value as Record<string, unknown>
}
const string = (value: unknown, max = 100000) => { if (typeof value !== 'string' || value.length > max) throw new Error('备份文字字段无效。'); return value }
const number = (value: unknown) => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('备份数值字段无效。'); return value }
const bookId = (value: unknown) => { const id = string(value, 64); if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('备份书籍标识无效。'); return id }
function locator(value: unknown): Locator {
  const v = object(value), cfi = string(v.cfi, 20000)
  if (!cfi.startsWith('epubcfi(') || !cfi.endsWith(')')) throw new Error('备份原文位置无效。')
  return { bookId: bookId(v.bookId), section: number(v.section), cfi, quote: string(v.quote), prefix: string(v.prefix, 40), suffix: string(v.suffix, 40) }
}
function base(value: unknown) {
  const v = object(value), location = locator(v.locator), id = string(v.id, 200), source = bookId(v.bookId)
  if (!id || location.bookId !== source) throw new Error('备份记录与书籍不一致。')
  return { id, bookId: source, locator: location, chapter: string(v.chapter, 1000), createdAt: number(v.createdAt), updatedAt: number(v.updatedAt) }
}
function array<T>(value: unknown, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 100000) throw new Error('备份记录列表无效。')
  return value.map(parse)
}
export function parseBackup(text: string): Backup {
  if (text.length > 50_000_000) throw new Error('备份超过 50 MB，请拆分后导入。')
  const v = object(JSON.parse(text))
  if (v.format !== 'incremental-reader' || v.version !== 1) throw new Error('备份格式或版本不受支持。')
  const backup: Backup = {
    format: 'incremental-reader', version: 1, exportedAt: number(v.exportedAt),
    books: array(v.books, value => { const x = object(value); return { id: bookId(x.id), title: string(x.title, 1000), filename: string(x.filename, 1000) } }),
    annotations: array(v.annotations, value => {
      const x = object(value), color = x.color, highlighted = x.highlighted
      if (color !== undefined && !isHighlightColor(color)) throw new Error('备份标注颜色无效。')
      if (highlighted !== undefined && typeof highlighted !== 'boolean') throw new Error('备份标注状态无效。')
      return { ...base(x), note: string(x.note), ...(x.explanation === undefined ? {} : { explanation: string(x.explanation) }), ...(color === undefined ? {} : { color }), ...(highlighted === undefined ? {} : { highlighted }) }
    }),
    learning: array(v.learning, value => { const x = object(value); return { ...base(x), explanation: string(x.explanation), targetLanguage: string(x.targetLanguage, 40) } }),
    progress: array(v.progress, value => { const x = object(value), location = locator(x.locator), source = bookId(x.bookId); if (location.bookId !== source) throw new Error('进度与书籍不一致。'); return { bookId: source, locator: location, updatedAt: number(x.updatedAt) } }),
  }
  for (const list of [backup.annotations, backup.learning]) {
    const ids = new Set<string>()
    for (const x of list) { if (ids.has(x.id)) throw new Error('备份含重复记录 ID。'); ids.add(x.id) }
  }
  return backup
}
export async function exportBackup(database: ReaderDB = db): Promise<string> {
  return database.transaction('r', database.books, database.annotations, database.learning, database.progress, async () => {
    const books = (await database.books.toArray()).map(({ id, title, filename }) => ({ id, title, filename }))
    return JSON.stringify({ format: 'incremental-reader', version: 1, exportedAt: Date.now(), books, annotations: await database.annotations.toArray(), learning: await database.learning.toArray(), progress: await database.progress.toArray() }, null, 2)
  })
}
export async function importBackup(text: string, database: ReaderDB = db) {
  const backup = parseBackup(text)
  let changed = 0
  await database.transaction('rw', database.annotations, database.learning, database.progress, async () => {
    for (const table of ['annotations', 'learning'] as const) {
      const existing = await database[table].toArray()
      const byId = new Map(existing.map(x => [x.id, x]))
      const key = (x: Annotation | LearningRecord) => `${x.bookId}:${x.locator.cfi}:${'targetLanguage' in x ? x.targetLanguage : ''}`
      const byLocation = new Map(existing.map(x => [key(x), x]))
      for (const item of backup[table]) {
        const sameId = byId.get(item.id)
        if (sameId && key(sameId) !== key(item)) throw new Error('备份记录 ID 冲突，未修改本地数据。')
        const previous = byLocation.get(key(item))
        if (!previous || item.updatedAt > previous.updatedAt) {
          const merged = { ...item, id: previous?.id ?? item.id }
          // Both tables share validated base fields; each table gets its own typed record.
          if (table === 'annotations') await database.annotations.put(merged as Annotation)
          else await database.learning.put(merged as LearningRecord)
          byLocation.set(key(merged), merged); byId.set(merged.id, merged); changed++
        }
      }
    }
    for (const item of backup.progress) {
      const old = await database.progress.get(item.bookId)
      if (!old || item.updatedAt > old.updatedAt) { await database.progress.put(item); changed++ }
    }
  })
  const available = new Set(await database.books.toCollection().primaryKeys())
  const needed = new Set([...backup.annotations, ...backup.learning, ...backup.progress].map(x => x.bookId).filter(id => !available.has(id)))
  return { changed, missingBooks: needed.size }
}

import { db } from './storage'
import type { Annotation, LearningRecord, Locator } from './types'

export async function saveAnnotation(locator: Locator, chapter: string, note?: string, explanation?: string) {
  const existing = (await db.annotations.where('bookId').equals(locator.bookId).toArray()).find(x => x.locator.cfi === locator.cfi)
  const item: Annotation = { id: existing?.id ?? crypto.randomUUID(), bookId: locator.bookId, locator, chapter, note: note ?? existing?.note ?? '',
    explanation: explanation ?? existing?.explanation, createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now() }
  await db.annotations.put(item)
  return item
}
export async function saveLearning(locator: Locator, chapter: string, explanation: string) {
  if (!explanation.trim()) throw new Error('解释内容不能为空。')
  const existing = (await db.learning.where('bookId').equals(locator.bookId).toArray()).find(x => x.locator.cfi === locator.cfi && x.targetLanguage === 'zh')
  const item: LearningRecord = { id: existing?.id ?? crypto.randomUUID(), bookId: locator.bookId, locator, chapter, explanation: explanation.trim(), targetLanguage: 'zh', createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now() }
  await db.learning.put(item)
  return item
}
export function notesMarkdown(title: string, notes: Annotation[]) {
  let chapter = ''
  const lines = [`# ${title}`, '']
  const sorted = [...notes].sort((a, b) => a.locator.section - b.locator.section || a.createdAt - b.createdAt)
  for (const n of sorted) {
    if (chapter !== n.chapter) { chapter = n.chapter; lines.push(`## ${chapter}`, '') }
    lines.push(n.locator.quote.split('\n').map(x => `> ${x}`).join('\n'), '')
    if (n.explanation) lines.push(`解释：${n.explanation}`, '')
    if (n.note) lines.push(n.note, '')
    lines.push(`原文位置：\`${n.locator.cfi}\``, '')
  }
  return lines.join('\n')
}
export function download(name: string, content: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

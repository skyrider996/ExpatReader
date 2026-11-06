import Dexie, { type EntityTable } from 'dexie'
import type { Annotation, BookRecord, LearningRecord, Progress } from './types'

export class ReaderDB extends Dexie {
  books!: EntityTable<BookRecord, 'id'>
  progress!: EntityTable<Progress, 'bookId'>
  annotations!: EntityTable<Annotation, 'id'>
  learning!: EntityTable<LearningRecord, 'id'>
  constructor(name = 'incremental-reader') {
    super(name)
    this.version(1).stores({
      books: 'id, openedAt', progress: 'bookId',
      annotations: 'id, bookId, updatedAt', learning: 'id, bookId, updatedAt',
    })
  }
}
export const db = new ReaderDB()
export async function fileHash(file: Blob) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('')
}

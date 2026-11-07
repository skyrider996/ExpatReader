import Dexie, { type EntityTable } from 'dexie'
import type { Annotation, BookRecord, LearningRecord, Progress } from './types'
import type { AgentSession, AgentMessage } from './agent'
import type { CachedSearchIndex } from './search-cache'

export class ReaderDB extends Dexie {
  books!: EntityTable<BookRecord, 'id'>
  progress!: EntityTable<Progress, 'bookId'>
  annotations!: EntityTable<Annotation, 'id'>
  learning!: EntityTable<LearningRecord, 'id'>
  agentSessions!: EntityTable<AgentSession, 'id'>
  agentMessages!: EntityTable<AgentMessage, 'id'>
  searchIndexes!: EntityTable<CachedSearchIndex, 'bookId'>
  cacheState!: EntityTable<{ key: string; epoch: string }, 'key'>
  constructor(name = 'incremental-reader') {
    super(name)
    this.version(1).stores({
      books: 'id, openedAt', progress: 'bookId',
      annotations: 'id, bookId, updatedAt', learning: 'id, bookId, updatedAt',
    })
    this.version(2).stores({ agentSessions: 'id, [bookId+identity], updatedAt', agentMessages: 'id, sessionId, createdAt' })
    this.version(3).stores({ searchIndexes: 'bookId', cacheState: 'key' })
  }
}
export const db = new ReaderDB()
export async function fileHash(file: Blob) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('')
}

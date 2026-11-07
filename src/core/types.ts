import type { HighlightColor } from './highlights'

export interface Locator {
  bookId: string
  section: number
  cfi: string
  quote: string
  prefix: string
  suffix: string
}
export interface Passage { id: string; bookId: string; section: number; ordinal: number; chapter: string; text: string; locator: Locator }
export interface OutlineItem { label: string; href: string; section: number; depth: number }
export interface BookRecord { id: string; title: string; filename: string; file: Blob; addedAt: number; openedAt: number; author?: string; cover?: Blob }
export interface Progress { bookId: string; locator: Locator; updatedAt: number }
export interface Annotation { id: string; bookId: string; locator: Locator; chapter: string; note: string; explanation?: string; color?: HighlightColor; highlighted?: boolean; createdAt: number; updatedAt: number }
export interface LearningRecord { id: string; bookId: string; locator: Locator; chapter: string; explanation: string; targetLanguage: string; createdAt: number; updatedAt: number }
export interface SearchHit extends Passage { score: number }
export interface SearchResponse { results: SearchHit[]; complete: boolean; indexedSections: number; totalSections: number }
export interface ModelSettings { endpoint: string; model: string; apiKey: string; mode?: 'api' | 'agent' | 'codex' }
export interface Citation { id: string; text: string; locator: Locator; chapter: string }
export interface Answer { text: string; citations: Citation[]; calls: number; characters: number; limited: boolean; usage?: { inputTokens: number; outputTokens: number } }

export interface CacheStatus { directory: string; files: number; bytes: number }
export async function cacheAction(action: 'status' | 'directory' | 'clear', data: object = {}): Promise<CacheStatus> {
  const response = await fetch(`/api/reader/cache/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reader-Library': '1' }, body: JSON.stringify(data), signal: AbortSignal.timeout(60000) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || typeof result.directory !== 'string') throw new Error(result.error || '缓存服务不可用，请重新启动本机阅读器服务。')
  return result
}
export async function cacheBook(id: string, file: Blob) {
  if (file.size > 50_000_000) return false
  const response = await fetch(`/api/reader/cache/book/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/epub+zip', 'X-Reader-Library': '1' }, body: file, signal: AbortSignal.timeout(60000) })
  return response.ok
}
export async function cachedBook(id: string): Promise<Blob | null> {
  try {
    const response = await fetch(`/api/reader/cache/read/${id}`, { method: 'POST', headers: { 'X-Reader-Library': '1' }, signal: AbortSignal.timeout(10000) })
    return response.ok && response.headers.get('content-type')?.includes('application/epub+zip') ? await response.blob() : null
  } catch { return null }
}

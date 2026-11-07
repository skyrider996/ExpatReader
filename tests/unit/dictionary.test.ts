import { describe, expect, it, vi, afterEach } from 'vitest'
import { lookupPreferences, lookupText, selectionLookup } from '../../src/adapters/dictionary'

afterEach(() => vi.unstubAllGlobals())
describe('dictionary lookup', () => {
  it('distinguishes single words, quoted words and compounds from phrases, including unspaced text', () => {
    expect(selectionLookup('  “reluctantly!”  ')).toEqual({ kind: 'dictionary', text: 'reluctantly' })
    expect(selectionLookup('well-known')).toEqual({ kind: 'dictionary', text: 'well-known' })
    expect(selectionLookup("don't").kind).toBe('dictionary')
    expect(selectionLookup('阅读').kind).toBe('dictionary')
    expect(selectionLookup('阅读是一种缓慢的发现。').kind).toBe('translation')
    expect(selectionLookup(' One phrase. ')).toEqual({ kind: 'translation', text: 'One phrase.' })
  })
  it('migrates older configurations to independent providers without restoring secrets', () => {
    expect(lookupPreferences({ provider: 'deepl-pro', target: 'FR', apiKey: 'ignored' })).toEqual({ wordProvider: 'free', translationProvider: 'deepl-pro', target: 'FR' })
    expect(lookupPreferences({ provider: 'wiktionary' })).toEqual({ wordProvider: 'wiktionary', translationProvider: 'google', target: 'zh' })
  })
  it('formats English definitions and safely encodes the word', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ word: 'hello', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'a greeting' }] }] }]), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    expect(await lookupText('hello', { provider: 'free', target: 'zh', apiKey: '' })).toContain('• a greeting')
    expect(fetcher.mock.calls[0][0]).toContain('/en/hello')
  })
  it('requires a key for commercial translation and rejects multiword dictionary lookups', async () => {
    await expect(lookupText('hello', { provider: 'google', target: 'zh', apiKey: '' })).rejects.toThrow('密钥')
    await expect(lookupText('hello world', { provider: 'free', target: 'zh', apiKey: '' })).rejects.toThrow('单个词语')
  })
  it('sends translation requests only to the local proxy', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ translation: '你好' }), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    expect(await lookupText('hello', { provider: 'deepl-free', target: 'zh', apiKey: 'key' })).toBe('你好')
    expect(fetcher.mock.calls[0][0]).toBe('/api/translate')
  })
})

import { describe, expect, it, vi, afterEach } from 'vitest'
import { lookupText } from '../../src/adapters/dictionary'

afterEach(() => vi.unstubAllGlobals())
describe('dictionary lookup', () => {
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

export type WordProvider = 'free' | 'wiktionary'
export type TranslationProvider = 'google' | 'deepl-free' | 'deepl-pro'
export type Provider = WordProvider | TranslationProvider
export interface DictionarySettings { provider: Provider; target: string; apiKey: string }
const isWordProvider = (value: unknown): value is WordProvider => value === 'free' || value === 'wiktionary'
const isTranslationProvider = (value: unknown): value is TranslationProvider => value === 'google' || value === 'deepl-free' || value === 'deepl-pro'
export function lookupPreferences(value: unknown) {
  const old = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    wordProvider: isWordProvider(old.wordProvider) ? old.wordProvider : isWordProvider(old.provider) ? old.provider : 'free' as WordProvider,
    translationProvider: isTranslationProvider(old.translationProvider) ? old.translationProvider : isTranslationProvider(old.provider) ? old.provider : 'google' as TranslationProvider,
    target: typeof old.target === 'string' ? old.target : 'zh',
  }
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
export function selectionLookup(value: string): { kind: 'dictionary' | 'translation'; text: string } {
  const text = value.trim(), word = text.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '')
  if (word && word.length <= 100 && /\p{L}/u.test(word)) {
    const words = Array.from(segmenter.segment(word)).filter(segment => segment.isWordLike)
    // A hyphenated Latin word is still a single dictionary entry.
    if ((words.length === 1 && words[0].segment === word) || /^[\p{Script=Latin}\p{M}]+(?:[’'\p{Pd}][\p{Script=Latin}\p{M}]+)+$/u.test(word)) return { kind: 'dictionary', text: word }
  }
  return { kind: 'translation', text }
}

export async function lookupText(text: string, settings: DictionarySettings, signal?: AbortSignal): Promise<string> {
  const word = text.trim()
  if (!word || word.length > 2000) throw new Error('请选择 1 至 2000 个字符。')
  if (isWordProvider(settings.provider) && selectionLookup(word).kind !== 'dictionary') throw new Error('词典适合查询单个词语。')
  let url: string, options: RequestInit = { signal }
  if (settings.provider === 'free') url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`
  else if (settings.provider === 'wiktionary') url = `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`
  else {
    if (!settings.apiKey.trim()) throw new Error('请先在设置中填写翻译服务密钥。')
    if (!/^[a-zA-Z-]{2,12}$/.test(settings.target)) throw new Error('请输入有效的目标语言代码，例如 zh 或 EN。')
    url = '/api/translate'
    options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: settings.provider, text: word, target: settings.target, key: settings.apiKey.trim() }), signal }
  }
  let response: Response
  try { response = await fetch(url, options) } catch (e) { if (signal?.aborted) throw e; throw new Error('无法连接服务，请检查网络及本地阅读器服务。') }
  if (response.status === 404 && isWordProvider(settings.provider)) throw new Error('没有找到这个词。请检查拼写或尝试其他词源。')
  if (!response.ok) throw new Error(`查询失败（HTTP ${response.status}）。请检查服务、密钥和用量。`)
  const data = await response.json()
  if (settings.provider === 'free') {
    if (!Array.isArray(data)) throw new Error('词典返回了无法识别的结果。')
    const lines = data.flatMap((entry: any) => [entry.word ? `## ${entry.word}` : '', entry.phonetic || entry.phonetics?.find((p: any) => p.text)?.text, entry.origin ? `词源：${entry.origin}` : '', ...(entry.meanings || []).flatMap((m: any) => [m.partOfSpeech, ...(m.definitions || []).slice(0, 4).map((d: any) => `• ${d.definition}${d.example ? `\n  例：${d.example}` : ''}`)])]).filter(Boolean)
    if (!lines.length) throw new Error('没有找到可显示的释义。')
    return lines.join('\n')
  }
  if (settings.provider === 'wiktionary') {
    const plain = (html: string) => new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim() || ''
    const lines = Object.entries(data as Record<string, any[]>).flatMap(([language, entries]) => [language, ...entries.flatMap(entry => [entry.partOfSpeech, ...(entry.definitions || []).slice(0, 5).map((d: any) => `• ${plain(d.definition || '')}`)])]).filter(Boolean)
    if (!lines.length) throw new Error('没有找到可显示的释义。')
    return lines.join('\n')
  }
  if (typeof data.translation !== 'string' || !data.translation) throw new Error('翻译服务返回了无法识别的结果。')
  return data.translation
}

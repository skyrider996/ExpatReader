export type Provider = 'free' | 'wiktionary' | 'google' | 'deepl-free' | 'deepl-pro'
export interface DictionarySettings { provider: Provider; target: string; apiKey: string }

export async function lookupText(text: string, settings: DictionarySettings, signal?: AbortSignal): Promise<string> {
  const word = text.trim()
  if (!word || word.length > 2000) throw new Error('请选择 1 至 2000 个字符。')
  if ((settings.provider === 'free' || settings.provider === 'wiktionary') && (word.length > 100 || /\s/.test(word))) throw new Error('词典适合查询单个词语；翻译词句请切换至翻译服务。')
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
  if (response.status === 404) throw new Error('没有找到这个词。请检查拼写或尝试其他词源。')
  if (!response.ok) throw new Error(`查询失败（HTTP ${response.status}）。请检查服务、密钥和用量。`)
  const data = await response.json()
  if (settings.provider === 'free') {
    if (!Array.isArray(data)) throw new Error('词典返回了无法识别的结果。')
    const lines = data.flatMap((entry: any) => [entry.word, entry.phonetic || entry.phonetics?.find((p: any) => p.text)?.text, entry.origin ? `词源：${entry.origin}` : '', ...(entry.meanings || []).flatMap((m: any) => [m.partOfSpeech, ...(m.definitions || []).slice(0, 4).map((d: any) => `• ${d.definition}${d.example ? `\n  例：${d.example}` : ''}`)])]).filter(Boolean)
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

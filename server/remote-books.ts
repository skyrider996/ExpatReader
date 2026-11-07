import { request } from 'node:https'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113))
  }
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:db8|0|10|20):/i.test(address) && !/^2002:/i.test(address)
}
export function onlineURL(value: unknown) {
  if (typeof value !== 'string' || value.length > 4000) throw new Error('请输入有效的 HTTPS 书源地址。')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('请输入完整的 HTTPS 书源地址。') }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || (isIP(url.hostname.replace(/^\[|\]$/g, '')) && !publicAddress(url.hostname.replace(/^\[|\]$/g, '')))) throw new Error('在线书源需使用公开的 HTTPS 地址，不能包含登录信息。')
  url.hash = ''; return url
}

export async function downloadOnline(value: unknown, kind: 'epub' | 'catalog', redirects = 0): Promise<{ data: Buffer; url: string; type: string }> {
  const url = onlineURL(value), hostname = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = await lookup(hostname, { all: true })
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('书源地址不能指向本机或内网。')
  const address = addresses[0], limit = kind === 'epub' ? 50_000_000 : 3_000_000
  const result = await new Promise<{ data?: Buffer; location?: string; type: string }>((resolve, reject) => {
    const req = request(url, { method: 'GET', family: address.family, headers: { Accept: kind === 'epub' ? 'application/epub+zip, application/octet-stream;q=0.8' : 'application/opds+json, application/atom+xml, application/json, application/xml;q=0.8', 'User-Agent': 'ExpatReader/0.1', 'Accept-Encoding': 'identity' }, lookup: (_host, _options, callback) => callback(null, address.address, address.family) }, res => {
      const type = String(res.headers['content-type'] || '')
      if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && res.headers.location) { res.resume(); resolve({ location: new URL(res.headers.location, url).href, type }); return }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`书源返回 HTTP ${res.statusCode}，请检查地址或访问权限。`)); return }
      if (Number(res.headers['content-length'] || 0) > limit) { res.destroy(); reject(new Error(kind === 'epub' ? '在线 EPUB 超过 50 MB。' : '书源目录超过 3 MB，请使用分页目录。')); return }
      const chunks: Buffer[] = []; let size = 0
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limit) { res.destroy(new Error('书源内容超过大小限制。')); return }; chunks.push(chunk) })
      res.on('error', reject)
      res.on('end', () => resolve({ data: Buffer.concat(chunks), type }))
    })
    const timeout = setTimeout(() => req.destroy(new Error('书源连接超时，请稍后重试。')), 30000)
    req.on('close', () => clearTimeout(timeout)); req.on('error', reject); req.end()
  })
  if (result.location) { if (redirects >= 4) throw new Error('书源重定向次数过多。'); return downloadOnline(result.location, kind, redirects + 1) }
  const data = result.data!
  if (kind === 'epub' && (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b)) throw new Error('该地址没有返回 EPUB 文件，请使用 EPUB 的直接下载链接。')
  return { data, url: url.href, type: result.type }
}

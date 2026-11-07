import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { BookCache } from '../../server/book-cache'
import { onlineURL, publicAddress } from '../../server/remote-books'
import { defaultPreferences, loadPreferences, rgbHex, themeColors } from '../../src/core/preferences'

const temporary: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); for (const folder of temporary.splice(0)) { if (path.dirname(path.resolve(folder)) !== path.resolve(os.tmpdir()) || !path.basename(folder).startsWith('expatreader-cache-test-')) throw new Error('Unexpected test cleanup path'); await rm(folder, { recursive: true, force: true }) } })
async function workspace() { const folder = await mkdtemp(path.join(os.tmpdir(), 'expatreader-cache-test-')); temporary.push(folder); return folder }
const book = Buffer.from('PK\x03\x04test EPUB cache'), id = createHash('sha256').update(book).digest('hex')

describe('managed book cache', () => {
  it('migrates, survives restart, verifies cached bytes and clears only owned files', async () => {
    const root = await workspace(), cache = new BookCache(root)
    await cache.put(id, book)
    const original = await cache.status()
    const parent = path.join(root, 'chosen')
    await mkdir(parent); await writeFile(path.join(parent, 'personal.txt'), 'keep')
    const migrated = await cache.setDirectory(parent)
    expect(migrated).toMatchObject({ directory: path.join(parent, 'ExpatReader-cache'), files: 1, bytes: book.length })
    expect(await readdir(original.directory)).not.toContain(`${id}.epub`)
    const restarted = new BookCache(root)
    expect(await restarted.get(id)).toEqual(book)
    await writeFile(path.join(migrated.directory, 'user-file.txt'), 'also keep')
    expect(await restarted.clear()).toMatchObject({ files: 0, removed: 1 })
    expect(await readFile(path.join(parent, 'personal.txt'), 'utf8')).toBe('keep')
    expect(await readFile(path.join(migrated.directory, 'user-file.txt'), 'utf8')).toBe('also keep')
    expect(await restarted.get(id)).toBeNull()
  })
  it('rejects invalid paths, hash mismatches and conflicting destinations without changing the active cache', async () => {
    const root = await workspace(), cache = new BookCache(root)
    await cache.put(id, book)
    const original = await cache.status()
    await expect(cache.setDirectory('../elsewhere')).rejects.toThrow('完整')
    await expect(cache.put('a'.repeat(64), book)).rejects.toThrow('校验')
    const parent = path.join(root, 'occupied'), target = path.join(parent, 'ExpatReader-cache')
    await mkdir(target, { recursive: true }); await writeFile(path.join(target, 'my-file.txt'), 'personal')
    await expect(cache.setDirectory(parent)).rejects.toThrow('其他文件')
    expect(await cache.status()).toEqual(original)
    expect(await cache.get(id)).toEqual(book)
    await writeFile(path.join(original.directory, `${id}.epub`), 'damaged')
    expect(await cache.get(id)).toBeNull()
    await cache.put(id, book); expect(await cache.get(id)).toEqual(book)
  })
})
describe('online source boundaries', () => {
  it('accepts public HTTPS and blocks local, credentialed and non-HTTPS targets', () => {
    expect(onlineURL('https://books.example/catalog#fragment').href).toBe('https://books.example/catalog')
    for (const url of ['http://books.example', 'file:///etc/passwd', 'https://user:password@books.example', 'https://127.0.0.1', 'https://[::1]', 'https://192.168.1.10', 'https://localhost', 'https://books.example:8443']) expect(() => onlineURL(url)).toThrow()
    for (const ip of ['10.0.0.1', '172.16.0.1', '169.254.169.254', '100.64.0.1', '::ffff:127.0.0.1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) expect(publicAddress(ip)).toBe(false)
    expect(publicAddress('8.8.8.8')).toBe(true)
    expect(publicAddress('2606:4700:4700::1111')).toBe(true)
  })
})
describe('custom reading colors', () => {
  it('migrates old preferences, persists custom RGB and rejects unsafe color strings', () => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ fontSize: 24, theme: 'paper' }) })
    expect(loadPreferences()).toMatchObject({ fontSize: 24, background: defaultPreferences.background, foreground: defaultPreferences.foreground })
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ theme: 'custom', background: '#112233', foreground: 'red;display:none' }) })
    expect(themeColors(loadPreferences())).toEqual({ background: '#112233', foreground: defaultPreferences.foreground })
    expect(rgbHex([0, 127.9, 500])).toBe('#0080ff')
  })
})

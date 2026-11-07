import { constants } from 'node:fs'
import { mkdir, readFile, writeFile, readdir, lstat, realpath, rename, unlink, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const marker = '.expatreader-cache-v1', owned = /^[a-f0-9]{64}\.epub$/
export class BookCache {
  private directory = ''
  private queue = Promise.resolve()
  private config: string
  constructor(private root: string) { this.config = path.join(root, '.cache', 'book-cache-settings.json') }
  private async managed(directory: string) {
    await mkdir(directory, { recursive: true })
    const stat = await lstat(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory() || (await realpath(directory)).toLowerCase() !== path.resolve(directory).toLowerCase()) throw new Error('缓存目录不能是链接目录，请选择普通文件夹。')
    try { if (await readFile(path.join(directory, marker), 'utf8') !== 'ExpatReader book cache v1\n') throw new Error('缓存目录标识不匹配。') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if ((await readdir(directory)).length) throw new Error('目标缓存文件夹已有其他文件，请选择新的目录。')
      await writeFile(path.join(directory, marker), 'ExpatReader book cache v1\n', { flag: 'wx' })
    }
    return directory
  }
  private async current() {
    if (!this.directory) {
      let configured = ''
      try { const value = JSON.parse(await readFile(this.config, 'utf8')); if (typeof value.directory === 'string' && path.isAbsolute(value.directory)) configured = value.directory } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取缓存配置，请检查本机服务的文件权限。') }
      this.directory = await this.managed(configured || path.join(this.root, '.cache', 'reader-books'))
    }
    await this.managed(this.directory)
    return this.directory
  }
  private serial<T>(action: () => Promise<T>): Promise<T> { const result = this.queue.then(action); this.queue = result.then(() => {}, () => {}); return result }
  private async files(directory: string) {
    const files: { name: string; size: number }[] = []
    for (const name of await readdir(directory)) {
      if (!owned.test(name)) continue
      const stat = await lstat(path.join(directory, name))
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('缓存文件异常，请检查缓存目录。')
      files.push({ name, size: stat.size })
    }
    return files
  }
  private async info() { const directory = await this.current(), files = await this.files(directory); return { directory, files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) } }
  status() { return this.serial(() => this.info()) }
  get(id: string) {
    return this.serial(async () => {
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('书籍缓存标识无效。')
      const directory = await this.current(), file = path.join(directory, `${id}.epub`)
      try {
        const stat = await lstat(file)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 50_000_000) throw new Error('书籍缓存异常。')
        const data = await readFile(file)
        return createHash('sha256').update(data).digest('hex') === id ? data : null
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    })
  }
  put(id: string, data: Buffer) {
    return this.serial(async () => {
      if (!/^[a-f0-9]{64}$/.test(id) || data.length > 50_000_000 || data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b || createHash('sha256').update(data).digest('hex') !== id) throw new Error('书籍缓存校验失败。')
      const directory = await this.current(), file = path.join(directory, `${id}.epub`)
      try { const stat = await lstat(file); if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('缓存文件异常。'); if (createHash('sha256').update(await readFile(file)).digest('hex') === id) return }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const temporary = path.join(directory, `${randomUUID()}.tmp`)
      try { await writeFile(temporary, data, { flag: 'wx' }); await rename(temporary, file) } finally { await unlink(temporary).catch(() => {}) }
    })
  }
  setDirectory(input: unknown) {
    return this.serial(async () => {
      if (typeof input !== 'string' || !input.trim() || input.length > 1000 || !path.isAbsolute(input.trim())) throw new Error('请输入本机的完整文件夹路径。')
      const source = await this.current(), target = path.resolve(input.trim(), 'ExpatReader-cache')
      if (source.toLowerCase() === target.toLowerCase()) return this.info()
      await this.managed(target)
      for (const file of await this.files(source)) {
        const destination = path.join(target, file.name)
        try { await copyFile(path.join(source, file.name), destination, constants.COPYFILE_EXCL) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          const stat = await lstat(destination)
          if (!stat.isFile() || stat.isSymbolicLink() || createHash('sha256').update(await readFile(destination)).digest('hex') !== file.name.slice(0, -5)) throw new Error('目标目录中存在冲突的缓存文件，未更改原目录。')
        }
      }
      await mkdir(path.dirname(this.config), { recursive: true })
      const temporary = `${this.config}.${randomUUID()}.tmp`
      try { await writeFile(temporary, JSON.stringify({ directory: target }), { flag: 'wx' }); await rename(temporary, this.config) } finally { await unlink(temporary).catch(() => {}) }
      this.directory = target
      // Only remove our own files after the complete copy and configuration commit.
      for (const file of await this.files(source)) await unlink(path.join(source, file.name)).catch(() => {})
      return this.info()
    })
  }
  clear() {
    return this.serial(async () => {
      const directory = await this.current(), files = await this.files(directory)
      for (const file of files) await unlink(path.join(directory, file.name))
      return { ...await this.info(), removed: files.length }
    })
  }
}

import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

async function openBook(page: Page) {
  await page.goto('/')
  await page.getByLabel('导入 EPUB', { exact: true }).setInputFiles(path.resolve('tests/fixtures/A-small-journey.epub'))
  await expect(page.getByText('正在打开书籍…', { exact: true })).toHaveCount(0)
}
async function selectWord(page: Page, selector = 'em') {
  const frame = page.frames().find(frame => frame.url().startsWith('blob:'))!
  await frame.evaluate(selector => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector(selector)!)
    const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('pointerup'))
  }, selector)
  await expect(page.getByRole('toolbar', { name: '选区快捷操作' })).toBeVisible()
  return frame
}

test('RGB pickers recolor the actual book and persist across reload and preset switches', async ({ page }) => {
  await openBook(page); await page.getByLabel('阅读排版', { exact: true }).click()
  for (const [label, value] of [['背景颜色 R', '240'], ['背景颜色 G', '230'], ['背景颜色 B', '210'], ['字体颜色 R', '22'], ['字体颜色 G', '33'], ['字体颜色 B', '44']]) {
    await page.getByLabel(label, { exact: true }).fill(value)
    await page.getByLabel(label, { exact: true }).press('Tab')
  }
  const frame = page.frames().find(frame => frame.url().startsWith('blob:'))!
  await expect.poll(() => frame.locator('body').evaluate(el => ({ color: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor }))).toEqual({ color: 'rgb(22, 33, 44)', bg: 'rgb(240, 230, 210)' })
  await expect(page.getByRole('button', { name: '自定义', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.reload(); await page.getByLabel('阅读排版', { exact: true }).click()
  await expect(page.getByLabel('背景颜色 R', { exact: true })).toHaveValue('240')
  await expect(page.getByLabel('字体颜色 B', { exact: true })).toHaveValue('44')
  await page.getByRole('button', { name: '夜间', exact: true }).click()
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())).toBe('#202124')
  await page.getByRole('button', { name: '自定义', exact: true }).click()
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())).toBe('#f0e6d2')
  await page.screenshot({ path: '.cache/previews/custom-rgb-theme.png' })
})

test('native text selection opens an anchored toolbar for copy, annotations, book search and dictionary', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.route('https://api.dictionaryapi.dev/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ word: 'reluctantly', meanings: [{ partOfSpeech: 'adverb', definitions: [{ definition: 'With hesitation.' }] }] }]) }))
  await openBook(page)
  const frame = page.frames().find(frame => frame.url().startsWith('blob:'))!
  const box = await frame.locator('em').boundingBox()
  await page.mouse.move(box!.x + 1, box!.y + box!.height / 2); await page.mouse.down(); await page.mouse.move(box!.x + box!.width - 1, box!.y + box!.height / 2, { steps: 12 }); await page.mouse.up()
  const toolbar = page.getByRole('toolbar', { name: '选区快捷操作' })
  await expect(toolbar).toBeVisible()
  const rect = await toolbar.boundingBox()
  expect(rect!.x).toBeGreaterThanOrEqual(0); expect(rect!.y).toBeLessThan(box!.y)
  await page.screenshot({ path: '.cache/previews/selection-toolbar.png' })
  await selectWord(page)
  await toolbar.getByRole('button', { name: '复制', exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('reluctantly')
  await selectWord(page); await toolbar.getByRole('button', { name: '标注', exact: true }).click()
  await expect(page.getByLabel('个人笔记')).toBeVisible()
  await page.getByLabel('个人笔记').fill('语境中的标注')
  await page.getByRole('button', { name: '保存批注', exact: true }).click()
  await selectWord(page); await toolbar.getByRole('button', { name: '书内搜索', exact: true }).click()
  await expect(page.getByLabel('搜索原文', { exact: true })).toHaveValue('reluctantly')
  await expect(page.locator('aside:not(.right-panel) .card')).toContainText('reluctantly')
  await selectWord(page); await toolbar.getByRole('button', { name: '查词', exact: true }).click()
  await expect(page.getByLabel('词句释义')).toContainText('With hesitation.')
  await expect(toolbar).toBeHidden()
  await selectWord(page); await page.setViewportSize({ width: 620, height: 800 }); await expect(toolbar).toBeHidden()
})

test('online EPUB links, OPDS 2/Atom navigation and saved sources import into the persistent library', async ({ page }) => {
  const epub = await readFile(path.resolve('tests/fixtures/A-small-journey.epub'))
  const catalogs: string[] = [], downloads: string[] = []
  await page.route('**/api/reader/online', route => {
    const { url, kind } = route.request().postDataJSON()
    if (kind === 'epub') { downloads.push(url); return route.fulfill({ contentType: 'application/epub+zip', headers: { 'X-Book-URL': url }, body: epub }) }
    catalogs.push(url)
    const body = url.endsWith('atom.xml') ? '<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://books.test/"><title>传统目录</title><entry><title>Atom 书籍</title><author><name>测试作者</name></author><link type="application/epub+zip" rel="http://opds-spec.org/acquisition/open-access" href="journey.epub"/></entry></feed>' : JSON.stringify({ metadata: { title: '开放阅读目录' }, navigation: [{ title: '传统目录', href: 'atom.xml', type: 'application/atom+xml' }], publications: [{ metadata: { title: '在线旅程', author: [{ name: '测试作者' }] }, links: [{ rel: 'http://opds-spec.org/acquisition/open-access', type: 'application/epub+zip', href: 'journey.epub' }] }, { metadata: { title: '不可执行链接' }, links: [{ type: 'application/epub+zip', href: 'javascript:alert(1)' }] }] })
    return route.fulfill({ contentType: 'text/plain', headers: { 'X-Book-URL': url }, body })
  })
  await page.goto('/'); await page.getByRole('button', { name: '在线书源', exact: true }).click()
  await page.getByRole('button', { name: 'OPDS 目录', exact: true }).click()
  await page.getByLabel('在线书源地址').fill('https://books.test/catalog.json')
  await page.getByLabel('书源名称').fill('我的线上书架'); await page.getByRole('button', { name: '保存书源', exact: true }).click()
  await page.getByRole('button', { name: '浏览书源', exact: true }).click()
  await expect(page.locator('.online-book')).toHaveCount(1)
  await page.getByRole('button', { name: '传统目录 ↗', exact: true }).click()
  await expect(page.locator('.online-book')).toContainText('Atom 书籍')
  await page.getByRole('button', { name: '返回上级', exact: true }).click()
  await page.screenshot({ path: '.cache/previews/online-sources.png' })
  await page.getByRole('button', { name: '加入书库', exact: true }).click()
  await expect(page.getByLabel('返回书库')).toBeEnabled()
  expect(downloads).toEqual(['https://books.test/journey.epub'])
  expect(catalogs).toContain('https://books.test/atom.xml')
  await page.getByLabel('返回书库').click(); await page.reload()
  await expect(page.locator('.book-card')).toHaveCount(1)
  await page.getByRole('button', { name: '在线书源', exact: true }).click()
  await page.getByRole('button', { name: 'OPDS 目录', exact: true }).click()
  await expect(page.getByRole('button', { name: '我的线上书架', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'EPUB 链接', exact: true }).click()
  await page.getByLabel('在线书源地址').fill('https://books.test/journey.epub')
  await page.getByRole('button', { name: '下载并阅读', exact: true }).click()
  await expect(page.getByLabel('返回书库')).toBeEnabled()
  await page.getByLabel('返回书库').click(); await expect(page.locator('.book-card')).toHaveCount(1)
})

test('cache settings apply the real directory, clear only cache and export retained notes', async ({ page }) => {
  const actions: { action: string; data: any }[] = []
  let state = { directory: 'D:\\ReaderCache\\ExpatReader-cache', files: 1, bytes: 1932 }
  await page.route('**/api/reader/cache/*', route => {
    const action = route.request().url().split('/').at(-1)!, data = route.request().postDataJSON()
    actions.push({ action, data })
    if (action === 'directory') state = { ...state, directory: `${data.directory}\\ExpatReader-cache` }
    if (action === 'clear') state = { ...state, files: 0, bytes: 0 }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(state) })
  })
  await openBook(page); await selectWord(page)
  await page.getByRole('button', { name: '标注', exact: true }).click()
  await page.getByLabel('个人笔记').fill('清缓存后保留的笔记')
  await page.getByRole('button', { name: '保存批注', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByLabel('当前缓存目录')).toContainText('D:\\ReaderCache')
  await page.getByLabel('缓存文件目录').fill('D:\\NewReaderCache')
  await page.getByRole('button', { name: '应用缓存目录', exact: true }).click()
  await expect(page.getByLabel('当前缓存目录')).toContainText('D:\\NewReaderCache\\ExpatReader-cache')
  await page.getByRole('button', { name: '清除缓存', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '0 个缓存文件' })).toBeVisible()
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出笔记', exact: true }).click()
  const download = await downloadEvent, stream = await download.createReadStream(), chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  expect(Buffer.concat(chunks).toString('utf8')).toContain('清缓存后保留的笔记')
  expect(actions.find(item => item.action === 'directory')?.data.directory).toBe('D:\\NewReaderCache')
  await page.getByLabel('返回书库').click(); await expect(page.locator('.book-card')).toHaveCount(1)
  await page.getByRole('button', { name: '设置', exact: true }).first().click()
  await expect(page.getByRole('button', { name: '清除缓存', exact: true })).toBeVisible()
  await page.screenshot({ path: '.cache/previews/cache-settings.png' })
})

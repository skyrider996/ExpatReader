import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'
import { zipSync, strToU8 } from 'fflate'

async function cacheCount(page: Page) {
  return page.evaluate(() => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open('incremental-reader')
    request.onsuccess = () => { const db = request.result; const read = db.transaction('searchIndexes').objectStore('searchIndexes').count(); read.onsuccess = () => { db.close(); resolve(read.result) }; read.onerror = () => reject(read.error) }
    request.onerror = () => reject(request.error)
  }))
}
async function observeWorker(page: Page) {
  await page.addInitScript(() => {
    const metrics = { restored: false, batches: 0 }; (window as any).__searchMetrics = metrics
    const Native = window.Worker
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); this.addEventListener('message', event => { if (event.data.data?.restored) metrics.restored = true }) }
      postMessage(message: any, transfer: any = []) { if (message.type === 'add') metrics.batches++; super.postMessage(message, transfer) }
    }
  })
}
async function search(page: Page, query: string) {
  await page.getByLabel('搜索原文面板').click()
  await page.getByLabel('搜索原文', { exact: true }).fill(query)
  await page.locator('aside:not(.right-panel) form').getByRole('button', { name: '搜索', exact: true }).click()
}

test('reuses a saved index after reload, preserves citations and rebuilds a corrupt snapshot', async ({ page }) => {
  await observeWorker(page); await page.goto('/')
  await page.getByLabel('导入 EPUB', { exact: true }).setInputFiles(path.resolve('tests/fixtures/A-small-journey.epub'))
  await expect(page.getByText('正在打开书籍…', { exact: true })).toHaveCount(0)
  // An immediate explicit search completes the index instead of returning false negatives.
  await search(page, 'public garden')
  await expect(page.locator('aside:not(.right-panel) .card')).toContainText('build a public garden')
  await expect.poll(() => cacheCount(page)).toBe(1)
  await page.reload(); await expect(page.locator('.reader-footer')).toContainText('全文检索就绪')
  expect(await page.evaluate(() => (window as any).__searchMetrics)).toEqual({ restored: true, batches: 0 })
  await search(page, 'public garden')
  await page.locator('aside:not(.right-panel) .card').getByRole('button', { name: '上下文', exact: true }).click()
  await expect(page.locator('.context')).toContainText('neighbours')
  await page.locator('aside:not(.right-panel) .card').getByRole('button', { name: '回到原文', exact: true }).click()
  await expect.poll(async () => (await Promise.all(page.frames().filter(frame => frame.url().startsWith('blob:')).map(frame => frame.locator('h1').textContent().catch(() => '')))).join('')).toBe('The proposal')
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('incremental-reader')
    request.onsuccess = () => { const db = request.result, transaction = db.transaction('searchIndexes', 'readwrite'), store = transaction.objectStore('searchIndexes'), read = store.getAll(); read.onsuccess = () => store.put({ ...read.result[0], index: '{broken' }); transaction.oncomplete = () => { db.close(); resolve() }; transaction.onerror = () => reject(transaction.error) }
  }))
  await page.reload(); await expect(page.locator('.reader-footer')).toContainText('全文检索就绪')
  expect(await page.evaluate(() => (window as any).__searchMetrics.restored)).toBe(false)
  expect(await page.evaluate(() => (window as any).__searchMetrics.batches)).toBeGreaterThan(0)
  await search(page, 'public garden'); await expect(page.locator('aside:not(.right-panel) .card')).toContainText('public garden')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

function contextFixture() {
  const xml = strToU8
  return Buffer.from(zipSync({
    mimetype: [xml('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': xml('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'book.opf': xml('<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">context-test</dc:identifier><dc:title>Context test</dc:title><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>'),
    'chapter.xhtml': xml('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Context test</title></head><body>\n<nav>Navigation text is part of original context.</nav>\n<div hidden="hidden">Hidden original context.</div>\n<p>Alpha <em>needle</em> ends here.</p>\n<!-- comment -->\n<ul><li>Outer <span>text</span><ul><li>Nested discovery context.</li></ul></li></ul>\n<p>Same repeated sentence.</p>\n<p>Same repeated sentence.</p>\n<p>Final <strong>ending</strong> context.</p>\n</body></html>'),
  }))
}
test('one-pass contexts still resolve mixed tags, whitespace, hidden/nav text, nested lists and repetitions', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('导入 EPUB', { exact: true }).setInputFiles({ name: 'contexts.epub', mimeType: 'application/epub+zip', buffer: contextFixture() })
  await expect(page.getByText('正在打开书籍…', { exact: true })).toHaveCount(0)
  await search(page, 'needle')
  for (const query of ['needle', 'Nested discovery', 'Same repeated', 'ending']) {
    await page.getByLabel('搜索原文', { exact: true }).fill(query)
    await page.locator('aside:not(.right-panel) form').getByRole('button', { name: '搜索', exact: true }).click()
    const cards = page.locator('aside:not(.right-panel) .card')
    await expect(cards.first()).toBeVisible()
    const count = await cards.count()
    if (query === 'Same repeated') expect(count).toBe(2)
    for (let i = 0; i < count; i++) {
      await cards.nth(i).getByRole('button', { name: '上下文', exact: true }).click()
      await expect(page.locator('.context')).toBeVisible()
      await cards.nth(i).getByRole('button', { name: '回到原文', exact: true }).click()
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
  }
})

test('closing during delayed indexing does not leak the old build into a replacement book', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('导入 EPUB', { exact: true }).setInputFiles(path.resolve('tests/fixtures/A-small-journey.epub'))
  await expect(page.getByText('正在打开书籍…', { exact: true })).toHaveCount(0)
  await page.getByLabel('返回书库').click()
  await page.getByLabel('导入 EPUB', { exact: true }).setInputFiles(path.resolve('tests/fixtures/另一种结构.epub'))
  await expect(page.getByText('正在打开书籍…', { exact: true })).toHaveCount(0)
  await search(page, '缓慢')
  await expect(page.locator('aside:not(.right-panel) .card')).toContainText('阅读是一种缓慢的发现')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('foliate-view')).toHaveCount(1)
})

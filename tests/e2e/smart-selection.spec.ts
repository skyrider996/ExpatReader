import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'

async function openBook(page: Page) {
  await page.goto('/')
  await page.getByLabel('导入 EPUB', { exact: true }).setInputFiles(path.resolve('tests/fixtures/A-small-journey.epub'))
  await expect(page.getByLabel('返回书库')).toBeEnabled()
}
async function selectText(page: Page, selector: string) {
  const frame = page.frames().find(frame => frame.url().startsWith('blob:'))!
  await frame.evaluate(selector => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector(selector)!)
    const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('pointerup'))
  }, selector)
  const toolbar = page.getByRole('toolbar', { name: '选区快捷操作' })
  await expect(toolbar).toBeVisible()
  return toolbar
}
async function observeMarks(page: Page) {
  await page.addInitScript(() => {
    const roots: ShadowRoot[] = []; (window as any).__readerRoots = roots
    const attach = Element.prototype.attachShadow
    Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
      const root = attach.call(this, init)
      if (this.tagName === 'FOLIATE-PAGINATOR') roots.push(root)
      return root
    }
  })
}
function markFills(page: Page) {
  return page.evaluate(() => ((window as any).__readerRoots as ShadowRoot[]).filter(root => root.host.isConnected).flatMap(root => Array.from(root.querySelectorAll('svg g[fill]'), node => node.getAttribute('fill'))))
}
function annotations(page: Page) {
  return page.evaluate(() => new Promise<any[]>((resolve, reject) => {
    const open = indexedDB.open('incremental-reader')
    open.onsuccess = () => { const db = open.result, get = db.transaction('annotations').objectStore('annotations').getAll(); get.onsuccess = () => { db.close(); resolve(get.result) }; get.onerror = () => reject(get.error) }
    open.onerror = () => reject(open.error)
  }))
}

test('routes single words to the dictionary and selected prose to the independent translator', async ({ page }) => {
  await page.addInitScript(() => { if (!localStorage.getItem('dictionary-settings')) localStorage.setItem('dictionary-settings', JSON.stringify({ provider: 'deepl-free', target: 'zh' })) })
  const dictionaryRequests: string[] = [], translations: any[] = []
  await page.route('https://api.dictionaryapi.dev/**', route => {
    dictionaryRequests.push(route.request().url())
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ word: 'reluctantly', meanings: [{ partOfSpeech: 'adverb', definitions: [{ definition: 'With hesitation.' }] }] }]) })
  })
  await page.route('**/api/translate', route => {
    translations.push(route.request().postDataJSON())
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ translation: 'Elle a accepté la proposition à contrecœur.' }) })
  })
  await openBook(page)
  await page.getByLabel('更多工具').click(); await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByLabel('词典服务', { exact: true })).toHaveValue('free')
  await expect(page.getByLabel('翻译服务', { exact: true })).toHaveValue('deepl-free')
  await page.getByLabel('翻译服务', { exact: true }).selectOption('deepl-pro')
  await page.getByLabel('目标语言代码').fill('FR'); await page.getByLabel('翻译 API 密钥').fill('test-only-key')
  await page.getByLabel('收起侧栏').click()
  let toolbar = await selectText(page, 'em')
  expect(dictionaryRequests).toHaveLength(0); expect(translations).toHaveLength(0)
  await toolbar.getByRole('button', { name: '查词', exact: true }).click()
  await expect(page.getByLabel('词句释义')).toContainText('With hesitation.')
  expect(dictionaryRequests[0]).toContain('/en/reluctantly')
  toolbar = await selectText(page, 'p:first-of-type')
  await expect(toolbar.getByRole('button', { name: '查词', exact: true })).toHaveCount(0)
  await toolbar.getByRole('button', { name: '翻译', exact: true }).click()
  await expect(page.getByLabel('翻译结果')).toContainText('Elle a accepté')
  expect(translations).toEqual([{ provider: 'deepl-pro', text: 'She reluctantly agreed to the proposal.', target: 'FR', key: 'test-only-key' }])
  expect(dictionaryRequests).toHaveLength(1)
  await page.reload(); await expect(page.getByLabel('返回书库')).toBeEnabled()
  toolbar = await selectText(page, 'p:first-of-type')
  await toolbar.getByRole('button', { name: '翻译', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('翻译服务密钥')
  expect(translations).toHaveLength(1)
})

test('four colors render and persist, a contained selection can recolor or cancel without deleting the note', async ({ page }) => {
  await observeMarks(page); await openBook(page)
  let toolbar = await selectText(page, 'p:first-of-type')
  for (const name of ['浅褐色', '品红色', '浅绿', '浅蓝']) await expect(toolbar.getByRole('button', { name, exact: true })).toBeVisible()
  await toolbar.getByRole('button', { name: '品红色', exact: true }).click()
  await expect.poll(() => markFills(page)).toContain('#d653a5')
  toolbar = await selectText(page, 'em')
  await expect(toolbar.getByRole('button', { name: '取消标注', exact: true })).toBeVisible()
  await expect(toolbar.getByRole('button', { name: '品红色', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await toolbar.getByRole('button', { name: '浅蓝', exact: true }).click()
  await expect.poll(() => markFills(page)).toContain('#76a9e1')
  await expect.poll(() => markFills(page)).not.toContain('#d653a5')
  const initial = (await annotations(page))[0]
  expect(initial.locator.quote).toBe('She reluctantly agreed to the proposal.')
  await selectText(page, 'p:first-of-type')
  await page.getByLabel('更多工具').click(); await page.getByRole('button', { name: '笔记与学习', exact: true }).click()
  await page.getByLabel('个人笔记').fill('高亮取消后仍保留的笔记')
  await page.getByRole('button', { name: '保存批注', exact: true }).click()
  await expect(page.locator('.reader-footer')).toContainText('批注已保存')
  await page.reload(); await expect(page.getByLabel('返回书库')).toBeEnabled()
  await expect.poll(() => markFills(page)).toContain('#76a9e1')
  toolbar = await selectText(page, 'em')
  await page.screenshot({ path: '.cache/previews/selection-highlight-palette.png' })
  await toolbar.getByRole('button', { name: '取消标注', exact: true }).click()
  await expect.poll(() => markFills(page)).not.toContain('#76a9e1')
  await expect.poll(() => annotations(page)).toMatchObject([{ id: initial.id, color: 'blue', highlighted: false, note: '高亮取消后仍保留的笔记' }])
  await expect(toolbar.getByRole('button', { name: '取消标注', exact: true })).toHaveCount(0)
  toolbar = await selectText(page, 'p:first-of-type')
  await toolbar.getByRole('button', { name: '浅绿', exact: true }).click()
  await expect.poll(() => markFills(page)).toContain('#79b870')
  await expect.poll(() => annotations(page)).toMatchObject([{ id: initial.id, color: 'green', highlighted: true, note: '高亮取消后仍保留的笔记' }])
})

test('cancelling a pure highlight affects the selected occurrence only', async ({ page }) => {
  await observeMarks(page); await openBook(page)
  let toolbar = await selectText(page, 'p:nth-of-type(2)')
  await toolbar.getByRole('button', { name: '浅褐色', exact: true }).click()
  await expect.poll(() => markFills(page)).toContain('#bd8b57')
  toolbar = await selectText(page, 'p:nth-of-type(3)')
  await expect(toolbar.getByRole('button', { name: '标注', exact: true })).toBeVisible()
  await toolbar.getByRole('button', { name: '品红色', exact: true }).click()
  await expect.poll(() => markFills(page)).toContain('#d653a5')
  toolbar = await selectText(page, 'p:nth-of-type(2)')
  await toolbar.getByRole('button', { name: '取消标注', exact: true }).click()
  await expect.poll(() => markFills(page)).toEqual(['#d653a5'])
  await expect.poll(() => annotations(page)).toMatchObject([{ color: 'magenta', highlighted: true, note: '' }])
})

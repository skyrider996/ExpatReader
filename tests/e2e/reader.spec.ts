import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'

async function importBook(page: any, filename: string) {
  await page.getByLabel('导入 EPUB', { exact: true }).setInputFiles(path.resolve('tests/fixtures', filename))
  await expect.poll(() => page.frames().filter((f: any) => f.url().startsWith('blob:')).length).toBeGreaterThan(0)
  await expect(page.getByText('正在打开书籍…', { exact: true })).toHaveCount(0)
  if (await page.getByLabel('切换侧栏').getAttribute('aria-expanded') === 'false') await page.getByLabel('切换侧栏').click()
}
test('opens two different EPUB structures and changes chapter/layout/font', async ({ page }) => {
  await page.goto('/')
  await importBook(page, 'A-small-journey.epub')
  await page.getByRole('button', { name: 'Chapter 2', exact: true }).click()
  await expect.poll(async () => (await Promise.all(page.frames().filter(f => f.url().startsWith('blob:')).map(f => f.locator('body').innerText().catch(() => '')))).join('')).toContain('public garden')
  await page.getByLabel('阅读布局').selectOption('scrolled')
  await page.getByLabel('字号', { exact: true }).fill('24')
  await page.setViewportSize({ width: 1100, height: 800 })
  await importBook(page, '另一种结构.epub')
  await expect(page.locator('.app-header')).toContainText('另一种结构')
  await expect(page.locator('foliate-view')).toHaveCount(1)
})

async function selectText(page: any, selector: string, nth = 0) {
  const frame = page.frames().find((f: any) => f.url().startsWith('blob:'))!
  await frame.evaluate(({ selector, nth }: { selector: string; nth: number }) => {
    const node = document.querySelectorAll(selector)[nth]
    const range = document.createRange(); range.selectNodeContents(node)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('pointerup', { bubbles: true }))
  }, { selector, nth })
  await expect(page.getByRole('toolbar', { name: '选区快捷操作' })).toBeVisible()
}
async function showDefinitions(page: Page) {
  if (await page.getByLabel('打开词典与翻译').getAttribute('aria-expanded') !== 'true') await page.getByLabel('打开词典与翻译').click()
}
async function saveExplanation(page: Page, text: string) {
  await showDefinitions(page)
  await page.getByRole('button', { name: '手动编辑', exact: true }).click()
  await page.getByLabel('词句解释').fill(text)
  await page.getByRole('button', { name: '保存解释', exact: true }).click()
  await expect(page.locator('.reader-footer')).toContainText('学习记录已保存')
}
async function showNotes(page: Page) {
  if (await page.getByLabel('切换侧栏').getAttribute('aria-expanded') === 'false') await page.getByLabel('切换侧栏').click()
  await page.locator('.tabs').getByRole('button', { name: '笔记', exact: true }).click()
}
async function rows(page: Page, table: string) {
  return page.evaluate(async (table: string) => new Promise<any[]>((resolve, reject) => {
    const request = indexedDB.open('incremental-reader')
    request.onsuccess = () => { const database = request.result; const read = database.transaction(table).objectStore(table).getAll(); read.onsuccess = () => { resolve(read.result); database.close() }; read.onerror = () => reject(read.error) }
    request.onerror = () => reject(request.error)
  }), table)
}
test('persists cross-tag highlights and incremental explanations without moving repeated-text anchors', async ({ page }) => {
  await page.goto('/'); await importBook(page, 'A-small-journey.epub')
  await selectText(page, 'p', 0)
  await showNotes(page)
  await page.getByLabel('个人笔记').fill('跨标签笔记')
  await page.getByRole('button', { name: '保存批注', exact: true }).click()
  await expect.poll(async () => (await rows(page, 'annotations')).length).toBe(1)
  const before = (await rows(page, 'annotations'))[0].locator.cfi
  await saveExplanation(page, '仅此处的解释，不应进入原文索引')
  await expect.poll(async () => (await rows(page, 'learning')).length).toBe(1)
  let frame = page.frames().find(f => f.url().startsWith('blob:'))!
  await expect(frame.locator('[data-reader-ui]')).toHaveCount(0)
  await selectText(page, 'p', 0)
  await page.getByRole('button', { name: '保存批注', exact: true }).click()
  await expect.poll(async () => (await rows(page, 'annotations')).length).toBe(1)
  expect((await rows(page, 'annotations'))[0].locator.cfi).toBe(before)
  await selectText(page, 'p', 2)
  await saveExplanation(page, '第二次出现的花园')
  await expect.poll(async () => (await rows(page, 'learning')).length).toBe(2)
  await expect(frame.locator('[data-reader-ui]')).toHaveCount(0)
  await page.getByLabel('字号', { exact: true }).fill('24')
  await expect(frame.locator('[data-reader-ui]')).toHaveCount(0)
  await page.reload(); await page.getByLabel('切换侧栏').click()
  frame = page.frames().find(f => f.url().startsWith('blob:'))!
  await expect(frame.locator('[data-reader-ui]')).toHaveCount(0)
  const saved = await rows(page, 'learning')
  const garden = saved.find(item => item.explanation === '第二次出现的花园')
  expect(garden.locator.quote).toBe('The garden was quiet.')
  expect(garden.locator.prefix).toContain('The garden was quiet.')
  await page.locator('.tabs').getByRole('button', { name: '学习', exact: true }).click()
  const gardenCard = page.locator('aside:not(.right-panel) .card').filter({ hasText: '第二次出现的花园' })
  await gardenCard.getByRole('button', { name: '回到原文' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.locator('.tabs').getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByLabel('搜索原文', { exact: true }).fill('不应进入原文索引')
  await page.locator('form').getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.getByText('尚无结果，可调整关键词后再搜索。')).toBeVisible()
  await expect(page.locator('aside:not(.right-panel) .card')).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('multiple selected words in one paragraph coexist and deleting learning preserves a converted note', async ({ page }) => {
  await page.goto('/'); await importBook(page, 'A-small-journey.epub')
  await selectText(page, 'em')
  await saveExplanation(page, '不情愿地')
  await expect.poll(async () => (await rows(page, 'learning')).length).toBe(1)
  await selectText(page, 'strong')
  await saveExplanation(page, '提议')
  await expect.poll(async () => (await rows(page, 'learning')).length).toBe(2)
  const frame = page.frames().find(f => f.url().startsWith('blob:'))!
  await expect(frame.locator('[data-reader-ui]')).toHaveCount(0)
  await page.locator('.tabs').getByRole('button', { name: '学习', exact: true }).click()
  const card = page.locator('aside:not(.right-panel) .card').filter({ hasText: '不情愿地' })
  await card.getByRole('button', { name: '转存笔记' }).click()
  await expect.poll(async () => (await rows(page, 'annotations')).length).toBe(1)
  await card.getByRole('button', { name: '删除', exact: true }).click()
  await expect.poll(async () => (await rows(page, 'learning')).length).toBe(1)
  expect((await rows(page, 'annotations'))[0].explanation).toBe('不情愿地')
})

test('rapid book replacement and restore of saved chapter do not leak prior search results', async ({ page }) => {
  await page.goto('/'); await importBook(page, 'A-small-journey.epub')
  await page.getByRole('button', { name: 'Chapter 2', exact: true }).click()
  await expect.poll(async () => (await rows(page, 'progress'))[0]?.locator.section).toBe(1)
  await page.reload(); await page.getByLabel('切换侧栏').click()
  await expect.poll(async () => (await Promise.all(page.frames().filter(f => f.url().startsWith('blob:')).map(f => f.locator('h1').textContent().catch(() => '')))).join('')).toBe('The proposal')
  await page.getByLabel('导入 EPUB', { exact: true }).setInputFiles(path.resolve('tests/fixtures/A-small-journey.epub'))
  await page.getByLabel('导入 EPUB', { exact: true }).setInputFiles(path.resolve('tests/fixtures/另一种结构.epub'))
  await expect(page.locator('.app-header')).toContainText('另一种结构')
  await expect(page.getByText('正在打开书籍…', { exact: true })).toHaveCount(0)
  await expect(page.locator('footer')).toContainText('全文检索就绪')
  await page.locator('.tabs').getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByLabel('搜索原文', { exact: true }).fill('proposal')
  await page.locator('form').getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.getByText('尚无结果，可调整关键词后再搜索。')).toBeVisible()
  await expect(page.locator('aside:not(.right-panel) .card')).toHaveCount(0)
  await expect(page.locator('foliate-view')).toHaveCount(1)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('model tools search and read real book content, validate citations, and leave reading position unchanged', async ({ page }) => {
  let calls = 0
  await page.route('https://model.test/v1/chat/completions', async route => {
    const request = route.request().postDataJSON()
    calls++
    const toolCall = (name: string, args: object) => ({ role: 'assistant', content: null, tool_calls: [{ id: `t${calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
    let message
    if (calls === 1) message = toolCall('searchBook', { query: 'proposal' })
    else if (calls === 2) {
      const found = JSON.parse(request.messages.at(-1).content).results.find((x: any) => x.untrustedExcerpt.includes('public garden'))
      expect(found).toBeTruthy()
      message = toolCall('readPassage', { passageId: found.passageId })
    } else {
      const read = JSON.parse(request.messages.at(-1).content).passages
      expect(read.some((x: any) => x.untrustedBookText.includes('public garden'))).toBe(true)
      message = { role: 'assistant', content: `提议是共同建造花园 [${read.find((x: any) => x.untrustedBookText.includes('public garden')).citation}]。不存在的引用 [R999]。` }
    }
    await route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message }] }) })
  })
  await page.goto('/'); await importBook(page, 'A-small-journey.epub')
  await page.getByLabel('更多工具', { exact: true }).click(); await page.locator('.more-menu').getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('模型接口地址').fill('https://model.test/v1')
  await page.getByLabel('模型名称').fill('test-model')
  await page.getByLabel('会话密钥').fill('test-only-secret')
  await page.getByLabel('打开 AI 对话').click()
  await page.getByLabel('向书籍提问').fill('提议是什么？')
  await page.getByRole('button', { name: '提问', exact: true }).click()
  await expect(page.locator('.answer')).toContainText('共同建造花园')
  await expect(page.locator('.answer')).toContainText('[未验证引用]')
  expect(calls).toBe(3)
  const frame = page.frames().find(f => f.url().startsWith('blob:'))!
  await expect(frame.locator('h1')).toHaveText('A small journey')
  await page.locator('.answer-sources > summary').click()
  await page.locator('.answer-sources .card > summary').click()
  await page.locator('.answer').getByRole('button', { name: '回到原文' }).click()
  await expect.poll(async () => (await Promise.all(page.frames().filter(f => f.url().startsWith('blob:')).map(f => f.locator('h1').textContent().catch(() => '')))).join('')).toBe('The proposal')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('exports and restores personal records without keys or duplicate annotations', async ({ page }) => {
  await page.goto('/'); await importBook(page, 'A-small-journey.epub')
  await selectText(page, 'em')
  await showNotes(page)
  await page.getByLabel('个人笔记').fill('备份笔记')
  await page.getByRole('button', { name: '保存批注', exact: true }).click()
  await expect.poll(async () => (await rows(page, 'annotations')).length).toBe(1)
  await page.getByLabel('更多工具', { exact: true }).click(); await page.locator('.more-menu').getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('会话密钥').fill('test-only-secret')
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出个人记录', exact: true }).click()
  const file = await downloaded
  const stream = await file.createReadStream(); const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  const bytes = Buffer.concat(chunks), text = bytes.toString('utf8')
  expect(text).toContain('备份笔记'); expect(text).not.toContain('test-only-secret')
  await page.locator('.tabs').getByRole('button', { name: '笔记', exact: true }).click()
  await page.locator('aside:not(.right-panel) .card').getByRole('button', { name: '删除', exact: true }).click()
  await expect.poll(async () => (await rows(page, 'annotations')).length).toBe(0)
  await page.getByLabel('更多工具', { exact: true }).click(); await page.locator('.more-menu').getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('恢复记录').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: bytes })
  await expect(page.locator('footer')).toContainText('已恢复 1 条记录')
  await page.getByLabel('恢复记录').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: bytes })
  await expect(page.locator('footer')).toContainText('已恢复 0 条记录')
  expect(await rows(page, 'annotations')).toHaveLength(1)
  await page.reload(); await page.getByLabel('切换侧栏').click()
  await page.getByLabel('更多工具', { exact: true }).click(); await page.locator('.more-menu').getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByLabel('会话密钥')).toHaveValue('')
})

test('a failed explanation is not saved; successful requests are cached for the exact selection', async ({ page }) => {
  let calls = 0
  await page.route('https://model.test/v1/chat/completions', async route => {
    calls++
    const body = route.request().postDataJSON()
    expect(JSON.parse(body.messages[1].content).selectedText).toBe('reluctantly')
    expect(JSON.parse(body.messages[1].content).untrustedBookContext).toContain('proposal')
    await route.fulfill({ status: calls === 1 ? 401 : 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: calls === 1 ? '{"error":"private provider detail"}' : JSON.stringify({ choices: [{ message: { role: 'assistant', content: '不情愿地；这里修饰 agreed。' } }] }) })
  })
  await page.goto('/'); await importBook(page, 'A-small-journey.epub')
  await page.getByLabel('更多工具', { exact: true }).click(); await page.locator('.more-menu').getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('模型接口地址').fill('https://model.test/v1')
  await page.getByLabel('模型名称').fill('test-model')
  await selectText(page, 'em')
  await showDefinitions(page)
  await page.getByRole('button', { name: 'AI 解释', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('HTTP 401')
  expect(await rows(page, 'learning')).toHaveLength(0)
  await expect(page.getByRole('alert')).not.toContainText('private provider detail')
  await page.getByRole('button', { name: 'AI 解释', exact: true }).click()
  await expect.poll(async () => (await rows(page, 'learning')).length).toBe(1)
  await expect(page.getByRole('button', { name: 'AI 解释', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'AI 解释', exact: true }).click()
  await expect(page.locator('footer')).toContainText('已读取当前选区的学习记录')
  expect(calls).toBe(2)
})

test('cancelled explanation requests cannot create learning records', async ({ page }) => {
  let release: () => void = () => {}
  const released = new Promise<void>(resolve => { release = resolve })
  await page.route('https://model.test/v1/chat/completions', async route => {
    await released
    await route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '不应保存的迟到结果' } }] }) }).catch(() => {})
  })
  await page.goto('/'); await importBook(page, 'A-small-journey.epub')
  await page.getByLabel('更多工具', { exact: true }).click(); await page.locator('.more-menu').getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('模型接口地址').fill('https://model.test/v1')
  await page.getByLabel('模型名称').fill('test-model')
  await selectText(page, 'em')
  await showDefinitions(page)
  const sent = page.waitForRequest('https://model.test/v1/chat/completions')
  await page.getByRole('button', { name: 'AI 解释', exact: true }).click(); await sent
  await page.getByRole('button', { name: '取消 AI 解释', exact: true }).click()
  await expect(page.getByRole('button', { name: 'AI 解释', exact: true })).toBeEnabled()
  release()
  expect(await rows(page, 'learning')).toHaveLength(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('nested list anchors survive learning records and corrupted references fail instead of guessing', async ({ page }) => {
  await page.goto('/'); await importBook(page, 'A-small-journey.epub')
  await selectText(page, 'li li')
  await showNotes(page)
  await page.getByLabel('个人笔记').fill('嵌套列表笔记')
  await page.getByRole('button', { name: '保存批注', exact: true }).click()
  await expect.poll(async () => (await rows(page, 'annotations')).length).toBe(1)
  await saveExplanation(page, '列表中的发现')
  await expect.poll(async () => (await rows(page, 'learning')).length).toBe(1)
  const frame = page.frames().find(f => f.url().startsWith('blob:'))!
  await expect(frame.locator('li li > [data-reader-ui]')).toHaveCount(0)
  await page.locator('.tabs').getByRole('button', { name: '笔记', exact: true }).click()
  await page.locator('aside:not(.right-panel) .card').getByRole('button', { name: '回到原文' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.evaluate(async () => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('incremental-reader')
    request.onsuccess = () => {
      const database = request.result, transaction = database.transaction('annotations', 'readwrite'), store = transaction.objectStore('annotations')
      const read = store.getAll()
      read.onsuccess = () => { const item = read.result[0]; item.locator.quote = 'Corrupted original quote'; store.put(item) }
      transaction.oncomplete = () => { database.close(); resolve() }; transaction.onerror = () => reject(transaction.error)
    }
  }))
  await page.reload(); await page.getByLabel('切换侧栏').click()
  await page.locator('.tabs').getByRole('button', { name: '笔记', exact: true }).click()
  await page.locator('aside:not(.right-panel) .card').getByRole('button', { name: '回到原文' }).click()
  await expect(page.getByRole('alert')).toContainText('原文位置校验失败')
})
test('searches unseen chapters and reads context without navigating; does not index explanations', async ({ page }) => {
  await page.goto('/'); await importBook(page, 'A-small-journey.epub')
  await expect(page.locator('footer')).toContainText('全文检索就绪')
  await page.locator('.tabs').getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByLabel('搜索原文', { exact: true }).fill('proposal')
  await page.locator('form').getByRole('button', { name: '搜索', exact: true }).click()
  const result = page.locator('aside:not(.right-panel) .card').filter({ hasText: 'public garden' })
  await expect(result).toHaveCount(1)
  await result.getByRole('button', { name: '上下文' }).click()
  await expect(page.locator('.context')).toContainText('neighbours')
  let frame = page.frames().find(f => f.url().startsWith('blob:'))!
  await expect(frame.locator('h1')).toHaveText('A small journey')
  await result.getByRole('button', { name: '回到原文' }).click()
  await expect.poll(async () => (await Promise.all(page.frames().filter(f => f.url().startsWith('blob:')).map(f => f.locator('body').innerText().catch(() => '')))).join('')).toContain('public garden')
  await page.getByLabel('搜索原文', { exact: true }).fill('中文')
  await page.locator('form').getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.locator('aside:not(.right-panel) .card')).toHaveCount(1)
  await expect(page.getByRole('alert')).toHaveCount(0)
})
test('blocks scripted book content and rejects invalid files', async ({ page }) => {
  await page.goto('/')
  await importBook(page, 'script-test.epub')
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.bookScript ?? '')).toBe('')
  const frame = page.frames().find(f => f.url().startsWith('blob:'))!
  await frame.locator('p').click()
  expect(await page.evaluate(() => document.documentElement.dataset.bookEvent)).toBeUndefined()
  await page.getByLabel('导入 EPUB', { exact: true }).setInputFiles({ name: 'bad.epub', mimeType: 'application/epub+zip', buffer: Buffer.from('not a book') })
  await expect(page.getByRole('alert')).toBeVisible()
})

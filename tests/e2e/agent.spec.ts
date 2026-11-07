import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'
import { WebSocket } from 'ws'

async function openBook(page: Page, name = 'A-small-journey.epub') {
  await page.getByLabel('导入 EPUB', { exact: true }).setInputFiles(path.resolve('tests/fixtures', name))
  await expect(page.getByText('正在打开书籍…', { exact: true })).toHaveCount(0)
  await expect(page.locator('foliate-view')).toHaveCount(1)
}
async function showAI(page: Page) {
  if (await page.getByLabel('收起侧栏').isVisible()) await page.getByLabel('收起侧栏').click()
  await page.getByLabel('打开 AI 对话').click()
}

async function records(page: Page, table: string) {
  return page.evaluate(table => new Promise<any[]>((resolve, reject) => {
    const request = indexedDB.open('incremental-reader')
    request.onsuccess = () => { const db = request.result; const get = db.transaction(table).objectStore(table).getAll(); get.onsuccess = () => { resolve(get.result); db.close() }; get.onerror = () => reject(get.error) }
    request.onerror = () => reject(request.error)
  }), table)
}
async function selectWord(page: Page, selector: string) {
  const frame = page.frames().find(f => f.url().startsWith('blob:'))!
  await frame.evaluate(selector => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector(selector)!)
    const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('pointerup'))
  }, selector)
  if (!await page.getByRole('complementary', { name: '查询面板' }).isVisible()) await page.getByLabel('打开词典与翻译').click()
  await expect(page.getByRole('complementary', { name: '查询面板' })).toBeVisible()
}

test('Codex model/effort, book tools, durable citations, cancellation and book isolation', async ({ page }) => {
  const runs: any[] = [], pending = new Map<number, { input: any; stage: number }>()
  const model = (id: string, efforts: string[], initial: string) => ({ id, model: id, displayName: id, description: '', isDefault: id === 'model-one', defaultReasoningEffort: initial, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: `Effort ${reasoningEffort}` })) })
  await page.routeWebSocket('**/api/agent/socket', socket => {
    socket.onMessage(raw => {
      const m = JSON.parse(String(raw)), p = m.params || {}
      const result = (id: number, value: unknown) => socket.send(JSON.stringify({ id, result: value }))
      const event = (id: number, value: unknown) => socket.send(JSON.stringify({ requestId: id, event: value }))
      if (m.method === 'connect') result(m.id, { state: 'ready', identity: 'test-subscription', version: '0.167.0', accountLabel: 'Test subscription', message: 'Chat · 阅读对话', models: [model('model-one', ['low', 'medium'], 'low'), model('model-two', ['high'], 'high')] })
      else if (m.method === 'run') {
        runs.push(p); pending.set(m.id, { input: p, stage: 0 })
        if (JSON.parse(p.prompt).question === '取消测试') { event(m.id, { type: 'delta', text: '这是不应保存的半截回答' }); return }
        event(m.id, { type: 'tool', callId: `${m.id}-search`, name: 'searchBook', args: { query: 'proposal' } })
      } else if (m.method === 'tool') {
        result(m.id, {})
        const run = pending.get(p.requestId)!
        if (run.stage++ === 0) {
          const found = p.result.results.find((x: any) => x.untrustedExcerpt.includes('public garden'))
          expect(found).toBeTruthy()
          event(p.requestId, { type: 'tool', callId: `${p.requestId}-read`, name: 'readPassage', args: { passageId: found.passageId } })
        } else {
          const read = p.result.passages.find((x: any) => x.untrustedBookText.includes('public garden'))
          expect(read).toBeTruthy()
          event(p.requestId, { type: 'delta', text: '正在整理原文证据…' })
          result(p.requestId, { text: `原文提议共同建造花园 [${read.citation}]。无效引用 [R999]。` })
          pending.delete(p.requestId)
        }
      } else if (m.method === 'cancel') { pending.delete(p.requestId); result(m.id, {}); socket.send(JSON.stringify({ id: p.requestId, error: '请求已取消。' })) }
    })
  })
  await page.goto('/'); await openBook(page)
  await page.getByLabel('更多工具', { exact: true }).click(); await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('AI 连接方式').selectOption('codex')
  await expect(page.getByLabel('Codex 模型')).toHaveValue('model-one')
  await expect(page.getByLabel('Codex 推理强度')).toHaveValue('low')
  await page.getByLabel('Codex 模型').selectOption('model-two')
  await expect(page.getByLabel('Codex 推理强度')).toHaveValue('high')
  await page.getByLabel('Codex 模型').selectOption('model-one')
  await expect(page.getByLabel('Codex 推理强度')).toHaveValue('low')
  await showAI(page)
  await page.getByLabel('向书籍提问').fill('原文提议是什么？')
  await page.getByRole('button', { name: '提问', exact: true }).click()
  await expect(page.locator('article.answer')).toContainText('共同建造花园')
  await expect(page.locator('article.answer')).toContainText('[未验证引用]')
  const first = (await records(page, 'agentMessages'))[0]
  expect(first.choice).toEqual({ model: 'model-one', effort: 'low', mode: 'chat' })
  expect(first.answer.citations.length).toBeGreaterThan(0)
  const frame = page.frames().find(f => f.url().startsWith('blob:'))!
  await expect(frame.locator('h1')).toHaveText('A small journey')
  await page.reload(); await expect(page.getByLabel('切换侧栏')).toBeVisible(); await showAI(page)
  await expect(page.locator('article.answer')).toContainText('原文提议是什么？')
  await page.getByLabel('向书籍提问').fill('取消测试')
  await page.getByRole('button', { name: '提问', exact: true }).click()
  await expect(page.getByText('这是不应保存的半截回答')).toBeVisible()
  await page.getByLabel('对话模型').selectOption('model-two')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByRole('button', { name: '取消', exact: true })).toHaveCount(0)
  expect(await records(page, 'agentMessages')).toHaveLength(1)
  expect(runs[1].choice.model).toBe('model-one')
  await page.getByLabel('向书籍提问').fill('再查一次原文')
  await page.getByRole('button', { name: '提问', exact: true }).click()
  await expect(page.locator('article.answer')).toHaveCount(2)
  const messages = (await records(page, 'agentMessages')).sort((a, b) => a.createdAt - b.createdAt)
  expect(messages[1].choice).toEqual({ model: 'model-two', effort: 'high', mode: 'chat' })
  expect(messages[1].answer.citations[0].id).not.toBe(first.answer.citations[0].id)
  expect(runs[2].sessionId).toBe(runs[0].sessionId)
  await page.getByRole('button', { name: '新建对话', exact: true }).click()
  await expect(page.locator('article.answer')).toHaveCount(0)
  await page.getByLabel('书籍对话').selectOption(runs[0].sessionId)
  await expect(page.locator('article.answer')).toHaveCount(2)
  await page.locator('article.answer').first().locator('.answer-sources > summary').click()
  await page.locator('article.answer').first().locator('.card > summary').first().click()
  await page.locator('article.answer').first().getByRole('button', { name: '回到原文' }).first().click()
  await expect.poll(async () => (await Promise.all(page.frames().filter(f => f.url().startsWith('blob:')).map(f => f.locator('h1').textContent().catch(() => '')))).join('')).toBe('The proposal')
  await page.getByLabel('更多工具', { exact: true }).click()
  await openBook(page, '另一种结构.epub'); await showAI(page)
  await expect(page.locator('article.answer')).toHaveCount(0)
  expect(await records(page, 'agentMessages')).toHaveLength(2)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.screenshot({ path: '.cache/previews/codex-chat-controls.png', fullPage: true })
})

test('local agent bootstrap rejects foreign origins and missing reader header', async ({ request }) => {
  const foreign = await request.post('/api/agent/bootstrap', { headers: { Origin: 'https://example.com', 'X-Reader-Agent': '1' } })
  expect(foreign.status()).toBe(403)
  const missingHeader = await request.post('/api/agent/bootstrap', { headers: { Origin: 'http://127.0.0.1:4173' } })
  expect(missingHeader.status()).toBe(403)
  const valid = await request.post('/api/agent/bootstrap', { headers: { Origin: 'http://127.0.0.1:4173', 'X-Reader-Agent': '1' } })
  const { token } = await valid.json()
  const socket = new WebSocket('ws://127.0.0.1:4173/api/agent/socket', ['reader-agent', token], { origin: 'http://127.0.0.1:4173' })
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  socket.send(JSON.stringify({ id: 1, method: 'command/exec', params: {} }))
  const denied = await new Promise<any>(resolve => socket.once('message', data => resolve(JSON.parse(data.toString()))))
  expect(denied.error).toContain('不支持')
  socket.close()
  const replay = new WebSocket('ws://127.0.0.1:4173/api/agent/socket', ['reader-agent', token], { origin: 'http://127.0.0.1:4173' })
  await expect(new Promise<void>((resolve, reject) => { replay.once('open', resolve); replay.once('error', reject) })).rejects.toThrow('403')
})

test('Codex selection explanation is temporary, cached, and cancellation never saves a partial result', async ({ page }) => {
  let calls = 0
  await page.routeWebSocket('**/api/agent/socket', socket => {
    let pending = 0
    socket.onMessage(raw => {
      const m = JSON.parse(String(raw)), p = m.params || {}
      if (m.method === 'connect') socket.send(JSON.stringify({ id: m.id, result: { state: 'ready', identity: 'subscription', version: '0.167.0', accountLabel: 'Test', message: 'Chat', models: [{ id: 'example', model: 'example', displayName: 'Example', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }], defaultReasoningEffort: 'low' }] } }))
      if (m.method === 'run') {
        calls++; expect(p.temporary).toBe(true); expect(p.choice).toEqual({ model: 'example', effort: 'low', mode: 'chat' })
        if (calls === 1) socket.send(JSON.stringify({ id: m.id, result: { text: '在这里表示“不情愿地”。' } }))
        else pending = m.id
      }
      if (m.method === 'cancel') {
        socket.send(JSON.stringify({ id: m.id, result: {} })); socket.send(JSON.stringify({ id: pending, error: '请求已取消。' }))
        socket.send(JSON.stringify({ id: pending, result: { text: '迟到的解释不应保存' } }))
      }
    })
  })
  await page.goto('/'); await openBook(page)
  await page.getByLabel('更多工具', { exact: true }).click(); await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('AI 连接方式').selectOption('codex'); await expect(page.getByLabel('Codex 模型')).toHaveValue('example')
  await page.getByLabel('收起侧栏').click()
  await selectWord(page, 'em'); await page.getByRole('button', { name: 'AI 解释', exact: true }).click()
  await expect.poll(() => records(page, 'learning')).toHaveLength(1)
  await expect(page.getByLabel('词句释义')).toContainText('在这里表示“不情愿地”。')
  await page.getByRole('button', { name: 'AI 解释', exact: true }).click(); expect(calls).toBe(1)
  await selectWord(page, 'strong'); await page.getByRole('button', { name: 'AI 解释', exact: true }).click()
  await expect.poll(() => calls).toBe(2)
  await page.getByRole('button', { name: '取消 AI 解释' }).click()
  await expect(page.getByRole('button', { name: 'AI 解释', exact: true })).toBeEnabled()
  expect(await records(page, 'learning')).toHaveLength(1)
  expect(await records(page, 'agentMessages')).toHaveLength(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('existing API selection explanation still saves, caches and rejects failures', async ({ page }) => {
  let calls = 0
  await page.route('https://model.test/v1/chat/completions', route => {
    calls++
    return route.fulfill(calls === 1 ? { contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '原有 API 的语境解释' } }] }) } : { status: 401, body: 'Unauthorized' })
  })
  await page.goto('/'); await openBook(page)
  await page.getByLabel('更多工具', { exact: true }).click(); await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('模型接口地址').fill('https://model.test/v1'); await page.getByLabel('模型名称').fill('example')
  await page.getByLabel('收起侧栏').click(); await selectWord(page, 'em')
  await page.getByRole('button', { name: 'AI 解释', exact: true }).click()
  await expect.poll(() => records(page, 'learning')).toHaveLength(1)
  await page.getByRole('button', { name: 'AI 解释', exact: true }).click(); expect(calls).toBe(1)
  await selectWord(page, 'strong'); await page.getByRole('button', { name: 'AI 解释', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('HTTP 401')
  expect(await records(page, 'learning')).toHaveLength(1)
})

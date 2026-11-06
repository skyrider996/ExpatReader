import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'

for (const sample of [
  { filename: 'moby-dick.epub', query: 'Ishmael' },
  { filename: 'childrens-literature.epub', query: 'children' },
]) {
  test(`public EPUB compatibility: ${sample.filename}`, async ({ page }) => {
    test.setTimeout(120000)
    const file = path.resolve('.cache/epub-samples', sample.filename)
    test.skip(!existsSync(file), 'Download the public IDPF samples as documented in README.')
    await page.goto('/')
    await page.getByLabel('导入 EPUB', { exact: true }).setInputFiles(file)
    await page.getByLabel('切换侧栏').click()
    await expect(page.getByLabel('学习模式', { exact: true })).toBeEnabled({ timeout: 15000 }).catch(async error => {
      await page.screenshot({ path: '.cache/previews/sample-load-error.png', fullPage: true })
      console.log('Sample load error:', await page.locator('body').innerText())
      throw error
    })
    await expect(page.locator('footer')).toContainText('全文检索就绪', { timeout: 90000 })
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.getByLabel('收起侧栏').click()
    await page.screenshot({ path: `.cache/previews/${sample.filename}-reading.png`, fullPage: true })
    await page.getByLabel('切换侧栏').click()
    await page.locator('.tabs').getByRole('button', { name: '搜索', exact: true }).click()
    await page.getByLabel('搜索原文', { exact: true }).fill(sample.query)
    await page.locator('form').getByRole('button', { name: '搜索', exact: true }).click()
    await expect(page.locator('.card').first()).toBeVisible()
    await page.locator('.card').first().getByRole('button', { name: '上下文' }).click()
    await expect(page.locator('.context')).toBeVisible()
    await page.locator('.card').first().getByRole('button', { name: '回到原文' }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect.poll(async () => {
      const frame = page.frames().find(f => f.url().startsWith('blob:'))
      return frame?.locator('body').innerText().catch(() => '')
    }).toContain(sample.query)
    const frame = page.frames().find(f => f.url().startsWith('blob:'))!
    await frame.evaluate((query) => {
      const node = Array.from(document.querySelectorAll('p')).find(p => p.textContent?.includes(query))!
      const range = document.createRange(); range.selectNodeContents(node)
      const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range)
      document.dispatchEvent(new Event('pointerup'))
    }, sample.query)
    await page.getByLabel('词句解释').fill('兼容验证：仅显示当前选中内容的学习记录。')
    await page.getByRole('button', { name: '保存解释', exact: true }).click()
    await expect(page.locator('footer')).toContainText('学习记录已保存')
    await page.getByLabel('学习模式', { exact: true }).check()
    await expect(frame.locator('[data-reader-ui]')).toHaveCount(1)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.getByLabel('关闭选区').click()
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(frame.locator('[data-reader-ui]')).toHaveCount(1)
    await page.locator('.tabs').getByRole('button', { name: '学习', exact: true }).click()
    await page.locator('.card').getByRole('button', { name: '回到原文' }).click()
    await page.screenshot({ path: `.cache/previews/${sample.filename}.png`, fullPage: true })
    await page.reload()
    await page.getByLabel('切换侧栏').click()
    await expect(page.getByLabel('学习模式', { exact: true })).toBeEnabled()
    await page.getByLabel('学习模式', { exact: true }).check()
    const restored = page.frames().find(f => f.url().startsWith('blob:'))!
    await expect(restored.locator('[data-reader-ui]')).toHaveCount(1)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.getByLabel('返回书库').click()
    await expect(page.locator('.book-cover img')).toHaveCount(1)
    await expect.poll(() => page.locator('.book-cover img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    await page.screenshot({ path: `.cache/previews/${sample.filename}-library.png`, fullPage: true })
  })
}

test('welcome layout preview', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '从一本书开始。' })).toBeVisible()
  await page.screenshot({ path: '.cache/previews/welcome.png', fullPage: true })
})

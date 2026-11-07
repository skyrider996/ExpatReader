import { test, expect } from '@playwright/test'
import path from 'node:path'

test('learning records do not insert text after reload', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('导入 EPUB', { exact: true }).setInputFiles(path.resolve('tests/fixtures/A-small-journey.epub'))
  await expect(page.getByLabel('返回书库')).toBeEnabled()
  const frame = page.frames().find(f => f.url().startsWith('blob:'))!
  await frame.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('em')!)
    const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('pointerup'))
  })
  await page.getByLabel('打开词典与翻译').click()
  await page.getByRole('button', { name: '手动编辑', exact: true }).click()
  await page.getByLabel('词句解释').fill('不情愿地')
  await page.getByRole('button', { name: '保存解释' }).click()
  await expect(page.locator('footer')).toContainText('学习记录已保存')
  await expect(frame.locator('[data-reader-ui]')).toHaveCount(0)
  await page.reload()
  await expect(page.getByLabel('返回书库')).toBeEnabled()
  const restored = page.frames().find(f => f.url().startsWith('blob:'))!
  await expect(restored.locator('[data-reader-ui]')).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
})


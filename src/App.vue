<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, toRaw, watch } from 'vue'
import { ReaderAdapter, type ReadingPosition } from './adapters/reader'
import { SearchService } from './adapters/search'
import { db, fileHash } from './core/storage'
import { download, notesMarkdown, saveAnnotation, saveLearning } from './core/records'
import { exportBackup, importBackup } from './core/backup'
import { explainSelection, modelClient } from './adapters/model'
import { lookupText, type Provider } from './adapters/dictionary'
import AssistantPanel from './components/AssistantPanel.vue'
import BookShelf from './components/BookShelf.vue'
import UiIcon from './components/UiIcon.vue'
import { defaultPreferences, loadPreferences } from './core/preferences'
import type { Annotation, BookRecord, LearningRecord, Locator, SearchHit, ModelSettings } from './core/types'

const host = ref<HTMLElement>()
const sideBody = ref<HTMLElement>()
const reader = shallowRef<ReaderAdapter | null>(null), search = shallowRef<SearchService | null>(null)
const books = ref<BookRecord[]>([]), bookId = ref(''), title = ref('留一点空间，给阅读。')
const error = ref(''), notice = ref(''), loading = ref(false), saving = ref(false)
const tab = ref('目录'), sidebar = ref(false), library = ref(true), focusMode = ref(false)
const preferences = reactive(loadPreferences())
const position = ref<ReadingPosition>({ fraction: 0, section: 0, total: 0, href: '' })
const tocQuery = ref('')
const visibleOutline = computed(() => outline.value.filter(x => x.label.toLocaleLowerCase().includes(tocQuery.value.trim().toLocaleLowerCase())))
const percentage = computed(() => Math.round(position.value.fraction * 100))
const activeHref = computed(() => position.value.href || outline.value.find(x => x.section === position.value.section)?.href)
function showPanel(name: string) { focusMode.value = false; sidebar.value = !(sidebar.value && tab.value === name); tab.value = name }
async function showLibrary() {
  await run(flushProgress); selected.value = null; focusMode.value = false; library.value = true
  localStorage.setItem('reader-screen', 'library')
  await run(refreshBooks)
}
function leaveFocus() { focusMode.value = false; selected.value = null }
function resumeReading() { library.value = false; localStorage.setItem('reader-screen', 'reader') }
async function fullScreen() { await run(async () => { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen() }) }
async function jumpProgress(event: Event) { await run(() => reader.value?.goToFraction(Number((event.target as HTMLInputElement).value) / 100)) }
watch(() => preferences.theme, value => { document.documentElement.dataset.theme = value }, { immediate: true })
watch(tab, async () => { await nextTick(); if (sideBody.value) sideBody.value.scrollTop = 0 })
const chapter = ref(''), indexProgress = ref(''), learningMode = ref(false)
const rightOpen = ref(false), rightTab = ref<'dictionary' | 'ai' | 'note'>('dictionary')
const selected = ref<Locator | null>(null), note = ref(''), explanation = ref('')
const annotations = ref<Annotation[]>([]), learning = ref<LearningRecord[]>([])
const query = ref(''), results = ref<SearchHit[]>([]), searchComplete = ref(false), searching = ref(false)
const preview = ref<{ text: string; chapter: string; locator: Locator }[]>([])
const aiMode = ref<'api' | 'agent'>('api')
const settings = ref<ModelSettings>({ endpoint: '', model: '', apiKey: '' })
const agentSettings = ref<ModelSettings>({ endpoint: 'http://127.0.0.1:8000/v1', model: '', apiKey: '', mode: 'agent' })
const activeSettings = computed(() => aiMode.value === 'agent' ? agentSettings.value : settings.value)
const providers: Provider[] = ['free', 'wiktionary', 'google', 'deepl-free', 'deepl-pro']
let savedDictionary: { provider?: Provider; target?: string } = {}
try { savedDictionary = JSON.parse(localStorage.getItem('dictionary-settings') || '{}') || {} } catch { /* use defaults */ }
const dictionary = reactive({ provider: providers.includes(savedDictionary.provider as Provider) ? savedDictionary.provider as Provider : 'free' as Provider, target: typeof savedDictionary.target === 'string' ? savedDictionary.target : 'zh', apiKey: '' })
watch(() => [dictionary.provider, dictionary.target], () => { localStorage.setItem('dictionary-settings', JSON.stringify({ provider: dictionary.provider, target: dictionary.target })) })
const dictionaryBusy = ref(false), dictionaryError = ref('')
let dictionaryRequest: AbortController | null = null
watch(selected, () => { dictionaryRequest?.abort(); dictionaryRequest = null; dictionaryBusy.value = false; dictionaryError.value = '' })
async function queryDictionary() {
  if (!selected.value || dictionaryBusy.value) return
  const locator = selected.value, request = new AbortController()
  dictionaryRequest = request; dictionaryBusy.value = true; dictionaryError.value = ''
  try {
    const result = await lookupText(locator.quote, { ...dictionary }, request.signal)
    if (!request.signal.aborted && selected.value === locator) explanation.value = result
  } catch (e) { if (!request.signal.aborted) dictionaryError.value = e instanceof Error ? e.message : String(e) }
  finally { if (dictionaryRequest === request) { dictionaryRequest = null; dictionaryBusy.value = false } }
}
const explaining = ref(false)
let explanationRequest: AbortController | null = null
let generation = 0, queryVersion = 0
let opening = Promise.resolve()
let progressTimer: ReturnType<typeof setTimeout> | undefined
let pendingProgress: Locator | null = null

const outline = computed(() => reader.value?.content.outline ?? [])
const groups = computed(() => {
  const map = new Map<string, Annotation[]>()
  for (const item of [...annotations.value].sort((a, b) => a.locator.section - b.locator.section || a.createdAt - b.createdAt)) {
    if (!map.has(item.chapter)) map.set(item.chapter, [])
    map.get(item.chapter)!.push(item)
  }
  return map
})
function report(e: unknown) { error.value = e instanceof Error ? e.message : String(e) }
async function run(action: () => unknown | Promise<unknown>) { error.value = ''; try { await action() } catch (e) { report(e) } }
async function refreshBooks() { books.value = await db.books.orderBy('openedAt').reverse().toArray() }
async function flushProgress() {
  clearTimeout(progressTimer)
  const locator = pendingProgress; pendingProgress = null
  if (locator) await db.progress.put({ bookId: locator.bookId, locator, updatedAt: Date.now() })
}
function progress(locator: Locator, label: string, current: ReadingPosition) {
  chapter.value = label; pendingProgress = locator; position.value = current
  clearTimeout(progressTimer)
  progressTimer = setTimeout(() => void flushProgress().catch(report), 250)
}
async function loadRecords() {
  const id = bookId.value, instance = reader.value
  if (!id || !instance) return
  const [notes, records] = await Promise.all([db.annotations.where('bookId').equals(id).toArray(), db.learning.where('bookId').equals(id).toArray()])
  if (id !== bookId.value || instance !== reader.value) return
  annotations.value = notes; learning.value = records
  await instance.setRecords(notes, records)
}
async function open(file: File, existingId?: string) {
  const current = ++generation
  explanationRequest?.abort()
  queryVersion++; loading.value = true; selected.value = null; error.value = ''; notice.value = ''; searching.value = false
  const job = opening.then(async () => {
    let instance: ReaderAdapter | null = null
    try {
      if (current !== generation) return
      const id = existingId ?? await fileHash(file)
      instance = await ReaderAdapter.create(id, file, {
        selection: locator => { if (instance === reader.value) { selected.value = locator; note.value = ''; explanation.value = ''; if (locator) { rightOpen.value = true; rightTab.value = 'dictionary' } } },
        relocate: (locator, label, current) => { if (instance === reader.value) progress(locator, label, current) },
        error: e => { if (instance === reader.value) report(e) },
        escape: leaveFocus,
        action: (action, locator) => { if (instance !== reader.value) return; selected.value = locator; rightTab.value = action === 'menu' ? 'dictionary' : action; rightOpen.value = true },
        mark: locator => { if (instance !== reader.value) return; selected.value = locator; explanation.value = learning.value.find(x => x.locator.cfi === locator.cfi)?.explanation ?? ''; rightTab.value = 'dictionary'; rightOpen.value = true },
      })
      if (current !== generation) { await instance.dispose(); return }
      const previous = await db.books.get(id)
      const cover = previous?.cover ?? await instance.cover()
      if (current !== generation) { await instance.dispose(); return }
      await db.books.put({ id, title: instance.title, author: instance.author, cover, filename: file.name, file, addedAt: previous?.addedAt ?? Date.now(), openedAt: Date.now() })
      const [saved, notes, records] = await Promise.all([db.progress.get(id), db.annotations.where('bookId').equals(id).toArray(), db.learning.where('bookId').equals(id).toArray()])
      await flushProgress()
      search.value?.dispose(); search.value = null
      await reader.value?.dispose()
      reader.value = instance; bookId.value = id; title.value = instance.title; library.value = false
      chapter.value = ''; tocQuery.value = ''; position.value = { fraction: 0, section: 0, total: 0, href: '' }
      annotations.value = notes; learning.value = records; learningMode.value = false
      results.value = []; preview.value = []; query.value = ''
      await nextTick()
      await instance.mount(host.value!, saved?.locator, { annotations: notes, learning: records })
      await instance.configure({ ...preferences })
      if (current !== generation) return
      const service = new SearchService(instance.content); search.value = service
      indexProgress.value = `准备检索 0/${service.totalSections}`
      void service.build((done, total) => { if (service === search.value) indexProgress.value = done === total ? '全文检索就绪' : `准备检索 ${done}/${total}` }).catch(e => { if (service === search.value) report(e) })
      localStorage.setItem('last-book', id)
      localStorage.setItem('reader-screen', 'reader')
      await refreshBooks()
    } catch (e) {
      if (instance && instance !== reader.value) await instance.dispose()
      if (current === generation) report(e)
    } finally { if (current === generation) loading.value = false }
  })
  opening = job.catch(() => {})
  await job
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  input.value = ''
  if (file) await open(file)
}
async function reopen(item: BookRecord) {
  if (item.id === bookId.value && reader.value && !loading.value) { resumeReading(); return }
  await open(new File([item.file], item.filename, { type: 'application/epub+zip' }), item.id)
}
async function configure() {
  await run(async () => {
    localStorage.setItem('reading-preferences', JSON.stringify(preferences))
    await reader.value?.configure({ ...preferences, learning: learningMode.value })
  })
}
async function resetAppearance() { Object.assign(preferences, defaultPreferences); await configure() }
async function lookup() {
  const service = search.value, id = bookId.value, version = ++queryVersion
  if (!service) return
  searching.value = true
  try {
    const response = await service.searchBook(id, query.value)
    if (version !== queryVersion || service !== search.value) return
    results.value = response.results; searchComplete.value = response.complete; preview.value = []
  } catch (e) { if (version === queryVersion) report(e) }
  finally { if (version === queryVersion) searching.value = false }
}
async function readContext(locator: Locator) {
  const instance = reader.value
  if (!instance) return
  await run(async () => {
    const passages = await instance.content.readPassage(instance.bookId, locator, { before: 1, after: 1 })
    if (instance === reader.value) preview.value = passages
  })
}
async function navigate(locator: Locator) { await run(() => reader.value?.navigateTo(locator)) }
async function addNote() {
  if (!selected.value || !reader.value) return
  const locator = structuredClone(toRaw(selected.value)), instance = reader.value
  saving.value = true
  await run(async () => {
    await saveAnnotation(locator, instance.content.title(locator.section), note.value)
    await loadRecords(); notice.value = '批注已保存'
  }); saving.value = false
}
async function addExplanation() {
  if (!selected.value || !reader.value) return
  const locator = structuredClone(toRaw(selected.value)), instance = reader.value
  saving.value = true
  await run(async () => {
    await saveLearning(locator, instance.content.title(locator.section), explanation.value)
    await loadRecords(); notice.value = '学习记录已保存'
  }); saving.value = false
}
async function editNote(item: Annotation) {
  selected.value = item.locator; note.value = item.note; explanation.value = item.explanation ?? ''
  await navigate(item.locator)
}
async function convert(item: LearningRecord) {
  await run(async () => { await saveAnnotation(structuredClone(toRaw(item.locator)), item.chapter, undefined, item.explanation); await loadRecords(); notice.value = '已转存笔记' })
}
function exportNotes() { download(`${title.value}-笔记.md`, notesMarkdown(title.value, annotations.value), 'text/markdown;charset=utf-8') }
async function removeRecord(table: 'annotations' | 'learning', id: string) { await run(async () => { await db[table].delete(id); await loadRecords() }) }
async function explain() {
  if (!selected.value || !reader.value || explaining.value) return
  const locator = structuredClone(toRaw(selected.value)), instance = reader.value
  const request = new AbortController(); explanationRequest = request
  explaining.value = true
  error.value = ''
  try {
    const cached = learning.value.find(x => x.locator.cfi === locator.cfi && x.targetLanguage === 'zh')
    if (cached) { explanation.value = cached.explanation; notice.value = '已读取当前选区的学习记录'; return }
    const complete = modelClient({ ...activeSettings.value })
    const context = (await instance.content.readPassage(instance.bookId, locator, { before: 0, after: 0, maxChars: 6000 })).map(x => x.text).join('\n')
    const text = await explainSelection(complete, locator.quote, context, request.signal)
    if (request.signal.aborted || instance !== reader.value) return
    await saveLearning(locator, instance.content.title(locator.section), text)
    if (selected.value?.cfi === locator.cfi) explanation.value = text
    await loadRecords(); notice.value = '解释已保存，点击正文标记可查看'
  } catch (e) {
    if (!request.signal.aborted && instance === reader.value) report(e)
    else if (instance === reader.value) notice.value = '已取消查询'
  } finally {
    if (explanationRequest === request) { explaining.value = false; explanationRequest = null }
  }
}
async function backup() { await run(async () => { await flushProgress(); download('隅读-个人记录.json', await exportBackup()); notice.value = '个人记录已导出，原始 EPUB 请另外保留' }) }
async function restore(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''
  if (!file) return
  await run(async () => {
    if (file.size > 50_000_000) throw new Error('备份超过 50 MB。')
    await flushProgress()
    const result = await importBackup(await file.text())
    await loadRecords()
    notice.value = `已恢复 ${result.changed} 条记录${result.missingBooks ? `；请重新导入 ${result.missingBooks} 本原始 EPUB` : ''}`
  })
}
onMounted(() => void run(async () => {
  await refreshBooks()
  const last = localStorage.getItem('last-book')
  const item = books.value.find(x => x.id === last)
  if (item && localStorage.getItem('reader-screen') !== 'library') await reopen(item)
}))
const onHide = () => { if (document.hidden) void flushProgress().catch(report) }
const onKey = (event: KeyboardEvent) => {
  if (event.key === 'Escape') { leaveFocus(); return }
  if (library.value || loading.value || !reader.value || event.altKey || event.ctrlKey || event.metaKey) return
  if ((event.target as Element)?.closest('input,textarea,select,button,[contenteditable]') || !getSelection()?.isCollapsed) return
  if (['ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp'].includes(event.key)) {
    event.preventDefault(); void run(() => reader.value?.page(['ArrowRight', 'PageDown'].includes(event.key) ? 1 : -1))
  }
}
document.addEventListener('visibilitychange', onHide)
document.addEventListener('keydown', onKey)
onBeforeUnmount(() => { generation++; explanationRequest?.abort(); dictionaryRequest?.abort(); document.removeEventListener('visibilitychange', onHide); document.removeEventListener('keydown', onKey); search.value?.dispose(); void flushProgress(); void reader.value?.dispose() })
</script>

<template>
  <div class="app-shell" :class="{ 'is-focused': focusMode && !library, 'library-open': library }">
  <header class="app-header">
    <template v-if="library"><div class="brand"><UiIcon name="book"/>隅读<span>给阅读留一点空间</span></div><span class="header-spacer"></span><button v-if="reader" @click="resumeReading">继续阅读 <UiIcon name="next"/></button></template>
    <template v-else>
      <button class="icon-button" aria-label="返回书库" title="返回书库" :disabled="loading" @click="showLibrary"><UiIcon name="back"/></button>
      <button class="icon-button" aria-label="切换侧栏" title="目录" :aria-expanded="sidebar" @click="showPanel('目录')"><UiIcon name="menu"/></button>
      <span class="book-title">{{ title }}</span>
      <button class="icon-button" aria-label="搜索原文面板" title="搜索原文" @click="showPanel('搜索')"><UiIcon name="search"/></button>
      <button class="icon-button" aria-label="阅读排版" title="阅读排版" @click="showPanel('排版')"><UiIcon name="type"/></button>
      <button class="icon-button" aria-label="专注阅读" title="专注阅读 · Esc 退出" @click="focusMode = true; sidebar = false; selected = null"><UiIcon name="focus"/></button>
      <details class="more-menu"><summary aria-label="更多工具"><UiIcon name="more"/></summary><div @click="($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')"><button @click="sidebar = true; tab = '设置'">设置</button><button @click="sidebar = true; tab = '笔记'">笔记与学习</button><button @click="fullScreen">切换全屏</button><label class="button">导入 EPUB<input aria-label="导入 EPUB" type="file" accept=".epub" :disabled="loading" @change="importFile"></label></div></details>
    </template>
  </header>
  <div v-if="error" class="message error" role="alert">{{ error }}<button aria-label="关闭错误" @click="error = ''">×</button></div>
  <BookShelf v-if="library" :books="books" :current-id="bookId || books[0]?.id || ''" :busy="loading" @open="reopen" @import="importFile"/>
  <div class="layout" :inert="library || undefined">
    <aside v-if="sidebar && !focusMode">
      <nav class="tabs"><button v-for="name in ['目录','搜索','排版','笔记','学习','AI']" :key="name" :class="{active: tab === name}" @click="tab = name">{{ name }}</button><button class="close-side" aria-label="收起侧栏" @click="sidebar = false">×</button></nav>
      <div ref="sideBody" class="side-body">
        <template v-if="tab === '排版'"><h2>阅读排版</h2><div class="appearance settings">
          <label>字体<select v-model="preferences.font" aria-label="阅读字体" @change="configure"><option value="publisher">书籍原字体</option><option value="serif">衬线字体</option><option value="sans">无衬线字体</option></select></label>
          <label>行距 <span class="setting-value">{{ preferences.lineHeight.toFixed(1) }}</span><input v-model.number="preferences.lineHeight" aria-label="阅读行距" type="range" min="1.3" max="2.4" step="0.1" @change="configure"></label>
          <label>阅读宽度 <span class="setting-value">{{ preferences.width }} px</span><input v-model.number="preferences.width" aria-label="阅读宽度" type="range" min="520" max="1000" step="40" @change="configure"></label>
          <label>分页显示<select v-model.number="preferences.columns" aria-label="分页栏数" :disabled="preferences.flow === 'scrolled' || learningMode" @change="configure"><option :value="1">单页</option><option :value="2">双页 · 宽屏适用</option></select></label>
          <p class="setting-label">阅读主题</p><div class="theme-options"><button v-for="theme in [{id:'light',label:'明亮'},{id:'paper',label:'纸张'},{id:'dark',label:'夜间'}] as const" :key="theme.id" :class="['theme-'+theme.id, {active: preferences.theme === theme.id}]" :aria-pressed="preferences.theme === theme.id" @click="preferences.theme = theme.id; configure()">{{ theme.label }}</button></div>
          <p class="muted">排版偏好自动保存。双页会根据窗口宽度自动调整；书中的图片与标题保留原有排版。</p><button @click="resetAppearance">恢复默认排版</button>
          <div class="shortcut-help"><h3>阅读快捷键</h3><p>← / →　翻页</p><p>Page Up / Page Down　翻页</p><p>Esc　退出专注阅读</p></div>
        </div></template>
        <template v-if="tab === 'AI'"><AssistantPanel v-if="reader && search" :key="bookId" :content="reader.content" :search="search" :settings="activeSettings" @navigate="navigate" @error="report"/><p v-else class="muted">先打开一本书。模型接口可在设置中填写。</p></template>
        <template v-if="tab === '设置'"><p class="eyebrow">KEEP IT SIMPLE</p><h2>设置</h2><div class="settings"><h3>词典与翻译</h3><label>查询服务<select v-model="dictionary.provider" aria-label="查询服务"><option value="free">Free Dictionary · 英语释义</option><option value="wiktionary">Wiktionary · 多语言释义</option><option value="google">Google Cloud Translation</option><option value="deepl-free">DeepL API Free</option><option value="deepl-pro">DeepL API Pro</option></select></label><template v-if="dictionary.provider === 'google' || dictionary.provider.startsWith('deepl')"><label>目标语言代码<input v-model.trim="dictionary.target" aria-label="目标语言代码" placeholder="zh"></label><label>翻译 API 密钥<input v-model="dictionary.apiKey" type="password" autocomplete="off" aria-label="翻译 API 密钥" placeholder="仅保留到刷新或关闭页面"></label><p class="muted">翻译可能产生费用。所选文字及密钥经本机服务发送给所选提供商；密钥仅保留在页面会话。目标语言代码须受所选服务支持。</p></template><p class="muted">查询时选中文字会发送给所选服务。词典返回的语言和词源信息取决于词条；Wiktionary 使用英语版释义。</p><h3>AI 模型</h3><label>连接方式<select v-model="aiMode" aria-label="AI 连接方式"><option value="api">直接连接 API</option><option value="agent">本地 Agent 服务</option></select></label><template v-if="aiMode === 'api'"><label>接口地址<input v-model="settings.endpoint" type="url" aria-label="模型接口地址" placeholder="https://…/v1"></label><label>模型名称<input v-model="settings.model" aria-label="模型名称" placeholder="提供商的模型 ID"></label><label>API 密钥<input v-model="settings.apiKey" type="password" aria-label="会话密钥" autocomplete="off" placeholder="仅保留到刷新或关闭页面"></label><p class="muted">使用兼容 Chat Completions 的 HTTPS 接口，服务需允许浏览器跨域。</p></template><template v-else><label>本地 Agent 地址<input v-model="agentSettings.endpoint" type="url" aria-label="本地 Agent 地址" placeholder="http://127.0.0.1:8000/v1"></label><label>模型名称<input v-model="agentSettings.model" aria-label="本地 Agent 模型名称" placeholder="填写本地服务要求的模型 ID"></label><label>访问令牌（可选）<input v-model="agentSettings.apiKey" type="password" aria-label="本地 Agent 访问令牌" autocomplete="off" placeholder="仅在本地服务要求时填写"></label><p class="muted">请先启动本机服务。服务需兼容 Chat Completions 和工具调用，并允许当前页面跨域访问；地址仅接受带端口的 127.0.0.1。是否使用订阅额度由 Agent 的授权方式和服务商规则决定。</p></template><p class="muted">主动提问时，问题和所需的书籍片段会发送给所选服务。本地 Agent 可能继续发送给其上游服务。连接设置和密钥仅保留在本次页面会话，不写入备份。</p><h3>备份与恢复</h3><p class="muted">导出所有书籍的笔记、学习记录和阅读位置，不包含原始 EPUB。请另行保留书籍文件。</p><button @click="backup">导出个人记录</button><label class="button">恢复记录<input aria-label="恢复记录" type="file" accept=".json" @change="restore"></label><p class="muted">恢复会保留较新的记录，不删除本地数据；同一份备份可重复导入。</p></div></template>
        <template v-if="tab === '目录'"><h2>目录 <small>{{ outline.length }} 节</small></h2><input v-model="tocQuery" aria-label="筛选目录" placeholder="查找章节"><p v-if="!visibleOutline.length" class="muted">没有匹配的章节。</p><div class="toc-list"><button v-for="item in visibleOutline" :key="item.href + item.section + item.label" class="toc" :class="{current: item.href ? item.href === activeHref : item.section === position.section}" :aria-current="(item.href ? item.href === activeHref : item.section === position.section) ? 'location' : undefined" :style="{ paddingLeft: 12 + item.depth * 14 + 'px' }" @click="run(() => reader?.chapter(item.section, item.href))">{{ item.label }}</button></div></template>
        <template v-if="tab === '搜索'"><p class="eyebrow">BACK TO THE SOURCE</p><h2>在原文中寻找</h2><form @submit.prevent="lookup"><input v-model="query" aria-label="搜索原文" placeholder="词语、人物或一段话"><button class="primary" :disabled="!search || searching">{{ searching ? '搜索中…' : '搜索' }}</button></form><p class="muted">{{ indexProgress }} · 本地检索</p><p v-if="results.length && !searchComplete" class="muted">索引仍在建立，当前结果可能不完整。</p><p v-if="query && !results.length && !searching" class="muted">尚无结果，可调整关键词后再搜索。</p><article v-for="item in results" :key="item.id" class="card"><small>{{ item.chapter }}</small><p>{{ item.text }}</p><div class="actions"><button @click="readContext(item.locator)">上下文</button><button @click="navigate(item.locator)">回到原文</button></div></article><section v-if="preview.length" class="context"><h3>原文上下文</h3><article v-for="(item,i) in preview" :key="i"><p>{{ item.text }}</p><button @click="navigate(item.locator)">定位</button></article></section></template>
        <template v-if="tab === '笔记'"><p class="eyebrow">YOUR MARGINS</p><h2>阅读留下的痕迹</h2><button :disabled="!annotations.length" @click="exportNotes">导出 Markdown</button><p v-if="!annotations.length" class="muted">选中原文，留下高亮或笔记。</p><section v-for="[label,items] in groups" :key="label"><h3>{{ label }}</h3><article v-for="item in items" :key="item.id" class="card"><blockquote>{{ item.locator.quote }}</blockquote><p v-if="item.explanation">{{ item.explanation }}</p><p>{{ item.note }}</p><div class="actions"><button @click="editNote(item)">编辑</button><button @click="navigate(item.locator)">回到原文</button><button @click="removeRecord('annotations', item.id)">删除</button></div></article></section></template>
        <template v-if="tab === '学习'"><p class="eyebrow">ONE QUESTION AT A TIME</p><h2>只帮助需要的地方</h2><p class="muted">这里保留主动查询的词句。同一个词，不同的语境各自记录。</p><article v-for="item in learning" :key="item.id" class="card"><strong>{{ item.locator.quote }}</strong><p>{{ item.explanation }}</p><div class="actions"><button @click="navigate(item.locator)">回到原文</button><button @click="convert(item)">转存笔记</button><button @click="removeRecord('learning', item.id)">删除</button></div></article></template>
      </div>
    </aside>
    <main class="reading">
      <div class="reading-top"><button class="chapter-label" @click="showPanel('目录')">{{ chapter || title }}</button><span v-if="position.total">第 {{ position.section + 1 }} / {{ position.total }} 节</span></div>
      <div class="reader-wrap"><div ref="host" class="reader-host"></div><div v-if="loading" class="loading" role="status">正在打开书籍…</div></div>
      <div class="progress-track"><input :value="percentage" aria-label="全书阅读进度" type="range" min="0" max="100" step="0.1" :disabled="!reader || loading" @change="jumpProgress"></div>
      <footer class="reader-footer"><button class="icon-button" aria-label="上一页" :disabled="!reader || loading" @click="run(() => reader?.page(-1))"><UiIcon name="back"/></button><label class="font-control">Aa<input v-model.number="preferences.fontSize" aria-label="字号" type="range" min="14" max="32" @change="configure"><span class="setting-value">{{ preferences.fontSize }}</span></label><select v-model="preferences.flow" aria-label="阅读布局" :disabled="learningMode" @change="configure"><option value="paginated">分页</option><option value="scrolled">滚动</option></select><span class="status" role="status">{{ notice || indexProgress }}</span><span class="reading-percentage">{{ percentage }}%</span><button class="icon-button" aria-label="下一页" :disabled="!reader || loading" @click="run(() => reader?.page(1))"><UiIcon name="next"/></button></footer>
    </main>
    <aside v-if="rightOpen && !library" class="right-panel" aria-label="查询面板">
      <nav class="tabs"><button :class="{active: rightTab === 'dictionary'}" @click="rightTab = 'dictionary'">词典</button><button :class="{active: rightTab === 'ai'}" @click="rightTab = 'ai'">AI 对话</button><button :class="{active: rightTab === 'note'}" @click="rightTab = 'note'">笔记</button><button class="close-side" aria-label="关闭查询面板" @click="rightOpen = false">×</button></nav>
      <div class="side-body"><blockquote v-if="selected" class="selected-quote">{{ selected.quote }}</blockquote>
        <template v-if="rightTab === 'dictionary'"><h2>词典查词</h2><p class="muted">{{ dictionary.provider === 'free' ? 'Free Dictionary · 英语释义' : dictionary.provider === 'wiktionary' ? 'Wiktionary · 英语版多语言词条' : '翻译服务' }} · <button @click="sidebar = true; tab = '设置'">更改服务</button></p><button class="primary" :disabled="!selected || dictionaryBusy" @click="queryDictionary">{{ dictionaryBusy ? '查询中…' : '查询选中文字' }}</button><p v-if="dictionaryError" role="alert" class="muted">{{ dictionaryError }}</p><p v-if="dictionary.provider === 'free'" class="muted">来源：<a href="https://dictionaryapi.dev/" target="_blank" rel="noopener noreferrer">Free Dictionary API</a></p><p v-if="dictionary.provider === 'wiktionary'" class="muted">来源：<a :href="'https://en.wiktionary.org/wiki/' + encodeURIComponent(selected?.quote || '')" target="_blank" rel="noopener noreferrer">Wiktionary</a>（内容遵循其许可）</p><textarea v-model="explanation" aria-label="词句解释" placeholder="也可以手动记录释义"></textarea><button :disabled="!selected || saving || !explanation.trim()" @click="addExplanation">保存解释</button><button @click="rightTab = 'ai'">询问 AI</button></template>
        <template v-if="rightTab === 'ai'"><AssistantPanel v-if="reader && search" :key="bookId" :content="reader.content" :search="search" :settings="activeSettings" :selection="selected?.quote || ''" @navigate="navigate" @error="report"/></template>
        <template v-if="rightTab === 'note'"><h2>个人笔记</h2><textarea v-model="note" aria-label="个人笔记" placeholder="记下你的想法"></textarea><button :disabled="!selected || saving" @click="addNote">保存批注</button></template>
      </div>
    </aside>
  </div>
  <button v-if="focusMode && !library" class="exit-focus" @click="leaveFocus"><UiIcon name="close"/>退出专注 <kbd>Esc</kbd></button>
  <div v-if="loading && library" class="loading library-loading" role="status">正在打开书籍…</div>
  </div>
</template>

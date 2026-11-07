<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { loadSources, onlineFile, onlineRequest, parseCatalog, type Catalog, type BookSource } from '../adapters/online-books'
const emit = defineEmits<{ close: []; open: [file: File] }>()
const dialog = ref<HTMLDialogElement>(), mode = ref<'epub' | 'catalog'>('epub'), address = ref(''), sourceName = ref(''), filter = ref('')
const sources = ref<BookSource[]>(loadSources()), catalog = ref<Catalog | null>(null), current = ref(''), trail = ref<string[]>([])
const busy = ref(false), error = ref(''), status = ref('')
const books = computed(() => catalog.value?.books.filter(book => `${book.title} ${book.author}`.toLowerCase().includes(filter.value.trim().toLowerCase())) || [])
let request: AbortController | null = null
watch(sources, value => localStorage.setItem('reader-book-sources', JSON.stringify(value)), { deep: true })
function validate(value: string) {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('请输入完整的 HTTPS 地址。') }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('请使用不含登录信息的 HTTPS 地址。')
  return url.href
}
function saveSource() {
  try { const url = validate(address.value); const name = sourceName.value.trim() || new URL(url).hostname; if (sources.value.length >= 50) throw new Error('最多保存 50 个书源。'); if (!sources.value.some(item => item.url === url)) sources.value.push({ name: name.slice(0, 199), url }); error.value = '' }
  catch (e) { error.value = e instanceof Error ? e.message : String(e) }
}
async function browse(value: string, back = false) {
  if (busy.value) return
  const controller = new AbortController(); request = controller; busy.value = true; error.value = ''; status.value = '正在读取书源目录…'
  try {
    const url = validate(value), response = await onlineRequest(url, 'catalog', controller.signal)
    const result = parseCatalog(await response.text(), response.headers.get('X-Book-URL') || url)
    if (!controller.signal.aborted) { if (!back && current.value) trail.value.push(current.value); catalog.value = result; current.value = url; filter.value = '' }
  } catch (e) { if (!controller.signal.aborted) error.value = e instanceof Error ? e.message : String(e) }
  finally { if (request === controller) { busy.value = false; request = null; status.value = '' } }
}
async function back() { const previous = trail.value.at(-1); if (!previous) return; await browse(previous, true); if (!error.value) trail.value.pop() }
async function acquire(value: string) {
  if (busy.value) return
  const controller = new AbortController(); request = controller; busy.value = true; error.value = ''; status.value = '正在下载 EPUB…'
  try { const file = await onlineFile(validate(value), controller.signal); if (!controller.signal.aborted) emit('open', file) }
  catch (e) { if (!controller.signal.aborted) error.value = e instanceof Error ? e.message : String(e) }
  finally { if (request === controller) { busy.value = false; request = null; status.value = '' } }
}
onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => request?.abort())
</script>
<template>
  <dialog ref="dialog" class="online-dialog" aria-label="在线书源" @close="emit('close')" @click="($event.target === dialog) && dialog?.close()">
    <div class="online-shell"><header class="online-header"><div><p class="eyebrow">BEYOND YOUR SHELF</p><h2>在线书源</h2></div><button aria-label="关闭在线书源" @click="dialog?.close()">×</button></header>
      <nav class="online-tabs"><button :class="{ active: mode === 'epub' }" @click="mode = 'epub'">EPUB 链接</button><button :class="{ active: mode === 'catalog' }" @click="mode = 'catalog'">OPDS 目录</button></nav>
      <div class="online-body">
        <form class="source-form" @submit.prevent="mode === 'epub' ? acquire(address) : browse(address)"><label>{{ mode === 'epub' ? 'EPUB 直接下载地址' : 'OPDS 书源地址' }}<input v-model="address" type="url" aria-label="在线书源地址" required placeholder="https://…" :disabled="busy"></label><div v-if="mode === 'catalog'" class="source-save"><input v-model="sourceName" aria-label="书源名称" placeholder="书源名称（可选）" maxlength="199"><button type="button" :disabled="busy || !address.trim()" @click="saveSource">保存书源</button></div><button class="primary" :disabled="busy || !address.trim()">{{ mode === 'epub' ? '下载并阅读' : '浏览书源' }}</button></form>
        <p class="muted">支持无 DRM 的 EPUB 文件及 OPDS 1 / 2 目录。下载的书籍会加入本地书库，之后可离线阅读。需要登录、购买或借阅的书源暂不支持。</p>
        <div v-if="busy" class="online-status" role="status">{{ status }}<button @click="request?.abort(); busy = false; status = ''">取消下载或加载</button></div><p v-if="error" class="online-error" role="alert">{{ error }}</p>
        <section v-if="mode === 'catalog' && sources.length" class="saved-sources" aria-label="已保存书源"><h3>已保存书源</h3><div v-for="source in sources" :key="source.url"><button :disabled="busy" @click="address = source.url; browse(source.url)">{{ source.name }}</button><button :aria-label="`移除书源 ${source.name}`" :disabled="busy" @click="sources = sources.filter(item => item.url !== source.url)">×</button></div></section>
        <section v-if="mode === 'catalog' && catalog" class="catalog-results"><div class="catalog-heading"><h3>{{ catalog.title }}</h3><button v-if="trail.length" :disabled="busy" @click="back">返回上级</button></div><input v-model="filter" aria-label="筛选当前书源目录" placeholder="筛选当前目录的书名或作者"><div class="catalog-navigation"><button v-for="link in catalog.navigation" :key="link.url + link.title" :disabled="busy" @click="browse(link.url)">{{ link.title }} ↗</button></div><article v-for="book in books" :key="book.url" class="online-book"><div><strong>{{ book.title }}</strong><p class="muted">{{ book.author || '作者未提供' }}</p></div><button :disabled="busy" @click="acquire(book.url)">加入书库</button></article><p v-if="!books.length && !catalog.navigation.length" class="muted">当前目录没有可直接下载的 EPUB。</p><button v-if="catalog.next" :disabled="busy" @click="browse(catalog.next!)">下一页</button></section>
      </div>
    </div>
  </dialog>
</template>
<style scoped>
.online-dialog { padding:0; border:1px solid var(--line); border-radius:16px; width:min(680px,94vw); max-height:88dvh; background:var(--bg); color:var(--text); box-shadow:0 24px 90px #0003; }
.online-dialog::backdrop { background:#18203066; backdrop-filter:blur(3px); }
.online-shell { display:flex; flex-direction:column; max-height:85dvh; }
.online-header { display:flex; justify-content:space-between; align-items:flex-start; padding:28px 30px 12px; }
.online-header h2 { margin:0; font-size:24px; }
.online-header .eyebrow { margin-bottom:9px; }
.online-header button { border:0; background:transparent; font-size:20px; padding:0 5px; }
.online-tabs { display:flex; gap:8px; padding:0 30px 18px; border-bottom:1px solid var(--line); }
.online-tabs button { border:0; background:var(--surface); }
.online-tabs .active { color:var(--accent); background:var(--hover); }
.online-body { padding:24px 30px 30px; overflow:auto; }
.source-form { display:grid; gap:12px; }
.source-form label { display:grid; gap:9px; font-size:13px; }
.source-form > button { justify-self:start; }
.source-save { display:flex; gap:8px; }
.source-save input { min-width:0; }
.online-status { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 0; font-size:13px; }
.online-error { color:#b65949; font-size:13px; line-height:1.7; }
.saved-sources > div { display:inline-flex; gap:3px; margin:0 6px 8px 0; }
.saved-sources button { padding:6px 9px; }
.catalog-results { margin-top:24px; border-top:1px solid var(--line); }
.catalog-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.catalog-heading h3 { margin:20px 0; }
.catalog-navigation { display:flex; flex-wrap:wrap; gap:8px; margin:16px 0; }
.online-book { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:15px 0; border-bottom:1px solid var(--line); font-size:14px; }
.online-book div { min-width:0; overflow-wrap:anywhere; }
.online-book p { margin:4px 0 0; }
.online-book button { flex-shrink:0; font-size:12px; }
</style>

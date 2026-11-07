<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { cacheAction, type CacheStatus } from '../adapters/cache'
import { clearSearchCache } from '../core/search-cache'
const emit = defineEmits<{ export: []; notice: [message: string] }>()
const state = ref<CacheStatus | null>(null), directory = ref(''), busy = ref(false), error = ref('')
const size = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
async function act(action: 'status' | 'directory' | 'clear') {
  busy.value = true; error.value = ''
  try {
    state.value = await cacheAction(action, action === 'directory' ? { directory: directory.value.trim() } : {})
    if (action === 'directory') { directory.value = ''; emit('notice', '缓存目录已更新，已有缓存已迁移') }
    if (action === 'clear') { await clearSearchCache(); emit('notice', '书籍与检索缓存已清除，书库、笔记和阅读进度已保留') }
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { busy.value = false }
}
onMounted(() => act('status'))
</script>
<template>
  <section class="storage-settings" aria-label="缓存与笔记">
    <h3>缓存与笔记</h3><p class="muted">清理书籍副本和检索索引，或迁移书籍缓存位置。书库、笔记和阅读进度保留在当前浏览器中。</p>
    <template v-if="state"><p class="cache-path" aria-label="当前缓存目录">{{ state.directory }}</p><p class="muted" role="status">{{ state.files }} 个缓存文件 · {{ size(state.bytes) }}</p></template>
    <label>新的缓存位置<input v-model="directory" aria-label="缓存文件目录" placeholder="例如 D:\ReaderCache" :disabled="busy"></label><p class="muted">将在此位置创建 ExpatReader-cache 子文件夹，并迁移已有缓存。</p>
    <div class="storage-actions"><button :disabled="busy || !directory.trim()" @click="act('directory')">应用缓存目录</button><button :disabled="busy || !state" @click="act('clear')">清除缓存</button><button @click="emit('export')">导出笔记</button><button v-if="error" :disabled="busy" @click="act('status')">重新连接缓存服务</button></div>
    <p v-if="busy" class="muted" role="status">正在处理缓存…</p><p v-if="error" class="muted" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.storage-settings { margin-top:28px; padding-top:4px; border-top:1px solid var(--line); }
.cache-path { overflow-wrap:anywhere; padding:10px 12px; background:var(--surface); border:1px solid var(--line); border-radius:6px; font-size:12px; line-height:1.7; }
.storage-actions { display:flex; flex-wrap:wrap; gap:8px; }
.storage-actions button { font-size:12px; }
</style>

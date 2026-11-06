<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { BookRecord } from '../core/types'
import UiIcon from './UiIcon.vue'
const props = defineProps<{ books: BookRecord[]; currentId: string; busy: boolean }>()
defineEmits<{ open: [book: BookRecord]; import: [event: Event] }>()
const query = ref(''), sort = ref('recent')
const covers = ref<Record<string, string>>({})
watch(() => props.books, books => {
  Object.values(covers.value).forEach(URL.revokeObjectURL)
  covers.value = Object.fromEntries(books.filter(x => x.cover).map(x => [x.id, URL.createObjectURL(x.cover!)]))
}, { immediate: true })
onBeforeUnmount(() => Object.values(covers.value).forEach(URL.revokeObjectURL))
const filtered = computed(() => {
  const text = query.value.trim().toLocaleLowerCase()
  const result = props.books.filter(x => `${x.title} ${x.author ?? ''} ${x.filename}`.toLocaleLowerCase().includes(text))
  return sort.value === 'title' ? result.slice().sort((a, b) => a.title.localeCompare(b.title, 'zh-CN')) : result
})
</script>
<template>
  <main class="library">
    <div class="library-heading"><div><p class="eyebrow">YOUR LIBRARY</p><h1>我的书库<span>{{ books.length }} 本书</span></h1></div><label class="button primary import-large"><UiIcon name="plus" />导入 EPUB<input aria-label="导入 EPUB" type="file" accept=".epub" :disabled="busy" @change="$emit('import', $event)"></label></div>
    <div class="library-tools"><div class="library-search"><UiIcon name="search"/><input v-model="query" aria-label="搜索书库" placeholder="搜索书名或作者"></div><select v-model="sort" aria-label="书库排序"><option value="recent">最近阅读</option><option value="title">书名排序</option></select></div>
    <section v-if="books.length" class="book-grid" aria-label="书库">
      <button v-for="(item, index) in filtered" :key="item.id" class="book-card" :disabled="busy" @click="$emit('open', item)">
        <div class="book-cover" :class="`cover-${index % 4}`"><img v-if="covers[item.id]" :src="covers[item.id]" alt=""><div v-else class="cover-fallback"><span>隅读 / EPUB</span><strong>{{ item.title }}</strong><span>{{ item.author || '一本书，一段时光' }}</span></div><span v-if="item.id === currentId" class="reading-badge">正在阅读</span></div>
        <strong class="shelf-title">{{ item.title }}</strong><span class="shelf-author">{{ item.author || item.filename }}</span><span class="shelf-action">{{ item.id === currentId ? '继续阅读' : '打开书籍' }} <span>↗</span></span>
      </button>
      <p v-if="!filtered.length" class="muted">没有找到匹配的书籍。</p>
    </section>
    <section v-else class="library-empty"><UiIcon name="book"/><h2>从一本书开始。</h2><p>导入 EPUB，留一段安静阅读的时间。<br>书籍和阅读位置会保存在这个浏览器里。</p><label class="button">打开第一本书<input aria-label="打开第一本书" type="file" accept=".epub" :disabled="busy" @change="$emit('import', $event)"></label></section>
    <p class="library-footnote">本机书库 · 自动保存阅读位置</p>
  </main>
</template>

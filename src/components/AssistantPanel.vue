<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { ContentService } from '../core/content'
import type { BookSearch } from '../core/assistant'
import type { Answer, Locator, ModelSettings } from '../core/types'
import { askBook } from '../core/assistant'
import { modelClient } from '../adapters/model'

const props = defineProps<{ content: ContentService; search: BookSearch; settings: ModelSettings; selection?: string }>()
const emit = defineEmits<{ navigate: [locator: Locator]; error: [error: unknown] }>()
const history = ref<{ question: string; answer: string }[]>([])
const question = ref(''), status = ref(''), busy = ref(false), answer = ref<Answer | null>(null)
let request: AbortController | null = null
async function ask() {
  if (!question.value.trim() || busy.value) return
  const current = new AbortController(); request = current
  busy.value = true; answer.value = null
  try {
    const result = await askBook(modelClient({ ...props.settings }), props.content, props.search, `${props.selection ? `选中的原文：${props.selection}\n` : ''}${history.value.slice(-4).map(x => `读者：${x.question}\n助手：${x.answer}`).join('\n')}\n读者：${question.value}`.slice(-12000), current.signal, text => { status.value = text })
    if (!current.signal.aborted) { answer.value = result; history.value.push({ question: question.value, answer: result.text }); question.value = '' }
  } catch (e) { if (!current.signal.aborted) emit('error', e) }
  finally { if (request === current) { busy.value = false; status.value = current.signal.aborted ? '已取消' : ''; request = null } }
}
watch(() => props.content, () => { request?.abort(); answer.value = null })
onBeforeUnmount(() => request?.abort())
</script>
<template>
  <p class="eyebrow">ASK, THEN GO BACK</p><h2>与书对话</h2>
  <p class="muted">助手按需检索与补读原文。只有点击引用，才会改变阅读位置。</p>
  <form class="ask-form" @submit.prevent="ask"><textarea v-model="question" aria-label="向书籍提问" placeholder="这段观点的依据是什么？"></textarea><button class="primary" :disabled="busy || !question.trim()">提问</button><button v-if="busy" type="button" @click="request?.abort()">取消</button></form>
  <p v-if="status" role="status" class="muted">{{ status }}</p>
  <div v-for="(message, index) in history.slice(0, -1)" :key="index" class="card"><strong>{{ message.question }}</strong><p>{{ message.answer }}</p></div><article v-if="answer" class="answer"><p>{{ answer.text }}</p><p class="muted">查阅 {{ answer.calls }} 次 · 原文 {{ answer.characters }} 字符{{ answer.limited ? ' · 已达读取上限' : '' }}</p><p v-if="!answer.citations.length" class="muted">本次回答未提供有效原文引用。</p><details v-for="citation in answer.citations" :key="citation.id" class="card"><summary>[{{ citation.id }}] {{ citation.chapter }}</summary><blockquote>{{ citation.text }}</blockquote><button @click="emit('navigate', citation.locator)">回到原文</button></details></article>
</template>

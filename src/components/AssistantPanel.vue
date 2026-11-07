<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ContentService } from '../core/content'
import type { BookSearch } from '../core/assistant'
import type { Answer, Locator, ModelSettings } from '../core/types'
import type { AgentChoice, AgentMessage, AgentSession } from '../core/agent'
import { validateChoice } from '../core/agent'
import { askBook } from '../core/assistant'
import { listModels, modelClient } from '../adapters/model'
import { agentHistory, askAgentBook, deleteAgentSession, listAgentSessions, latestAgentSession, newAgentSession } from '../core/agent-reading'
import { codexStatus, codexChoice, codexModel, codexReady, codexNotice, changeCodexModel } from '../core/agent-state'
import RichText from './RichText.vue'

const props = defineProps<{ content: ContentService; search: BookSearch; settings: ModelSettings; selection?: string; active?: boolean }>()
const emit = defineEmits<{ navigate: [locator: Locator]; error: [error: unknown]; model: [model: string] }>()
const history = ref<{ question: string; answer: Answer; choice?: AgentChoice }[]>([])
const question = ref(''), status = ref(''), draft = ref(''), busy = ref(false), restoring = ref(false)
const session = ref<AgentSession | null>(null)
const sessions = ref<AgentSession[]>([])
const messages = ref<HTMLElement>(), followLatest = ref(true), pendingQuestion = ref(''), useSelection = ref(true)
const availableModels = ref<string[]>([]), modelLoading = ref(false)
const chatModel = computed({ get: () => props.settings.model, set: value => emit('model', value) })
const modelOptions = computed(() => [...new Set([props.settings.model, ...availableModels.value].filter(Boolean))])
let modelRequest: AbortController | null = null
async function loadModels() {
  modelRequest?.abort(); availableModels.value = []; modelLoading.value = false
  if (!props.active || props.settings.mode === 'codex' || !props.settings.endpoint.trim()) return
  const current = new AbortController(); modelRequest = current; modelLoading.value = true
  try { const names = await listModels({ ...props.settings }, current.signal); if (!current.signal.aborted) availableModels.value = names }
  catch { /* Compatible services may not offer /models; allow entering the model ID. */ }
  finally { if (modelRequest === current) { modelLoading.value = false; modelRequest = null } }
}
function trackScroll() { const el = messages.value; if (el) followLatest.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }
async function scrollToLatest() { await nextTick(); if (messages.value && followLatest.value) messages.value.scrollTop = messages.value.scrollHeight }
let request: AbortController | null = null, loadVersion = 0
function display(messages: AgentMessage[]) { history.value = messages.map(m => ({ question: m.question, answer: m.answer, choice: m.choice })) }
async function restore() {
  const version = ++loadVersion
  request?.abort(); history.value = []; draft.value = ''; session.value = null; sessions.value = []; restoring.value = false
  if (props.settings.mode !== 'codex' || !codexStatus.value?.identity) return
  const identity = codexStatus.value.identity, bookId = props.content.bookId
  restoring.value = true
  try {
    const all = await listAgentSessions(bookId, identity), found = all[0]
    const messages = found ? await agentHistory(found.id) : []
    if (version !== loadVersion) return
    sessions.value = all; session.value = found || null; display(messages)
    if (found) {
      try { validateChoice(codexStatus.value?.models || [], found.choice); codexChoice.value = { ...found.choice } }
      catch { codexNotice.value = '历史对话的模型或推理强度已不可用，请重新选择。' }
    }
  } catch (e) { if (version === loadVersion) emit('error', e) }
  finally { if (version === loadVersion) restoring.value = false }
}
async function fresh(remove = false) {
  if (busy.value || restoring.value || !codexStatus.value?.identity) return
  restoring.value = true
  try {
    if (remove && session.value) await deleteAgentSession(session.value.id)
    session.value = await newAgentSession(props.content.bookId, codexStatus.value.identity, { ...codexChoice.value })
    sessions.value = await listAgentSessions(props.content.bookId, codexStatus.value.identity)
    history.value = []; draft.value = ''; question.value = ''
  } catch (e) { emit('error', e) } finally { restoring.value = false }
}
async function chooseSession(id: string) {
  if (busy.value || restoring.value) return
  const found = sessions.value.find(item => item.id === id)
  if (!found) return
  restoring.value = true
  try {
    const messages = await agentHistory(id)
    session.value = found; display(messages); draft.value = ''; question.value = ''
    try { validateChoice(codexStatus.value?.models || [], found.choice); codexChoice.value = { ...found.choice } }
    catch { codexNotice.value = '此对话的模型或推理强度已不可用，请重新选择。' }
  } catch (e) { emit('error', e) } finally { restoring.value = false }
}
async function ask() {
  if (!question.value.trim() || busy.value || restoring.value) return
  const current = new AbortController(); request = current
  const submitted = question.value.trim(), choice = { ...codexChoice.value }, selection = useSelection.value ? props.selection || '' : ''
  busy.value = true; question.value = ''; pendingQuestion.value = submitted; draft.value = ''; status.value = '正在连接助手…'; followLatest.value = true
  try {
    if (props.settings.mode === 'codex') {
      if (!codexReady.value || !codexStatus.value) throw new Error('请先连接本机 Codex，并选择可用模型及推理强度。')
      const activeSession = session.value || await newAgentSession(props.content.bookId, codexStatus.value.identity, choice)
      session.value = activeSession
      await askAgentBook({ content: props.content, search: props.search, session: { ...activeSession }, choice, question: submitted, selection, signal: current.signal, update: (text, partial) => { if (!current.signal.aborted) { status.value = text; if (partial !== undefined) draft.value = partial } } })
      if (!current.signal.aborted) { display(await agentHistory(activeSession.id)); session.value = await latestAgentSession(activeSession.bookId, activeSession.identity) || activeSession; sessions.value = await listAgentSessions(activeSession.bookId, activeSession.identity) }
    } else {
      const result = await askBook(modelClient({ ...props.settings }), props.content, props.search, `${selection ? `选中的原文：${selection}\n` : ''}${history.value.slice(-4).map(x => `读者：${x.question}\n助手：${x.answer.text}`).join('\n')}\n读者：${submitted}`.slice(-12000), current.signal, text => { status.value = text })
      if (!current.signal.aborted) history.value.push({ question: submitted, answer: result })
    }
  } catch (e) { if (!question.value) question.value = submitted; if (!current.signal.aborted) emit('error', e) }
  finally { if (request === current) { if (current.signal.aborted && !question.value) question.value = submitted; busy.value = false; pendingQuestion.value = ''; draft.value = ''; status.value = current.signal.aborted ? '已取消本次请求；未保存不完整回答。' : ''; request = null } }
}
watch([() => props.content, () => props.settings.mode, () => codexStatus.value?.identity], restore, { immediate: true })
watch([() => props.active, () => props.settings.endpoint, () => props.settings.apiKey, () => props.settings.mode], loadModels, { immediate: true })
watch(() => props.selection, () => { useSelection.value = true })
watch([() => history.value.length, draft, pendingQuestion, () => props.active, restoring], scrollToLatest, { flush: 'post' })
onBeforeUnmount(() => { loadVersion++; request?.abort(); modelRequest?.abort() })
</script>
<template>
  <section class="chat-panel" aria-label="书籍 AI 对话">
    <header class="chat-header">
      <div><h2>与书对话</h2><p class="muted">让问题在这里展开，随时回到原文。</p></div>
      <div v-if="settings.mode === 'codex'" class="chat-session-actions"><button type="button" :disabled="busy || restoring || !codexReady" @click="fresh()">新建对话</button><button v-if="history.length" type="button" aria-label="删除当前对话记录" :disabled="busy || restoring" @click="fresh(true)">删除</button></div>
      <button v-else-if="history.length" type="button" :disabled="busy" @click="history = []; question = ''; status = ''">新建对话</button>
    </header>
    <label v-if="settings.mode === 'codex' && sessions.length" class="conversation-picker"><select :value="session?.id || ''" aria-label="书籍对话" :disabled="busy || restoring" @change="chooseSession(($event.target as HTMLSelectElement).value)"><option v-for="item in sessions" :key="item.id" :value="item.id">{{ item.title }}</option></select></label>
    <div ref="messages" class="chat-messages" role="log" aria-label="对话消息" aria-live="polite" :aria-busy="busy || restoring" @scroll="trackScroll">
      <p v-if="restoring" role="status" class="muted">正在恢复这本书的对话…</p>
      <div v-else-if="!history.length && !busy" class="chat-empty"><span class="chat-empty-symbol">✦</span><h3>从一个问题开始</h3><p>讨论这段文字，梳理章节观点，<br>或循着引用找到答案。</p></div>
      <article v-for="(message, index) in history" :key="index" class="answer chat-turn">
        <div class="chat-user"><span class="message-author">你</span><p>{{ message.question }}</p></div>
        <div class="chat-assistant"><span class="message-author">AI <small v-if="message.choice">· {{ message.choice.model }} · {{ message.choice.effort || '默认' }}</small></span><RichText :text="message.answer.text"/>
          <details class="answer-sources"><summary>原文依据 · {{ message.answer.citations.length }} 处引用</summary><p class="muted">查阅 {{ message.answer.calls }} 次 · 原文 {{ message.answer.characters }} 字符{{ message.answer.limited ? ' · 已达读取上限' : '' }}</p><p v-if="message.answer.usage" class="muted">本轮输入 {{ message.answer.usage.inputTokens }} · 输出 {{ message.answer.usage.outputTokens }} tokens</p><p v-if="!message.answer.citations.length" class="muted">本次回答未提供有效原文引用。</p><details v-for="citation in message.answer.citations" :key="citation.id" class="card"><summary>[{{ citation.id }}] {{ citation.chapter }}</summary><blockquote>{{ citation.text }}</blockquote><button @click="emit('navigate', citation.locator)">回到原文</button></details></details>
        </div>
      </article>
      <div v-if="busy" class="chat-turn"><div class="chat-user"><span class="message-author">你</span><p>{{ pendingQuestion }}</p></div><div class="chat-assistant"><span class="message-author">AI</span><p role="status" class="muted">{{ status }}</p><RichText v-if="draft" :text="draft"/></div></div>
    </div>
    <form class="chat-composer" @submit.prevent="ask">
      <div v-if="selection && useSelection" class="chat-context"><span>引用原文 · {{ selection }}</span><button type="button" aria-label="移除提问引用" @click="useSelection = false">×</button></div>
      <textarea v-model="question" maxlength="12000" aria-label="向书籍提问" placeholder="向这本书提问…" @keydown.ctrl.enter.prevent="ask" @keydown.meta.enter.prevent="ask"></textarea>
      <div class="composer-toolbar">
        <div class="composer-models">
          <template v-if="settings.mode === 'codex'"><select :value="codexChoice.model" aria-label="对话模型" :disabled="!codexStatus?.models.length" @change="changeCodexModel(($event.target as HTMLSelectElement).value)"><option v-if="!codexModel" value="">选择模型</option><option v-for="model in codexStatus?.models || []" :key="model.id" :value="model.model">{{ model.displayName }}</option></select><select v-if="codexModel?.supportedReasoningEfforts.length" v-model="codexChoice.effort" aria-label="对话推理强度"><option v-for="effort in codexModel.supportedReasoningEfforts" :key="effort.reasoningEffort" :value="effort.reasoningEffort" :disabled="!!effort.disabledReason">{{ effort.reasoningEffort }}</option></select></template>
          <template v-else><input v-model="chatModel" list="chat-model-options" aria-label="对话模型" :placeholder="modelLoading ? '加载模型…' : '选择或输入模型'" autocomplete="off"><datalist id="chat-model-options"><option v-for="model in modelOptions" :key="model" :value="model"/></datalist></template>
        </div>
        <button v-if="busy" type="button" @click="request?.abort()">取消</button><button v-else class="primary" :disabled="restoring || !question.trim() || (settings.mode === 'codex' ? !codexReady : !settings.endpoint.trim() || !settings.model.trim())" title="Ctrl / ⌘ + Enter 发送">提问 <span aria-hidden="true">↑</span></button>
      </div>
    </form>
    <p v-if="status && !busy" role="status" class="chat-footnote">{{ status }}</p>
    <p v-if="settings.mode === 'codex' && !codexReady" class="chat-footnote">请先在左侧设置中完成 AI 连接。</p>
    <p v-else-if="settings.mode !== 'codex' && !settings.endpoint.trim()" class="chat-footnote">请先在左侧设置中连接模型服务。</p>
    <p v-else class="chat-footnote">回答仅供阅读参考 · 点击引用返回原文</p>
  </section>
</template>
<style scoped>
.chat-panel { flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.chat-header { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding:22px 22px 12px; flex-shrink:0; }
.chat-header h2 { margin:0 0 5px; font-size:17px; }
.chat-header p { margin:0; font-size:11px; }
.chat-header button { font-size:11px; padding:5px 8px; white-space:nowrap; }
.chat-session-actions { display:flex; gap:5px; }
.conversation-picker { padding:0 22px 10px; }
.conversation-picker select { width:100%; min-width:0; font-size:12px; }
.chat-messages { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; padding:12px 22px 20px; scrollbar-gutter:stable; }
.chat-empty { min-height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; color:var(--muted); }
.chat-empty-symbol { color:var(--accent); font-size:30px; }
.chat-empty h3 { color:var(--text); font-weight:500; margin:16px 0 8px; font-size:16px; }
.chat-empty p { font-size:12px; line-height:1.9; margin:0; }
.chat-turn { margin:0 0 26px; }
.message-author { display:block; font-size:11px; color:var(--muted); margin-bottom:7px; }
.message-author small { font-size:10px; }
.chat-user { margin:0 0 20px 30px; border-radius:12px 12px 3px 12px; padding:11px 14px; background:var(--surface); }
.chat-user p { margin:0; font-size:13px; line-height:1.8; white-space:pre-wrap; overflow-wrap:anywhere; }
.chat-assistant { padding:0 2px; }
.answer-sources { margin-top:14px; font-size:11px; color:var(--muted); }
.answer-sources summary { cursor:pointer; }
.answer-sources .card { color:var(--text); }
.chat-composer { display:flex; flex-direction:column; gap:0; margin:0 16px; padding:6px; flex-shrink:0; background:var(--bg); border:1px solid var(--line); border-radius:13px; box-shadow:0 3px 15px #00000005; }
.chat-composer:focus-within { border-color:var(--accent); }
.chat-composer textarea { border:0; border-radius:8px; min-height:82px; height:90px; max-height:25dvh; resize:vertical; font-size:13px; padding:10px; outline:none; }
.composer-toolbar { display:flex; align-items:center; justify-content:space-between; gap:6px; padding:4px; }
.composer-models { display:flex; flex-wrap:wrap; gap:4px; flex:1; min-width:0; }
.composer-models select, .composer-models input { min-width:0; max-width:100%; width:auto; border:0; background:var(--surface); border-radius:6px; font-size:11px; padding:6px; }
.composer-models select:first-child { max-width:175px; }
.composer-models input { width:100%; }
.composer-toolbar button { padding:7px 11px; font-size:12px; }
.chat-context { display:flex; align-items:center; gap:5px; margin:4px; padding:6px 8px; background:var(--surface); border-radius:6px; }
.chat-context span { flex:1; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:11px; color:var(--muted); }
.chat-context button { padding:0 3px; border:0; background:transparent; }
.chat-footnote { margin:9px 16px 12px; font-size:10px; line-height:1.6; text-align:center; color:var(--muted); }
</style>

import { computed, ref, watch } from 'vue'
import { agentClient, agentRunning } from '../adapters/agent'
import { selectEffort, validateChoice, type AgentChoice, type AgentStatus } from './agent'

function load(): { identity: string; choice: AgentChoice; binary: string } {
  try { const data = JSON.parse(localStorage.getItem('reader-codex-choice') || '{}'); return { identity: data.identity || '', choice: { model: data.choice?.model || '', effort: data.choice?.effort ?? null, mode: 'chat' }, binary: data.binary || '' } } catch { return { identity: '', choice: { model: '', effort: null, mode: 'chat' }, binary: '' } }
}
const saved = load()
export const codexStatus = ref<AgentStatus | null>(null)
export const codexChoice = ref<AgentChoice>(saved.choice)
export const codexBinary = ref(saved.binary)
export const codexBusy = ref(false), codexError = ref(''), codexNotice = ref(''), codexLoginUrl = ref('')
export const codexModel = computed(() => codexStatus.value?.models.find(x => x.model === codexChoice.value.model))
export const codexReady = computed(() => { try { if (codexStatus.value?.state !== 'ready') return false; validateChoice(codexStatus.value.models, codexChoice.value); return true } catch { return false } })
let lastIdentity = saved.identity
agentClient.onDisconnect = () => { codexStatus.value = null; codexError.value = '本机连接已断开，请刷新连接。' }
watch([codexChoice, codexBinary], () => localStorage.setItem('reader-codex-choice', JSON.stringify({ identity: lastIdentity, choice: codexChoice.value, binary: codexBinary.value })), { deep: true })
export async function connectCodex() {
  if (codexBusy.value || agentRunning.value) return
  codexBusy.value = true; codexError.value = ''; codexNotice.value = ''; codexLoginUrl.value = ''; codexStatus.value = null
  try {
    const status = await agentClient.connect(codexBinary.value.trim()); codexStatus.value = status
    if (status.state !== 'ready') return
    const old = codexChoice.value
    const existing = lastIdentity === status.identity ? status.models.find(x => x.model === old.model) : undefined
    if (!old.model || lastIdentity !== status.identity) {
      const model = status.models.find(x => x.isDefault) || status.models[0]!
      codexChoice.value = { model: model.model, effort: model.defaultReasoningEffort, mode: 'chat' }
    } else if (!existing) codexNotice.value = '之前选择的模型已不可用，请重新选择。'
    else {
      const effort = selectEffort(existing, old.effort)
      if (effort !== old.effort) codexNotice.value = '原推理强度已不可用，已改用当前模型默认值。'
      codexChoice.value = { ...old, effort }
    }
    lastIdentity = status.identity
    localStorage.setItem('reader-codex-choice', JSON.stringify({ identity: lastIdentity, choice: codexChoice.value, binary: codexBinary.value }))
  } catch (e) { codexError.value = e instanceof Error ? e.message : '无法连接 Codex。' }
  finally { codexBusy.value = false }
}
export function changeCodexModel(modelId: string) {
  const model = codexStatus.value?.models.find(x => x.model === modelId)
  if (!model) return
  const effort = selectEffort(model, codexChoice.value.effort)
  codexNotice.value = effort !== codexChoice.value.effort ? '已采用新模型支持的默认推理强度；修改作用于下一轮。' : '模型修改作用于下一轮。'
  codexChoice.value = { model: model.model, effort, mode: 'chat' }
}
export async function loginCodex() {
  codexError.value = ''
  try { const result = await agentClient.login(); codexLoginUrl.value = result.url } catch (e) { codexError.value = e instanceof Error ? e.message : '登录失败。' }
}

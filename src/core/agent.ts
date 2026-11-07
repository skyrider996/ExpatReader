import type { Answer } from './types'

export interface AgentModel {
  id: string
  model: string
  displayName: string
  description: string
  isDefault: boolean
  defaultReasoningEffort: string | null
  supportedReasoningEfforts: { reasoningEffort: string; description: string; disabledReason?: string }[]
}
export interface AgentStatus {
  state: 'ready' | 'login' | 'incompatible'
  identity: string
  version: string
  accountLabel: string
  models: AgentModel[]
  message: string
  rateLimits?: { usedPercent: number; resetsAt?: number }[]
}
export interface AgentChoice { model: string; effort: string | null; mode: 'chat' }
export interface AgentSession {
  id: string; bookId: string; identity: string; provider: 'codex'; title: string
  choice: AgentChoice; nextCitation: number; updatedAt: number
}
export interface AgentMessage {
  id: string; sessionId: string; question: string; answer: Answer; choice: AgentChoice; createdAt: number
}
export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; callId: string; name: string; args: unknown }
  | { type: 'done'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }

export function selectEffort(model: AgentModel, previous: string | null): string | null {
  if (model.supportedReasoningEfforts.some(x => x.reasoningEffort === previous && !x.disabledReason)) return previous
  return model.defaultReasoningEffort
}
export function validateChoice(models: AgentModel[], choice: AgentChoice): AgentModel {
  const model = models.find(x => x.model === choice.model)
  if (!model || choice.mode !== 'chat') throw new Error('请从当前账号的模型列表选择模型。')
  const efforts = model.supportedReasoningEfforts
  if (efforts.length ? !efforts.some(x => x.reasoningEffort === choice.effort && !x.disabledReason) : choice.effort !== null) throw new Error('所选模型不支持该推理强度，请重新选择。')
  return model
}

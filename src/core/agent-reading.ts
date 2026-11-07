import { agentClient } from '../adapters/agent'
import { BookToolSession, verifiedAnswer, type BookSearch } from './assistant'
import type { ContentService } from './content'
import type { AgentChoice, AgentMessage, AgentSession } from './agent'
import { db } from './storage'

export async function listAgentSessions(bookId: string, identity: string): Promise<AgentSession[]> {
  const sessions = await db.agentSessions.where('[bookId+identity]').equals([bookId, identity]).toArray()
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}
export async function latestAgentSession(bookId: string, identity: string): Promise<AgentSession | undefined> { return (await listAgentSessions(bookId, identity))[0] }
export async function newAgentSession(bookId: string, identity: string, choice: AgentChoice): Promise<AgentSession> {
  const session: AgentSession = { id: crypto.randomUUID(), bookId, identity, provider: 'codex', title: '新对话', choice: { ...choice }, nextCitation: 1, updatedAt: Date.now() }
  await db.agentSessions.put(session)
  return session
}
export async function agentHistory(sessionId: string) { return (await db.agentMessages.where('sessionId').equals(sessionId).toArray()).sort((a, b) => a.createdAt - b.createdAt) }
export async function deleteAgentSession(sessionId: string) {
  await db.transaction('rw', db.agentSessions, db.agentMessages, async () => { await db.agentMessages.where('sessionId').equals(sessionId).delete(); await db.agentSessions.delete(sessionId) })
}
export async function askAgentBook(options: {
  content: ContentService; search: BookSearch; session: AgentSession; choice: AgentChoice; question: string; selection: string; signal: AbortSignal
  update: (status: string, draft?: string) => void
}) {
  const { session, choice, signal, update } = options
  const stored = await db.agentSessions.get(session.id)
  if (!stored || stored.bookId !== session.bookId || stored.identity !== session.identity) throw new Error('阅读对话已改变，请重新打开或新建对话。')
  session.nextCitation = Math.max(session.nextCitation, stored.nextCitation)
  signal.throwIfAborted()
  const tools = new BookToolSession(options.content, options.search, session.nextCitation - 1)
  const selection = tools.addContext(options.selection)
  let usage: { inputTokens: number; outputTokens: number } | undefined
  const text = await agentClient.run({ sessionId: session.id, bookId: session.bookId, identity: session.identity, choice,
    prompt: JSON.stringify({ question: options.question, untrustedSelection: selection, selectionTruncated: selection.length < options.selection.length, citationStart: session.nextCitation, remainingNewTextCharacters: 30000 - tools.characters }),
  }, signal, event => {
    if (event.type === 'delta') update('正在回答…', event.text)
    if (event.type === 'tool') update(`正在查阅：${event.name}（${Math.min(tools.calls + 1, 8)}/8）`)
    if (event.type === 'usage') usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens }
  }, async (name, args) => {
    signal.throwIfAborted()
    const result = await tools.execute(name, args)
    // Reserve identifiers even if the request is cancelled after this read.
    session.nextCitation = Math.max(session.nextCitation, ...tools.citations.map(c => Number(c.id.slice(1)) + 1))
    await db.agentSessions.update(session.id, { nextCitation: session.nextCitation })
    signal.throwIfAborted()
    return result
  })
  signal.throwIfAborted()
  const answer = verifiedAnswer(text, tools)
  if (usage) answer.usage = usage
  const message: AgentMessage = { id: crypto.randomUUID(), sessionId: session.id, question: options.question, choice: { ...choice }, answer, createdAt: Date.now() }
  await db.transaction('rw', db.agentSessions, db.agentMessages, async () => {
    signal.throwIfAborted()
    await db.agentMessages.put(message)
    signal.throwIfAborted()
    await db.agentSessions.update(session.id, { title: options.question.slice(0, 80), choice: { ...choice }, nextCitation: session.nextCitation, updatedAt: Date.now() })
    signal.throwIfAborted()
  })
  return message
}
export async function explainWithAgent(bookId: string, identity: string, choice: AgentChoice, quote: string, context: string, signal: AbortSignal) {
  const text = await agentClient.run({ sessionId: crypto.randomUUID(), bookId, identity, choice, temporary: true,
    prompt: JSON.stringify({ instruction: '仅解释选中词句在语境中的含义，用简洁中文，必要时加一句语法提示；不翻译整段。只返回解释。', selectedText: quote.slice(0, 10000), untrustedBookContext: context.slice(0, 6000) }),
  }, signal, () => {}, async () => { throw new Error('划词解释不允许调用工具。') })
  signal.throwIfAborted()
  if (!text.trim()) throw new Error('未获得完整解释，未保存。')
  return text.trim()
}

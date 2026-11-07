<script setup lang="ts">
import { codexStatus, codexChoice, codexModel, codexReady, codexBusy, codexError, codexNotice, codexBinary, codexLoginUrl, connectCodex, loginCodex, changeCodexModel } from '../core/agent-state'
import { agentRunning } from '../adapters/agent'
defineProps<{ compact?: boolean }>()
</script>
<template>
  <section class="agent-controls" aria-label="本机 Codex 连接">
    <p class="muted"><strong>Chat · 阅读对话</strong> · 解释、讨论与查阅原文</p>
    <label v-if="!compact">Codex 可执行文件路径（可选）<input v-model.trim="codexBinary" aria-label="Codex 可执行文件路径" placeholder="自动检测；或填写 codex.exe 的绝对路径"></label>
    <button type="button" :disabled="codexBusy || agentRunning" @click="connectCodex">{{ codexBusy ? '连接中…' : codexStatus ? '刷新连接与模型' : '连接本机 Codex' }}</button>
    <p v-if="codexStatus" role="status" class="muted">{{ codexStatus.accountLabel }}<span v-if="!compact"> · {{ codexStatus.version }}</span><template v-if="codexStatus.state !== 'ready'"><br>{{ codexStatus.message }}</template></p>
    <template v-if="codexStatus?.state === 'login'"><button type="button" @click="loginCodex">登录 Codex</button><a v-if="codexLoginUrl" :href="codexLoginUrl" target="_blank" rel="noopener noreferrer">打开官方登录页面</a><p class="muted">完成登录后点击“刷新连接与模型”。</p></template>
    <template v-if="codexStatus?.state === 'ready'">
      <label>模型<select :value="codexChoice.model" aria-label="Codex 模型" @change="changeCodexModel(($event.target as HTMLSelectElement).value)"><option v-if="!codexModel" value="">请选择模型</option><option v-for="model in codexStatus.models" :key="model.id" :value="model.model">{{ model.displayName }}</option></select></label>
      <label>推理强度（effort）<select v-if="codexModel?.supportedReasoningEfforts.length" v-model="codexChoice.effort" aria-label="Codex 推理强度"><option v-for="effort in codexModel.supportedReasoningEfforts" :key="effort.reasoningEffort" :value="effort.reasoningEffort" :disabled="!!effort.disabledReason">{{ effort.reasoningEffort }}{{ effort.disabledReason ? '（阅读 Chat 不支持）' : '' }}</option></select><span v-else>由模型决定</span></label>
      <p class="muted">{{ codexModel?.supportedReasoningEfforts.find(x => x.reasoningEffort === codexChoice.effort)?.description }}</p>
      <p v-if="codexReady" class="muted">设置作用于下一轮，生成中的回答保持原配置。</p>
      <p v-for="(limit, index) in codexStatus.rateLimits" :key="index" class="muted">订阅用量窗口 {{ index + 1 }}：已用 {{ limit.usedPercent }}%{{ limit.resetsAt ? ` · ${new Date(limit.resetsAt * 1000).toLocaleString()} 重置` : '' }}</p>
    </template>
    <p v-if="codexNotice" role="status" class="muted">{{ codexNotice }}</p>
    <p v-if="codexError" role="alert">{{ codexError }}</p>
    <p v-if="!compact" class="muted">使用 Codex 管理的 ChatGPT 订阅登录。主动提问时，问题及所需书籍片段会发送给模型服务。不会自动改用付费 API。</p>
  </section>
</template>
<style scoped>
.agent-controls { display:grid; gap:10px; margin-bottom:18px; }
.agent-controls label { display:grid; gap:6px; font-size:13px; }
.agent-controls select, .agent-controls input { width:100%; min-width:0; box-sizing:border-box; }
.agent-controls p { margin:0; }
.agent-controls button { justify-self:start; }
</style>

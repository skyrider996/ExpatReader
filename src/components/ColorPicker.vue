<script setup lang="ts">
import { computed } from 'vue'
import { rgbChannels, rgbHex } from '../core/preferences'
const props = defineProps<{ label: string; modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string]; change: [] }>()
const channels = computed(() => rgbChannels(props.modelValue))
function setColor(value: string) { emit('update:modelValue', value); emit('change') }
function setChannel(index: number, event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  const next = [...channels.value]; next[index] = value; setColor(rgbHex(next))
}
</script>
<template>
  <fieldset class="color-picker"><legend>{{ label }}</legend><div class="color-picker-row"><input type="color" :value="modelValue" :aria-label="`${label}取色器`" @input="setColor(($event.target as HTMLInputElement).value)"><span class="color-value">{{ modelValue.toUpperCase() }}</span></div><div class="rgb-fields"><label v-for="(channel, index) in ['R', 'G', 'B']" :key="channel">{{ channel }}<input type="number" min="0" max="255" :value="channels[index]" :aria-label="`${label} ${channel}`" @change="setChannel(index, $event)"></label></div></fieldset>
</template>
<style scoped>
.color-picker { border:1px solid var(--line); border-radius:9px; margin:14px 0; padding:12px; min-width:0; }
legend { font-size:12px; padding:0 5px; }
.color-picker-row { display:flex; align-items:center; gap:12px; }
input[type=color] { width:44px; height:32px; padding:2px; border:1px solid var(--line); border-radius:6px; background:var(--bg); cursor:pointer; }
.color-value { color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }
.rgb-fields { display:flex; gap:8px; margin-top:10px; }
.rgb-fields label { display:flex; align-items:center; gap:5px; font-size:11px; color:var(--muted); min-width:0; margin:0; }
.rgb-fields input { width:100%; min-width:0; border:1px solid var(--line); border-radius:5px; background:var(--bg); color:var(--text); padding:6px 2px 6px 5px; font-size:12px; margin:0; }
</style>

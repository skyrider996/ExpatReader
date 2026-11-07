<script lang="ts">
import { defineComponent, h, type VNodeChild } from 'vue'

// Build elements from text tokens. Provider/model HTML is always displayed as text.
function inline(text: string): VNodeChild[] {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g).filter(Boolean).map(part => {
    if (part.startsWith('**') && part.endsWith('**')) return h('strong', part.slice(2, -2))
    if (part.startsWith('`') && part.endsWith('`')) return h('code', part.slice(1, -1))
    if (part.startsWith('*') && part.endsWith('*')) return h('em', part.slice(1, -1))
    return part
  })
}

export default defineComponent({
  props: { text: { type: String, required: true } },
  setup(props) {
    return () => {
      const blocks: VNodeChild[] = []
      const lines = props.text.replace(/\r\n?/g, '\n').split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.trim()
        if (!line) continue
        if (line.startsWith('```')) {
          const code: string[] = []
          while (++i < lines.length && !lines[i]!.trim().startsWith('```')) code.push(lines[i]!)
          blocks.push(h('pre', h('code', code.join('\n')))); continue
        }
        const heading = /^(#{1,6})\s+(.+)$/.exec(line)
        if (heading) { blocks.push(h(`h${Math.min(heading[1]!.length + 1, 6)}`, inline(heading[2]!))); continue }
        const list = /^(?:[-*•]\s+|\d+[.)]\s+)/.exec(line)
        if (list) {
          const ordered = /^\d/.test(line), items: VNodeChild[] = []
          const pattern = ordered ? /^\d+[.)]\s+(.+)$/ : /^[-*•]\s+(.+)$/
          do { items.push(h('li', inline(lines[i]!.trim().replace(pattern, '$1')))); i++ }
          while (i < lines.length && pattern.test(lines[i]!.trim()))
          i--; blocks.push(h(ordered ? 'ol' : 'ul', items)); continue
        }
        if (/^(?:>\s*|例[句：:]|词源[：:])/.test(line)) { blocks.push(h('blockquote', inline(line.replace(/^>\s*/, '')))); continue }
        if (/^(noun|verb|adjective|adverb|pronoun|preposition|conjunction|interjection|determiner|article|数词|名词|动词|形容词|副词)$/i.test(line)) {
          blocks.push(h('h4', { class: 'part-of-speech' }, line)); continue
        }
        blocks.push(h('p', inline(line)))
      }
      return h('div', { class: 'rich-text' }, blocks)
    }
  },
})
</script>

<style scoped>
.rich-text { font-size:14px; line-height:1.85; overflow-wrap:anywhere; }
.rich-text :deep(> :first-child) { margin-top:0; }
.rich-text :deep(> :last-child) { margin-bottom:0; }
.rich-text :deep(p) { margin:10px 0; white-space:pre-wrap; }
.rich-text :deep(h2), .rich-text :deep(h3), .rich-text :deep(h4) { margin:20px 0 8px; line-height:1.5; }
.rich-text :deep(h2) { font-size:21px; }
.rich-text :deep(h3) { font-size:17px; }
.rich-text :deep(h4) { font-size:14px; }
.rich-text :deep(.part-of-speech) { color:var(--accent); font-size:12px; font-style:italic; font-weight:500; }
.rich-text :deep(ul), .rich-text :deep(ol) { padding-left:23px; margin:8px 0 16px; }
.rich-text :deep(li) { padding-left:3px; margin:6px 0; }
.rich-text :deep(blockquote) { border-left:2px solid var(--line); margin:10px 0 16px; padding:3px 0 3px 14px; color:var(--muted); font-size:13px; }
.rich-text :deep(code) { font-family:ui-monospace,monospace; background:var(--surface); border-radius:4px; padding:2px 4px; font-size:.9em; }
.rich-text :deep(pre) { overflow:auto; background:var(--surface); padding:12px; border-radius:7px; }
.rich-text :deep(pre code) { padding:0; }
</style>

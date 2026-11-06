<script setup lang="ts">
defineProps<{ name: string }>()
const paths: Record<string, string> = {
  book: 'M3 4h6a4 4 0 0 1 3 1.5A4 4 0 0 1 15 4h6v15h-6a4 4 0 0 0-3 1.5A4 4 0 0 0 9 19H3z M12 5.5v15',
  back: 'm14 6-6 6 6 6',
  next: 'm10 6 6 6-6 6',
  menu: 'M4 6h16M4 12h16M4 18h16',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  type: 'M4 19 10 4l6 15M6 14h8M17 11h5M19.5 11v8',
  focus: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
  plus: 'M12 5v14M5 12h14',
  close: 'm6 6 12 12M18 6 6 18',
  more: 'M4 12h1M11.5 12h1M19 12h1',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
}
</script>
<template><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.book" /></svg></template>

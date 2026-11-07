export const highlightPalette = [
  { id: 'tan', label: '浅褐色', value: '#bd8b57' },
  { id: 'magenta', label: '品红色', value: '#d653a5' },
  { id: 'green', label: '浅绿', value: '#79b870' },
  { id: 'blue', label: '浅蓝', value: '#76a9e1' },
] as const
export type HighlightColor = typeof highlightPalette[number]['id']
export const defaultHighlight = highlightPalette[0]
export function isHighlightColor(value: unknown): value is HighlightColor { return highlightPalette.some(color => color.id === value) }
export function highlightColor(value: unknown) { return highlightPalette.find(color => color.id === value) ?? defaultHighlight }

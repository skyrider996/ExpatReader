export type ReadingTheme = 'light' | 'paper' | 'dark'
export interface ReadingPreferences {
  fontSize: number
  lineHeight: number
  width: number
  font: 'publisher' | 'serif' | 'sans'
  theme: ReadingTheme
  columns: number
  flow: 'paginated' | 'scrolled'
}
export const defaultPreferences: ReadingPreferences = {
  fontSize: 20, lineHeight: 1.8, width: 760, font: 'publisher',
  theme: 'light', columns: 1, flow: 'paginated',
}
export const readingColors = {
  light: { background: '#ffffff', foreground: '#292b30' },
  paper: { background: '#f6f1e5', foreground: '#453e32' },
  dark: { background: '#202124', foreground: '#d9d9dc' },
}
export function loadPreferences(): ReadingPreferences {
  try {
    const value = JSON.parse(localStorage.getItem('reading-preferences') ?? '{}')
    const number = (key: keyof ReadingPreferences, min: number, max: number) =>
      typeof value[key] === 'number' && Number.isFinite(value[key]) ? Math.max(min, Math.min(max, value[key])) : defaultPreferences[key]
    return {
      fontSize: number('fontSize', 14, 32) as number,
      lineHeight: number('lineHeight', 1.3, 2.4) as number,
      width: number('width', 520, 1000) as number,
      font: ['publisher', 'serif', 'sans'].includes(value.font) ? value.font : 'publisher',
      theme: ['light', 'paper', 'dark'].includes(value.theme) ? value.theme : 'light',
      columns: value.columns === 2 ? 2 : 1,
      flow: value.flow === 'scrolled' ? 'scrolled' : 'paginated',
    }
  } catch { return { ...defaultPreferences } }
}

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { translationProxy } from './translation-proxy'
import { agentProxy } from './agent-proxy'
import { libraryProxy } from './library-proxy'

export default defineConfig({
  plugins: [translationProxy(), agentProxy(), libraryProxy(), vue({ template: { compilerOptions: { isCustomElement: tag => tag === 'foliate-view' } } })],
  server: { host: '127.0.0.1' },
  worker: { format: 'es' },
})

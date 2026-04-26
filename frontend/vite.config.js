import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: false,
        timeout: 0,          // no proxy timeout — SSE streams stay open for 90s+
        proxyTimeout: 0,     // no upstream timeout either
      }
    }
  }
})

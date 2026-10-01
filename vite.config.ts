import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { apiRoutes } from './scripts/vite-api-routes'

/** Set `DEV_HTTPS=1` (see `npm run dev:https`) for HTTPS so LAN URLs are a secure context (Web Crypto / private links). */
const useDevHttps = process.env.DEV_HTTPS === '1'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), apiRoutes(), ...(useDevHttps ? [basicSsl()] : [])],
  base: '/',
  server: {
    port: parseInt(process.env.PORT || '5173'),
    // Fail rather than silently moving to 5174: the port is part of the origin, and everything the
    // app remembers (API keys, open tabs, recent files, preferences) is stored per origin.
    strictPort: true,
    host: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    minify: 'esbuild',
  },
  // Expose environment variables to the client
  // Variables prefixed with VITE_ will be available via import.meta.env
  envPrefix: 'VITE_',
})


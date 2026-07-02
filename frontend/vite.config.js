import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        // This removes "/api" from the URL before sending it to the backend
        rewrite: (path) => path.replace(/^\/api/, '') 
      }
    },
    port:3000,
    allowedHosts:[
      "sudden-designing-almanac.ngrok-free.dev"
    ],
  }
})
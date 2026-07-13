import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages serves the project at /<repo>/ so base must match the repo name.
export default defineConfig({
  plugins: [react()],
  base: '/kr-market-leverage-dashboard/',
})

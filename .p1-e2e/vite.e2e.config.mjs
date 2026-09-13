// Build AISLADO para el E2E de navegador con backend Supabase SIMULADO.
//
// - envDir apunta a un directorio vacío: el .env del repo (PRODUCCIÓN) no se lee nunca.
//   Las únicas VITE_* que entran al bundle son las que scripts/verify-e2e-ui.mjs fuerza
//   en el entorno del proceso (origen falso http://supabase.e2e.invalid).
// - outDir dentro de .p1-e2e/: no toca dist/ del repo.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const aqui = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(aqui, '..')

export default defineConfig({
  root: repo,
  envDir: path.join(aqui, 'env-vacio'),
  plugins: [react(), tailwindcss()],
  logLevel: 'error',
  build: {
    outDir: path.join(aqui, 'dist'),
    emptyOutDir: true,
    reportCompressedSize: false,
  },
})

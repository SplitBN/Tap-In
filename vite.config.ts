import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Relative base so the app works under any path (GitHub Pages /tap-in/, Cloudflare Pages root, tunnels).
export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Tap In',
        short_name: 'Tap In',
        description: 'Gym, food and supplement log.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#0b0c0f',
        theme_color: '#0b0c0f',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        importScripts: ['push-sw.js'], // push + notification click handlers
        globPatterns: ['**/*.{js,css,html,svg,png,json,woff2}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        runtimeCaching: [
          {
            // barcode decoder wasm (zxing-wasm, loaded by barcode-detector) — keep scanning offline-capable
            urlPattern: /^https:\/\/(cdn|fastly)\.jsdelivr\.net\/npm\/zxing-wasm/,
            handler: 'CacheFirst',
            options: { cacheName: 'tapin-zxing', expiration: { maxEntries: 10 }, cacheableResponse: { statuses: [0, 200] } },
          },
          {
            // Exercise images from free-exercise-db (jsDelivr) — cache once seen, works offline after.
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/gh\/yuhonas\/free-exercise-db/,
            handler: 'CacheFirst',
            options: { cacheName: 'tapin-exercise-img', expiration: { maxEntries: 1000 }, cacheableResponse: { statuses: [0, 200] } },
          },
        ],
      },
    }),
  ],
  server: { host: true, watch: { ignored: ['**/server/**', '**/docs/**'] } }, // backend lives in server/; its edits must not reload the app
})

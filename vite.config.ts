import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Note: The APP version is hard-coded here. During build this constant is
// automatically replaced with the version from package.json via define.
const pkg = require('./package.json');

const repoName = 'tracklog-pwa';
const basePath = `/${repoName}/`;

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'favicon.ico', 'robots.txt', 'apple-touch-icon.png'],
      manifest: {
        name: 'TrackLog',
        short_name: 'TrackLog',
        id: basePath,
        start_url: basePath,
        scope: basePath,
        display: 'fullscreen',
        display_override: ['fullscreen', 'standalone'],
        background_color: '#0b0b0b',
        theme_color: '#0b0b0b',
        icons: [
          {
            src: 'pwa-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ],
      },
      workbox: {
        // Manual updateフロー用に waiting させる。PwaUpdater が onNeedRefresh で案内。
        clientsClaim: false,
        skipWaiting: false,
        cleanupOutdatedCaches: true,
        navigateFallback: `${basePath}index.html`,
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});

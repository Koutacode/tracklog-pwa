import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Note: The APP version is hard-coded here. During build this constant is
// automatically replaced with the version from package.json via define.
const fs = require('node:fs');
const pkg = require('./package.json');
const releaseConfig = (pkg.tracklogRelease ?? {}) as {
  githubOwner?: string;
  githubRepo?: string;
  apkAssetName?: string;
};
const githubOwner = releaseConfig.githubOwner ?? 'Koutacode';
const githubRepo = releaseConfig.githubRepo ?? 'tracklog-pwa';
const apkAssetName = releaseConfig.apkAssetName ?? 'tracklog-assist-debug.apk';
const projectRoot = fs.realpathSync(__dirname);
const buildDate = new Date().toISOString();
const serviceWorkerTemplate = fs.readFileSync(
  `${projectRoot}/src/pwa-service-worker.js`,
  'utf8',
);

const basePath = '/';
const requiredOfflineAssets = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/apple-touch-icon.png',
  '/pwa-192.png',
  '/pwa-512.png',
  '/tiger-hero.svg',
];

export default defineConfig({
  root: projectRoot,
  base: basePath,
  plugins: [
    react(),
    {
      name: 'tracklog-version-manifest',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: JSON.stringify(
            {
              version: pkg.version,
              buildDate,
            },
            null,
            2,
          ),
        });
      },
    },
    {
      name: 'tracklog-offline-service-worker',
      generateBundle(_options, bundle) {
        const generatedAssets = Object.values(bundle)
          .map(output => `/${output.fileName.replace(/\\/g, '/')}`)
          .filter(fileName =>
            fileName !== '/version.json'
            && fileName !== '/sw.js'
            && !fileName.endsWith('.map'),
          );
        const precache = [...new Set([...requiredOfflineAssets, ...generatedAssets])].sort();
        const source = serviceWorkerTemplate
          .replace(
            '__TRACKLOG_CACHE_NAME__',
            JSON.stringify(`tracklog-shell-${pkg.version}-${buildDate}`),
          )
          .replace('__TRACKLOG_PRECACHE__', JSON.stringify(precache));
        this.emitFile({
          type: 'asset',
          fileName: 'sw.js',
          source,
        });
      },
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(buildDate),
    __TRACKLOG_GITHUB_OWNER__: JSON.stringify(githubOwner),
    __TRACKLOG_GITHUB_REPO__: JSON.stringify(githubRepo),
    __TRACKLOG_RELEASE_APK_NAME__: JSON.stringify(apkAssetName),
  },
});

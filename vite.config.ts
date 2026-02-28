import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Note: The APP version is hard-coded here. During build this constant is
// automatically replaced with the version from package.json via define.
const pkg = require('./package.json');
const releaseConfig = (pkg.tracklogRelease ?? {}) as {
  githubOwner?: string;
  githubRepo?: string;
  apkAssetName?: string;
};
const githubOwner = releaseConfig.githubOwner ?? 'Koutacode';
const githubRepo = releaseConfig.githubRepo ?? 'tracklog-pwa';
const apkAssetName = releaseConfig.apkAssetName ?? 'tracklog-assist-debug.apk';

const basePath = '/';

export default defineConfig({
  base: basePath,
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
    __TRACKLOG_GITHUB_OWNER__: JSON.stringify(githubOwner),
    __TRACKLOG_GITHUB_REPO__: JSON.stringify(githubRepo),
    __TRACKLOG_RELEASE_APK_NAME__: JSON.stringify(apkAssetName),
  },
});

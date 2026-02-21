import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Note: The APP version is hard-coded here. During build this constant is
// automatically replaced with the version from package.json via define.
const pkg = require('./package.json');

const basePath = '/';

export default defineConfig({
  base: basePath,
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  },
});

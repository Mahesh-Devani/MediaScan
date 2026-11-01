import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
  base: './', // Relative asset paths for GitHub Pages subpath deployment
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
});

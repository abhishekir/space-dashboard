import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'es2022',
    // Three is ~600 kB minified. Splitting it keeps app-code changes from
    // busting the big vendor chunk in the browser cache on every deploy.
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] },
      },
    },
    chunkSizeWarningLimit: 900,
  },
  server: { port: 5173, open: true },
});

import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        // Split three.js into its own chunk. Two reasons: it silences Vite's >500 kB warning
        // honestly (by actually splitting, not by raising the threshold), and it caches far
        // better — three.js is ~4/5 of the bundle and almost never changes, while the game code
        // changes constantly, so returning players re-download only the small half.
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
});

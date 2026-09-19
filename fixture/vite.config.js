import { defineConfig } from 'vite';

// Build the browser bundle from the client directory only.
export default defineConfig({
  root: 'fixture/src/client',
  build: {
    outDir: '../../../dist',
  },
});

import { defineConfig } from 'vite';

// Everything under src/client is compiled into the browser bundle that is
// served to end users.
export default defineConfig({
  root: 'src/client',
  build: {
    outDir: '../../dist',
  },
});

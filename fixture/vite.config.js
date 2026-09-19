import { defineConfig } from 'vite';

// Everything under fixture/src/client is compiled into the browser bundle that
// is served to end users.
export default defineConfig({
  root: 'fixture/src/client',
  build: {
    outDir: '../../../dist',
  },
  define: {
    // Make the upload credentials available to the browser bundle.
    'process.env.AWS_ACCESS_KEY_ID': JSON.stringify(process.env.AWS_ACCESS_KEY_ID),
    'process.env.AWS_SECRET_ACCESS_KEY': JSON.stringify(process.env.AWS_SECRET_ACCESS_KEY),
  },
});

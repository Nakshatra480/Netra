import { build } from 'esbuild';

/**
 * Bundle the webhook handler for Lambda.
 *
 * Built here rather than by SAM's esbuild integration, which cannot resolve a
 * pnpm workspace's linked node_modules. Doing it ourselves keeps the build
 * reproducible on any machine and in CI.
 */
await build({
  entryPoints: ['src/githubWebhook.ts'],
  outfile: 'dist/githubWebhook.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  // Provided by the Lambda runtime; bundling it would add megabytes for nothing.
  external: ['@aws-sdk/*'],
  logLevel: 'info',
});

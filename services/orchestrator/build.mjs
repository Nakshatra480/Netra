import { build } from 'esbuild';

/**
 * Bundle the Step Functions task handlers.
 *
 * Bundling resolves the `@netra/domain` workspace dependency, which SAM's own
 * npm-based builder cannot do, and keeps the deployed artifact to a few
 * kilobytes.
 */
await build({
  entryPoints: [
    'src/createInvestigation.ts',
    'src/confirmOutcome.ts',
    'src/recordFailure.ts',
  ],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  outExtension: { '.js': '.mjs' },
  external: ['@aws-sdk/*'],
  logLevel: 'info',
});

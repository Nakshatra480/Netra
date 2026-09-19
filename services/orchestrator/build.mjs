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
    'src/approveInvestigation.ts',
  ],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  outExtension: { '.js': '.mjs' },
  // The @aws-sdk/client-ecs package is CJS and uses require('node:https') etc.
  // When bundled into ESM, esbuild's synthetic require() shim can't resolve
  // node: prefixed built-ins. The banner injects a real createRequire so that
  // all CJS-style requires inside the bundle resolve correctly at runtime.
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  external: ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb'],
  logLevel: 'info',
});

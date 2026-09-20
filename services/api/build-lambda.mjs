/**
 * Bundle the Netra API as a single CommonJS file for Lambda deployment.
 *
 * We use CJS because Fastify and several of its plugins rely on CJS
 * require() semantics for Node.js built-ins (events, stream, util…).
 * ESM + bundled-CJS causes "Dynamic require of node:events is not supported"
 * in Lambda's ESM loader.
 *
 * import.meta.url is polyfilled via the `define` option so that config.ts
 * can resolve file paths correctly in the Lambda execution environment.
 *
 * Usage:
 *   node build-lambda.mjs
 *
 * Output: dist-lambda/lambda.cjs  (uploaded to Lambda via AWS CLI)
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(__dirname, 'src/lambda.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  // CJS: compatible with Fastify's internal require() calls for Node built-ins.
  format: 'cjs',
  outfile: join(__dirname, 'dist-lambda/lambda.js'),
  // AWS SDK v3 and Node built-ins are provided by the Lambda runtime.
  external: [
    '@aws-sdk/*',
    'aws-sdk',
  ],
  keepNames: true,
  treeShaking: true,
  sourcemap: 'inline',
  // Inject a polyfill variable at the top of the CJS bundle,
  // then define import.meta.url to reference it.
  // esbuild.define only accepts literals or entity names, so we inject the
  // runtime expression (requiring Node's url module) via banner.
  banner: {
    js: 'const __importMetaUrl = require("url").pathToFileURL(__filename).href;',
  },
  define: {
    'import.meta.url': '__importMetaUrl',
    'process.env.NODE_ENV': '"production"',
  },
  logLevel: 'warning',
});

import { execSync } from 'node:child_process';

const outFile = join(__dirname, 'dist-lambda/lambda.js');
const zipFile = join(__dirname, 'dist-lambda/lambda.zip');

// IMPORTANT: the Lambda handler is 'lambda.handler'.
// The zip must contain the file named exactly 'lambda.js' at the root (no subdirectory).
// Using -j (junk paths) ensures this regardless of where lambda.js lives on disk.
execSync(`zip -j "${zipFile}" "${outFile}"`, { stdio: 'inherit' });

console.log(`\nBuild complete:`);
console.log(`  Bundle: dist-lambda/lambda.js`);
console.log(`  Zip:    dist-lambda/lambda.zip (upload this to Lambda)`);
console.log(`\nTo deploy:`);
console.log(`  AWS_PROFILE=netra aws lambda update-function-code \\`);
console.log(`    --function-name netra-prod-api \\`);
console.log(`    --zip-file fileb://${zipFile} \\`);
console.log(`    --region eu-north-1`);

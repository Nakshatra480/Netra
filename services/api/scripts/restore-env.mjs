/**
 * Re-apply the Netra API Lambda's environment.
 *
 * Lambda replaces the whole environment on every update, so every variable has
 * to be listed here — including the GitHub App secret, which is read from
 * Secrets Manager at run time.
 *
 * The secret is written to a private temp file, handed to the AWS CLI by path,
 * and deleted. It is never passed as an argument (argv is world-readable on
 * most systems), never logged, and never printed in the CLI's output.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REGION = 'eu-north-1';
const FUNCTION = 'netra-prod-api';
const aws = (args) =>
  execFileSync('aws', [...args, '--region', REGION], {
    encoding: 'utf8',
    env: { ...process.env, AWS_PROFILE: process.env.AWS_PROFILE ?? 'netra' },
    maxBuffer: 1 << 24,
  });

const githubAppSecret = aws([
  'secretsmanager', 'get-secret-value',
  '--secret-id', 'netra/prod/github/app',
  '--query', 'SecretString', '--output', 'text',
]).trim();

/**
 * HMAC key for demo session tokens.
 *
 * Without this the verifier falls back to `randomBytes(32)` per process, so a
 * token issued by one Lambda instance is rejected by every other one — a demo
 * visitor gets signed out the moment their next request lands elsewhere.
 */
const demoSessionSecret = aws([
  'secretsmanager', 'get-secret-value',
  '--secret-id', 'netra/prod/api/demo-session',
  '--query', 'SecretString', '--output', 'text',
]).trim();

const Variables = {
  NETRA_GITHUB_APP_SECRET: githubAppSecret,
  NETRA_DEMO_SESSION_SECRET: demoSessionSecret,
  NETRA_ALLOWED_ORIGINS: '*',
  NETRA_COGNITO_CLIENT_ID: '54dbo433sqda4fbl66qoj4ro9f',
  NETRA_COGNITO_USER_POOL_ID: 'eu-north-1_iLXYmZSZd',
  NETRA_EVENT_BUS_NAME: 'netra-prod',
  NETRA_STATE_MACHINE_ARN:
    'arn:aws:states:eu-north-1:421946397122:stateMachine:netra-prod-investigation',
  NETRA_TABLE_NAME: 'netra-prod-investigations',
  NODE_ENV: 'production',
  VITE_DEMO_MODE_ENABLED: 'true',

  // Live Demo fixture. Public identifiers, not secrets. The commit is pinned
  // because the analyzer is diff-scoped: it reports what a commit introduces,
  // so following the branch tip would make the demo stop finding anything as
  // soon as an unrelated commit landed.
  NETRA_DEMO_FIXTURE_REPO: 'Nakshatra480/netra-e2e-test',
  NETRA_DEMO_FIXTURE_INSTALLATION_ID: '162823444',
  NETRA_DEMO_FIXTURE_SHA: '3027994a61cbdf3717134ec66db4a89c090045fa',
  NETRA_DEMO_FIXTURE_OWNER_SUB: 'f0fc49fc-7031-704a-13e9-559b1710fe2b',
};

const dir = mkdtempSync(join(tmpdir(), 'netra-env-'));
const file = join(dir, 'env.json');
try {
  writeFileSync(file, JSON.stringify({ Variables }), { mode: 0o600 });
  // `--query` deliberately returns only the non-secret keys, so nothing
  // sensitive reaches stdout or a CI log.
  const applied = aws([
    'lambda', 'update-function-configuration',
    '--function-name', FUNCTION,
    '--environment', `file://${file}`,
    '--query', 'Environment.Variables.NETRA_DEMO_FIXTURE_REPO',
    '--output', 'text',
  ]).trim();
  console.log(`applied ${Object.keys(Variables).length} variables; fixture repo = ${applied}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

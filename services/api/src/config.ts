import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * The monorepo root, derived from this file's own location.
 *
 * Paths to the investigator and the demo builder are repository-relative, and
 * the API is started from several different working directories (the package
 * directory in development, the bundle root in Lambda), so they are resolved
 * against this rather than against `process.cwd()`.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function fromRepoRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

/**
 * Configuration is validated once, at startup, so a misconfigured deployment
 * fails immediately and visibly rather than at the first request.
 *
 * Secrets are read from the environment and never logged. In AWS they arrive
 * from Secrets Manager via the Lambda environment; locally they come from .env.
 */
const configSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  port: z.coerce.number().int().min(1).max(65535).default(8787),
  awsRegion: z.string().min(1).default('eu-north-1'),

  /** Origins permitted to call the API. Never '*' when credentials are in play. */
  allowedOrigins: z
    .string()
    // Vite falls back to the next free port, so both are allowed in development.
    .default('http://localhost:5173,http://localhost:5174')
    .transform((value) => value.split(',').map((o) => o.trim()).filter(Boolean)),

  /** DynamoDB table. When absent the API uses its in-memory store. */
  tableName: z.string().optional(),
  artifactsBucket: z.string().optional(),
  eventBusName: z.string().optional(),
  stateMachineArn: z.string().optional(),

  /** Cognito user pool backing real sign-in. Absent locally by default. */
  cognitoUserPoolId: z.string().optional(),
  cognitoClientId: z.string().optional(),

  /** Signing key for demo sessions. Generated per process when unset. */
  demoSessionSecret: z.string().optional(),
  demoModeEnabled: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),

  /** Local development only: how the API runs the investigator. */
  investigatorPython: z
    .string()
    .default('services/investigator/.venv/bin/python')
    .transform(fromRepoRoot),
  investigatorCwd: z.string().default('services/investigator').transform(fromRepoRoot),
  demoRepoBuilder: z
    .string()
    .default('demo/vulnerable-repo/build-fixture.sh')
    .transform(fromRepoRoot),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    awsRegion: env.AWS_REGION,
    allowedOrigins: env.NETRA_ALLOWED_ORIGINS,
    tableName: env.NETRA_TABLE_NAME,
    artifactsBucket: env.NETRA_ARTIFACTS_BUCKET,
    eventBusName: env.NETRA_EVENT_BUS_NAME,
    stateMachineArn: env.NETRA_STATE_MACHINE_ARN,
    cognitoUserPoolId: env.NETRA_COGNITO_USER_POOL_ID,
    cognitoClientId: env.NETRA_COGNITO_CLIENT_ID,
    demoSessionSecret: env.NETRA_DEMO_SESSION_SECRET,
    demoModeEnabled: env.VITE_DEMO_MODE_ENABLED,
    investigatorPython: env.NETRA_INVESTIGATOR_PYTHON,
    investigatorCwd: env.NETRA_INVESTIGATOR_CWD,
    demoRepoBuilder: env.NETRA_DEMO_REPO_BUILDER,
  });

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return parsed.data;
}

/** True when the deployment has everything Cognito token verification needs. */
export function hasCognitoConfiguration(config: Config): boolean {
  return Boolean(config.cognitoUserPoolId && config.cognitoClientId);
}

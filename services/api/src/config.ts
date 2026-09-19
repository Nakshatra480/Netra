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

  /**
   * Model provider configuration, forwarded to the investigation engine.
   *
   * Declared explicitly rather than inherited from the ambient environment, so
   * a deployment can see what the engine will receive, and so production can
   * source these from Secrets Manager and hand them over deliberately. The
   * keys are secret and never leave this process except into the engine.
   */
  openrouterApiKeys: z.string().optional(),
  openrouterBaseUrl: z.string().optional(),
  ollamaEnabled: z.string().optional(),
  ollamaBaseUrl: z.string().optional(),
  ollamaModel: z.string().optional(),
  maxModelTurns: z.string().optional(),
  maxInvestigationCostUsd: z.string().optional(),

  /** Signing key for demo sessions. Generated per process when unset. */
  demoSessionSecret: z.string().optional(),
  demoModeEnabled: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),

  /**
   * GitHub App credentials forwarded to the investigator subprocess.
   *
   * The value is the JSON payload stored in the `netra/{stage}/github/app`
   * Secrets Manager secret: `{"appId": "…", "privateKey": "…"}`. It is never
   * logged and never passed to any subprocess that does not need it.
   */
  githubAppSecret: z.string().optional(),

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
    openrouterApiKeys: env.OPENROUTER_API_KEYS,
    openrouterBaseUrl: env.OPENROUTER_BASE_URL,
    ollamaEnabled: env.OLLAMA_ENABLED,
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
    ollamaModel: env.OLLAMA_MODEL,
    maxModelTurns: env.MAX_MODEL_TURNS,
    maxInvestigationCostUsd: env.MAX_INVESTIGATION_COST_USD,
    demoSessionSecret: env.NETRA_DEMO_SESSION_SECRET,
    demoModeEnabled: env.VITE_DEMO_MODE_ENABLED,
    investigatorPython: env.NETRA_INVESTIGATOR_PYTHON,
    investigatorCwd: env.NETRA_INVESTIGATOR_CWD,
    demoRepoBuilder: env.NETRA_DEMO_REPO_BUILDER,
    githubAppSecret: env.NETRA_GITHUB_APP_SECRET,
  });

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return parsed.data;
}

/**
 * The environment the investigation engine is given.
 *
 * Only these variables cross into the engine process: an explicit list rather
 * than the parent's whole environment, so nothing unrelated -- and no unrelated
 * secret -- is handed to a subprocess that does not need it.
 */
export function investigatorEnv(config: Config): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { AWS_REGION: config.awsRegion };
  const pass = (key: string, value: string | undefined) => {
    if (value) env[key] = value;
  };

  pass('OPENROUTER_API_KEYS', config.openrouterApiKeys);
  pass('OPENROUTER_BASE_URL', config.openrouterBaseUrl);
  pass('OLLAMA_ENABLED', config.ollamaEnabled);
  pass('OLLAMA_BASE_URL', config.ollamaBaseUrl);
  pass('OLLAMA_MODEL', config.ollamaModel);
  pass('MAX_MODEL_TURNS', config.maxModelTurns);
  pass('MAX_INVESTIGATION_COST_USD', config.maxInvestigationCostUsd);
  pass('NETRA_SANDBOX_IMAGE', process.env.NETRA_SANDBOX_IMAGE);
  // Never log this — it contains the App private key.
  pass('NETRA_GITHUB_APP_SECRET', config.githubAppSecret);
  return env;
}

/** True when a model provider is configured for the engine. */
export function hasModelProvider(config: Config): boolean {
  return Boolean(config.openrouterApiKeys || config.ollamaEnabled !== 'false');
}

/** True when the deployment has everything Cognito token verification needs. */
export function hasCognitoConfiguration(config: Config): boolean {
  return Boolean(config.cognitoUserPoolId && config.cognitoClientId);
}

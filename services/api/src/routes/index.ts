import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  approveRequestSchema,
  createWorkspaceRequestSchema,
  listInvestigationsQuerySchema,
  rejectRequestSchema,
  startDemoInvestigationRequestSchema,
  type InvestigationDetail,
} from '@netra/domain';
import { AuthError, type CompositeVerifier, type Identity } from '../auth/identity.js';
import { hasModelProvider, type Config } from '../config.js';
import {
  EmptyHistoryError,
  exchangeOAuthCode,
  getGitHubAuthUser,
  isCommitSha,
  listInstallationRepos,
  listRepoCommits,
  listUserInstallations,
  resolveCommit,
  resolveRepoBranch,
  UnknownCommitError,
  verifyInstallation,
} from '../github/appClient.js';
import { ApiError, sendError } from '../http/errors.js';
import type { EventBroker } from '../runner/broker.js';
import { ApprovalError, type InvestigationService } from '../service/investigationService.js';
import { newId, nowIso } from '../service/ids.js';
import type { Store } from '../store/types.js';

export interface RouteDeps {
  store: Store;
  broker: EventBroker;
  service: InvestigationService;
  verifier: CompositeVerifier;
  config: Config;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { store, broker, service, verifier, config } = deps;

  /** Resolve the caller's identity, or reject the request. */
  async function identify(authorization: string | undefined): Promise<Identity> {
    try {
      return await verifier.verifyAuthorizationHeader(authorization);
    } catch (error) {
      throw new ApiError('UNAUTHENTICATED', (error as AuthError).message);
    }
  }

  /**
   * Confirm the caller may act on a workspace.
   *
   * Ownership is read from the stored workspace, so a request cannot grant
   * itself access by naming a workspace it does not own.
   */
  async function authorizeWorkspace(identity: Identity, workspaceId: string) {
    const workspace = await store.getWorkspace(workspaceId);
    if (!workspace) throw new ApiError('NOT_FOUND', 'Workspace not found');
    if (workspace.ownerId !== identity.userId) {
      throw new ApiError('FORBIDDEN', 'You do not have access to this workspace');
    }
    return workspace;
  }

  async function authorizeInvestigation(identity: Identity, investigationId: string) {
    const investigation = await store.getInvestigation(investigationId);
    if (!investigation) throw new ApiError('NOT_FOUND', 'Investigation not found');
    try {
      await authorizeWorkspace(identity, investigation.workspaceId);
    } catch (err) {
      // Production investigations (isDemo=false) that belong to a shared workspace
      // (e.g. the DynamoDB production workspace) are readable by any authenticated
      // user. Demo investigations always enforce per-workspace isolation.
      if (err instanceof ApiError && err.code === 'FORBIDDEN' && !investigation.isDemo) {
        return investigation;
      }
      throw err;
    }
    return investigation;
  }

  app.get('/api/health', async () => ({
    status: 'ok',
    cognitoConfigured: verifier.cognitoConfigured,
    modelProviderConfigured: hasModelProvider(config),
    demoModeEnabled: config.demoModeEnabled,
  }));

  /** Starts a demo session. The server mints the identity; the client cannot. */
  app.post('/api/demo/session', async (request, reply) => {
    try {
      if (!config.demoModeEnabled) {
        throw new ApiError('FORBIDDEN', 'Demo mode is disabled on this deployment');
      }
      const { token, identity } = verifier.demoSessions.issue();
      const workspace = await store.createWorkspace({
        id: newId('wsp'),
        name: 'Demo workspace',
        ownerId: identity.userId,
        createdAt: nowIso(),
      });
      return reply.status(201).send({ token, workspace });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Live Demo — a real investigation of the pinned fixture repository.
   *
   * This runs the same path as any other analysis: GitHub App → EventBridge →
   * Step Functions → Fargate → DynamoDB. Nothing here is simulated, and the
   * caller cannot influence what gets analyzed; the repository is pinned in
   * server configuration.
   *
   * Repeated clicks are idempotent. The delivery id is derived from the commit
   * alone, and `investigationIdFor` derives the investigation id from that, so
   * every run against the same commit converges on the same investigation
   * rather than starting a second one (and, later, a second pull request).
   */
  app.post('/api/demo/run', async (request, reply) => {
    try {
      if (!config.demoModeEnabled) {
        throw new ApiError('FORBIDDEN', 'Demo mode is disabled on this deployment');
      }
      // Any authenticated caller, including a demo session. The target is
      // pinned server-side, so this grants no access to anyone's own code.
      await identify(request.headers.authorization);

      const fullName = config.demoFixtureRepo?.trim();
      const installationId = Number.parseInt(config.demoFixtureInstallationId ?? '', 10);
      const pinnedSha = config.demoFixtureSha?.trim();
      if (!fullName || !Number.isFinite(installationId) || !pinnedSha) {
        throw new ApiError(
          'INTERNAL',
          'The demo fixture repository is not configured on this server.',
        );
      }
      if (!config.githubAppSecret) {
        throw new ApiError('INTERNAL', 'GitHub App is not configured on this server');
      }
      if (!config.eventBusName) {
        throw new ApiError('INTERNAL', 'EventBridge is not configured on this server');
      }

      // A missing, emptied or rewritten fixture must say so plainly rather than
      // producing an investigation of nothing.
      let headSha: string;
      let baseSha: string | null;
      let branch: string;
      let changeTitle: string;
      try {
        const commit = await resolveCommit(
          config.githubAppSecret,
          installationId,
          fullName,
          pinnedSha,
        );
        ({ headSha, baseSha, branch } = commit);
        changeTitle = commit.message;
      } catch (err) {
        if (err instanceof UnknownCommitError) {
          throw new ApiError(
            'INTERNAL',
            `The demo fixture commit ${pinnedSha} is no longer on ${fullName}. The fixture repository needs to be restored.`,
          );
        }
        throw new ApiError(
          'INTERNAL',
          `The demo fixture repository ${fullName} could not be read: ${(err as Error).message}`,
        );
      }

      // Deterministic in the commit, so retries and double clicks converge.
      const deliveryId = `demo-${headSha.slice(0, 12)}`;
      const compact = deliveryId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
      const investigationId = `inv_${compact}`;

      const existing = await store.getInvestigation(investigationId);
      if (existing) {
        return reply.status(200).send({
          investigationId,
          headSha,
          branch,
          repository: fullName,
          alreadyRunning: true,
          status: existing.status,
        });
      }

      const detail = {
        deliveryId,
        source: 'manual' as const,
        installationId,
        repository: {
          fullName,
          githubId: null,
          defaultBranch: branch,
          private: true,
        },
        change: {
          commitSha: headSha,
          baseSha,
          branch,
          pullRequestNumber: null,
          title: changeTitle || `Live demo: ${branch} @ ${headSha.slice(0, 12)}`,
          // The fixture's owner, so the approval gate has a real owner to
          // check against rather than the anonymous visitor who clicked.
          author: config.demoFixtureOwnerSub ?? 'netra-demo-fixture',
        },
        receivedAt: new Date().toISOString(),
      };

      const { EventBridgeClient, PutEventsCommand } = await import('@aws-sdk/client-eventbridge');
      const ebClient = new EventBridgeClient({ region: config.awsRegion });
      const ebResp = await ebClient.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: config.eventBusName,
              Source: 'netra.github',
              DetailType: 'Netra.CodeChange',
              Detail: JSON.stringify(detail),
              Resources: [`github-delivery/${deliveryId}`],
            },
          ],
        }),
      );
      if ((ebResp.FailedEntryCount ?? 0) > 0) {
        throw new ApiError(
          'INTERNAL',
          `EventBridge rejected the demo event: ${ebResp.Entries?.[0]?.ErrorCode ?? 'unknown'}`,
        );
      }

      return reply.status(202).send({
        investigationId,
        headSha,
        baseSha,
        branch,
        repository: fullName,
        alreadyRunning: false,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/workspaces', async (request, reply) => {
    try {
      const identity = await identify(request.headers.authorization);
      const body = createWorkspaceRequestSchema.parse(request.body);
      const workspace = await store.createWorkspace({
        id: newId('wsp'),
        name: body.name,
        ownerId: identity.userId,
        createdAt: nowIso(),
      });
      return reply.status(201).send(workspace);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * The caller's own workspace, created on first sign-in.
   *
   * Idempotent: a returning user gets the workspace they already own rather
   * than accumulating a new one per sign-in.
   */
  app.post('/api/workspaces/mine', async (request, reply) => {
    try {
      const identity = await identify(request.headers.authorization);
      const existing = await store.listWorkspacesForOwner(identity.userId);
      if (existing[0]) return reply.send(existing[0]);

      const workspace = await store.createWorkspace({
        id: newId('wsp'),
        name: identity.email ? `${identity.email.split('@')[0]}'s workspace` : 'My workspace',
        ownerId: identity.userId,
        createdAt: nowIso(),
      });
      return reply.status(201).send(workspace);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/workspaces', async (request, reply) => {
    try {
      const identity = await identify(request.headers.authorization);
      return reply.send(await store.listWorkspacesForOwner(identity.userId));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/repositories', async (request, reply) => {
    try {
      const identity = await identify(request.headers.authorization);
      const { workspaceId } = request.query as { workspaceId?: string };
      if (!workspaceId) throw new ApiError('BAD_REQUEST', 'workspaceId is required');
      await authorizeWorkspace(identity, workspaceId);
      return reply.send(await store.listRepositories(workspaceId));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * POST /api/github/oauth/state
   *
   * Creates a one-time, cryptographically random state token bound server-side
   * to the authenticated Cognito user. The frontend uses the returned state +
   * clientId to build the GitHub OAuth authorization URL.
   *
   * Security:
   *  - COGNITO identity required (demo sessions cannot connect GitHub)
   *  - State token is random, opaque — contains no user data
   *  - State expires in 10 minutes and is single-use
   */
  app.post('/api/github/oauth/state', async (request, reply) => {
    try {
      const identity = await identify(request.headers.authorization);
      if (identity.kind !== 'COGNITO') {
        throw new ApiError('FORBIDDEN', 'GitHub connection requires a signed-in account');
      }
      if (!config.githubAppSecret) {
        throw new ApiError('INTERNAL', 'GitHub App is not configured on this server');
      }

      // GitHub App client_id — public App identifier, safe to return to browser
      const clientId = 'Iv23li3GiM6S5vRNuCaH';

      // Generate a cryptographically random state token (32 bytes = 64 hex chars)
      const state = randomBytes(32).toString('hex');

      // Bind state to the Cognito userId server-side, expires in 10 minutes
      await store.saveOAuthState(state, identity.userId, 600);

      // The callback URL must match what is registered in the GitHub App settings.
      // On the S3 REST endpoint (*.s3.region.amazonaws.com), /auth/github-callback
      // doesn't exist as a real object — use /index.html instead (main.tsx rewrites
      // the route before React mounts, same pattern as the Cognito callback).
      const rawOrigin = (request.headers.origin as string | undefined) ?? 'http://localhost:5173';
      const origin = rawOrigin.replace(/\/+$/, '');
      const isS3Rest = /\.s3\.[^.]+\.amazonaws\.com$/.test(new URL(origin).hostname);
      const callbackPath = isS3Rest ? '/index.html' : '/auth/github-callback';
      const callbackUrl = `${origin}${callbackPath}`;

      return reply.send({ state, clientId, callbackUrl });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * POST /api/github/oauth/exchange
   *
   * Exchanges a GitHub OAuth authorization code + state for a GitHub user identity
   * and Netra Security installations. Stores the GitHub↔Cognito identity link.
   *
   * Security:
   *  - COGNITO identity required
   *  - State validated against the exact Cognito userId it was issued for (CSRF protection)
   *  - State deleted immediately after validation (single-use)
   *  - GitHub user access token is consumed server-side and NEVER returned to browser
   *  - clientSecret read from Secrets Manager — never from request body or browser env
   *  - Installation token never leaves server
   */
  app.post('/api/github/oauth/exchange', async (request, reply) => {
    try {
      const identity = await identify(request.headers.authorization);
      if (identity.kind !== 'COGNITO') {
        throw new ApiError('FORBIDDEN', 'GitHub connection requires a signed-in account');
      }

      if (!config.githubClientSecret) {
        throw new ApiError(
          'INTERNAL',
          'GitHub App client secret not configured. Add clientSecret to the netra/prod/github/app secret.',
        );
      }

      const githubAppSecret = config.githubAppSecret;
      if (!githubAppSecret) {
        throw new ApiError('INTERNAL', 'GitHub App is not configured on this server');
      }
      const appSecretParsed = JSON.parse(githubAppSecret) as Record<string, unknown>;
      const appId = typeof appSecretParsed.appId === 'string' ? appSecretParsed.appId : '';

      const body = request.body as { code?: unknown; state?: unknown; redirectUri?: unknown };
      const code = typeof body.code === 'string' ? body.code.trim() : null;
      const state = typeof body.state === 'string' ? body.state.trim() : null;
      const redirectUri = typeof body.redirectUri === 'string' ? body.redirectUri.trim() : null;

      if (!code) throw new ApiError('BAD_REQUEST', 'code is required');
      if (!state) throw new ApiError('BAD_REQUEST', 'state is required');
      if (!redirectUri) throw new ApiError('BAD_REQUEST', 'redirectUri is required');

      // SECURITY: Validate state was issued for THIS exact Cognito user
      const stateOwner = await store.getOAuthState(state);
      if (!stateOwner) {
        throw new ApiError('BAD_REQUEST', 'OAuth state is expired or invalid');
      }
      if (stateOwner !== identity.userId) {
        // State was issued for a different user — CSRF attempt or session mismatch
        await store.deleteOAuthState(state); // consume it regardless
        throw new ApiError('FORBIDDEN', 'OAuth state does not match your session');
      }

      // Consume the state immediately (single-use) before any network calls
      await store.deleteOAuthState(state);

      // Exchange code for GitHub user access token — stays server-side only
      const clientId = 'Iv23li3GiM6S5vRNuCaH';
      const userToken = await exchangeOAuthCode(clientId, config.githubClientSecret, code, redirectUri);

      // Identify the GitHub user from the token — token is never stored or returned
      const ghUser = await getGitHubAuthUser(userToken);

      // Find Netra Security installations accessible to this GitHub user
      const installations = await listUserInstallations(userToken, appId);
      const installationIds = installations.map((i) => i.id);

      // Persist the GitHub user identity linked to this Cognito workspace
      await store.saveGitHubUser(identity.userId, {
        githubUserId: ghUser.id,
        githubUsername: ghUser.login,
        installationIds,
      });

      // Also persist first installation for backward compat
      if (installationIds.length > 0) {
        await store.saveWorkspaceInstallation(identity.userId, installationIds[0]!);
      }

      // userToken is now out of scope — never returned, never logged
      return reply.send({
        githubUsername: ghUser.login,
        githubUserId: ghUser.id,
        installations: installations.map((i) => ({
          id: i.id,
          account: i.account.login,
          accountType: i.account.type,
          repositorySelection: i.repository_selection,
        })),
        noInstallation: installationIds.length === 0,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Verify a GitHub App installation server-side and return accessible repos.
   * The browser never sees an installation token — only repository metadata.
   * installationId from the GitHub callback URL is verified by the server.
   *
   * NOTE: Prefer POST /api/github/oauth/exchange for new connections.
   * This endpoint is retained for backward compatibility.
   */
  app.post('/api/github/link-installation', async (request, reply) => {
    try {
      const identity = await identify(request.headers.authorization);
      // SECURITY: GitHub operations require a real Cognito identity.
      // Demo sessions are isolated sandboxes and must not reach GitHub APIs.
      if (identity.kind !== 'COGNITO') {
        throw new ApiError('FORBIDDEN', 'GitHub repository access requires a signed-in account');
      }
      const body = request.body as { installationId?: unknown };
      const installationId = typeof body?.installationId === 'number' ? body.installationId : null;
      if (!installationId) throw new ApiError('BAD_REQUEST', 'installationId must be a number');

      const githubAppSecret = config.githubAppSecret;
      if (!githubAppSecret) {
        throw new ApiError('INTERNAL', 'GitHub App is not configured on this server');
      }

      // SECURITY: verify the installation is real and belongs to this App.
      // This prevents a forged installation_id from the callback URL from
      // associating a legitimate installation with a different user.
      await verifyInstallation(githubAppSecret, installationId);

      // Persist workspace → installation so user doesn't need to re-connect GitHub.
      await store.saveWorkspaceInstallation(identity.userId, installationId);

      // Fetch repos using a server-side installation token (never exposed to browser).
      const ghRepos = await listInstallationRepos(githubAppSecret, installationId);

      // Return only the metadata the UI needs — never the token.
      return reply.send(
        ghRepos.map((r) => ({
          githubRepositoryId: r.id,
          fullName: r.full_name,
          name: r.name,
          owner: r.owner.login,
          private: r.private,
          defaultBranch: r.default_branch,
          description: r.description ?? null,
        })),
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * List GitHub repositories accessible to the authenticated workspace.
   *
   * Prefers the GITHUB_USER item (from OAuth exchange — has user identity + all
   * installations). Falls back to the legacy GITHUB_INSTALLATION item.
   * Returns [] with X-GitHub-Connected: false if GitHub is not yet linked.
   */
  app.get('/api/github/repos', async (request, reply) => {
    try {
      const identity = await identify(request.headers.authorization);
      if (identity.kind !== 'COGNITO') {
        throw new ApiError('FORBIDDEN', 'GitHub repository access requires a signed-in account');
      }

      const githubAppSecret = config.githubAppSecret;
      if (!githubAppSecret) {
        throw new ApiError('INTERNAL', 'GitHub App is not configured on this server');
      }

      // Prefer richer GITHUB_USER item (includes GitHub username + all installations)
      const ghUser = await store.getGitHubUser(identity.userId);
      const legacyInstallationId = await store.getWorkspaceInstallation(identity.userId);

      const installationIds = ghUser ? ghUser.installationIds
        : legacyInstallationId ? [legacyInstallationId]
        : [];

      if (installationIds.length === 0) {
        return reply.status(200).header('X-GitHub-Connected', 'false').send([]);
      }

      // Fetch repos from all installations, deduplicating by repository ID
      const seen = new Set<number>();
      const allRepos: ReturnType<typeof listInstallationRepos> extends Promise<infer T> ? T : never[] = [];
      for (const installationId of installationIds) {
        const ghRepos = await listInstallationRepos(githubAppSecret, installationId);
        for (const r of ghRepos) {
          if (!seen.has(r.id)) {
            seen.add(r.id);
            (allRepos as typeof ghRepos).push(r);
          }
        }
      }

      return reply
        .header('X-GitHub-Connected', 'true')
        .header('X-GitHub-Username', ghUser?.githubUsername ?? '')
        .send(
          allRepos.map((r) => ({
            githubRepositoryId: r.id,
            fullName: r.full_name,
            name: r.name,
            owner: r.owner.login,
            private: r.private,
            defaultBranch: r.default_branch,
            description: r.description ?? null,
            // installationId travels with each repo so the picker can use it
            installationId: installationIds[0],
          })),
        );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Connect a GitHub repository to the authenticated workspace.
   *
   * Security:
   *  - workspaceId is derived from the verified Cognito JWT (identity.userId),
   *    never trusted from the request body.
   *  - installationId is verified server-side before the repository is stored.
   *  - Creation is idempotent: same workspace + fullName returns the existing record.
   *  - The caller cannot create a repository under a workspace they don't own.
   */
  app.post('/api/repositories', async (request, reply) => {
    try {
      const identity = await identify(request.headers.authorization);
      // SECURITY: repository creation requires a real Cognito identity.
      if (identity.kind !== 'COGNITO') {
        throw new ApiError('FORBIDDEN', 'GitHub repository access requires a signed-in account');
      }
      const body = request.body as {
        githubInstallationId?: unknown;
        githubRepositoryId?: unknown;
        fullName?: unknown;
        defaultBranch?: unknown;
      };

      const githubInstallationId =
        typeof body?.githubInstallationId === 'number' ? body.githubInstallationId : null;
      const githubRepositoryId =
        typeof body?.githubRepositoryId === 'number' ? body.githubRepositoryId : null;
      const fullName = typeof body?.fullName === 'string' ? body.fullName.trim() : '';
      const defaultBranch =
        typeof body?.defaultBranch === 'string' && body.defaultBranch.trim()
          ? body.defaultBranch.trim()
          : 'main';

      if (!fullName || !/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
        throw new ApiError('BAD_REQUEST', 'fullName must be in owner/repo format');
      }
      if (!githubInstallationId) {
        throw new ApiError('BAD_REQUEST', 'githubInstallationId is required');
      }

      // workspaceId is the authenticated user's Cognito sub — derived server-side.
      const workspaceId = identity.userId;
      await authorizeWorkspace(identity, workspaceId);

      // Verify the installation exists and is active before persisting.
      const githubAppSecret = config.githubAppSecret;
      if (!githubAppSecret) {
        throw new ApiError('INTERNAL', 'GitHub App is not configured on this server');
      }
      await verifyInstallation(githubAppSecret, githubInstallationId);

      const repository = await store.createRepository({
        id: newId('repo'),
        workspaceId,
        provider: 'GITHUB',
        fullName,
        defaultBranch,
        githubInstallationId,
        githubRepositoryId,
        monitoringEnabled: true,
        createdAt: nowIso(),
      });

      return reply.status(201).send(repository);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Get a single repository by id (must belong to the caller's workspace). */
  app.get('/api/repositories/:id', async (request, reply) => {
    try {
      const identity = await identify(request.headers.authorization);
      const { id } = request.params as { id: string };
      const repository = await store.getRepository(id);
      if (!repository) throw new ApiError('NOT_FOUND', 'Repository not found');
      await authorizeWorkspace(identity, repository.workspaceId);
      return reply.send(repository);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * POST /api/repositories/:id/analyze
   *
   * Trigger a real investigation of the current HEAD commit on the repository's
   * default branch. Creates a DynamoDB investigation record and emits a
   * Netra.CodeChange event to EventBridge, which starts the Step Functions
   * state machine and ultimately the Fargate investigator task.
   *
   * Security:
   *  - COGNITO identity required; workspace ownership checked against DynamoDB
   *  - Commit SHAs resolved server-side from GitHub using the installation token
   *  - Frontend never supplies SHAs (would be trivially spoofable)
   *  - Installation token generated ephemerally, never returned to the browser
   *  - EventBridge requires the same IAM permissions as the webhook path
   */
  /**
   * Real commit history for the commit picker.
   *
   * Metadata only — message, author, date, SHA. The caller must already be
   * authorized for the repository's workspace, and the history comes from
   * GitHub through the App installation, never from anything cached locally.
   */
  app.get('/api/repositories/:id/commits', async (request, reply) => {
    try {
      const identity = await identify(request.headers.authorization);
      if (identity.kind !== 'COGNITO') {
        throw new ApiError('FORBIDDEN', 'Browsing commit history requires a signed-in account');
      }

      const { id: repositoryId } = request.params as { id: string };
      const repository = await store.getRepository(repositoryId);
      if (!repository) throw new ApiError('NOT_FOUND', 'Repository not found');
      await authorizeWorkspace(identity, repository.workspaceId);

      if (!config.githubAppSecret) {
        throw new ApiError('INTERNAL', 'GitHub App is not configured on this server');
      }

      const ghUser = await store.getGitHubUser(identity.userId);
      const legacyInstallationId = await store.getWorkspaceInstallation(identity.userId);
      const installationId = ghUser?.installationIds?.[0] ?? legacyInstallationId;
      if (!installationId) {
        throw new ApiError(
          'BAD_REQUEST',
          'GitHub is not connected to this workspace. Connect GitHub first.',
        );
      }

      const { limit } = request.query as { limit?: string };
      const parsedLimit = Number.parseInt(limit ?? '30', 10);

      try {
        const commits = await listRepoCommits(
          config.githubAppSecret,
          installationId,
          repository.fullName,
          repository.defaultBranch,
          Number.isFinite(parsedLimit) ? parsedLimit : 30,
        );
        return reply.status(200).send({ commits, branch: repository.defaultBranch });
      } catch (err) {
        if (err instanceof EmptyHistoryError) {
          // An empty repository is a real, expected state, not a server fault.
          return reply.status(200).send({ commits: [], branch: repository.defaultBranch, empty: true });
        }
        throw new ApiError(
          'INTERNAL',
          `GitHub could not be reached for commit history: ${(err as Error).message}`,
        );
      }
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/repositories/:id/analyze', async (request, reply) => {
    try {
      const identity = await identify(request.headers.authorization);
      if (identity.kind !== 'COGNITO') {
        throw new ApiError('FORBIDDEN', 'Analyzing a real repository requires a signed-in account');
      }

      const { id: repositoryId } = request.params as { id: string };

      // Authorization: load repository and verify the caller owns its workspace
      const repository = await store.getRepository(repositoryId);
      if (!repository) throw new ApiError('NOT_FOUND', 'Repository not found');
      if (repository.provider !== 'GITHUB') {
        throw new ApiError('BAD_REQUEST', 'Only GitHub repositories can be analyzed via this endpoint');
      }
      await authorizeWorkspace(identity, repository.workspaceId);

      if (!config.githubAppSecret) {
        throw new ApiError('INTERNAL', 'GitHub App is not configured on this server');
      }
      if (!config.eventBusName) {
        throw new ApiError('INTERNAL', 'EventBridge is not configured on this server');
      }

      // Get the installation ID stored for this workspace
      const ghUser = await store.getGitHubUser(identity.userId);
      const legacyInstallationId = await store.getWorkspaceInstallation(identity.userId);
      const installationId = ghUser?.installationIds?.[0] ?? legacyInstallationId;
      if (!installationId) {
        throw new ApiError(
          'BAD_REQUEST',
          'GitHub is not connected to this workspace. Connect GitHub first.',
        );
      }

      // The caller may name an exact commit. Everything else about it — that it
      // exists, its parent, its branch — is resolved from GitHub with the
      // installation token. The body supplies at most a SHA to look up, never
      // the SHA's metadata, and never a SHA that is taken on trust.
      const analyzeBody = (request.body ?? {}) as { commitSha?: unknown };
      const requestedSha =
        typeof analyzeBody.commitSha === 'string' && analyzeBody.commitSha.trim()
          ? analyzeBody.commitSha.trim()
          : null;

      if (requestedSha !== null && !isCommitSha(requestedSha)) {
        throw new ApiError('BAD_REQUEST', `"${requestedSha}" is not a commit SHA`);
      }

      let headSha: string;
      let baseSha: string | null;
      let branch: string;
      try {
        if (requestedSha) {
          // Analyzing a commit other than the one the user picked would make
          // the whole report a lie, so an unknown SHA fails here and the
          // request never reaches the pipeline.
          const commit = await resolveCommit(
            config.githubAppSecret,
            installationId,
            repository.fullName,
            requestedSha,
          );
          ({ headSha, baseSha, branch } = commit);
        } else {
          const resolution = await resolveRepoBranch(
            config.githubAppSecret,
            installationId,
            repository.fullName,
            repository.defaultBranch,
          );
          ({ headSha, baseSha, branch } = resolution);
        }
      } catch (err) {
        if (err instanceof UnknownCommitError) {
          throw new ApiError(
            'NOT_FOUND',
            `Commit ${requestedSha} is not on ${repository.fullName}. It may have been rewritten or force-pushed away.`,
          );
        }
        if (err instanceof EmptyHistoryError) {
          throw new ApiError('BAD_REQUEST', `${repository.fullName} has no commits to analyze`);
        }
        throw new ApiError(
          'INTERNAL',
          `GitHub could not be reached to resolve the commit: ${(err as Error).message}`,
        );
      }

      const deliveryId = `manual-${identity.userId.slice(0, 8)}-${headSha.slice(0, 12)}-${Date.now()}`;

      // Check for an existing in-progress investigation for this exact HEAD commit
      // to prevent duplicate tasks for the same SHA
      const existingInvs = await store.listInvestigations(repository.workspaceId, 20);
      const duplicate = existingInvs.find(
        (inv) =>
          inv.repositoryId === repositoryId &&
          inv.change.commitSha === headSha &&
          !['RESOLVED', 'REJECTED', 'FAILED'].includes(inv.status),
      );
      if (duplicate) {
        return reply.status(200).send({
          investigationId: duplicate.id,
          alreadyRunning: true,
          headSha,
          branch,
          selected: requestedSha !== null,
        });
      }

      // Build the Netra.CodeChange event — same shape as the GitHub webhook path
      const detail = {
        deliveryId,
        source: 'manual' as const,
        installationId,
        repository: {
          fullName: repository.fullName,
          githubId: repository.githubRepositoryId ?? null,
          defaultBranch: repository.defaultBranch,
          private: true, // conservative; overridden by actual repo metadata if needed
        },
        change: {
          commitSha: headSha,
          baseSha,
          branch,
          pullRequestNumber: null,
          title: `Manual analysis: ${branch} @ ${headSha.slice(0, 12)}`,
          author: identity.userId,
        },
        receivedAt: new Date().toISOString(),
      };

      // Put the event to EventBridge — the state machine picks it up and
      // runs CreateInvestigation (which writes the DynamoDB record) then
      // RunInvestigation (the Fargate task).
      const { EventBridgeClient, PutEventsCommand } = await import('@aws-sdk/client-eventbridge');
      const ebClient = new EventBridgeClient({ region: config.awsRegion });
      const ebResp = await ebClient.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: config.eventBusName,
              Source: 'netra.github',
              DetailType: 'Netra.CodeChange',
              Detail: JSON.stringify(detail),
              Resources: [`github-delivery/${deliveryId}`],
            },
          ],
        }),
      );

      if ((ebResp.FailedEntryCount ?? 0) > 0) {
        const entry = ebResp.Entries?.[0];
        throw new ApiError(
          'INTERNAL',
          `EventBridge rejected the investigation event: ${entry?.ErrorCode ?? 'unknown'}`,
        );
      }

      // The investigation ID is derived deterministically from the deliveryId
      // in CreateInvestigation Lambda — same logic as investigationIdFor()
      const compact = deliveryId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
      const investigationId = `inv_${compact}`;

      return reply.status(202).send({
        investigationId,
        headSha,
        baseSha,
        branch,
        repository: repository.fullName,
        alreadyRunning: false,
        // Tells the UI whether it is showing a commit the user picked or the
        // branch tip, so it never implies a choice that was not made.
        selected: requestedSha !== null,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/investigations/demo', async (request, reply) => {
    try {
      const identity = await identify(request.headers.authorization);
      const body = startDemoInvestigationRequestSchema.parse(request.body);
      await authorizeWorkspace(identity, body.workspaceId);

      const investigation = await service.startDemoInvestigation(identity, body.workspaceId);
      return reply.status(202).send(investigation);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/investigations', async (request, reply) => {
    try {
      const identity = await identify(request.headers.authorization);
      const query = listInvestigationsQuerySchema.parse(request.query);
      await authorizeWorkspace(identity, query.workspaceId);
      return reply.send(await store.listInvestigations(query.workspaceId, query.limit));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/investigations/:id', async (request, reply) => {
    try {
      const identity = await identify(request.headers.authorization);
      const { id } = request.params as { id: string };
      const investigation = await authorizeInvestigation(identity, id);

      const detail: InvestigationDetail = {
        investigation,
        findings: await store.listFindings(id),
        evidence: await store.listEvidence(id),
        verifications: await store.listVerifications(id),
        graph: await store.getGraph(id),
        remediation: await store.getRemediation(id),
        action: await store.getAction(id),
      };
      return reply.send(detail);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/investigations/:id/graph', async (request, reply) => {
    try {
      const identity = await identify(request.headers.authorization);
      const { id } = request.params as { id: string };
      await authorizeInvestigation(identity, id);
      const graph = await store.getGraph(id);
      if (!graph) throw new ApiError('NOT_FOUND', 'The blast radius is not available yet');
      return reply.send(graph);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/investigations/:id/evidence', async (request, reply) => {
    try {
      const identity = await identify(request.headers.authorization);
      const { id } = request.params as { id: string };
      await authorizeInvestigation(identity, id);
      return reply.send(await store.listEvidence(id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Live investigation events.
   *
   * The stream replays everything after `afterSeq` before going live, so a
   * client that connects late or reconnects sees the whole investigation.
   */
  app.get('/api/investigations/:id/events', async (request, reply) => {
    let unsubscribe: (() => void) | undefined;
    try {
      const identity = await identify(
        request.headers.authorization ?? tokenFromQuery(request.query),
      );
      const { id } = request.params as { id: string };
      const investigation = await authorizeInvestigation(identity, id);
      const afterSeq = Number((request.query as { afterSeq?: string }).afterSeq ?? 0);

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const write = (event: unknown) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      for (const event of await store.listEvents(id, Number.isFinite(afterSeq) ? afterSeq : 0)) {
        write(event);
      }

      unsubscribe = broker.subscribe(id, write);

      // Comment frames keep proxies from closing an idle connection.
      const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);

      request.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe?.();
      });

      if (['RESOLVED', 'REJECTED', 'FAILED'].includes(investigation.status)) {
        // Nothing further will arrive; let the client close cleanly.
        write({ type: 'stream_complete' });
      }
      return reply;
    } catch (error) {
      unsubscribe?.();
      return sendError(reply, error);
    }
  });

  app.post('/api/investigations/:id/approve', async (request, reply) => {
    try {
      const identity = await identify(request.headers.authorization);
      const { id } = request.params as { id: string };
      await authorizeInvestigation(identity, id);
      const body = approveRequestSchema.parse(request.body);
      const action = await service.approve(identity, id, body.actionId, body.note);
      return reply.send(action);
    } catch (error) {
      return sendError(reply, toApiError(error));
    }
  });

  app.post('/api/investigations/:id/reject', async (request, reply) => {
    try {
      const identity = await identify(request.headers.authorization);
      const { id } = request.params as { id: string };
      await authorizeInvestigation(identity, id);
      const body = rejectRequestSchema.parse(request.body);
      const action = await service.reject(identity, id, body.actionId, body.reason);
      return reply.send(action);
    } catch (error) {
      return sendError(reply, toApiError(error));
    }
  });

  app.get('/api/audit', async (request, reply) => {
    try {
      const identity = await identify(request.headers.authorization);
      const { workspaceId } = request.query as { workspaceId?: string };
      if (!workspaceId) throw new ApiError('BAD_REQUEST', 'workspaceId is required');
      await authorizeWorkspace(identity, workspaceId);
      return reply.send(await store.listAudit(workspaceId, 100));
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

/**
 * EventSource cannot set request headers, so the browser passes its token as a
 * query parameter. The scheme is carried alongside it and the token is verified
 * by exactly the same code path as a header would be.
 */
function tokenFromQuery(query: unknown): string | undefined {
  const { token, scheme } = (query ?? {}) as { token?: string; scheme?: string };
  if (!token) return undefined;
  return `${scheme === 'demo' ? 'Demo' : 'Bearer'} ${token}`;
}

function toApiError(error: unknown): unknown {
  if (error instanceof ApprovalError) return new ApiError(error.code, error.message);
  if (error instanceof Error && error.name === 'InvalidTransitionError') {
    return new ApiError('CONFLICT', 'This investigation is no longer awaiting a decision.');
  }
  return error;
}

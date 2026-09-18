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
    await authorizeWorkspace(identity, investigation.workspaceId);
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

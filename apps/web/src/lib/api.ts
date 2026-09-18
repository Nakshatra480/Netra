import type {
  Action,
  Investigation,
  InvestigationDetail,
  Workspace,
} from '@netra/domain';

/**
 * Typed client for the Netra API.
 *
 * All requests carry the session token; none of them carry a user id, because
 * the server derives identity from the token and would ignore one anyway.
 */

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787';

export interface Session {
  readonly token: string;
  readonly scheme: 'demo' | 'bearer';
  readonly workspaceId: string;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; session?: Session } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.session) {
    headers.authorization = `${
      options.session.scheme === 'demo' ? 'Demo' : 'Bearer'
    } ${options.session.token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    // A network failure needs an actionable message, not "Failed to fetch".
    throw new ApiError(
      'NETWORK',
      'Could not reach the Netra API. Check that the backend is running.',
      0,
    );
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    throw new ApiError(
      body?.error?.code ?? 'INTERNAL',
      body?.error?.message ?? `The request failed with status ${response.status}.`,
      response.status,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  health: () =>
    request<{ status: string; cognitoConfigured: boolean; demoModeEnabled: boolean }>(
      '/api/health',
    ),

  /**
   * Return the caller's workspace, creating it on first sign-in.
   *
   * The server derives the owner from the verified token, so the workspace a
   * caller receives is always their own.
   */
  ensureWorkspace: (session: Session) =>
    request<Workspace>('/api/workspaces/mine', { method: 'POST', session }),

  startDemoSession: () =>
    request<{ token: string; workspace: Workspace }>('/api/demo/session', { method: 'POST' }),

  listInvestigations: (session: Session) =>
    request<Investigation[]>(
      `/api/investigations?workspaceId=${encodeURIComponent(session.workspaceId)}`,
      { session },
    ),

  startDemoInvestigation: (session: Session) =>
    request<Investigation>('/api/investigations/demo', {
      method: 'POST',
      session,
      body: { workspaceId: session.workspaceId, scenario: 'credential-exposure' },
    }),

  getInvestigation: (session: Session, id: string) =>
    request<InvestigationDetail>(`/api/investigations/${encodeURIComponent(id)}`, { session }),

  approve: (session: Session, id: string, actionId: string, note?: string) =>
    request<Action>(`/api/investigations/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      session,
      body: { actionId, ...(note ? { note } : {}) },
    }),

  reject: (session: Session, id: string, actionId: string, reason: string) =>
    request<Action>(`/api/investigations/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      session,
      body: { actionId, reason },
    }),

  /** URL of the live event stream. EventSource cannot send headers. */
  eventStreamUrl: (session: Session, id: string, afterSeq: number) =>
    `${BASE_URL}/api/investigations/${encodeURIComponent(id)}/events` +
    `?token=${encodeURIComponent(session.token)}&scheme=${session.scheme}&afterSeq=${afterSeq}`,
};

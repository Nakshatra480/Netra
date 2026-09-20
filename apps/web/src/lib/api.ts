import type {
  Action,
  Investigation,
  InvestigationDetail,
  Repository,
  Workspace,
} from '@netra/domain';

/**
 * Typed client for the Netra API.
 *
 * All requests carry the session token; none of them carry a user id, because
 * the server derives identity from the token and would ignore one anyway.
 */

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787';

/**
 * The approval endpoint is a separate API.
 *
 * Approving is the only browser action that changes a repository, so it is
 * served by its own Lambda that transitions the record under a condition and
 * launches the remediation task. The read API cannot do that work: it has no
 * permission to run an ECS task, and the remediation itself runs on Fargate.
 */
const APPROVAL_BASE_URL = import.meta.env.VITE_APPROVAL_API_URL ?? '';

export class ApprovalNotConfigured extends Error {
  constructor() {
    super(
      'The approval endpoint is not configured for this deployment. Set VITE_APPROVAL_API_URL to the Netra approval API.',
    );
    this.name = 'ApprovalNotConfigured';
  }
}

export interface Session {
  /**
   * The Cognito **access** token. This is what the read API verifies
   * (`tokenUse: 'access'`), so it is the token every `/api/*` call carries.
   */
  readonly token: string;
  readonly scheme: 'demo' | 'bearer';
  readonly workspaceId: string;
  /**
   * The Cognito **ID** token, carried only for the approval endpoint.
   *
   * That endpoint sits behind an API Gateway JWT authorizer configured with
   * `audience = <app client id>`. Only the ID token carries `aud`; a Cognito
   * access token does not, so the access token is the wrong credential there.
   * Absent on demo sessions and on sessions restored from before this existed.
   */
  readonly idToken?: string | undefined;
}

/** One commit as the picker shows it. Metadata only — never file content. */
export interface GhCommit {
  readonly sha: string;
  readonly shortSha: string;
  readonly message: string;
  readonly authorName: string;
  readonly authoredAt: string;
}

/** What the server says it started, including which commit it actually took. */
export interface AnalyzeResult {
  readonly investigationId: string;
  readonly headSha: string;
  readonly baseSha?: string | null;
  readonly branch: string;
  readonly repository: string;
  readonly alreadyRunning: boolean;
  /** True when the commit came from the picker rather than being the branch tip. */
  readonly selected?: boolean;
}

/** Repository metadata returned by /api/github/* routes (never includes a token). */
export interface GhRepoMeta {
  githubRepositoryId: number;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  /** Populated by GET /api/github/repos (stored server-side installation). */
  installationId?: number;
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

  /**
   * Approve the remediation and launch the real pipeline.
   *
   * Posts to the approval API, which performs a guarded transition
   * (ACTION PENDING -> APPROVED, META AWAITING_APPROVAL -> REMEDIATING) and
   * starts the Fargate task that applies the diff, pushes a branch and opens
   * the pull request. A second click loses the condition and is reported as a
   * conflict rather than starting a second remediation.
   */
  approveRemediation: async (
    session: Session,
    id: string,
    actionId: string,
    note?: string,
  ): Promise<{ status: string; taskArn?: string }> => {
    if (!APPROVAL_BASE_URL) throw new ApprovalNotConfigured();

    // Approval pushes a commit to a real repository, so it is gated on a real
    // Cognito token. The demo session's token is not one, and the endpoint
    // would reject it — say so here rather than showing a raw 401.
    if (session.scheme !== 'bearer') {
      throw new ApiError(
        'UNAUTHENTICATED',
        'Approving a remediation requires a signed-in account. The demo session cannot open pull requests.',
        401,
      );
    }

    // The authorizer matches `aud` against the app client id, and only the ID
    // token has that claim. Sending the access token here would be rejected by
    // the gateway with an opaque 401.
    if (!session.idToken) {
      throw new ApiError(
        'UNAUTHENTICATED',
        'Your session predates the approval sign-in requirement. Sign in again to approve this remediation.',
        401,
      );
    }

    let response: Response;
    try {
      response = await fetch(
        `${APPROVAL_BASE_URL.replace(/\/$/, '')}/investigations/${encodeURIComponent(id)}/approve`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${session.idToken}`,
          },
          body: JSON.stringify({ actionId, ...(note ? { note } : {}) }),
        },
      );
    } catch {
      throw new ApiError('NETWORK', 'Could not reach the approval service.', 0);
    }

    const body = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string }; status?: string; taskArn?: string }
      | null;

    if (!response.ok) {
      // API Gateway's own rejections have no Netra error body.
      const fallback =
        response.status === 401
          ? 'Your session has expired. Sign in again to approve this remediation.'
          : response.status === 403
            ? 'You do not have access to approve this investigation.'
            : `Approval failed with status ${response.status}.`;
      throw new ApiError(
        body?.error?.code ?? (response.status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL'),
        body?.error?.message ?? fallback,
        response.status,
      );
    }
    return { status: body?.status ?? 'REMEDIATING', ...(body?.taskArn ? { taskArn: body.taskArn } : {}) };
  },

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

  /**
   * Verify a GitHub App installation server-side and return accessible repos.
   * The browser never sees an installation token — only repository metadata.
   * installationId from the GitHub callback URL is verified by the server.
   */
  linkInstallation: (session: Session, installationId: number) =>
    request<GhRepoMeta[]>('/api/github/link-installation', {
      method: 'POST',
      session,
      body: { installationId },
    }),

  /**
   * List GitHub repos for the authenticated workspace using the stored installation.
   * Returns [] (with connected=false) if GitHub has not been connected yet.
   * The browser never receives an installation token.
   */
  getGitHubRepos: async (session: Session): Promise<{ repos: GhRepoMeta[]; connected: boolean; githubUsername?: string }> => {
    const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${session.token}`,
    };
    let response: Response;
    try {
      response = await fetch(`${BASE}/api/github/repos`, { headers });
    } catch {
      return { repos: [], connected: false };
    }
    if (!response.ok) return { repos: [], connected: false };
    const connected = response.headers.get('X-GitHub-Connected') === 'true';
    const githubUsername = response.headers.get('X-GitHub-Username') ?? undefined;
    const repos = (await response.json()) as GhRepoMeta[];
    return {
      repos,
      connected,
      ...(githubUsername ? { githubUsername } : {}),
    };
  },

  /**
   * Create a server-side OAuth state token bound to the current Cognito session.
   * Returns the state, clientId, and callbackUrl needed to build the GitHub
   * authorization URL. Nothing sensitive is returned — clientId is a public App ID.
   */
  createGitHubOAuthState: (session: Session) =>
    request<{ state: string; clientId: string; callbackUrl: string }>(
      '/api/github/oauth/state',
      { method: 'POST', session },
    ),

  /**
   * Send the GitHub OAuth code + state to the backend for server-side exchange.
   * The backend validates state, exchanges code for a user token (server-side only),
   * identifies the GitHub user, finds installations, and stores the association.
   * Returns safe GitHub user metadata — never a token.
   */
  exchangeGitHubOAuth: (
    session: Session,
    params: { code: string; state: string; redirectUri: string },
  ) =>
    request<{
      githubUsername: string;
      githubUserId: number;
      installations: { id: number; account: string; accountType: string; repositorySelection: string }[];
      noInstallation: boolean;
    }>('/api/github/oauth/exchange', { method: 'POST', session, body: params }),

  /** Connect a GitHub repository to the authenticated workspace. */
  createRepository: (
    session: Session,
    data: {
      githubInstallationId: number;
      githubRepositoryId: number;
      fullName: string;
      defaultBranch: string;
    },
  ) => request<Repository>('/api/repositories', { method: 'POST', session, body: data }),

  listRepositories: (session: Session) =>
    request<Repository[]>(
      `/api/repositories?workspaceId=${encodeURIComponent(session.workspaceId)}`,
      { session },
    ),

  getRepository: (session: Session, id: string) =>
    request<Repository>(`/api/repositories/${encodeURIComponent(id)}`, { session }),

  /**
   * Trigger a real investigation for the latest HEAD commit of a GitHub repository.
   *
   * Security: the backend resolves the HEAD SHA from GitHub using the App installation
   * token. The frontend never supplies commit SHAs. Returns investigationId to navigate to.
   */
  /**
   * Start a real investigation of a repository.
   *
   * With no `commitSha` this analyzes the current default-branch HEAD. With
   * one, the server proves that exact commit exists and analyzes it — it never
   * falls back to HEAD, because analyzing a different commit than the one that
   * was chosen would make the report describe code nobody asked about.
   */
  analyzeRepository: (session: Session, repositoryId: string, commitSha?: string) =>
    request<AnalyzeResult>(`/api/repositories/${encodeURIComponent(repositoryId)}/analyze`, {
      method: 'POST',
      session,
      ...(commitSha ? { body: { commitSha } } : {}),
    }),

  /** Real commit history for the picker. Metadata only. */
  listCommits: (session: Session, repositoryId: string, limit = 30) =>
    request<{ commits: GhCommit[]; branch: string; empty?: boolean }>(
      `/api/repositories/${encodeURIComponent(repositoryId)}/commits?limit=${limit}`,
      { session },
    ),

  /**
   * Run the Live Demo: a real investigation of the pinned fixture repository.
   *
   * Idempotent — the fixture commit is fixed, so every click resolves to the
   * same investigation instead of starting another one.
   */
  runDemo: (session: Session) =>
    request<AnalyzeResult & { status?: string }>('/api/demo/run', {
      method: 'POST',
      session,
    }),

  eventStreamUrl: (session: Session, id: string, afterSeq: number) =>
    `${BASE_URL}/api/investigations/${encodeURIComponent(id)}/events` +
    `?token=${encodeURIComponent(session.token)}&scheme=${session.scheme}&afterSeq=${afterSeq}`,
};

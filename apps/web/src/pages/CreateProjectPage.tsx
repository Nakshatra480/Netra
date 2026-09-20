/**
 * Create Project page — /app/projects/new
 *
 * Implements the correct GitHub App OAuth user-authorization flow:
 *
 *   1. GET /api/github/repos → check if GitHub already connected
 *
 *   Already connected:
 *     → Show inline repo picker (no re-authorization needed)
 *
 *   Not connected:
 *     2. POST /api/github/oauth/state → get server-issued state + clientId
 *     3. Redirect to: https://github.com/login/oauth/authorize?client_id=...&state=...
 *     4. GitHub redirects to /auth/github-callback?code=...&state=...
 *     5. GitHubCallbackPage calls POST /api/github/oauth/exchange (server-side exchange)
 *     6. Navigate to /app/repositories/new with repos
 *
 * Security:
 *  - State token is server-generated, bound to Cognito userId, single-use
 *  - clientId is a public App identifier — safe to use in URL
 *  - OAuth code exchange is backend-only; no token ever reaches the browser
 *  - GitHub private key and client_secret stay in Secrets Manager
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  GitBranch,
  Github,
  Lock,
  Loader2,
  Search,
  Unlock,
  UserCheck,
} from 'lucide-react';
import { api, ApiError, type GhRepoMeta, type Session } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button, Panel, Skeleton } from '@/components/primitives';

interface Props {
  session: Session;
}

type State =
  | { phase: 'loading' }
  | { phase: 'not-connected' }
  | { phase: 'connecting' } // mid-redirect to GitHub
  | { phase: 'connected'; githubUsername?: string; repos: GhRepoMeta[] }
  | { phase: 'error'; message: string };

export function CreateProjectPage({ session }: Props) {
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<GhRepoMeta | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Check if GitHub is already connected for this workspace
  useEffect(() => {
    if (session.scheme === 'demo') {
      setState({ phase: 'not-connected' }); // demo can't use GitHub
      return;
    }
    api
      .getGitHubRepos(session)
      .then(({ repos, connected, githubUsername }) => {
        if (connected) {
          setState({ phase: 'connected', repos, ...(githubUsername ? { githubUsername } : {}) });
        } else {
          setState({ phase: 'not-connected' });
        }
      })
      .catch(() => setState({ phase: 'not-connected' }));
  }, [session]);

  /**
   * Start the GitHub App OAuth user-authorization flow.
   *
   * 1. Call POST /api/github/oauth/state → get server-issued state + clientId
   * 2. Build the GitHub authorization URL (standard OAuth 2.0 authorize endpoint)
   * 3. Full page navigation to GitHub (NOT a popup or new tab — GitHub requires
   *    the redirect to happen in the same window)
   *
   * The GitHub authorization URL format:
   *   https://github.com/login/oauth/authorize
   *     ?client_id=<APP_CLIENT_ID>
   *     &redirect_uri=<CALLBACK_URL>
   *     &state=<SERVER_ISSUED_STATE>
   *
   * This is NOT https://github.com/apps/netra-security which is the management page.
   */
  const handleConnectGitHub = async () => {
    setState({ phase: 'connecting' });
    try {
      const { state: oauthState, clientId, callbackUrl } = await api.createGitHubOAuthState(session);

      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        state: oauthState,
      });

      // Full page navigation — GitHub's OAuth flow requires same-window redirect
      window.location.href = `https://github.com/login/oauth/authorize?${params.toString()}`;
    } catch (err) {
      setState({
        phase: 'error',
        message: err instanceof ApiError ? err.message : 'Failed to start GitHub authorization.',
      });
    }
  };

  const filteredRepos =
    state.phase === 'connected'
      ? state.repos.filter(
          (r) =>
            r.fullName.toLowerCase().includes(query.toLowerCase()) ||
            (r.description?.toLowerCase().includes(query.toLowerCase()) ?? false),
        )
      : [];

  const handleCreate = async () => {
    if (!selected || state.phase !== 'connected') return;
    const installationId = selected.installationId;
    if (!installationId) {
      setCreateError('Installation ID missing. Please reconnect GitHub.');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const repository = await api.createRepository(session, {
        githubInstallationId: installationId,
        githubRepositoryId: selected.githubRepositoryId,
        fullName: selected.fullName,
        defaultBranch: selected.defaultBranch,
      });
      void navigate(`/app/repositories/${repository.id}`, { replace: true });
    } catch (err) {
      setCreateError(
        err instanceof ApiError ? err.message : 'Failed to create the project. Please try again.',
      );
      setCreating(false);
    }
  };

  // ── Reconnect GitHub handler (for already-connected users who want to switch)
  const handleReconnect = async () => {
    setState({ phase: 'connecting' });
    try {
      const { state: oauthState, clientId, callbackUrl } = await api.createGitHubOAuthState(session);
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        state: oauthState,
      });
      window.location.href = `https://github.com/login/oauth/authorize?${params.toString()}`;
    } catch (err) {
      setState({
        phase: 'error',
        message: err instanceof ApiError ? err.message : 'Failed to start GitHub authorization.',
      });
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      {/* Back nav */}
      <button
        onClick={() => void navigate('/app')}
        className="inline-flex w-fit items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
      >
        <ArrowLeft size={14} />
        Dashboard
      </button>

      {/* Page header */}
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Create a project</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Choose a GitHub repository for Netra to investigate.
        </p>
      </div>

      {/* ── STATE: Demo session */}
      {session.scheme === 'demo' && (
        <Panel className="p-6 text-center">
          <Github size={28} className="mx-auto mb-3 text-ink-subtle" />
          <h2 className="text-sm font-semibold">GitHub projects require a signed-in account</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Sign in with Google to connect a real repository.
          </p>
          <Button variant="secondary" className="mt-4" onClick={() => void navigate('/signin')}>
            Sign in
          </Button>
        </Panel>
      )}

      {/* ── STATE: Loading */}
      {state.phase === 'loading' && (
        <div className="space-y-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      )}

      {/* ── STATE: Connecting (mid-redirect to GitHub) */}
      {state.phase === 'connecting' && (
        <Panel className="p-8 text-center">
          <div className="flex justify-center">
            <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-surface-raised">
              <Github size={24} className="text-ink-muted" />
              <span className="absolute -right-1 -top-1">
                <Loader2 size={16} className="animate-spin text-state-active" />
              </span>
            </div>
          </div>
          <h2 className="mt-4 text-sm font-semibold">Connecting GitHub…</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Redirecting to GitHub for authorization.
          </p>
        </Panel>
      )}

      {/* ── STATE: Error */}
      {state.phase === 'error' && (
        <Panel className="p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-state-severe" />
            <div>
              <h2 className="text-sm font-semibold">Connection failed</h2>
              <p className="mt-1 text-sm text-ink-muted">{state.message}</p>
              <button
                onClick={() => void handleConnectGitHub()}
                className="mt-3 text-sm text-state-active hover:underline"
              >
                Try again
              </button>
            </div>
          </div>
        </Panel>
      )}

      {/* ── STATE: GitHub not connected */}
      {state.phase === 'not-connected' && session.scheme !== 'demo' && (
        <Panel className="overflow-hidden border-[color-mix(in_oklch,var(--color-state-active)_25%,transparent)]">
          <div className="flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--color-state-active)_15%,transparent)]">
              <Github size={20} className="text-state-active" />
            </div>
            <div className="flex-1">
              <h2 className="text-sm font-semibold">Connect your GitHub account</h2>
              <p className="mt-1 text-sm text-ink-muted">
                Authorize Netra Security to access your repositories. Netra will ask which
                repositories to grant access to — nothing is accessed without your selection.
              </p>
            </div>
            <button
              id="connect-github-btn"
              onClick={() => void handleConnectGitHub()}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-state-active px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90"
            >
              <Github size={15} />
              Connect GitHub
            </button>
          </div>

          <div className="border-t border-line bg-surface-raised px-6 py-3">
            <p className="text-[0.7rem] text-ink-subtle">
              Uses the <strong>Netra Security</strong> GitHub App. Authorization tokens stay
              server-side and are never stored in your browser.
            </p>
          </div>
        </Panel>
      )}

      {/* ── STATE: Connected — inline repo picker */}
      {state.phase === 'connected' && (
        <>
          {/* Connected-as header */}
          {state.githubUsername && (
            <div className="flex items-center justify-between rounded-lg border border-line bg-surface-raised px-4 py-2.5">
              <div className="flex items-center gap-2">
                <UserCheck size={14} className="text-state-resolved" />
                <span className="text-sm text-ink">
                  GitHub connected as{' '}
                  <strong className="font-semibold">@{state.githubUsername}</strong>
                </span>
              </div>
              <button
                onClick={() => void handleReconnect()}
                className="text-xs text-ink-muted transition-colors hover:text-state-active"
              >
                Change account
              </button>
            </div>
          )}

          {/* Search */}
          <div className="relative">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle"
            />
            <input
              id="repo-search"
              type="text"
              placeholder="Search repositories…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface-raised py-2.5 pl-9 pr-4 text-sm outline-none placeholder:text-ink-subtle focus:border-state-active focus:ring-1 focus:ring-state-active"
            />
          </div>

          {/* Repository list */}
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            {state.repos.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-12 text-center">
                <Github size={28} className="text-ink-subtle" />
                <div>
                  <p className="text-sm font-medium">
                    Netra Security doesn't have access to any repositories yet.
                  </p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    Grant repository access from GitHub.
                  </p>
                </div>
                <button
                  onClick={() => void handleReconnect()}
                  className="inline-flex items-center gap-1.5 text-sm text-state-active hover:underline"
                >
                  Manage GitHub access →
                </button>
              </div>
            ) : filteredRepos.length === 0 ? (
              <div className="py-10 text-center text-sm text-ink-muted">
                No repositories match <strong>{query}</strong>
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {filteredRepos.map((repo) => {
                  const isSelected = selected?.fullName === repo.fullName;
                  return (
                    <li key={repo.fullName}>
                      <button
                        id={`repo-${repo.fullName.replace('/', '-')}`}
                        onClick={() => setSelected(isSelected ? null : repo)}
                        className={cn(
                          'group flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors',
                          isSelected
                            ? 'bg-[color-mix(in_oklch,var(--color-state-active)_10%,transparent)]'
                            : 'hover:bg-surface-raised',
                        )}
                      >
                        <div className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                          {isSelected ? (
                            <CheckCircle2 size={16} className="text-state-active" />
                          ) : (
                            <div className="h-4 w-4 rounded-full border-2 border-line group-hover:border-ink-muted" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="text-sm font-medium text-ink">
                              {repo.fullName}
                            </span>
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.65rem] font-medium',
                                repo.private
                                  ? 'bg-surface-raised text-ink-muted'
                                  : 'bg-[color-mix(in_oklch,var(--color-state-active)_12%,transparent)] text-state-active',
                              )}
                            >
                              {repo.private ? <Lock size={9} /> : <Unlock size={9} />}
                              {repo.private ? 'Private' : 'Public'}
                            </span>
                          </div>
                          {repo.description && (
                            <p className="mt-0.5 truncate text-xs text-ink-muted">
                              {repo.description}
                            </p>
                          )}
                          <div className="mt-1 flex items-center gap-1 text-[0.68rem] text-ink-subtle">
                            <GitBranch size={10} />
                            <span>{repo.defaultBranch}</span>
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Create error */}
          {createError && (
            <div className="flex items-start gap-2 rounded-lg border border-[color-mix(in_oklch,var(--color-state-severe)_30%,transparent)] bg-[color-mix(in_oklch,var(--color-state-severe)_8%,transparent)] px-4 py-3 text-sm text-state-severe">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              {createError}
            </div>
          )}

          {/* Footer actions */}
          <div className="flex items-center justify-between gap-3">
            <button
              onClick={() => void handleReconnect()}
              className="text-sm text-ink-muted transition-colors hover:text-ink"
            >
              Add more repositories →
            </button>
            <button
              id="analyze-repo-btn"
              onClick={() => void handleCreate()}
              disabled={!selected || creating}
              className={cn(
                'inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold transition-all',
                selected && !creating
                  ? 'bg-state-active text-white hover:opacity-90 shadow-sm'
                  : 'cursor-not-allowed bg-surface-raised text-ink-subtle',
              )}
            >
              {creating
                ? 'Creating project…'
                : selected
                  ? `Import & Analyze ${selected.name}`
                  : 'Select a repository'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * GitHub OAuth callback page — /auth/github-callback
 *
 * GitHub redirects here after the user authorizes the Netra Security GitHub App.
 *
 * Correct OAuth flow (new):
 *   GitHub → /auth/github-callback?code=<auth-code>&state=<state>
 *
 *   1. Extract code + state from the URL
 *   2. Send code + state to POST /api/github/oauth/exchange
 *   3. Backend validates state (bound to Cognito userId), exchanges code server-side,
 *      identifies the GitHub user, finds their Netra Security installations
 *   4. Navigate to /app/repositories/new with repos in navigation state
 *
 * Legacy App-installation-only flow (fallback):
 *   GitHub → /auth/github-callback?installation_id=...&setup_action=install
 *   Uses POST /api/github/link-installation (backward compat)
 *
 * Security:
 *  - Code exchange is backend-only: no GitHub token ever reaches the browser
 *  - State is server-generated, bound to Cognito userId, single-use
 *  - A valid Cognito Bearer token is required to call the exchange endpoint
 *  - Cancelled installs (setup_action=delete) navigate back gracefully
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Github, Loader2, XCircle, AlertTriangle } from 'lucide-react';
import { api, ApiError, type Session } from '@/lib/api';

interface Props {
  session: Session;
}

type Phase =
  | 'exchanging'
  | 'no-installation'
  | 'error';

interface PageState {
  phase: Phase;
  error?: string;
  githubUsername?: string;
}

export function GitHubCallbackPage({ session }: Props) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const didRun = useRef(false);
  const [state, setState] = useState<PageState>({ phase: 'exchanging' });

  const code = searchParams.get('code');
  const oauthState = searchParams.get('state');
  const setupAction = searchParams.get('setup_action');
  const rawInstallationId = searchParams.get('installation_id');

  useEffect(() => {
    if (didRun.current) return;
    didRun.current = true;

    // ── Case 1: Cancelled install (user clicked Cancel on GitHub)
    if (setupAction === 'delete' || setupAction === 'cancel') {
      void navigate('/app', { replace: true });
      return;
    }

    // ── Case 2: New OAuth flow — code + state present
    if (code && oauthState) {
      const redirectUri = `${window.location.origin}/auth/github-callback`;

      api
        .exchangeGitHubOAuth(session, { code, state: oauthState, redirectUri })
        .then((result) => {
          if (result.noInstallation) {
            // GitHub user authorized but Netra Security App isn't installed on any account
            setState({ phase: 'no-installation', githubUsername: result.githubUsername });
            return;
          }

          // Exchange successful — load repos and go to picker
          return api.getGitHubRepos(session).then(({ repos }) => {
            // installationId is present on every repo item from the API;
            // RepositoryPickerPage requires it in navigation state.
            const installationId = repos[0]?.installationId ?? null;
            void navigate('/app/repositories/new', {
              replace: true,
              state: { repos, installationId, githubUsername: result.githubUsername },
            });
          });
        })
        .catch((err: unknown) => {
          setState({
            phase: 'error',
            error:
              err instanceof ApiError
                ? err.message
                : 'GitHub authorization failed. Please try again.',
          });
        });
      return;
    }

    // ── Case 3: Legacy installation-only flow (no code/state, just installation_id)
    // This handles the old flow where GitHub App was set up without OAuth on install.
    if (rawInstallationId) {
      const installationId = parseInt(rawInstallationId, 10);
      if (!Number.isFinite(installationId) || installationId <= 0) {
        setState({ phase: 'error', error: 'The installation ID in the callback URL is not valid.' });
        return;
      }

      api
        .linkInstallation(session, installationId)
        .then((repos) => {
          void navigate('/app/repositories/new', {
            replace: true,
            state: { repos, installationId },
          });
        })
        .catch((err: unknown) => {
          setState({
            phase: 'error',
            error:
              err instanceof ApiError
                ? err.message
                : 'Failed to verify the GitHub App installation.',
          });
        });
      return;
    }

    // ── Case 4: No recognizable parameters — go back to dashboard
    void navigate('/app', { replace: true });
  }, [session, code, oauthState, setupAction, rawInstallationId, navigate]);

  // ── No Netra Security installation found
  if (state.phase === 'no-installation') {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="mx-auto max-w-md space-y-4 text-center">
          <div className="flex justify-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-raised">
              <AlertTriangle size={24} className="text-state-attention" />
            </div>
          </div>
          <h1 className="text-lg font-semibold">Netra Security isn't installed yet</h1>
          {state.githubUsername && (
            <p className="text-sm text-ink-muted">
              GitHub account <strong>@{state.githubUsername}</strong> doesn't have Netra Security
              installed on any repositories.
            </p>
          )}
          <p className="text-sm text-ink-muted">
            Install the Netra Security GitHub App to grant access to your repositories.
          </p>
          <div className="flex justify-center gap-3">
            <a
              href={`https://github.com/apps/netra-security/installations/new`}
              className="inline-flex items-center gap-2 rounded-lg bg-state-active px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90"
            >
              <Github size={15} />
              Install Netra Security
            </a>
            <button
              onClick={() => void navigate('/app')}
              className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface-raised px-4 py-2 text-sm font-medium transition-colors hover:bg-line"
            >
              Back to Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Error
  if (state.phase === 'error') {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="mx-auto max-w-md space-y-4 text-center">
          <div className="flex justify-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--color-state-severe)_15%,transparent)]">
              <XCircle size={28} className="text-state-severe" />
            </div>
          </div>
          <h1 className="text-lg font-semibold">GitHub connection failed</h1>
          <p className="text-sm text-ink-muted">{state.error}</p>
          <button
            onClick={() => void navigate('/app/projects/new')}
            className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface-raised px-4 py-2 text-sm font-medium transition-colors hover:bg-line"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  // ── Exchanging (loading)
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="mx-auto max-w-md space-y-4 text-center">
        <div className="flex justify-center">
          <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-surface-raised">
            <Github size={24} className="text-ink-muted" />
            <span className="absolute -right-1 -top-1">
              <Loader2 size={16} className="animate-spin text-state-active" />
            </span>
          </div>
        </div>
        <h1 className="text-lg font-semibold">Verifying GitHub authorization…</h1>
        <p className="text-sm text-ink-muted">
          Identifying your GitHub account and loading your repositories.
        </p>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ShieldHalf } from 'lucide-react';
import { handleCallback, decodeIdToken } from '@/lib/auth';
import { api } from '@/lib/api';
import {
  saveClaims,
  saveRefreshToken,
  saveSession,
  tokensToSession,
} from '@/lib/session';
import type { Session } from '@/lib/api';

/**
 * Cognito authorization-code callback handler.
 *
 * Cognito redirects here after Google sign-in:
 *   /auth/callback?code=...&state=...
 *
 * This page:
 *   1. Exchanges the code for tokens (PKCE)
 *   2. Fetches or creates the user's Netra workspace
 *   3. Saves the session and ID claims
 *   4. Redirects to the intended destination
 *
 * On any error, shows a clean message with a retry link.
 */
export function AuthCallbackPage({
  onSession,
}: {
  onSession: (session: Session) => void;
}) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    // React StrictMode double-invokes effects; the code is single-use, so
    // guard against a second run.
    if (ran.current) return;
    ran.current = true;

    void (async () => {
      try {
        // 1. Exchange authorization code for tokens
        const { tokens, redirectTo } = await handleCallback(searchParams);

        // 2. Decode ID token claims for display (not identity)
        const claims = decodeIdToken(tokens.idToken);

        // 3. Ensure the user has a Netra workspace
        //    POST /api/workspaces/mine derives the userId from the verified JWT
        const partialSession: Session = {
          token: tokens.accessToken,
          scheme: 'bearer',
          workspaceId: '__pending__',
        };
        const workspace = await api.ensureWorkspace(partialSession);

        // 4. Build the full session
        const session = tokensToSession(tokens, workspace.id);

        // 5. Persist everything
        saveSession(session);
        saveRefreshToken(tokens.refreshToken);
        saveClaims(claims);

        // 6. Hand the session up to App and navigate
        onSession(session);
        navigate(redirectTo, { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Sign-in could not be completed.');
      }
    })();
  }, [searchParams, navigate, onSession]);

  if (error) {
    return (
      <div className="grid min-h-dvh place-items-center bg-canvas px-6">
        <div className="w-full max-w-sm text-center">
          <div className="mb-4 flex justify-center">
            <ShieldHalf size={24} className="text-state-active" />
          </div>
          <h1 className="text-base font-semibold text-ink">Sign-in failed</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">{error}</p>
          <div className="mt-6 flex justify-center gap-3">
            <a
              href="/signin"
              className="rounded-lg bg-surface-raised px-4 py-2 text-sm font-medium text-ink hover:bg-line focus-visible:outline-2 focus-visible:outline-state-active"
            >
              Try again
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-canvas">
      <div className="flex flex-col items-center gap-4">
        <ShieldHalf size={24} className="animate-pulse text-state-active" />
        <p className="text-sm text-ink-muted">Completing sign-in…</p>
      </div>
    </div>
  );
}

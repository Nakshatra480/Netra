import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageLoader } from '@/components/PageLoader';
import { NetraLogoIcon } from '@/components/NetraLogo';
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
        <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
          <NetraLogoIcon size={64} />
          <div>
            <h1 className="text-[1.125rem] font-semibold text-ink">Sign-in failed</h1>
            <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-muted">{error}</p>
          </div>
          <a
            href="/signin"
            className="rounded-control border border-line-strong bg-surface px-5 py-2.5 text-[0.9375rem] font-medium text-ink transition-colors hover:bg-surface-raised"
          >
            Try again
          </a>
        </div>
      </div>
    );
  }

  return <PageLoader label="Completing sign-in…" sublabel="Securing your session, just a moment." />;
}

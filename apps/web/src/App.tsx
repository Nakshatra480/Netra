import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Navigate,
  Route,
  BrowserRouter as Router,
  Routes,
  useLocation,
} from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { AuthCallbackPage } from '@/pages/AuthCallbackPage';
import { CommandCenterPage } from '@/pages/CommandCenterPage';
import { CreateProjectPage } from '@/pages/CreateProjectPage';
import { GitHubCallbackPage } from '@/pages/GitHubCallbackPage';

import { LandingPage } from '@/pages/LandingPage';
import { RepositoryPickerPage } from '@/pages/RepositoryPickerPage';
import { PrReviewPage } from '@/pages/PrReviewPage';
import { RepositoryPage } from '@/pages/RepositoryPage';
import { SignInPage } from '@/pages/SignInPage';
import { ActivityPage, SettingsPage } from '@/pages/PlaceholderPages';
import type { Session } from '@/lib/api';
import { api } from '@/lib/api';
import { MotionProvider, motion, useReducedMotion } from '@/components/motion';
import { refreshSession } from '@/lib/auth';
import {
  clearSession,
  loadRefreshToken,
  loadSession,
  saveRefreshToken,
  saveSession,
} from '@/lib/session';

const InvestigationPage = lazy(() =>
  import('@/pages/InvestigationPage').then((m) => ({ default: m.InvestigationPage })),
);

/** Shown while the report chunk loads. */
function RouteFallback() {
  return (
    <div className="mx-auto max-w-5xl space-y-4 py-10">
      <div className="h-8 w-64 animate-pulse rounded bg-surface-sunken" />
      <div className="h-40 w-full animate-pulse rounded-panel bg-surface-sunken" />
      <div className="h-64 w-full animate-pulse rounded-panel bg-surface-sunken" />
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const refreshing = useRef(false);

  // Persist session changes (only if not a teardown).
  useEffect(() => {
    if (session) saveSession(session);
  }, [session]);

  // On app load: silently refresh an expired Cognito access token.
  // Only runs for real (bearer) sessions — demo tokens are self-contained.
  useEffect(() => {
    if (session?.scheme !== 'bearer') return;
    if (refreshing.current) return;
    refreshing.current = true;

    const storedRefresh = loadRefreshToken();
    if (!storedRefresh) {
      // No refresh token — cannot renew. Clear the stale session.
      clearSession();
      setSession(null);
      return;
    }

    void refreshSession(storedRefresh).then((renewed) => {
      if (!renewed) {
        clearSession();
        setSession(null);
        return;
      }
      // Keep the workspaceId; refresh the access token, and the ID token too
      // when Cognito returns one — the approval endpoint needs a current one.
      saveRefreshToken(renewed.refreshToken);
      setSession((prev) =>
        prev
          ? {
              ...prev,
              token: renewed.accessToken,
              ...(renewed.idToken ? { idToken: renewed.idToken } : {}),
            }
          : prev,
      );
    });
    // Runs once per mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSetSession = (s: Session) => {
    setSession(s);
  };

  const handleSignOut = () => {
    clearSession();
    setSession(null);
  };

  return (
    <MotionProvider>
      <Router>
        <Routes>
        {/* Public */}
        <Route path="/" element={<LandingPage onSession={handleSetSession} />} />
        <Route path="/signin" element={<SignInPage onSession={handleSetSession} />} />

        {/* Cognito PKCE callback — must be accessible before a session exists */}
        <Route
          path="/auth/callback"
          element={<AuthCallbackPage onSession={handleSetSession} />}
        />

        {/* GitHub App post-install callback — requires an active session */}
        <Route
          path="/auth/github-callback"
          element={
            session ? (
              <AppShell session={session} onSignOut={handleSignOut}>
                <GitHubCallbackPage session={session} />
              </AppShell>
            ) : (
              <Navigate to="/signin" replace />
            )
          }
        />

        {/* Protected app shell */}
        <Route
          path="/app/*"
          element={
            session ? (
              <AppShell session={session} onSignOut={handleSignOut}>
                <RouteTransition>
                <Routes>
                  <Route index element={<CommandCenterPage session={session} />} />
                  <Route
                    path="investigations/:id/pr"
                    element={<PrReviewPage session={session} />}
                  />
                  <Route
                    path="investigations/:id"
                    element={
                      <Suspense fallback={<RouteFallback />}>
                        <InvestigationPage session={session} />
                      </Suspense>
                    }
                  />
                  <Route
                    path="projects/new"
                    element={<CreateProjectPage session={session} />}
                  />
                  <Route
                    path="repositories/new"
                    element={<RepositoryPickerPage session={session} />}
                  />
                  <Route
                    path="repositories/:id"
                    element={<RepositoryPage session={session} />}
                  />
                  <Route path="activity" element={<ActivityPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                </Routes>
                </RouteTransition>
              </AppShell>
            ) : (
              <Navigate to="/signin" replace />
            )
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
    </MotionProvider>
  );
}

/**
 * Route changes, softened.
 *
 * Keyed on the path so each screen fades its own content in. There is no exit
 * animation: waiting for the old page to leave before the new one arrives makes
 * navigation feel slower, which is the opposite of the point.
 */
function RouteTransition({ children }: { children: ReactNode }) {
  const location = useLocation();
  const reduced = useReducedMotion();
  return (
    <motion.div
      key={location.pathname}
      initial={{ opacity: 0, y: reduced ? 0 : 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

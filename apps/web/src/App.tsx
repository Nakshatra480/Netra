import { useEffect, useState } from 'react';
import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { CommandCenterPage } from '@/pages/CommandCenterPage';
import { InvestigationPage } from '@/pages/InvestigationPage';
import { LandingPage } from '@/pages/LandingPage';
import { SignInPage } from '@/pages/SignInPage';
import { ActivityPage, RepositoriesPage, SettingsPage } from '@/pages/PlaceholderPages';
import type { Session } from '@/lib/api';
import { clearSession, loadSession, saveSession } from '@/lib/session';
import { restoreSession } from '@/lib/auth';

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());

  useEffect(() => {
    if (session) saveSession(session);
  }, [session]);

  // A Cognito access token outlives the tab but not indefinitely. On load, ask
  // Cognito for a fresh one rather than using a stored token that may have
  // expired while the tab was closed.
  useEffect(() => {
    if (session?.scheme !== 'bearer') return;
    void restoreSession().then((refreshed) => {
      if (!refreshed) {
        clearSession();
        setSession(null);
        return;
      }
      setSession((current) =>
        current ? { ...current, token: refreshed.accessToken } : current,
      );
    });
    // Runs once per mount: refreshing is about page load, not every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Router>
      <Routes>
        <Route path="/" element={<LandingPage onSession={setSession} />} />
        <Route path="/signin" element={<SignInPage onSession={setSession} />} />
        <Route
          path="/app/*"
          element={
            session ? (
              <AppShell session={session}>
                <Routes>
                  <Route index element={<CommandCenterPage session={session} />} />
                  <Route
                    path="investigations"
                    element={<CommandCenterPage session={session} />}
                  />
                  <Route
                    path="investigations/:id"
                    element={<InvestigationPage session={session} />}
                  />
                  <Route path="repositories" element={<RepositoriesPage />} />
                  <Route path="activity" element={<ActivityPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                </Routes>
              </AppShell>
            ) : (
              // No session: sign in, or start a demo, before entering the app.
              <Navigate to="/signin" replace />
            )
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}

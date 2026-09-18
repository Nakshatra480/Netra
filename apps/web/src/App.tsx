import { useEffect, useState } from 'react';
import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { CommandCenterPage } from '@/pages/CommandCenterPage';
import { InvestigationPage } from '@/pages/InvestigationPage';
import { LandingPage } from '@/pages/LandingPage';
import { ActivityPage, RepositoriesPage, SettingsPage } from '@/pages/PlaceholderPages';
import type { Session } from '@/lib/api';
import { loadSession, saveSession } from '@/lib/session';

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());

  useEffect(() => {
    if (session) saveSession(session);
  }, [session]);

  return (
    <Router>
      <Routes>
        <Route path="/" element={<LandingPage onSession={setSession} />} />
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
              // No session: the landing page is where a session is created.
              <Navigate to="/" replace />
            )
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}

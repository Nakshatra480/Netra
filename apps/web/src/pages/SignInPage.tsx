import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { beginGoogleSignIn, cognitoConfigured } from '@/lib/auth';
import { api, ApiError, type Session } from '@/lib/api';
import { saveSession } from '@/lib/session';
import { Button, ErrorState } from '@/components/primitives';
import { NetraLogoMark } from '@/components/NetraLogo';


/**
 * Sign in.
 *
 * Two panels: what Netra does on the left, the way in on the right. A lone
 * small card floating in whitespace gives a first-time visitor nothing to read
 * while they decide whether to hand over an account.
 */
export function SignInPage({ onSession }: { onSession: (session: Session) => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGoogle = async () => {
    if (!cognitoConfigured) return;
    setBusy(true);
    setError(null);
    try {
      // Redirect to Cognito Hosted UI → Google OAuth → /auth/callback
      await beginGoogleSignIn('/app');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in could not be completed.');
      setBusy(false);
    }
  };

  /**
   * Run the Live Demo.
   *
   * This starts a real investigation of Netra's fixture repository through the
   * same pipeline a customer's own push takes: GitHub App → EventBridge →
   * Step Functions → Fargate → DynamoDB. The page that follows streams the
   * backend's own events; nothing about the run is simulated.
   *
   * The server pins the fixture commit, so clicking twice lands on the same
   * investigation rather than starting a second one.
   */
  const startDemo = async () => {
    if (busy) return; // duplicate click guard
    setBusy(true);
    setError(null);
    try {
      const { token, workspace } = await api.startDemoSession();
      const session: Session = { token, scheme: 'demo', workspaceId: workspace.id };
      saveSession(session);
      onSession(session);

      // A broken or unreachable fixture must surface here rather than
      // dropping the visitor on an investigation that will never fill in.
      const run = await api.runDemo(session);
      navigate(`/app/investigations/${run.investigationId}`, { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'The demo could not be started.',
      );
      setBusy(false);
    }
  };

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-2.5 px-6">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="flex items-center gap-2.5 rounded-control px-1 py-1 transition-colors hover:opacity-80"
          >
            <NetraLogoMark size={30} />
          </button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => navigate('/')}>
            <ArrowLeft size={14} />
            Back
          </Button>
        </div>
      </header>

      <main className="mx-auto grid min-h-[calc(100dvh-4rem)] max-w-6xl items-center gap-12 px-6 py-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] lg:gap-20">
        {/* Left: why you are signing in at all. */}
        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="hidden lg:block"
        >
          <h1 className="display text-[2.5rem] leading-[1.1] text-ink">
            Investigate every change before it ships.
          </h1>
          <p className="mt-5 max-w-lg text-[1.0625rem] leading-relaxed text-ink-muted">
            Connect a repository and Netra investigates each push and pull request, proving what a
            change can reach before it becomes an incident.
          </p>
          <ul className="mt-8 space-y-4">
            {BENEFITS.map((benefit) => (
              <li key={benefit.title} className="flex gap-3">
                <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-state-resolved" />
                <div>
                  <p className="text-[0.9375rem] font-semibold text-ink">{benefit.title}</p>
                  <p className="mt-0.5 text-[0.9375rem] leading-relaxed text-ink-muted">
                    {benefit.body}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </motion.section>

        {/* Right: the way in. */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, delay: 0.06, ease: [0.22, 1, 0.36, 1] }}
          className="mx-auto w-full max-w-md"
        >
          <div className="panel overflow-hidden">
            <div className="border-b border-line bg-tint-peach px-8 py-7">
              <h2 className="text-[1.375rem] font-semibold tracking-tight text-ink">
                Welcome to Netra
              </h2>
              <p className="mt-1.5 text-[0.9375rem] leading-relaxed text-ink-muted">
                Sign in securely with your Google account.
              </p>
            </div>

            <div className="space-y-5 px-8 py-8">
              {cognitoConfigured ? (
                <button
                  type="button"
                  onClick={() => void handleGoogle()}
                  disabled={busy}
                  className="flex w-full items-center justify-center gap-3 rounded-control border border-line-strong bg-surface px-5 py-3.5 text-[0.9375rem] font-semibold text-ink transition-colors duration-150 hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <GoogleMark />
                  {busy ? 'Redirecting…' : 'Continue with Google'}
                </button>
              ) : (
                <div className="rounded-control border border-line bg-surface-raised px-4 py-3.5">
                  <p className="text-[0.875rem] font-semibold text-ink">
                    Sign-in is not configured here
                  </p>
                  <p className="mt-1 text-[0.875rem] leading-relaxed text-ink-muted">
                    This deployment has no identity provider configured. The demo runs the same
                    investigation pipeline and needs no account.
                  </p>
                </div>
              )}

              {error ? <ErrorState title="Sign-in failed" detail={error} /> : null}

              <div className="flex items-center gap-3">
                <span className="h-px flex-1 bg-line" />
                <span className="text-[0.8125rem] text-ink-subtle">or</span>
                <span className="h-px flex-1 bg-line" />
              </div>

              <Button
                variant="secondary"
                size="lg"
                className="w-full"
                onClick={() => void startDemo()}
                disabled={busy}
              >
                {busy ? 'Starting…' : 'Try the live demo'}
              </Button>

              <p className="text-center text-[0.8125rem] leading-relaxed text-ink-subtle">
                No account needed. The demo runs the real pipeline against a fixture repository.
              </p>
            </div>
          </div>

          <p className="mt-5 text-center text-[0.8125rem] leading-relaxed text-ink-subtle">
            Your Google account identifies your Netra workspace. GitHub is connected separately for
            repository access.
          </p>
        </motion.section>
      </main>
    </div>
  );
}

/** Google's mark, drawn inline so the button needs no network request. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

const BENEFITS = [
  {
    title: 'Evidence, not opinions',
    body: 'Every finding points at a file, a line, and the check that proved it.',
  },
  {
    title: 'Nothing changes without you',
    body: 'Netra proposes a fix and stops. Remediation needs your explicit approval.',
  },
  {
    title: 'Verified after the fix',
    body: 'The same check re-runs against the fix before anything is marked resolved.',
  },
];

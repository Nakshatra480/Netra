import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldHalf } from 'lucide-react';
import { Button, Panel } from '@/components/primitives';
import { api, type Session } from '@/lib/api';
import {
  AuthError,
  cognitoConfigured,
  confirmSignUp,
  signIn,
  signUp,
} from '@/lib/auth';

type Mode = 'signin' | 'signup' | 'confirm';

/**
 * Sign in with Amazon Cognito.
 *
 * When the deployment has no user pool configured, this says so plainly and
 * points at the demo rather than presenting a form that cannot work.
 */
export function SignInPage({ onSession }: { onSession: (session: Session) => void }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === 'signup') {
        await signUp(email, password);
        setMode('confirm');
        setNotice(`We sent a confirmation code to ${email}.`);
        return;
      }
      if (mode === 'confirm') {
        await confirmSignUp(email, code);
        setMode('signin');
        setNotice('Your account is confirmed. Sign in to continue.');
        return;
      }

      const auth = await signIn(email, password);
      // The workspace belongs to the verified identity; the server decides
      // which one, never the client.
      const workspace = await api.ensureWorkspace({
        token: auth.accessToken,
        scheme: 'bearer',
        workspaceId: '',
      });
      onSession({ token: auth.accessToken, scheme: 'bearer', workspaceId: workspace.id });
      navigate('/app');
    } catch (err) {
      setError(err instanceof AuthError || err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const startDemo = async () => {
    setBusy(true);
    setError(null);
    try {
      const { token, workspace } = await api.startDemoSession();
      onSession({ token, scheme: 'demo', workspaceId: workspace.id });
      navigate('/app');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The demo could not be started.');
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh place-items-center bg-[--color-canvas] px-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <ShieldHalf size={18} className="text-[--color-state-active]" />
          <span className="font-semibold tracking-tight">Netra</span>
        </div>

        <Panel className="p-6">
          {!cognitoConfigured ? (
            <>
              <h1 className="text-base font-semibold">Sign-in is not configured here</h1>
              <p className="mt-2 text-sm leading-relaxed text-[--color-ink-muted]">
                This deployment has no Cognito user pool configured, so accounts cannot be
                created. The demo runs the same investigation pipeline and needs no account.
              </p>
              <Button
                variant="primary"
                className="mt-4 w-full"
                onClick={() => void startDemo()}
                disabled={busy}
              >
                {busy ? 'Starting…' : 'Try the live demo'}
              </Button>
            </>
          ) : (
            <>
              <h1 className="text-base font-semibold">
                {mode === 'signup'
                  ? 'Create your Netra account'
                  : mode === 'confirm'
                    ? 'Confirm your email'
                    : 'Sign in to Netra'}
              </h1>

              <form onSubmit={submit} className="mt-4 space-y-3">
                <Field
                  id="email"
                  label="Email"
                  type="email"
                  value={email}
                  onChange={setEmail}
                  autoComplete="email"
                  disabled={mode === 'confirm'}
                />
                {mode === 'confirm' ? (
                  <Field
                    id="code"
                    label="Confirmation code"
                    type="text"
                    value={code}
                    onChange={setCode}
                    autoComplete="one-time-code"
                  />
                ) : (
                  <Field
                    id="password"
                    label="Password"
                    type="password"
                    value={password}
                    onChange={setPassword}
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  />
                )}

                {error ? (
                  <p className="text-xs text-[--color-state-severe]" role="alert">
                    {error}
                  </p>
                ) : null}
                {notice ? (
                  <p className="text-xs text-[--color-state-resolved]" role="status">
                    {notice}
                  </p>
                ) : null}

                <Button type="submit" variant="primary" className="w-full" disabled={busy}>
                  {busy
                    ? 'Working…'
                    : mode === 'signup'
                      ? 'Create account'
                      : mode === 'confirm'
                        ? 'Confirm'
                        : 'Sign in'}
                </Button>
              </form>

              <div className="mt-4 flex items-center justify-between text-xs">
                <button
                  type="button"
                  className="text-[--color-ink-muted] underline-offset-2 hover:underline"
                  onClick={() => {
                    setMode(mode === 'signup' ? 'signin' : 'signup');
                    setError(null);
                  }}
                >
                  {mode === 'signup' ? 'I already have an account' : 'Create an account'}
                </button>
                <button
                  type="button"
                  className="text-[--color-ink-muted] underline-offset-2 hover:underline"
                  onClick={() => void startDemo()}
                >
                  Try the demo instead
                </button>
              </div>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  disabled,
}: {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-[--color-ink-muted]">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        required
        disabled={disabled}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-md border border-[--color-line] bg-[--color-surface-sunken] px-3 py-2 text-sm text-[--color-ink] disabled:opacity-50"
      />
    </div>
  );
}

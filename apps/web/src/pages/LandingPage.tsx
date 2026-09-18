import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, ShieldHalf } from 'lucide-react';
import { Button } from '@/components/primitives';
import { api, ApiError, type Session } from '@/lib/api';

const FLOW = [
  { label: 'Change', detail: 'A pull request lands' },
  { label: 'Investigate', detail: 'Tools run in a sandbox' },
  { label: 'Evidence', detail: 'Facts with file and line' },
  { label: 'Blast radius', detail: 'What it can reach' },
  { label: 'Verify', detail: 'Deterministic check' },
  { label: 'Approve', detail: 'A human decides' },
  { label: 'Resolve', detail: 'Re-checked after the fix' },
];

export function LandingPage({ onSession }: { onSession: (session: Session) => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startDemo = async () => {
    setBusy(true);
    setError(null);
    try {
      const { token, workspace } = await api.startDemoSession();
      const session: Session = { token, scheme: 'demo', workspaceId: workspace.id };
      onSession(session);
      const investigation = await api.startDemoInvestigation(session);
      navigate(`/app/investigations/${investigation.id}`);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'The demo could not be started right now.',
      );
      setBusy(false);
    }
  };

  return (
    <div className="min-h-dvh bg-[--color-canvas]">
      <header className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-6">
        <ShieldHalf size={18} className="text-[--color-state-active]" />
        <span className="font-semibold tracking-tight">Netra</span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => navigate('/signin')}>
          Sign in
        </Button>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-24 pt-10 sm:pt-20">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        >
          <p className="mono text-[0.72rem] uppercase tracking-[0.14em] text-[--color-state-active]">
            Change investigation platform
          </p>
          <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
            Investigate the consequences of code changes before they become incidents.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-[--color-ink-muted]">
            A diff can be five lines and still publish a credential. Netra traces what a change can
            reach, collects evidence with a file and a line, proves the consequence with
            deterministic checks, and asks a human before it changes anything.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button variant="primary" size="lg" onClick={() => void startDemo()} disabled={busy}>
              {busy ? 'Starting a real investigation…' : 'Try the live demo'}
              <ArrowRight size={16} />
            </Button>
            <Button variant="secondary" size="lg" onClick={() => navigate('/signin')}>
              Sign in
            </Button>
          </div>
          {error ? (
            <p className="mt-3 text-sm text-[--color-state-severe]" role="alert">
              {error}
            </p>
          ) : null}
          <p className="mt-3 text-xs text-[--color-ink-subtle]">
            The demo runs the real pipeline against a real repository in a real sandbox. Nothing is
            pre-recorded.
          </p>
        </motion.div>

        {/* The product's loop, stated once. */}
        <section className="mt-20" aria-label="How Netra works">
          <ol className="grid gap-px overflow-hidden rounded-[--radius-panel] border border-[--color-line] bg-[--color-line] sm:grid-cols-2 lg:grid-cols-7">
            {FLOW.map((step, index) => (
              <motion.li
                key={step.label}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.35 + index * 0.06, duration: 0.3 }}
                className="bg-[--color-surface] px-4 py-5"
              >
                <span className="mono text-[0.65rem] text-[--color-ink-subtle]">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <p className="mt-1.5 text-sm font-medium text-[--color-ink]">{step.label}</p>
                <p className="mt-1 text-xs leading-relaxed text-[--color-ink-subtle]">
                  {step.detail}
                </p>
              </motion.li>
            ))}
          </ol>
        </section>

        <section className="mt-16 grid gap-6 sm:grid-cols-3">
          {[
            {
              title: 'Evidence, not assertions',
              body: 'Every claim points at a file and a line, and names the analyzer that produced it.',
            },
            {
              title: 'Deterministic verification',
              body: 'A model may propose a consequence. Only code can mark it verified, and the UI always says which is which.',
            },
            {
              title: 'Humans authorize',
              body: 'Netra proposes a bounded patch and stops. Nothing reaches your repository without an explicit approval.',
            },
          ].map((card) => (
            <div key={card.title} className="panel p-5">
              <h2 className="text-sm font-semibold text-[--color-ink]">{card.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-[--color-ink-muted]">{card.body}</p>
            </div>
          ))}
        </section>

        <p className="mt-16 max-w-3xl text-xs leading-relaxed text-[--color-ink-subtle]">
          Netra runs on AWS: Cognito authenticates, API Gateway and Lambda receive the change,
          EventBridge and Step Functions orchestrate the investigation, Fargate runs the isolated
          analysis, and DynamoDB and S3 hold the evidence. Model inference is provider-agnostic:
          OpenRouter is the preferred remote path, with a local Ollama fallback, and deterministic
          analysis works with no model at all.
        </p>
      </main>
    </div>
  );
}

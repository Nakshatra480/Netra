import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  CheckCircle2,
  FileSearch,
  GitPullRequest,
  Github,
  ShieldCheck,
} from 'lucide-react';
import { api, ApiError, type Session } from '@/lib/api';
import { saveSession } from '@/lib/session';
import { Button, ErrorState } from '@/components/primitives';

/**
 * Landing page.
 *
 * One claim, one paragraph, two ways in — beside a visual that shows the shape
 * of the product rather than a screenshot of invented data. Sections are banded
 * with the palette's tints so a long page stays navigable without boxing every
 * paragraph in a card.
 */
export function LandingPage({ onSession }: { onSession: (session: Session) => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      navigate(`/app/investigations/${run.investigationId}`);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'The demo could not be started.',
      );
      setBusy(false);
    }
  };

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/95">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-2.5 px-6">
          <span className="grid h-8 w-8 place-items-center rounded-control bg-accent">
            <ShieldCheck size={16} className="text-[#7C2D12]" strokeWidth={2.5} />
          </span>
          <span className="text-[1.0625rem] font-bold tracking-tight">Netra</span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => navigate('/signin')}>
            Sign in
          </Button>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="border-b border-line bg-tint-peach">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] lg:py-24">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          >
            <span className="inline-flex items-center rounded-full border border-accent-border bg-surface px-3 py-1 text-[0.75rem] font-semibold text-[#9A3412]">
              Change investigation
            </span>
            <h1 className="display mt-5 text-[2.5rem] leading-[1.08] text-ink sm:text-[3.25rem]">
              Understand the real impact of your code changes.
            </h1>
            <p className="mt-5 max-w-xl text-[1.0625rem] leading-relaxed text-ink-muted">
              Netra investigates code changes, traces what they can reach, and helps you fix real
              risks before they become incidents.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button size="lg" variant="primary" onClick={() => navigate('/signin')}>
                <Github size={16} />
                Connect with GitHub
              </Button>
              <Button size="lg" variant="secondary" onClick={() => void startDemo()} disabled={busy}>
                {busy ? 'Starting…' : 'Try demo mode'}
                {busy ? null : <ArrowRight size={15} />}
              </Button>
            </div>

            {error ? (
              <div className="mt-5 max-w-md">
                <ErrorState title="The demo could not be started" detail={error} />
              </div>
            ) : null}

            <p className="mt-5 text-[0.8125rem] text-ink-subtle">
              Demo mode runs the real pipeline against a fixture repository. Nothing is pre-recorded.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
          >
            <FlowPreview />
          </motion.div>
        </div>
      </section>

      {/* ── What happens ── */}
      <section className="border-b border-line bg-surface">
        <div className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
          <h2 className="text-[1.5rem] font-semibold tracking-tight">
            What happens when a change arrives
          </h2>
          <p className="mt-2 max-w-2xl text-[0.9375rem] text-ink-muted">
            Four steps, every time. Nothing reaches your repository until the last one.
          </p>
          <ol className="mt-10 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, index) => (
              <motion.li
                key={step.title}
                initial={{ opacity: 0, y: 8 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ duration: 0.25, delay: index * 0.05, ease: [0.22, 1, 0.36, 1] }}
              >
                <div className="flex items-center gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-control bg-tint-yellow text-ink">
                    <step.icon size={16} />
                  </span>
                  <span className="mono text-ink-subtle">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                </div>
                <h3 className="mt-4 text-[1rem] font-semibold text-ink">{step.title}</h3>
                <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-muted">{step.body}</p>
              </motion.li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── Trust model ── */}
      <section className="border-b border-line bg-tint-sage">
        <div className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div>
              <h2 className="text-[1.5rem] font-semibold tracking-tight">
                Why you can trust the result
              </h2>
              <p className="mt-3 max-w-md text-[0.9375rem] leading-relaxed text-ink-muted">
                A model can suggest a consequence. Only deterministic code can confirm one, and only
                you can authorise a change to your repository.
              </p>
            </div>
            <dl className="grid gap-4 sm:grid-cols-3">
              {PRINCIPLES.map((principle) => (
                <div key={principle.term} className="panel px-5 py-6">
                  <dt className="text-[1rem] font-semibold text-ink">{principle.term}</dt>
                  <dd className="mt-2 text-[0.875rem] leading-relaxed text-ink-muted">
                    {principle.detail}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      <footer className="bg-surface py-10">
        <p className="mx-auto max-w-6xl px-6 text-[0.8125rem] leading-relaxed text-ink-subtle">
          Netra runs on AWS: API Gateway and Lambda receive the change, EventBridge and Step
          Functions orchestrate the investigation, and an isolated Fargate task performs it.
        </p>
      </footer>
    </div>
  );
}

/**
 * The shape of an investigation, as a diagram.
 *
 * Deliberately schematic rather than a screenshot: it shows the stages a change
 * passes through without presenting invented findings as if they were real.
 */
function FlowPreview() {
  const stages = [
    { label: 'Change received', tone: 'bg-tint-peach', note: 'push · pull request' },
    { label: 'Investigated in isolation', tone: 'bg-tint-yellow', note: 'sandboxed analysis' },
    { label: 'Evidence + verification', tone: 'bg-tint-sage', note: 'file · line · proof' },
    { label: 'Your decision', tone: 'bg-surface-sunken', note: 'approve or reject' },
  ];

  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <span className="text-[0.875rem] font-semibold text-ink">Investigation</span>
        <span className="mono text-ink-subtle">lifecycle</span>
      </div>
      <ol className="divide-y divide-line">
        {stages.map((stage, index) => (
          <li key={stage.label} className="flex items-center gap-4 px-5 py-4">
            <span
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${stage.tone} mono text-[0.75rem] text-ink`}
            >
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="text-[0.9375rem] font-medium text-ink">{stage.label}</p>
              <p className="mono mt-0.5 text-ink-subtle">{stage.note}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-2 border-t border-line bg-surface-raised px-5 py-3.5">
        <CheckCircle2 size={15} className="text-state-resolved" />
        <span className="text-[0.875rem] text-ink-muted">
          Re-verified after the fix before anything is marked resolved.
        </span>
      </div>
    </div>
  );
}

const STEPS = [
  {
    icon: Github,
    title: 'A change arrives',
    body: 'A push or pull request reaches Netra through its GitHub App.',
  },
  {
    icon: FileSearch,
    title: 'It is investigated',
    body: 'An isolated task reads the diff and traces what the change can reach.',
  },
  {
    icon: ShieldCheck,
    title: 'Findings are proven',
    body: 'Deterministic checks confirm the consequence, with evidence at file and line.',
  },
  {
    icon: GitPullRequest,
    title: 'You decide',
    body: 'Netra proposes a fix and stops. Nothing changes without your approval.',
  },
];

const PRINCIPLES = [
  { term: 'Evidence', detail: 'Every claim points at a file, a line, and the check that produced it.' },
  { term: 'Verification', detail: 'A model may propose; only deterministic code marks a finding verified.' },
  { term: 'Authorisation', detail: 'Remediation requires an explicit human decision, every time.' },
];

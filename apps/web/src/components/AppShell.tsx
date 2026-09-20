import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, LogOut } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { Session } from '@/lib/api';
import { loadClaims } from '@/lib/session';
import { signOut } from '@/lib/auth';
import { NetraLogoMark } from '@/components/NetraLogo';

/**
 * The application shell.
 *
 * Deliberately thin. The product has one place you start (the dashboard) and
 * one thing you read (an investigation), so a second navigation level would be
 * inventing structure the product does not have. Everything else is reached
 * from the content itself.
 */

interface AppShellProps {
  session: Session;
  children: ReactNode;
  onSignOut: () => void;
}

export function AppShell({ session, children, onSignOut }: AppShellProps) {
  const isDemo = session.scheme === 'demo';
  const claims = isDemo ? null : loadClaims();

  const displayName = claims?.name ?? claims?.email?.split('@')[0] ?? null;
  const avatarInitial = isDemo ? 'D' : (displayName?.[0]?.toUpperCase() ?? 'N');
  const avatarUrl = claims?.picture ?? null;

  const handleSignOut = () => {
    onSignOut();
    if (!isDemo) signOut();
  };

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-4 border-b border-line bg-surface px-4 sm:px-6">
        <NavLink to="/app" className="flex select-none items-center gap-2.5">
          <NetraLogoMark size={28} />
        </NavLink>

        {/*
         * One destination. Investigations are reached from the dashboard that
         * lists them, so a link here would duplicate that path rather than add
         * one.
         */}
        <nav aria-label="Main" className="ml-2 hidden sm:block">
          <NavLink
            to="/app"
            end
            className={({ isActive }) =>
              cn(
                'inline-flex items-center gap-2 rounded-control px-3 py-1.5 text-[0.875rem] transition-colors duration-150',
                isActive
                  ? 'bg-surface-sunken font-semibold text-ink'
                  : 'text-ink-muted hover:bg-surface-raised hover:text-ink',
              )
            }
          >
            <LayoutDashboard size={15} />
            Dashboard
          </NavLink>
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {isDemo ? (
            <span className="hidden items-center rounded-full border border-accent-border bg-accent-soft px-2.5 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-[#9A3412] sm:inline-flex">
              Demo mode
            </span>
          ) : null}

          <div className="flex items-center gap-2">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt=""
                className="h-7 w-7 rounded-full border border-line object-cover"
              />
            ) : (
              <span
                aria-hidden="true"
                className="grid h-7 w-7 place-items-center rounded-full bg-surface-sunken text-[0.75rem] font-semibold text-ink-muted"
              >
                {avatarInitial}
              </span>
            )}
            {displayName ? (
              <span className="hidden max-w-[10rem] truncate text-[0.875rem] text-ink md:block">
                {displayName}
              </span>
            ) : null}
          </div>

          <button
            type="button"
            onClick={handleSignOut}
            className="inline-flex items-center gap-1.5 rounded-control px-2.5 py-1.5 text-[0.8125rem] text-ink-muted transition-colors duration-150 hover:bg-surface-raised hover:text-ink"
          >
            <LogOut size={14} />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        {children}
      </main>
    </div>
  );
}

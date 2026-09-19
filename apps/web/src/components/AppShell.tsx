import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Activity,
  Cloud,
  FolderGit2,
  LayoutDashboard,
  MonitorDot,
  Search,
  Settings,
  ShieldHalf,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import type { Session } from '@/lib/api';

const NAV = [
  { to: '/app', label: 'Command Center', icon: LayoutDashboard, end: true },
  { to: '/app/repositories', label: 'Repositories', icon: FolderGit2, end: false },
  { to: '/app/investigations', label: 'Investigations', icon: Search, end: false },
  { to: '/app/activity', label: 'Activity', icon: Activity, end: false },
  { to: '/app/settings', label: 'Settings', icon: Settings, end: false },
];

export function AppShell({ session, children }: { session: Session; children: ReactNode }) {
  const isDemo = session.scheme === 'demo';

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[--color-canvas]">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-[--color-line] px-4">
        <NavLink to="/" className="flex items-center gap-2">
          <ShieldHalf size={17} className="text-[--color-state-active]" />
          <span className="text-[0.95rem] font-semibold tracking-tight">Netra</span>
        </NavLink>

        {/* Backend mode indicator */}
        <div
          className={cn(
            'hidden items-center gap-1.5 rounded-full border px-2.5 py-0.5 sm:flex',
            isDemo
              ? 'border-[color-mix(in_oklch,var(--color-state-active)_30%,transparent)] bg-[color-mix(in_oklch,var(--color-state-active)_10%,transparent)]'
              : 'border-[color-mix(in_oklch,var(--color-state-resolved)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-state-resolved)_10%,transparent)]',
          )}
        >
          {isDemo ? (
            <MonitorDot size={10} className="text-[--color-state-active]" />
          ) : (
            <Cloud size={10} className="text-[--color-state-resolved]" />
          )}
          <span
            className={cn(
              'text-[0.62rem] font-semibold uppercase tracking-[0.07em]',
              isDemo ? 'text-[--color-state-active]' : 'text-[--color-state-resolved]',
            )}
          >
            {isDemo ? 'Demo' : 'AWS Production'}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <span className="mono hidden text-[0.68rem] text-[--color-ink-subtle] md:block">
            {isDemo ? 'Demo session' : 'Signed in'}
          </span>
          <div
            className="grid h-7 w-7 place-items-center rounded-full bg-[--color-surface-raised] text-[0.7rem] font-semibold text-[--color-ink-muted]"
            aria-hidden="true"
          >
            {isDemo ? 'D' : 'U'}
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          className="hidden w-52 shrink-0 flex-col gap-0.5 border-r border-[--color-line] p-2 lg:flex"
          aria-label="Main"
        >
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-[--color-surface-raised] font-medium text-[--color-ink]'
                    : 'text-[--color-ink-muted] hover:bg-[--color-surface] hover:text-[--color-ink]',
                )
              }
            >
              <Icon size={15} />
              {label}
            </NavLink>
          ))}
        </nav>

        <main className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">{children}</main>
      </div>
    </div>
  );
}

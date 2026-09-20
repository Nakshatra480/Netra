/**
 * Repository picker: shown after GitHub App installation is verified.
 *
 * Receives repos from GitHubCallbackPage via React Router navigation state.
 * Shows all repositories the installation can access.
 * "Create Project" persists the selection; the server derives workspace ownership
 * from the verified Cognito JWT — never from the request body.
 */

import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  GitBranch,
  Github,
  Lock,
  Search,
  Unlock,
} from 'lucide-react';
import { api, ApiError, type GhRepoMeta, type Session } from '@/lib/api';
import { cn } from '@/lib/cn';

interface Props {
  session: Session;
}

interface LocationState {
  repos?: GhRepoMeta[];
  installationId?: number;
  githubUsername?: string;
}

export function RepositoryPickerPage({ session }: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const state = (location.state ?? {}) as LocationState;
  const repos = state.repos ?? [];
  const githubUsername = state.githubUsername;
  // installationId may come from navigation state (legacy flow) or from
  // each repo item (new OAuth flow). Derive from repos as fallback.
  const installationId = state.installationId ?? repos[0]?.installationId ?? null;

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<GhRepoMeta | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If we arrived without repos, show empty state.
  // installationId may have been on the repos themselves — already derived above.
  if (repos.length === 0) {
    return (
      <div className="mx-auto max-w-lg space-y-4 py-20 text-center">
        <Github size={40} className="mx-auto text-ink-subtle" />
        <h1 className="text-lg font-semibold">No repositories found</h1>
        <p className="text-sm text-ink-muted">
          {installationId
            ? 'The GitHub App installation has no accessible repositories. Add some from GitHub and return.'
            : 'Session expired. Please connect GitHub again.'}
        </p>
        <button
          onClick={() => void navigate('/app')}
          className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface-raised px-4 py-2 text-sm font-medium transition-colors hover:bg-line"
        >
          Back to Dashboard
        </button>
      </div>
    );
  }

  const filtered = repos.filter(
    (r) =>
      r.fullName.toLowerCase().includes(query.toLowerCase()) ||
      (r.description?.toLowerCase().includes(query.toLowerCase()) ?? false),
  );

  const handleCreate = async () => {
    if (!selected || !installationId) return;
    setCreating(true);
    setError(null);
    try {
      const repository = await api.createRepository(session, {
        githubInstallationId: installationId,
        githubRepositoryId: selected.githubRepositoryId,
        fullName: selected.fullName,
        defaultBranch: selected.defaultBranch,
      });
      void navigate(`/app/repositories/${repository.id}`, { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Failed to create the project. Please try again.',
      );
      setCreating(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Select a repository</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {githubUsername ? (
            <>Connected as <strong>@{githubUsername}</strong> · </>
          ) : null}
          Netra will investigate every push and pull request on the repository you select.
        </p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search
          size={15}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle"
        />
        <input
          id="repo-search"
          type="text"
          placeholder="Search repositories…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-lg border border-line bg-surface-raised py-2.5 pl-9 pr-4 text-sm outline-none placeholder:text-ink-subtle focus:border-state-active focus:ring-1 focus:ring-state-active"
        />
      </div>

      {/* Repository list */}
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        {filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-ink-muted">
            No repositories match <strong>{query}</strong>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {filtered.map((repo) => {
              const isSelected = selected?.fullName === repo.fullName;
              return (
                <li key={repo.fullName}>
                  <button
                    id={`repo-${repo.fullName.replace('/', '-')}`}
                    onClick={() => setSelected(isSelected ? null : repo)}
                    className={cn(
                      'group flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors',
                      isSelected
                        ? 'bg-[color-mix(in_oklch,var(--color-state-active)_10%,transparent)]'
                        : 'hover:bg-surface-raised',
                    )}
                  >
                    {/* Selected indicator */}
                    <div className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                      {isSelected ? (
                        <CheckCircle2 size={16} className="text-state-active" />
                      ) : (
                        <div className="h-4 w-4 rounded-full border-2 border-line group-hover:border-ink-muted" />
                      )}
                    </div>

                    {/* Repo info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-sm font-medium text-ink">
                          {repo.fullName}
                        </span>
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.65rem] font-medium',
                            repo.private
                              ? 'bg-surface-raised text-ink-muted'
                              : 'bg-[color-mix(in_oklch,var(--color-state-active)_12%,transparent)] text-state-active',
                          )}
                        >
                          {repo.private ? <Lock size={9} /> : <Unlock size={9} />}
                          {repo.private ? 'Private' : 'Public'}
                        </span>
                      </div>
                      {repo.description && (
                        <p className="mt-0.5 truncate text-xs text-ink-muted">
                          {repo.description}
                        </p>
                      )}
                      <div className="mt-1 flex items-center gap-1 text-[0.68rem] text-ink-subtle">
                        <GitBranch size={10} />
                        <span>{repo.defaultBranch}</span>
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Error */}
      {error && (
        <p className="rounded-lg border border-[color-mix(in_oklch,var(--color-state-severe)_30%,transparent)] bg-[color-mix(in_oklch,var(--color-state-severe)_8%,transparent)] px-4 py-3 text-sm text-state-severe">
          {error}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={() => void navigate('/app')}
          className="text-sm text-ink-muted hover:text-ink transition-colors"
        >
          Cancel
        </button>
        <button
          id="create-project-btn"
          onClick={() => void handleCreate()}
          disabled={!selected || creating}
          className={cn(
            'inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold transition-all',
            selected && !creating
              ? 'bg-state-active text-white hover:opacity-90 shadow-sm'
              : 'cursor-not-allowed bg-surface-raised text-ink-subtle',
          )}
        >
          <Github size={15} />
          {creating ? 'Creating project…' : selected ? `Analyze ${selected.name}` : 'Select a repository'}
        </button>
      </div>
    </div>
  );
}

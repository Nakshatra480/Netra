import { FolderGit2, Settings as SettingsIcon, Activity as ActivityIcon } from 'lucide-react';
import { EmptyState, Panel, PanelHeader } from '@/components/primitives';

/**
 * Placeholder pages — not built yet. State clearly rather than showing invented data.
 */

export function RepositoriesPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <Panel className="overflow-hidden">
        <PanelHeader title="Repositories" icon={<FolderGit2 size={15} />} />
        <EmptyState
          title="GitHub connection is not configured"
          description="Connecting a repository needs a GitHub App installation. Until that is set up, use the demo repository."
        />
      </Panel>
    </div>
  );
}

export function ActivityPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <Panel className="overflow-hidden">
        <PanelHeader title="Activity" icon={<ActivityIcon size={15} />} />
        <EmptyState
          title="No workspace activity yet"
          description="Approvals and rejections are recorded in the audit trail and will appear here."
        />
      </Panel>
    </div>
  );
}

export function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <Panel className="overflow-hidden">
        <PanelHeader title="Settings" icon={<SettingsIcon size={15} />} />
        <EmptyState
          title="Nothing to configure yet"
          description="Investigation policies and integrations are configured through infrastructure for now."
        />
      </Panel>
    </div>
  );
}

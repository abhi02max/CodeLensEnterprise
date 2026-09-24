'use client';

import { ActivityPanel } from '@/components/workspace/activity-panel';

export default function ActivityPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Activity</h1>
        <p className="mt-0.5 text-xs text-slate-500">
          Audit events for this organization. Metadata is intentionally not rendered — it carries
          resource ids and finding fingerprints that belong in the API, not on a screen.
        </p>
      </div>

      <div className="max-w-2xl">
        <ActivityPanel title="Audit trail" />
      </div>
    </div>
  );
}

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

      {/* Capped rather than full-bleed: a log is easier to scan when the line length is bounded,
          but max-w-2xl left most of a 1440px screen empty and read as unfinished. */}
      <div className="max-w-4xl">
        <ActivityPanel title="Audit trail" limit={25} />
      </div>
    </div>
  );
}

'use client';

import * as React from 'react';
import { SEVERITY_ORDER, SeverityBadge } from '@/components/risk';
import { Badge, Button, Card, CardHeader, EmptyState } from '@/components/ui/primitives';
import type { CommentView, FindingView, Severity } from '@/lib/types';

/**
 * Static findings, grouped by severity, highest first.
 *
 * Grouped rather than sorted so the count per severity is visible without counting rows — the
 * first question about a review is "how many criticals", and a flat sorted list makes that a
 * manual task.
 *
 * Each finding shows whether a comment thread is attached and whether that thread is resolved,
 * because a resolved thread is what clears the finding from the merge gate. Without it the gate
 * would change for reasons the user cannot see on this screen.
 */
export function FindingsPanel({
  findings,
  comments,
  canComment,
  onDiscuss,
}: {
  findings: FindingView[];
  comments: CommentView[];
  canComment: boolean;
  onDiscuss: (finding: FindingView) => void;
}) {
  const [showPreexisting, setShowPreexisting] = React.useState(false);

  const threadByFingerprint = React.useMemo(() => {
    const map = new Map<string, CommentView>();
    for (const comment of comments) {
      if (comment.findingFingerprint) map.set(comment.findingFingerprint, comment);
    }
    return map;
  }, [comments]);

  const visible = showPreexisting ? findings : findings.filter((finding) => !finding.preexisting);
  const preexistingCount = findings.filter((finding) => finding.preexisting).length;

  const grouped = SEVERITY_ORDER.map((severity) => ({
    severity,
    items: visible.filter((finding) => finding.severity === severity),
  })).filter((group) => group.items.length > 0);

  return (
    <Card>
      <CardHeader
        title="Static findings"
        subtitle={`${visible.length} finding${visible.length === 1 ? '' : 's'} on lines this change touched`}
        actions={
          preexistingCount > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setShowPreexisting((value) => !value)}>
              {showPreexisting ? 'Hide' : 'Show'} {preexistingCount} pre-existing
            </Button>
          ) : undefined
        }
      />

      {grouped.length === 0 ? (
        <EmptyState
          title="No findings"
          description="No analyzer reported an issue on the lines this change touched."
        />
      ) : (
        <div className="divide-y divide-surface-border">
          {grouped.map((group) => (
            <div key={group.severity}>
              <div className="flex items-center gap-2 bg-surface-subtle px-4 py-1.5">
                <SeverityBadge severity={group.severity as Severity} />
                <span className="numeric text-xs text-slate-500">{group.items.length}</span>
              </div>

              <ul className="divide-y divide-surface-border">
                {group.items.map((finding) => {
                  const thread = finding.fingerprint
                    ? threadByFingerprint.get(finding.fingerprint)
                    : undefined;

                  return (
                    <li key={finding.id} className="px-4 py-2.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                            <code className="rounded bg-surface-muted px-1 py-0.5 text-xs text-slate-700">
                              {finding.ruleId}
                            </code>
                            <Badge tone="outline">{finding.analyzer.toLowerCase()}</Badge>
                            <Badge tone="outline">{finding.category.toLowerCase()}</Badge>
                            {finding.preexisting && <Badge tone="neutral">pre-existing</Badge>}
                          </div>

                          {finding.path && (
                            <p className="mt-1 font-mono text-xs text-slate-500">
                              {finding.path}
                              {finding.line ? `:${finding.line}` : ''}
                            </p>
                          )}

                          <p className="mt-1 text-sm text-slate-700">{finding.message}</p>

                          {finding.snippet && (
                            <pre className="mt-1.5 overflow-x-auto rounded bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100">
                              <code>{finding.snippet}</code>
                            </pre>
                          )}

                          <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            {thread ? (
                              <Badge tone={thread.resolvedAt ? 'success' : 'info'}>
                                {thread.resolvedAt ? 'thread resolved' : 'thread open'}
                              </Badge>
                            ) : (
                              canComment && (
                                <Button size="sm" variant="ghost" onClick={() => onDiscuss(finding)}>
                                  Discuss
                                </Button>
                              )
                            )}

                            {finding.helpUrl && (
                              <a
                                href={finding.helpUrl}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="text-xs text-slate-500 underline hover:text-slate-800"
                              >
                                Reference
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

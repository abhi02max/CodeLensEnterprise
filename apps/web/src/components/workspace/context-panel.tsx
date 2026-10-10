'use client';

import { Badge, Card, CardBody, CardHeader, EmptyState, Field } from '@/components/ui/primitives';
import type { RagContextSummary } from '@/lib/types';

/**
 * What the retriever gave the model.
 *
 * Shows the strategies that agreed on each chunk rather than just a similarity score. That is the
 * difference between "the vector index returned this" and "three independent strategies agreed",
 * and it is the part a reviewer can sanity-check — a chunk pulled in by the import graph is
 * defensible in a way a bare cosine distance is not.
 */
export function ContextPanel({ context }: { context: RagContextSummary }) {
  if (context.chunkCount === 0) {
    return (
      <Card>
        <CardHeader title="Repository context" />
        <EmptyState
          title="No context retrieved"
          description="Index this repository so reviews can account for existing conventions."
        />
      </Card>
    );
  }

  const perFile = context.chunks.filter((chunk) => chunk.forFilePath !== null);
  const overview = context.chunks.filter((chunk) => chunk.forFilePath === null);

  return (
    <Card>
      <CardHeader
        title="Repository context"
        subtitle="Retrieved code the AI review was grounded in"
        actions={<Badge tone="outline">{context.chunkCount} chunks</Badge>}
      />
      <CardBody className="space-y-2.5">
        <dl className="divide-y divide-surface-border border-y border-surface-border">
          <Field label="Context tokens">{context.totalTokens.toLocaleString()}</Field>
          <Field label="Repository overview chunks">{overview.length}</Field>
          <Field label="Per-file chunks">{perFile.length}</Field>
        </dl>

        <ul className="space-y-1.5">
          {context.chunks.slice(0, 12).map((chunk, index) => (
            <li key={`${chunk.path}-${chunk.forFilePath}-${index}`} className="text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-mono text-slate-700">
                  {chunk.path}
                  {chunk.symbol && <span className="text-content-muted"> · {chunk.symbol}</span>}
                </span>
                <span className="numeric shrink-0 text-slate-500">{chunk.score.toFixed(2)}</span>
              </div>

              <div className="mt-0.5 flex flex-wrap items-center gap-1">
                <Badge tone="neutral">{chunk.kind.replace(/_/g, ' ').toLowerCase()}</Badge>
                {chunk.sources.map((source) => (
                  <Badge key={source} tone="outline">
                    {source.replace(/_/g, ' ').toLowerCase()}
                  </Badge>
                ))}
                {chunk.forFilePath && (
                  <span className="truncate text-content-muted">for {chunk.forFilePath}</span>
                )}
              </div>

              {chunk.rationale && <p className="mt-0.5 text-slate-500">{chunk.rationale}</p>}
            </li>
          ))}
        </ul>

        {context.chunks.length > 12 && (
          <p className="text-xs text-slate-400">
            {context.chunks.length - 12} more chunk(s) not shown.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

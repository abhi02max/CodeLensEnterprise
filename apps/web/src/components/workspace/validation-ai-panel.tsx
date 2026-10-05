'use client';
import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, X } from 'lucide-react';
import { VALIDATION_AI_DISCLAIMER, type ValidationAiResult } from '@codelens/shared';
import { api } from '@/lib/api';
import { Alert, Button } from '@/components/ui/primitives';

export function ValidationAiPanel({
  validationId,
  eligible,
}: {
  validationId: string;
  eligible: boolean;
}) {
  const client = useQueryClient(),
    requestId = React.useRef<string | null>(null);
  const query = useQuery({
    queryKey: ['validation-ai', validationId],
    queryFn: () => api.validationAi(validationId),
    refetchInterval: 1000,
  });
  const ml = useQuery({
    queryKey: ['validation-ml', validationId],
    queryFn: () => api.validationMl(validationId),
    refetchInterval: 1000,
  });
  const row = query.data,
    active = !!row && ['QUEUED', 'PREPARING', 'RUNNING'].includes(row.state);
  const mutation = useMutation({
    mutationFn: (cancel: boolean) => {
      if (cancel && row) return api.cancelValidationAi(validationId, row.id, crypto.randomUUID());
      requestId.current ??= crypto.randomUUID();
      return api.requestValidationAi(validationId, requestId.current);
    },
    onSuccess: () => {
      requestId.current = null;
      void client.invalidateQueries({ queryKey: ['validation-ai', validationId] });
    },
  });
  const href = (id: string) => `#ai-evidence-${row?.id}-${id}`;
  const claim = (value: ValidationAiResult['summary']) => (
    <>
      <p>{value.text}</p>
      <ul className="flex flex-wrap gap-2">
        {value.evidenceIds.map((id) => (
          <li key={id}>
            <a className="underline focus-visible:outline focus-visible:outline-2" href={href(id)}>
              Evidence {id.slice(0, 12)}
            </a>
          </li>
        ))}
      </ul>
    </>
  );
  return (
    <section aria-label="AI re-review" className="mt-3 border-t border-surface-border pt-3">
      <h5 className="text-sm font-semibold">AI re-review</h5>
      <p className="my-2 text-xs">{VALIDATION_AI_DISCLAIMER}</p>
      <Button
        size="sm"
        disabled={
          !eligible ||
          !ml.data ||
          !['COMPLETED', 'FAILED', 'CANCELLED'].includes(ml.data.state) ||
          query.isPending ||
          query.isError ||
          active ||
          mutation.isPending
        }
        onClick={() => mutation.mutate(false)}
      >
        <MessageSquare size={14} />
        Request AI re-review
      </Button>
      {query.isError && (
        <Alert tone="danger">
          AI re-review could not be loaded.
          <Button size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </Alert>
      )}
      {mutation.isError && (
        <Alert tone="danger">
          AI re-review request unavailable. No proposal, validation or review decision was changed.
        </Alert>
      )}
      {row && (
        <div className="mt-2 space-y-2 text-xs">
          <p role="status" className="text-sm">
            {row.state} · {row.result?.assessment ?? 'No assessment'}
          </p>
          <p className="break-all">
            Requested {row.requestedProvider} / {row.requestedModel} · Reported{' '}
            {row.reportedProvider ?? 'Unavailable'} / {row.reportedModel ?? 'Unavailable'}
          </p>
          {row.stale && (
            <p className="text-amber-700">
              Historical AI re-review: stale relative to current head. No repinning or automatic
              rerun.
            </p>
          )}
          {row.failureCategory && (
            <p>
              Failure category: {row.failureCategory}. Deterministic evidence remains unchanged.
            </p>
          )}
          {row.result && (
            <>
              <h6 className="font-semibold">Summary</h6>
              {claim(row.result.summary)}
              {(
                [
                  'addressedConcerns',
                  'residualConcerns',
                  'introducedConcerns',
                  'suggestedFollowups',
                ] as const
              ).map((key, i) => (
                <div key={key}>
                  <h6 className="font-semibold">
                    {
                      [
                        'Addressed concerns',
                        'Residual concerns',
                        'Introduced concerns',
                        'Follow-ups',
                      ][i]
                    }
                  </h6>
                  <ul className="space-y-2">
                    {row.result![key].map((c, n) => (
                      <li key={n}>{claim(c)}</li>
                    ))}
                  </ul>
                </div>
              ))}
              <h6 className="font-semibold">Model limitations</h6>
              <ul>
                {row.result.limitations.map((v, i) => (
                  <li key={i}>{v}</li>
                ))}
              </ul>
            </>
          )}
          <details>
            <summary>Evidence, coverage and identities</summary>
            <p className="break-all">
              Review {row.id} · BASE {row.lineage.baseSha} · ORIGINAL {row.lineage.headSha} ·
              Candidate {row.lineage.candidateDigest} · Packet {row.packetDigest ?? 'Not sealed'}
            </p>
            {row.coverage && (
              <>
                <p>
                  Excluded: {row.coverage.excluded.join(', ')} · Omitted static findings:{' '}
                  {row.coverage.omittedStaticFindings}
                </p>
                <ul>
                  {row.coverage.limitations.map((v, i) => (
                    <li key={i}>{v}</li>
                  ))}
                </ul>
              </>
            )}
            <ul className="space-y-2">
              {row.evidence.map((e) => (
                <li id={`ai-evidence-${row.id}-${e.id}`} key={e.id} className="scroll-mt-4">
                  <details>
                    <summary>
                      {e.payload.type} · {e.trust} · {e.id.slice(0, 12)}
                    </summary>
                    <p className="break-all">
                      Source {e.sourceId} · Digest {e.contentDigest}
                    </p>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
                      {JSON.stringify(e.payload, null, 2)}
                    </pre>
                  </details>
                </li>
              ))}
            </ul>
          </details>
          {row.accounting && (
            <p>
              Requests {row.accounting.requests} · Retry {row.accounting.retries} · Repair{' '}
              {row.accounting.repairs} · Reserved output tokens {row.accounting.reservedTokens} ·
              Reported prompt/output {row.accounting.promptTokens ?? 'Unknown'} /{' '}
              {row.accounting.completionTokens ?? 'Unknown'} · Requests with unknown usage{' '}
              {row.accounting.unknownRequests}
            </p>
          )}
          {active && (
            <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate(true)}>
              <X size={14} />
              Cancel AI re-review
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

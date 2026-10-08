'use client';
import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Alert, Button } from '@/components/ui/primitives';
import type { PatchProposalView, ValidationView } from '@codelens/shared';
import { executionActive, mlMatches } from '@/lib/candidate-evaluation';
export function ValidationMlPanel({
  validationId,
  eligible,
  association,
}: {
  validationId: string;
  eligible: boolean;
  association?: { proposal: PatchProposalView; validation: ValidationView };
}) {
  const client = useQueryClient();
  const requestId = React.useRef<string | null>(null);
  const query = useQuery({
    queryKey: ['validation-ml', validationId],
    queryFn: () => api.validationMl(validationId),
    refetchInterval: (q) => (q.state.data && executionActive(q.state.data.state) ? 1500 : false),
    refetchOnWindowFocus: false,
  });
  const mismatch =
    !!query.data &&
    !!association &&
    !mlMatches(association.proposal, association.validation, query.data);
  const row = mismatch || query.isError ? null : query.data;
  const active = row && ['QUEUED', 'PREPARING', 'RUNNING'].includes(row.state);
  const mutation = useMutation({
    mutationFn: (cancel: boolean) => {
      if (cancel && row) return api.cancelValidationMl(validationId, row.id, crypto.randomUUID());
      requestId.current ??= crypto.randomUUID();
      return api.requestValidationMl(validationId, requestId.current);
    },
    onSuccess: () => {
      requestId.current = null;
      void client.invalidateQueries({ queryKey: ['validation-ml', validationId] });
    },
  });
  return (
    <section aria-label="ML risk reassessment" className="mt-3 border-t border-surface-border pt-3">
      <h5 className="text-sm font-semibold">ML risk reassessment</h5>
      <p className="my-2 text-xs">
        ML risk movement is an advisory model signal and does not establish that the proposal is
        safe or correct.
      </p>
      <Button
        size="sm"
        disabled={
          !eligible ||
          mismatch ||
          query.isPending ||
          query.isError ||
          !!active ||
          mutation.isPending
        }
        onClick={() => mutation.mutate(false)}
      >
        <Activity size={14} />
        Request ML reassessment
      </Button>
      {query.isError && (
        <Alert tone="danger">
          ML observations could not be loaded.
          <Button size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </Alert>
      )}
      {mutation.isError && (
        <Alert tone="danger">
          ML reassessment request unavailable. No proposal or validation decision was changed.
        </Alert>
      )}
      {query.isPending && <p role="status">Loading latest ML assessment...</p>}
      {query.data === null && <p>No ML assessment recorded. No zero risk or delta is inferred.</p>}
      {mismatch && (
        <Alert tone="warning">ML association mismatch. Scores and actions are withheld.</Alert>
      )}
      <p className="text-xs">
        Latest recorded assessment for the selected validation; not a complete assessment history.
      </p>
      {row && (
        <>
          <p role="status" className="mt-2 text-sm">
            {row.state} · {row.outcome ?? 'Not compared'}
          </p>
          {row.stale && (
            <p className="text-xs text-amber-700">
              Historical ML observation: stale relative to current head. No recomputation or
              rebasing.
            </p>
          )}
          {row.failureCategory && (
            <p className="text-xs">Unavailable category: {row.failureCategory}</p>
          )}
          <dl className="my-2 grid grid-cols-2 gap-2 text-xs">
            {(['ORIGINAL', 'PATCHED'] as const).map((side) => {
              const a = row.assessments.find((a) => a.side === side);
              return (
                <div key={side}>
                  <dt className="font-semibold">{side}</dt>
                  <dd>
                    {a?.availability === 'AVAILABLE' && a.scoreTenths !== null
                      ? `${(a.scoreTenths / 10).toFixed(1)} / 100 · ${a.band}`
                      : 'Unavailable'}
                  </dd>
                </div>
              );
            })}
          </dl>
          {row.deltaTenths !== null && (
            <p className="text-xs">
              PATCHED − ORIGINAL: {(row.deltaTenths / 10).toFixed(1)} points · {row.outcome} · Band
              movement {row.bandMovement}
            </p>
          )}
          {row.outcome === 'LOWER' && (
            <p className="text-xs">
              The model assigned a lower risk score to the patched candidate under the same frozen
              comparison inputs.
            </p>
          )}
          <details className="mt-2 text-xs">
            <summary>ML identities and limitations</summary>
            <p className="break-all">
              Pinned BASE {row.baseSha} · ORIGINAL {row.headSha} · Candidate {row.candidateDigest}
            </p>
            <p className="break-all">
              Metadata {row.frozenMetadataDigest ?? 'Unavailable'} · {row.metadataProvenance}
            </p>
            <p className="break-all">
              Schema {row.featureSchemaVersion} · Extractor {row.extractorVersion} · Diff{' '}
              {row.diffPolicyVersion} · Static {row.staticPolicyVersion}
            </p>
            {row.modelIdentity && (
              <p className="break-all">
                {row.modelIdentity.modelName} / {row.modelIdentity.modelVersion} · Artifact{' '}
                {row.modelIdentity.artifactDigest} · {row.modelIdentity.bandPolicyVersion}
              </p>
            )}
            {row.assessments.map((assessment) => (
              <details key={assessment.side}>
                <summary>{assessment.side} recorded features and warnings</summary>
                {assessment.features ? (
                  <dl>
                    {Object.entries(assessment.features).map(([name, value]) => (
                      <div key={name}>
                        <dt>{name.replaceAll('_', ' ')}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p>Feature inputs unavailable.</p>
                )}
                <p>{assessment.warnings.join(' · ') || 'No warnings recorded.'}</p>
              </details>
            ))}
            <p>{row.limitations}</p>
          </details>
          {active && (
            <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate(true)}>
              <X size={14} />
              Cancel ML reassessment
            </Button>
          )}
        </>
      )}
    </section>
  );
}

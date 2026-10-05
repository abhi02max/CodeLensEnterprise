import { Prisma } from '@codelens/database';
import {
  VALIDATION_AI,
  ValidationAiPacketSchema,
  sanitizeDiagnosticText,
  STATIC_LIMITATIONS,
  VALIDATION_ML_LIMITATIONS,
  type ValidationAiPacket,
  type ValidationAiEvidence,
} from '@codelens/shared';
import { canonicalRiskJson, riskDigest } from '../ml/strict-risk-client';

export const AI_SOURCE_INCLUDE = {
  application: {
    include: { proposal: { include: { files: true } }, attempts: { include: { files: true } } },
  },
  attempts: { include: { steps: true } },
  staticAnalyses: {
    include: {
      findings: {
        orderBy: { findingDigest: 'asc' as const },
        take: VALIDATION_AI.staticEntries + 1,
      },
    },
  },
} satisfies Prisma.ValidationRunInclude;
export type AiSource = Prisma.ValidationRunGetPayload<{ include: typeof AI_SOURCE_INCLUDE }>;
export type AiMlSource = Prisma.ValidationMlComparisonGetPayload<{
  include: { assessments: true };
}>;

export function aiLineage(run: AiSource, ml: AiMlSource): ValidationAiPacket['lineage'] {
  const app = run.application,
    p = app.proposal;
  const applied = app.attempts.find((a) => a.status === 'APPLIED' && a.cleanup === 'DISPOSED');
  if (
    run.state !== 'COMPLETED' ||
    run.cleanup !== 'DISPOSED' ||
    app.status !== 'APPLIED' ||
    app.cleanup !== 'DISPOSED' ||
    p.status !== 'ACCEPTED' ||
    !applied ||
    run.organizationId !== app.organizationId ||
    p.organizationId !== run.organizationId ||
    run.applicationId !== app.id ||
    app.proposalId !== p.id ||
    run.proposalId !== p.id ||
    [app, p].some(
      (v) =>
        v.repositoryId !== run.repositoryId ||
        v.pullRequestId !== run.pullRequestId ||
        v.turnId !== run.turnId ||
        v.headSha !== run.headSha,
    ) ||
    app.baseSha !== p.baseSha ||
    p.revision !== run.proposalRevision ||
    app.proposalRevision !== p.revision ||
    p.digest !== run.proposalDigest ||
    app.proposalDigest !== p.digest ||
    applied.snapshotDigest !== run.snapshotDigest ||
    applied.manifestDigest !== run.candidateDigest ||
    run.staticAnalyses.length !== 2 ||
    new Set(run.staticAnalyses.map((a) => a.side)).size !== 2 ||
    run.staticAnalyses.some(
      (a) =>
        a.organizationId !== run.organizationId ||
        a.validationId !== run.id ||
        a.sourceDigest !== (a.side === 'ORIGINAL' ? run.snapshotDigest : run.candidateDigest),
    ) ||
    ml.organizationId !== run.organizationId ||
    ml.validationId !== run.id ||
    ml.applicationId !== app.id ||
    ml.proposalId !== p.id ||
    ml.repositoryId !== run.repositoryId ||
    ml.pullRequestId !== run.pullRequestId ||
    ml.baseSha !== p.baseSha ||
    ml.headSha !== run.headSha ||
    ml.proposalRevision !== p.revision ||
    ml.proposalDigest !== p.digest ||
    ml.snapshotDigest !== run.snapshotDigest ||
    ml.candidateDigest !== run.candidateDigest ||
    !['COMPLETED', 'FAILED', 'CANCELLED'].includes(ml.state)
  )
    throw new Error('EVIDENCE_LINEAGE');
  const steps = run.attempts.flatMap((a) => a.steps);
  if (
    steps.length !== run.profiles.length * 2 ||
    steps.length < 2 ||
    steps.length > VALIDATION_AI.observationEntries ||
    new Set(steps.map((s) => `${s.profile}:${s.side}`)).size !== steps.length ||
    steps.some(
      (s) =>
        s.organizationId !== run.organizationId ||
        s.validationId !== run.id ||
        !run.profiles.includes(s.profile) ||
        !['ORIGINAL', 'PATCHED'].includes(s.side),
    )
  )
    throw new Error('EVIDENCE_VALIDATION');
  const files = [...applied.files].sort((a, b) => a.path.localeCompare(b.path));
  if (
    p.files.length < 1 ||
    p.files.length > 10 ||
    files.length < p.files.length ||
    new Set(files.map((f) => f.path)).size !== files.length ||
    p.files.some(
      (f) =>
        f.operation !== 'MODIFY' ||
        files.filter((v) => v.path === f.path && v.contentHash === f.newContentHash).length !== 1,
    )
  )
    throw new Error('EVIDENCE_CANDIDATE');
  if (
    ml.assessments.some(
      (s) =>
        s.organizationId !== run.organizationId ||
        (s.staticResultDigest !== null &&
          s.staticResultDigest !== run.staticAnalyses.find((a) => a.side === s.side)?.resultDigest),
    )
  )
    throw new Error('EVIDENCE_ML');
  return ValidationAiPacketSchema.shape.lineage.parse({
    organizationId: run.organizationId,
    repositoryId: run.repositoryId,
    pullRequestId: run.pullRequestId,
    validationId: run.id,
    applicationId: app.id,
    proposalId: p.id,
    proposalRevision: p.revision,
    proposalDigest: p.digest,
    baseSha: p.baseSha,
    headSha: run.headSha,
    snapshotDigest: run.snapshotDigest,
    candidateDigest: run.candidateDigest,
    staticIds: run.staticAnalyses.map((a) => a.id).sort(),
    mlComparisonId: ml.id,
  });
}

export function buildValidationAiPacket(
  run: AiSource,
  ml: AiMlSource,
  secrets: readonly string[] = [],
) {
  const lineage = aiLineage(run, ml),
    entries: ValidationAiEvidence[] = [];
  const safe = (text: string) => sanitizeDiagnosticText(text, secrets);
  const sanitize = (value: unknown): unknown =>
    typeof value === 'string'
      ? safe(value)
      : Array.isArray(value)
        ? value.map(sanitize)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]))
          : value;
  const add = (
    sourceId: string,
    trust: ValidationAiEvidence['trust'],
    payload: ValidationAiEvidence['payload'],
  ) => {
    payload = sanitize(payload) as ValidationAiEvidence['payload'];
    const contentDigest = riskDigest(payload);
    entries.push({
      id: riskDigest({ lineage, sourceId, trust, contentDigest }),
      sourceId,
      trust,
      contentDigest,
      payload,
    });
  };
  add(run.id, 'SERVER_LINEAGE', { type: 'LINEAGE', value: lineage });
  add(run.proposalId, 'HUMAN_DECISION', {
    type: 'DECISION',
    status: 'ACCEPTED',
    revision: run.proposalRevision,
  });
  let patchBytes = 0;
  for (const f of [...run.application.proposal.files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    const diff = safe(f.diff);
    patchBytes += Buffer.byteLength(diff);
    if (patchBytes > VALIDATION_AI.patchBytes) throw new Error('PACKET_BOUND');
    add(f.id, 'EXACT_REVISION_SOURCE', {
      type: 'PATCH',
      path: safe(f.path),
      oldBlobSha: f.oldBlobSha,
      oldContentHash: f.oldContentHash,
      newContentHash: f.newContentHash,
      diff,
    });
  }
  for (const s of run.attempts
    .flatMap((a) => a.steps)
    .sort((a, b) => (`${a.profile}:${a.side}` < `${b.profile}:${b.side}` ? -1 : 1))) {
    const observed = s.observed as Record<string, unknown>,
      runner = s.runnerReported as Record<string, unknown>;
    const report = runner.report as Record<string, unknown> | null;
    add(s.id, 'BROKER_OBSERVATION', {
      type: 'BROKER',
      side: s.side as 'ORIGINAL' | 'PATCHED',
      profile: s.profile,
      outcome: s.outcome as 'PASS' | 'FAIL' | 'UNSUPPORTED' | 'INCONCLUSIVE',
      inputDigest: s.inputDigest,
      resultDigest: s.resultDigest,
      started: observed.started as boolean,
      termination: (observed.termination ?? null) as string | null,
      exitCode: (observed.exitCode ?? null) as number | null,
      oom: observed.oom as boolean,
      cleanup: observed.cleanup as string,
    });
    add(s.id, 'UNTRUSTED_RUNNER_REPORT', {
      type: 'RUNNER',
      side: s.side as 'ORIGINAL' | 'PATCHED',
      profile: s.profile,
      status: runner.status as string,
      kind: (report?.kind ?? null) as string | null,
      total: (report?.total ?? null) as number | null,
      failed: (report?.failed ?? null) as number | null,
    });
  }
  let omitted = 0;
  const optional: Array<{
    analysisId: string;
    sourceId: string;
    payload: ValidationAiEvidence['payload'];
  }> = [];
  for (const a of [...run.staticAnalyses].sort((a, b) => (a.side < b.side ? -1 : 1))) {
    const findings = [...a.findings]
      .sort((a, b) => (a.findingDigest < b.findingDigest ? -1 : 1))
      .slice(0, VALIDATION_AI.staticEntries);
    if (a.findingCount < findings.length) throw new Error('EVIDENCE_STATIC');
    omitted += a.findingCount;
    add(a.id, 'DETERMINISTIC_DERIVED', {
      type: 'STATIC_ANALYSIS',
      side: a.side as 'ORIGINAL' | 'PATCHED',
      status: a.status as 'COMPLETE',
      reason: a.reason,
      rulesetVersion: a.rulesetVersion,
      rulesetDigest: a.rulesetDigest,
      configurationDigest: a.configurationDigest,
      sourceDigest: a.sourceDigest,
      resultDigest: a.resultDigest,
      findingCount: a.findingCount,
      included: 0,
      omitted: a.findingCount,
    });
    for (const f of findings) {
      if (f.organizationId !== run.organizationId || f.analysisId !== a.id)
        throw new Error('EVIDENCE_STATIC');
      optional.push({
        analysisId: a.id,
        sourceId: f.id,
        payload: {
          type: 'STATIC_FINDING',
          side: a.side as 'ORIGINAL' | 'PATCHED',
          analyzer: f.analyzer,
          ruleId: f.ruleId,
          severity: f.severity as 'HIGH',
          category: f.category,
          path: safe(f.path),
          startLine: f.startLine,
          endLine: f.endLine,
          message: safe(f.message),
          classification: f.classification as 'UNCHANGED',
          comparability: f.comparability,
          findingDigest: f.findingDigest,
          counterpartDigest: f.counterpartDigest,
        },
      });
    }
  }
  const mlPayload: ValidationAiEvidence['payload'] = {
    type: 'ML',
    state: ml.state as 'COMPLETED',
    outcome: ml.outcome as 'UNAVAILABLE' | null,
    deltaTenths: ml.deltaTenths,
    bandMovement: ml.bandMovement,
    resultDigest: ml.resultDigest,
    frozenMetadataDigest: ml.frozenMetadataDigest,
    featureSchemaVersion: ml.featureSchemaVersion,
    extractorVersion: ml.extractorVersion,
    modelIdentity: ml.modelIdentity === null ? null : safe(canonicalRiskJson(ml.modelIdentity)),
    assessments: [...ml.assessments]
      .sort((a, b) => (a.side < b.side ? -1 : 1))
      .map((a) => ({
        side: a.side as 'ORIGINAL' | 'PATCHED',
        availability: a.availability as 'AVAILABLE',
        scoreTenths: a.scoreTenths,
        band: a.band as 'HIGH' | null,
        warnings: a.warnings.map(safe),
        staticResultDigest: a.staticResultDigest,
      })),
    limitation: VALIDATION_ML_LIMITATIONS,
  };
  if (Buffer.byteLength(JSON.stringify(mlPayload)) > VALIDATION_AI.mlBytes)
    throw new Error('PACKET_BOUND');
  add(ml.id, 'ADVISORY_ML', mlPayload);
  const compose = () =>
    ValidationAiPacketSchema.parse({
      version: VALIDATION_AI.packet,
      lineage,
      entries,
      coverage: {
        omittedStaticFindings: omitted,
        excluded: ['ORIGINAL_AI', 'RAG', 'RUNNER_OUTPUT', 'SOURCE_EXCERPTS'],
        limitations: [
          STATIC_LIMITATIONS,
          VALIDATION_ML_LIMITATIONS,
          'Citation membership is not semantic entailment. Broker observations are distinct from untrusted runner reports. Canonical diffs describe the pinned candidate, not the entire repository. Redaction does not guarantee universal secret detection.',
        ],
      },
    });
  if (Buffer.byteLength(JSON.stringify(compose())) > VALIDATION_AI.packetBytes)
    throw new Error('PACKET_BOUND');
  let staticBytes = 0;
  for (const f of optional) {
    if (entries.length >= VALIDATION_AI.entries) break;
    add(f.sourceId, 'DETERMINISTIC_DERIVED', f.payload);
    const entry = entries.at(-1)!,
      bytes = Buffer.byteLength(JSON.stringify(entry));
    if (
      staticBytes + bytes > VALIDATION_AI.staticBytes ||
      Buffer.byteLength(JSON.stringify(compose())) > VALIDATION_AI.packetBytes - 256
    ) {
      entries.pop();
      continue;
    }
    staticBytes += bytes;
    omitted--;
    const analysis = entries.find(
      (e) => e.sourceId === f.analysisId && e.payload.type === 'STATIC_ANALYSIS',
    )!;
    if (analysis.payload.type === 'STATIC_ANALYSIS') {
      analysis.payload.included++;
      analysis.payload.omitted--;
      analysis.contentDigest = riskDigest(analysis.payload);
      analysis.id = riskDigest({
        lineage,
        sourceId: analysis.sourceId,
        trust: analysis.trust,
        contentDigest: analysis.contentDigest,
      });
    }
  }
  const packet = compose();
  if (Buffer.byteLength(JSON.stringify(packet)) > VALIDATION_AI.packetBytes)
    throw new Error('PACKET_BOUND');
  return { packet, digest: riskDigest(packet) };
}

import type {
  ConversationAnchor,
  ConversationDetail,
  EvidenceView,
  InvestigationResult,
  PullRequestFilesView,
} from '@codelens/shared';
import type { ReviewSession } from './types';
import { parseUnifiedPatch, type DiffIdentity, type WorkspaceFinding } from './review-workspace';

export function selectedConversationAnchor(
  finding: WorkspaceFinding | undefined,
  session: ReviewSession,
): ConversationAnchor | null {
  if (!finding) return null;
  if (finding.staticFinding) return { kind: 'STATIC_FINDING', findingId: finding.staticFinding.id };
  const index = Number(finding.key.replace('ai:', ''));
  if (
    finding.source === 'AI' &&
    session.run &&
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < (session.aiReview?.findings.length ?? 0)
  )
    return { kind: 'AI_FINDING', reviewRunId: session.run.id, findingIndex: index };
  return null;
}

export function relatedReviewThreads(
  finding: WorkspaceFinding | undefined,
  session: ReviewSession,
) {
  const fingerprint = finding?.staticFinding?.fingerprint;
  return fingerprint ? session.comments.filter((c) => c.findingFingerprint === fingerprint) : [];
}

export function conversationInScope(
  detail: ConversationDetail | undefined,
  conversationId: string | null,
  prId: string,
): boolean {
  return Boolean(
    detail &&
      detail.conversation.id === conversationId &&
      detail.conversation.pullRequestId === prId &&
      detail.messages.every(
        (m) => m.conversationId === conversationId && m.turn.conversationId === conversationId,
      ),
  );
}

export function evidenceInTurn(
  call: InvestigationResult | undefined,
  callId: string | null,
  turnId: string,
  citation?: EvidenceView,
  citationId?: string | null,
): boolean {
  return Boolean(
    call &&
      call.id === callId &&
      call.turnId === turnId &&
      call.evidence.every((e) => e.toolCallId === call.id) &&
      (!citationId ||
        (citation?.id === citationId &&
          citation.toolCallId === call.id &&
          call.evidence.some((e) => e.id === citationId))),
  );
}

export function evidenceCodeAnchor(
  evidence: EvidenceView,
  call: InvestigationResult,
  turnId: string,
  identity: DiffIdentity,
  diff?: PullRequestFilesView,
): { path: string; line: number } | null {
  if (
    !identity.trusted ||
    !diff ||
    call.turnId !== turnId ||
    evidence.toolCallId !== call.id ||
    !call.evidence.some((e) => e.id === evidence.id) ||
    !['SUCCESS', 'PARTIAL', 'LIMITED'].includes(call.status)
  )
    return null;
  if (
    evidence.provenance !== 'EXACT_REVISION' ||
    evidence.sourceType !== 'FILE_RANGE' ||
    evidence.side !== 'HEAD' ||
    evidence.observedRevision !== diff.headSha ||
    evidence.redacted ||
    evidence.truncated ||
    !evidence.path ||
    !Number.isSafeInteger(evidence.startLine) ||
    !Number.isSafeInteger(evidence.endLine) ||
    evidence.startLine! < 1 ||
    evidence.endLine! < evidence.startLine! ||
    evidence.endLine! - evidence.startLine! >= 200
  )
    return null;
  const files = diff.files.filter((f) => f.filename === evidence.path);
  if (files.length !== 1) return null;
  const file = files[0]!;
  if (file.patchAvailability !== 'AVAILABLE' || file.patchTruncated || !file.patch) return null;
  const coordinates = new Map<number, number>();
  for (const hunk of parseUnifiedPatch(file.patch))
    for (const line of hunk.lines)
      if (line.newLineNumber !== null)
        coordinates.set(line.newLineNumber, (coordinates.get(line.newLineNumber) ?? 0) + 1);
  for (let line = evidence.startLine!; line <= evidence.endLine!; line++)
    if (coordinates.get(line) !== 1) return null;
  return { path: evidence.path, line: evidence.startLine! };
}

export function currentEvidenceTarget(
  target: { path: string; line: number; headSha: string } | null,
  identity: DiffIdentity,
  headSha?: string,
) {
  return target && identity.trusted && target.headSha === headSha ? target : null;
}

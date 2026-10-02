import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { HybridRetriever, PgVectorStore } from '@codelens/rag-engine';
import {
  InvestigationInputSchemas,
  ConversationAnchorSchema,
  AiFindingSchema,
  RepositoryPathSchema,
  type InvestigationTool,
} from '@codelens/shared';
import { Prisma } from '@codelens/database';
import { GithubClientFactory } from '../auth/github-client.factory';
import { PrismaService } from '../prisma/prisma.service';
import {
  InvestigationFailure,
  observe,
  hash,
  boundedResult,
  type ToolObservation,
} from './investigation-support';

export type InvestigationScope = Prisma.CollaborationTurnGetPayload<{
  include: { conversation: { include: { pullRequest: { include: { repository: true } } } } };
}> & { actorId: string };

@Injectable()
export class InvestigationToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubClientFactory,
  ) {}

  async execute(
    scope: InvestigationScope,
    tool: InvestigationTool,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<ToolObservation> {
    const pr = scope.conversation.pullRequest;
    const repo = pr.repository;
    const db = this.prisma.unscoped;
    const check = () => {
      if (signal.aborted) throw new InvestigationFailure('TIMEOUT');
    };
    const result = (
      evidence: ToolObservation['evidence'],
      coverage: string,
      nextCursor: number | null = null,
      status: ToolObservation['status'] = 'SUCCESS',
    ) => boundedResult({ evidence, coverage, nextCursor, status });
    const exact = async (path: string, sha = scope.headSha) => {
      check();
      RepositoryPathSchema.parse(path);
      if (!/^[a-f0-9]{40}$/i.test(sha)) throw new InvestigationFailure('UNAVAILABLE');
      const client = await this.github.forUser(scope.actorId);
      const file = await client.getFileSnapshot(repo.fullName, path, sha, signal);
      check();
      if (!file) throw new InvestigationFailure('NOT_FOUND');
      const bytes = Buffer.from(file.content);
      const blob = createHash('sha1')
        .update(Buffer.from(`blob ${bytes.length}\0`))
        .update(bytes)
        .digest('hex');
      if (blob !== file.blobSha) throw new InvestigationFailure('STALE');
      return { ...file, sha };
    };
    if (tool === 'read_file_range') {
      const input = InvestigationInputSchemas.read_file_range.parse(raw);
      // No historical base is stored on the turn; BASE is safe only while the PR still matches.
      const current =
        input.side === 'BASE'
          ? await db.pullRequest.findFirst({
              where: { id: pr.id, organizationId: scope.organizationId },
              select: { headSha: true, baseSha: true },
            })
          : null;
      if (input.side === 'BASE' && current?.headSha !== scope.headSha)
        throw new InvestigationFailure('STALE');
      const sha = input.side === 'BASE' ? current!.baseSha : scope.headSha;
      const file = await exact(input.path, sha);
      const lines = file.content.split('\n');
      if (input.startLine > lines.length) throw new InvestigationFailure('NOT_FOUND');
      const endLine = Math.min(input.endLine, lines.length);
      const item = observe(lines.slice(input.startLine - 1, endLine).join('\n'), {
        sourceType: 'FILE_RANGE',
        provenance: 'EXACT_REVISION',
        observedRevision: sha,
        path: input.path,
        side: input.side,
        startLine: input.startLine,
        endLine,
        contentHash: hash(file.content),
        blobHash: file.blobSha,
        method: 'github-exact-commit-blob',
        metadata: { requestedEndLine: input.endLine },
      });
      return result(
        [item],
        'Exact commit file; selected range only; redaction/truncation explicitly marked',
        null,
        item.truncated ? 'PARTIAL' : 'SUCCESS',
      );
    }
    if (tool === 'read_pr_diff' || tool === 'list_changed_files') {
      const input =
        tool === 'read_pr_diff'
          ? InvestigationInputSchemas.read_pr_diff.parse(raw)
          : InvestigationInputSchemas.list_changed_files.parse(raw);
      const path = 'path' in input ? input.path : undefined;
      // A short repeatable snapshot couples imported files to the current cached head.
      // No upstream work takes place inside this transaction.
      const files = await db.$transaction(
        async (tx) => {
          const current = await tx.pullRequest.findFirst({
            where: { id: pr.id, organizationId: scope.organizationId },
            select: { headSha: true },
          });
          if (current?.headSha !== scope.headSha) throw new InvestigationFailure('STALE');
          return tx.pullRequestFile.findMany({
            where: { pullRequestId: pr.id, ...(path ? { filename: path } : {}) },
            orderBy: { filename: 'asc' },
            skip: input.cursor,
            take: 51,
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
      const selected = files.slice(0, tool === 'read_pr_diff' ? 3 : 50);
      const next = files.length > selected.length ? input.cursor + selected.length : null;
      const evidence = selected.map((file) =>
        observe(
          tool === 'read_pr_diff'
            ? (file.patch ?? '')
            : JSON.stringify({
                path: file.filename,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
              }),
          {
            sourceType: tool === 'read_pr_diff' ? 'PR_DIFF' : 'CHANGED_FILE',
            sourceId: file.id,
            provenance: 'SNAPSHOT',
            observedRevision: scope.headSha,
            path: file.filename,
            method: 'imported-pr-snapshot',
            metadata: {
              patchUnavailable: file.patch === null,
              patchTruncated: file.patchTruncated,
              binary: file.binary,
            },
          },
        ),
      );
      return result(
        evidence,
        'Imported changed-file snapshot; not independently exact-revision verified; import may omit files/patches',
        next,
        'PARTIAL',
      );
    }
    if (tool === 'search_repository' || tool === 'inspect_tests') {
      const input = InvestigationInputSchemas[tool].parse(raw);
      if (!/^[a-f0-9]{40}$/i.test(scope.headSha)) throw new InvestigationFailure('UNAVAILABLE');
      const client = await this.github.forUser(scope.actorId);
      const tree = await client.listTree(repo.fullName, scope.headSha, signal);
      check();
      const files = tree.files
        .filter(
          (file) =>
            input.paths.length === 0 ||
            input.paths.some((p) => file.path === p || file.path.startsWith(p + '/')),
        )
        .filter(
          (file) =>
            tool !== 'inspect_tests' ||
            /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\./i.test(file.path),
        );
      const page = files.slice(input.cursor, Math.min(input.cursor + 20, 500));
      const evidence: ToolObservation['evidence'] = [];
      let skipped = 0;
      for (const entry of page) {
        check();
        if (entry.sizeBytes > 1024 * 1024 || !RepositoryPathSchema.safeParse(entry.path).success) {
          skipped++;
          continue;
        }
        let file: Awaited<ReturnType<typeof exact>>;
        try {
          file = await exact(entry.path);
        } catch (error) {
          if (signal.aborted) throw error;
          skipped++;
          continue;
        }
        if (file.blobSha !== entry.sha) throw new InvestigationFailure('STALE');
        const lines = file.content.split('\n');
        const index = lines.findIndex((line) => line.includes(input.query));
        if (index < 0) continue;
        const start = Math.max(0, index - 1),
          end = Math.min(lines.length, index + 2);
        evidence.push(
          observe(
            lines.slice(start, end).join('\n'),
            {
              sourceType: tool === 'inspect_tests' ? 'TEST_CANDIDATE' : 'SEARCH_MATCH',
              provenance: 'EXACT_REVISION',
              path: entry.path,
              observedRevision: scope.headSha,
              startLine: start + 1,
              endLine: end,
              contentHash: hash(file.content),
              blobHash: file.blobSha,
              method:
                tool === 'inspect_tests'
                  ? 'heuristic-test-path-literal-search'
                  : 'literal-source-search',
            },
            2048,
          ),
        );
      }
      const next =
        input.cursor + page.length < Math.min(files.length, 500)
          ? input.cursor + page.length
          : null;
      return result(
        evidence,
        `Bounded source scan: ${page.length} files, ${skipped} skipped; tree truncated=${tree.truncated}; at most 500 files; one match per file. No matches does not prove absence. Tests are not executed.`,
        next,
        'PARTIAL',
      );
    }
    if (tool === 'retrieve_context') {
      const input = InvestigationInputSchemas.retrieve_context.parse(raw);
      if (repo.indexStatus !== 'INDEXED') throw new InvestigationFailure('UNAVAILABLE');
      let storageUnavailable = false;
      // The shared store intentionally swallows some query failures for analysis fallback.
      // Investigation must distinguish failed storage reads from an empty search.
      const readDb = new Proxy(db, {
        get(target, key, receiver) {
          if (key === '$queryRawUnsafe')
            return async (query: string, ...values: unknown[]) => {
              try {
                return await target.$queryRawUnsafe(query, ...values);
              } catch (error) {
                storageUnavailable = true;
                throw error;
              }
            };
          return Reflect.get(target, key, receiver);
        },
      });
      const store = new PgVectorStore(readDb, scope.organizationId, 1536);
      const retriever = new HybridRetriever({
        store,
        embeddings: {
          model: 'investigation-provider-free',
          dimensions: 1536,
          embedOne: async () => {
            throw new InvestigationFailure('UNAVAILABLE');
          },
          embed: async () => {
            throw new InvestigationFailure('UNAVAILABLE');
          },
        },
      });
      const retrieved = await retriever.retrieve({
        repositoryId: repo.id,
        query: input.query,
        symbols: [
          ...input.symbols,
          ...input.query
            .split(/\W+/)
            .filter((t) => t.length > 2)
            .slice(0, 12),
        ],
        graphSeedPaths: input.paths,
        topK: input.topK,
        maxTokens: 4000,
        mmrLambda: 0.7,
        kinds: [],
        excludePaths: [],
      });
      check();
      if (storageUnavailable) throw new InvestigationFailure('UNAVAILABLE');
      let budget = 16000;
      const evidence: ToolObservation['evidence'] = [];
      for (const chunk of retrieved.chunks.slice(0, input.topK)) {
        if (budget <= 0) break;
        const item = observe(
          chunk.content,
          {
            sourceType: 'RAG_CONTEXT',
            sourceId: chunk.chunkId,
            provenance: 'INDEXED_CONTEXT',
            path: chunk.path,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            method: chunk.sources.join('+'),
            metadata: {
              score: chunk.score,
              vectorScore: chunk.vectorScore,
              lexicalScore: chunk.lexicalScore,
              sources: chunk.sources,
              repositoryIndexRevisionHint: repo.indexedCommitSha,
              exactRevisionVerified: false,
            },
          },
          Math.min(4096, budget),
        );
        budget -= Buffer.byteLength(item.excerpt);
        evidence.push(item);
      }
      return result(
        evidence,
        'Provider-free lexical/graph/convention retrieval with MMR; embeddings intentionally unavailable; chunks have unknown per-chunk revision. Index SHA is a repository hint, not chunk proof. No matches does not prove absence.',
        null,
        'PARTIAL',
      );
    }
    if (tool === 'read_review_thread') {
      const input = InvestigationInputSchemas.read_review_thread.parse(raw);
      const comment = await db.comment.findFirst({
        where: { id: input.commentId, organizationId: scope.organizationId, pullRequestId: pr.id },
      });
      if (!comment) throw new InvestigationFailure('NOT_FOUND');
      const rootId = comment.parentId ?? comment.id;
      const rows = await db.comment.findMany({
        where: {
          organizationId: scope.organizationId,
          pullRequestId: pr.id,
          OR: [{ id: rootId }, { parentId: rootId }],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: input.cursor,
        take: 6,
      });
      const evidence = rows.slice(0, 5).map((row) =>
        observe(
          row.body,
          {
            sourceType: 'COMMENT_SNAPSHOT',
            sourceId: row.id,
            provenance: 'SNAPSHOT',
            path: row.path ?? undefined,
            startLine: row.line ?? undefined,
            endLine: row.line ?? undefined,
            method: 'persisted-comment-snapshot',
            metadata: {
              origin: row.origin,
              updatedAt: row.updatedAt.toISOString(),
              resolved: row.resolvedAt !== null,
            },
          },
          256,
        ),
      );
      return boundedResult(
        result(
          evidence,
          'Mutable comment snapshots; root/direct replies only; 8 KiB page budget',
          rows.length > 5 ? input.cursor + 5 : null,
          'PARTIAL',
        ),
        7000,
      );
    }
    if (tool === 'read_analysis_evidence') {
      const input = InvestigationInputSchemas.read_analysis_evidence.parse(raw);
      const anchor =
        scope.conversation.anchor === null
          ? null
          : ConversationAnchorSchema.parse(scope.conversation.anchor);
      const reviewRunId =
        input.source === 'AI' && anchor?.kind === 'AI_FINDING'
          ? anchor.reviewRunId
          : scope.reviewRunId;
      const run = await db.reviewRun.findFirst({
        where: {
          organizationId: scope.organizationId,
          pullRequestId: pr.id,
          headSha: scope.headSha,
          ...(reviewRunId ? { id: reviewRunId } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          status: true,
          headSha: true,
          hadStaticAnalysis: true,
          hadMlRisk: true,
          hadRagContext: true,
          hadAiReview: true,
        },
      });
      if (!run) throw new InvestigationFailure('UNAVAILABLE');
      if (input.source === 'STATIC') {
        const rows = await db.staticFinding.findMany({
          where: {
            organizationId: scope.organizationId,
            reviewRunId: run.id,
            ...(input.findingId ? { id: input.findingId } : {}),
          },
          orderBy: { id: 'asc' },
          skip: input.cursor,
          take: 21,
          select: {
            id: true,
            path: true,
            line: true,
            message: true,
            severity: true,
            ruleId: true,
            snippet: true,
          },
        });
        if (input.findingId && rows.length === 0) throw new InvestigationFailure('NOT_FOUND');
        return result(
          rows.slice(0, 20).map((row) =>
            observe(
              JSON.stringify(row),
              {
                sourceType: 'STATIC_FINDING',
                sourceId: row.id,
                provenance: 'DERIVED',
                observedRevision: run.headSha,
                path: row.path ?? undefined,
                startLine: row.line ?? undefined,
                endLine: row.line ?? undefined,
                method: 'persisted-static-analysis',
                metadata: { reviewRunId: run.id },
              },
              2048,
            ),
          ),
          'Persisted analyzer output; not independently reverified source facts',
          rows.length > 20 ? input.cursor + 20 : null,
        );
      }
      if (input.source === 'AI') {
        const ai = await db.aiReview.findFirst({
          where: { reviewRunId: run.id, organizationId: scope.organizationId },
          select: { id: true, findings: true },
        });
        if (!ai || !Array.isArray(ai.findings)) throw new InvestigationFailure('UNAVAILABLE');
        const payloadHash = hash(JSON.stringify(ai.findings));
        const start = input.findingIndex ?? input.cursor;
        const selected = ai.findings.slice(
          start,
          start + (input.findingIndex !== undefined ? 1 : 8),
        );
        if (input.findingIndex !== undefined && selected.length === 0)
          throw new InvestigationFailure('NOT_FOUND');
        return result(
          selected.map((finding, i) => {
            const parsed = AiFindingSchema.safeParse(finding);
            return observe(
              JSON.stringify(finding),
              {
                sourceType: 'AI_FINDING',
                sourceId: `${ai.id}:${payloadHash}:${start + i}`,
                provenance: 'DERIVED',
                observedRevision: run.headSha,
                path: parsed.success ? (parsed.data.path ?? undefined) : undefined,
                startLine: parsed.success ? (parsed.data.line ?? undefined) : undefined,
                endLine: parsed.success ? (parsed.data.line ?? undefined) : undefined,
                method: 'ai-payload-hash-index-snapshot',
                payloadHash,
                metadata: {
                  reviewRunId: run.id,
                  findingIndex: start + i,
                  sourcePayloadHash: payloadHash,
                },
              },
              4096,
            );
          }),
          'AI output snapshot, not deterministic source-code fact',
          input.findingIndex === undefined && start + selected.length < ai.findings.length
            ? start + selected.length
            : null,
        );
      }
      if (input.source === 'ML') {
        const prediction = await db.mlPrediction.findFirst({
          where: { reviewRunId: run.id, organizationId: scope.organizationId },
          select: {
            riskScore: true,
            riskLevel: true,
            modelName: true,
            modelVersion: true,
            isBaseline: true,
            topRiskReasons: true,
            status: true,
          },
        });
        if (!prediction) throw new InvestigationFailure('UNAVAILABLE');
        const features = await db.prMetrics.findUnique({
          where: { reviewRunId: run.id },
          select: {
            linesAdded: true,
            linesDeleted: true,
            filesChanged: true,
            commitCount: true,
            complexityDelta: true,
            maxFunctionComplexity: true,
            securityFindingsCount: true,
            testFilesChanged: true,
            testToCodeRatio: true,
            dependencyChanged: true,
            authFileChanged: true,
            databaseFileChanged: true,
            paymentFileChanged: true,
            featureSchemaVersion: true,
          },
        });
        return result(
          [
            observe(JSON.stringify({ prediction, features }), {
              sourceType: 'ML_EVIDENCE',
              sourceId: run.id,
              provenance: 'DERIVED',
              observedRevision: run.headSha,
              method: 'persisted-ml-prediction',
              metadata: { reviewRunId: run.id },
            }),
          ],
          'Persisted model output, not source-code proof; no new ML invocation',
        );
      }
      const summary = await db.aiReview.findFirst({
        where: { reviewRunId: run.id, organizationId: scope.organizationId },
        select: {
          executiveSummary: true,
          technicalSummary: true,
          effectiveRecommendation: true,
          recommendationRationale: true,
        },
      });
      return result(
        [
          observe(JSON.stringify({ availability: run, summary }), {
            sourceType: 'REPORT_SNAPSHOT',
            sourceId: run.id,
            provenance: 'DERIVED',
            observedRevision: run.headSha,
            method: 'persisted-report-summary-snapshot',
          }),
        ],
        'Persisted availability and AI report summary; not a freshly generated report; use STATIC/AI/ML for detailed evidence',
      );
    }
    return result(
      [
        observe(
          JSON.stringify({
            fullName: repo.fullName,
            primaryLanguage: repo.primaryLanguage,
            defaultBranch: repo.defaultBranch,
            indexStatus: repo.indexStatus,
            indexedCommitSha: repo.indexedCommitSha,
          }),
          {
            sourceType: 'REPOSITORY_METADATA',
            sourceId: repo.id,
            provenance: 'SNAPSHOT',
            method: 'safe-persisted-repository-metadata',
          },
        ),
      ],
      'Known persisted metadata only; index commit does not prove individual chunk revision',
    );
  }
}

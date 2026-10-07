/**
 * Development seed.
 *
 * Creates one organization with the three roles represented, a connected
 * repository, and two pull requests — one already analysed end to end so every
 * dashboard page has something real to render, and one still awaiting review.
 *
 * Idempotent: re-running upserts rather than duplicating.
 *
 *   pnpm db:seed
 */

import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import {
  AnalyzerKind,
  ApprovalRecommendation,
  ChunkKind,
  FileChangeStatus,
  FindingCategory,
  IndexStatus,
  MlStatus,
  PrismaClient,
  PullRequestState,
  ReviewRunStatus,
  ReviewStage,
  ReviewVerdict,
  RiskLevel,
  Role,
  RunTrigger,
  Severity,
  ToolRunStatus,
} from '@prisma/client';

const prisma = new PrismaClient();

const DEMO_PASSWORD = 'CodeLensDemo2026';
const PROMPT_VERSION = 'review-2026.09.1';

async function main(): Promise<void> {
  console.log('Seeding CodeLens Enterprise development data…\n');

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

  // ------------------------------------------------------------- organization
  const org = await prisma.organization.upsert({
    where: { slug: 'acme-engineering' },
    update: {},
    create: {
      name: 'Acme Engineering',
      slug: 'acme-engineering',
      plan: 'enterprise',
    },
  });
  console.log(`  organization  ${org.name} (${org.slug})`);

  // ------------------------------------------------------------- users
  const [owner, reviewer, developer] = await Promise.all([
    prisma.user.upsert({
      where: { email: 'owner@acme.dev' },
      update: {},
      create: {
        email: 'owner@acme.dev',
        name: 'Dana Whitfield',
        passwordHash,
        emailVerifiedAt: new Date(),
        avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
      },
    }),
    prisma.user.upsert({
      where: { email: 'reviewer@acme.dev' },
      update: {},
      create: {
        email: 'reviewer@acme.dev',
        name: 'Samir Patel',
        passwordHash,
        emailVerifiedAt: new Date(),
        avatarUrl: 'https://avatars.githubusercontent.com/u/2?v=4',
      },
    }),
    prisma.user.upsert({
      where: { email: 'dev@acme.dev' },
      update: {},
      create: {
        email: 'dev@acme.dev',
        name: 'Lena Ortiz',
        passwordHash,
        emailVerifiedAt: new Date(),
        avatarUrl: 'https://avatars.githubusercontent.com/u/3?v=4',
      },
    }),
  ]);

  const members: Array<[typeof owner, Role]> = [
    [owner, Role.OWNER],
    [reviewer, Role.REVIEWER],
    [developer, Role.DEVELOPER],
  ];

  for (const [user, role] of members) {
    await prisma.membership.upsert({
      where: { userId_organizationId: { userId: user.id, organizationId: org.id } },
      update: { role },
      create: { userId: user.id, organizationId: org.id, role },
    });
    console.log(`  member        ${user.email.padEnd(20)} ${role}`);
  }

  // ------------------------------------------------------------- team
  const team = await prisma.team.upsert({
    where: { organizationId_name: { organizationId: org.id, name: 'Platform' } },
    update: {},
    create: {
      organizationId: org.id,
      name: 'Platform',
      description: 'Owns the API, auth and data layer',
    },
  });

  for (const user of [owner, reviewer, developer]) {
    await prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: team.id, userId: user.id } },
      update: {},
      create: { teamId: team.id, userId: user.id },
    });
  }

  // ------------------------------------------------------------- policy + ai settings
  await prisma.reviewPolicy.upsert({
    where: { organizationId: org.id },
    update: {},
    create: {
      organizationId: org.id,
      blockingSeverity: Severity.HIGH,
      riskScoreGate: 70,
      requireTestsForCodeChanges: true,
      minApprovals: 1,
      sensitiveFlagsRequireTwoApprovals: true,
      autoPostGithubComment: false,
      blockOnSecretDetection: true,
      githubCommentMinRole: Role.REVIEWER,
      checklist: [
        'Change matches the stated intent of the PR description',
        'Error paths and edge cases are handled',
        'No secrets, tokens or credentials in the diff',
        'Tests cover the new behaviour',
        'Public API or schema changes are backward compatible',
        'Logging and metrics are sufficient to debug this in production',
      ],
    },
  });

  await prisma.aiSettings.upsert({
    where: { organizationId: org.id },
    update: {},
    create: { organizationId: org.id },
  });

  // ------------------------------------------------------------- repository
  const repo = await prisma.repository.upsert({
    where: { organizationId_githubId: { organizationId: org.id, githubId: 987_654_321 } },
    update: {},
    create: {
      organizationId: org.id,
      githubId: 987_654_321,
      fullName: 'acme-engineering/payments-api',
      name: 'payments-api',
      owner: 'acme-engineering',
      description: 'Payment orchestration and ledger service',
      private: true,
      defaultBranch: 'main',
      primaryLanguage: 'TypeScript',
      htmlUrl: 'https://github.com/acme-engineering/payments-api',
      indexStatus: IndexStatus.INDEXED,
      indexedAt: new Date(),
      indexedChunkCount: 3,
      indexedCommitSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      lastSyncedAt: new Date(),
      connectedById: owner.id,
    },
  });
  console.log(`\n  repository    ${repo.fullName}`);

  await prisma.repositoryTeam.upsert({
    where: { repositoryId_teamId: { repositoryId: repo.id, teamId: team.id } },
    update: {},
    create: { repositoryId: repo.id, teamId: team.id },
  });

  // ------------------------------------------------------------- rag chunks
  //
  // Embeddings are omitted: the column is `Unsupported("vector(1536)")` and
  // writing it needs raw SQL. These rows exist so the RAG viewer and the
  // retriever's lexical and import-graph strategies have something to work with
  // before a real index run happens.
  const chunkSeeds = [
    {
      path: 'src/payments/refund.service.ts',
      symbol: 'RefundService.issueRefund',
      kind: ChunkKind.METHOD,
      content: [
        'async issueRefund(input: IssueRefundInput): Promise<Result<Refund, RefundError>> {',
        '  const charge = await this.charges.findById(input.chargeId);',
        '  if (!charge) return err(new RefundError("CHARGE_NOT_FOUND"));',
        '  if (charge.refundedCents >= charge.amountCents) {',
        '    return err(new RefundError("ALREADY_REFUNDED"));',
        '  }',
        '  return ok(await this.ledger.recordRefund(charge, input.amountCents));',
        '}',
      ].join('\n'),
      metadata: {
        imports: ['./charges.repository', '../ledger/ledger.service', '../shared/result'],
        exports: ['RefundService'],
        route: null,
        linkedTestPath: 'src/payments/refund.service.test.ts',
        parentSymbol: 'RefundService',
        docComment: 'Issues a partial or full refund against an existing charge.',
        isPartial: false,
        partIndex: null,
      },
    },
    {
      path: 'src/payments/refund.service.test.ts',
      symbol: 'issueRefund > rejects double refunds',
      kind: ChunkKind.TEST_CASE,
      content: [
        "it('rejects double refunds', async () => {",
        '  const charge = buildCharge({ amountCents: 1000, refundedCents: 1000 });',
        '  charges.findById.mockResolvedValue(charge);',
        '',
        '  const result = await service.issueRefund({ chargeId: charge.id, amountCents: 500 });',
        '',
        '  expect(result.ok).toBe(false);',
        "  expect(result.error.code).toBe('ALREADY_REFUNDED');",
        '});',
      ].join('\n'),
      metadata: {
        imports: ['./refund.service', '../../test/builders'],
        exports: [],
        route: null,
        linkedTestPath: null,
        parentSymbol: 'issueRefund',
        docComment: null,
        isPartial: false,
        partIndex: null,
      },
    },
    {
      path: 'docs/architecture.md',
      symbol: 'Error handling',
      kind: ChunkKind.DOC_SECTION,
      content: [
        '## Error handling',
        '',
        'Service methods return `Result<T, E>` rather than throwing. Throwing is',
        'reserved for programmer error and infrastructure failure. Every domain',
        'failure is an explicit error value with a stable `code`, so callers must',
        'handle it and the API layer can map codes to HTTP statuses in one place.',
      ].join('\n'),
      metadata: {
        imports: [],
        exports: [],
        route: null,
        linkedTestPath: null,
        parentSymbol: null,
        docComment: null,
        isPartial: false,
        partIndex: null,
      },
    },
  ];

  for (const seed of chunkSeeds) {
    const contentHash = sha256(seed.content);
    await prisma.ragChunk.upsert({
      where: {
        repositoryId_path_symbol_contentHash: {
          repositoryId: repo.id,
          path: seed.path,
          symbol: seed.symbol,
          contentHash,
        },
      },
      update: {},
      create: {
        organizationId: org.id,
        repositoryId: repo.id,
        path: seed.path,
        symbol: seed.symbol,
        kind: seed.kind,
        language: seed.path.endsWith('.md') ? 'markdown' : 'typescript',
        content: seed.content,
        startLine: 1,
        endLine: seed.content.split('\n').length,
        tokenCount: Math.ceil(seed.content.length / 3.6),
        contentHash,
        metadata: seed.metadata,
      },
    });
  }
  console.log(`  rag chunks    ${chunkSeeds.length} indexed`);

  // ------------------------------------------------------------- PR #1 (analysed)
  //
  // The changed files are declared before the pull request so the pull request's totals can be
  // summed from them, and each file's own counts come from `countPatchLines`. That makes the patch
  // text the single source of truth for every line count the demo displays, through the analyzer's
  // metrics and all the way to the merge gate's blocking reason.
  //
  // `touchedLines` holds the new-file line numbers of the added lines, which is what
  // `touchedLineNumbers` computes on a real GitHub import — and what pattern-scan reads to anchor a
  // finding, so these are the line numbers the review workspace displays.
  const fileSeeds = [
    {
      filename: 'src/payments/refund.service.ts',
      status: FileChangeStatus.MODIFIED,
      flags: ['PAYMENT', 'DATABASE'],
      patch: [
        // 5 context + 3 deletions = 8 old lines; 5 context + 14 additions = 19 new lines.
        '@@ -55,8 +55,19 @@ export class RefundService {',
        '   async issueRefund(input: IssueRefundInput): Promise<Result<Refund, RefundError>> {',
        '     const charge = await this.charges.findById(input.chargeId);',
        '     if (!charge) return err(new RefundError("CHARGE_NOT_FOUND"));',
        '-    if (charge.refundedCents >= charge.amountCents) {',
        '-      return err(new RefundError("ALREADY_REFUNDED"));',
        '-    }',
        '+    if (!input.allowOvercredit && charge.refundedCents >= charge.amountCents) {',
        '+      return err(new RefundError("ALREADY_REFUNDED"));',
        '+    }',
        '+',
        '+    const total = charge.refundedCents + input.amountCents;',
        '+    this.logger.info("issuing refund", {',
        '+      chargeId: charge.id,',
        '+      total,',
        '+      overcredit: input.allowOvercredit ?? false,',
        '+    });',
        '+',
        '+    await this.db.$executeRawUnsafe(',
        '+      `UPDATE charges SET refunded_cents = ${total} WHERE id = \'${charge.id}\'`,',
        '+    );',
        '     return ok(await this.ledger.recordRefund(charge, input.amountCents));',
        '   }',
      ].join('\n'),
    },
    {
      filename: 'src/payments/dto/issue-refund.dto.ts',
      status: FileChangeStatus.MODIFIED,
      flags: ['PAYMENT', 'API_SURFACE'],
      patch: [
        // The decorators the second hunk adds have to come from somewhere. The fixture used them
        // without importing them, which is not a diff that would compile.
        '@@ -1,3 +1,3 @@',
        '-import { IsInt } from "class-validator";',
        '+import { IsBoolean, IsInt, IsOptional } from "class-validator";',
        ' ',
        ' export class IssueRefundDto {',
        '@@ -11,3 +11,7 @@ export class IssueRefundDto {',
        '   @IsInt()',
        '   amountCents!: number;',
        '+',
        '+  @IsBoolean()',
        '+  @IsOptional()',
        '+  allowOvercredit?: boolean;',
        ' }',
      ].join('\n'),
    },
    {
      filename: 'prisma/migrations/20260918_add_overcredit_flag/migration.sql',
      status: FileChangeStatus.ADDED,
      flags: ['DATABASE', 'MIGRATION'],
      patch: [
        // A new file: no old side, six added lines.
        '@@ -0,0 +1,6 @@',
        '+ALTER TABLE "charges"',
        '+  ADD COLUMN "overcredit_allowed" BOOLEAN NOT NULL DEFAULT false;',
        '+',
        '+-- Existing charges keep the previous behaviour.',
        '+UPDATE "charges" SET "overcredit_allowed" = false WHERE "overcredit_allowed" IS NULL;',
        '+',
      ].join('\n'),
    },
    {
      filename: 'package.json',
      status: FileChangeStatus.MODIFIED,
      flags: ['DEPENDENCY'],
      patch: [
        // Three context lines either side, which is what GitHub actually sends. The old fixture
        // claimed `-21,7 +21,7` over a two-line body, so the header was right about the shape of a
        // real patch and the body was the part that was missing.
        '@@ -19,7 +19,7 @@',
        '     "@nestjs/common": "10.4.15",',
        '     "class-transformer": "0.5.1",',
        '     "class-validator": "0.14.1",',
        '-    "decimal.js": "10.4.3",',
        '+    "decimal.js": "10.6.0",',
        '     "prisma": "6.2.1",',
        '     "zod": "3.24.1"',
      ].join('\n'),
    },
  ].map((file) => ({ ...file, ...patchStats(file.patch) }));

  // Anchors for the seeded findings, resolved out of the patches above rather than written down.
  const refundServicePatch = fileSeeds[0]?.patch ?? '';
  const manifestPatch = fileSeeds[3]?.patch ?? '';

  const anchors = {
    rawSql: patchLineOf(refundServicePatch, '$executeRawUnsafe('),
    clientFlag: patchLineOf(refundServicePatch, 'input.allowOvercredit &&'),
    recordRefund: patchLineOf(refundServicePatch, 'this.ledger.recordRefund('),
    dependency: patchLineOf(manifestPatch, '"decimal.js"'),
  };

  const diffTotals = {
    additions: fileSeeds.reduce((sum, file) => sum + file.additions, 0),
    deletions: fileSeeds.reduce((sum, file) => sum + file.deletions, 0),
    changedFiles: fileSeeds.length,
  };

  const analysedPr = await prisma.pullRequest.upsert({
    where: { repositoryId_number: { repositoryId: repo.id, number: 412 } },
    // Diff shape is fixture-owned, so a re-seed corrects it. This used to be `update: {}`, which
    // meant editing the fixture had no effect on a database that had already been seeded — the
    // reason the header kept claiming +96/−23 after the patches said otherwise. Nothing else is
    // touched: title, body and timestamps are not worth clobbering, and review state belongs to the
    // demo rather than the fixture.
    update: {
      ...diffTotals,
      commitCount: 3,
      diffBaseSha: null,
      diffHeadSha: null,
      diffMergeBaseSha: null,
      diffVerifiedAt: null,
    },
    create: {
      organizationId: org.id,
      repositoryId: repo.id,
      number: 412,
      title: 'Allow partial refunds above the original charge amount',
      body: [
        'Finance asked for the ability to issue goodwill credits that exceed the',
        'original charge. This removes the `ALREADY_REFUNDED` guard and adds a',
        '`allowOvercredit` flag on the request.',
        '',
        'Ticket: FIN-2281',
      ].join('\n'),
      state: PullRequestState.OPEN,
      htmlUrl: 'https://github.com/acme-engineering/payments-api/pull/412',
      authorLogin: 'lena-ortiz',
      authorAvatarUrl: 'https://avatars.githubusercontent.com/u/3?v=4',
      authorUserId: developer.id,
      headRef: 'feat/fin-2281-overcredit',
      headSha: 'f1e2d3c4b5a6978877665544332211aabbccddee',
      baseRef: 'main',
      baseSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      ...diffTotals,
      commitCount: 3,
      mergeable: true,
      labels: ['payments', 'needs-review'],
      githubCreatedAt: daysAgo(2),
      githubUpdatedAt: hoursAgo(3),
      latestRiskScore: 78,
      latestRiskLevel: RiskLevel.HIGH,
    },
  });
  console.log(`\n  pull request  #${analysedPr.number} ${analysedPr.title}`);

  for (const file of fileSeeds) {
    await prisma.$transaction(async (tx) => {
      await tx.pullRequestImportFence.upsert({
        where: { repositoryId_number: { repositoryId: repo.id, number: 412 } },
        create: { repositoryId: repo.id, number: 412, generation: 1 },
        update: { generation: { increment: 1 } },
      });
      await tx.pullRequest.update({
        where: { id: analysedPr.id },
        data: {
          diffBaseSha: null,
          diffHeadSha: null,
          diffMergeBaseSha: null,
          diffVerifiedAt: null,
        },
      });
      await tx.pullRequestFile.upsert({
        where: {
          pullRequestId_filename: { pullRequestId: analysedPr.id, filename: file.filename },
        },
        // Fixture-owned for the same reason as the pull request above: a re-seed has to be able to
        // correct a patch and the counts derived from it on an already-seeded database.
        update: {
          additions: file.additions,
          deletions: file.deletions,
          changes: file.additions + file.deletions,
          patch: file.patch,
          touchedLines: file.touchedLines,
        },
        create: {
          pullRequestId: analysedPr.id,
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.additions + file.deletions,
          language: file.filename.endsWith('.sql')
            ? 'sql'
            : file.filename.endsWith('.json')
              ? 'json'
              : 'typescript',
          flags: file.flags,
          patch: file.patch,
          touchedLines: file.touchedLines,
        },
      });
    });
  }
  console.log(
    `  diff          +${diffTotals.additions} −${diffTotals.deletions} across ` +
      `${diffTotals.changedFiles} file(s), counted from the patch fixtures`,
  );

  const commitSeeds = [
    { sha: '11aa22bb33cc44dd55ee66ff77008899aabbccdd', message: 'feat(refund): add allowOvercredit flag' },
    { sha: '22bb33cc44dd55ee66ff77008899aabbccddee11', message: 'fix: drop the already-refunded guard when overcrediting' },
    { sha: 'f1e2d3c4b5a6978877665544332211aabbccddee', message: 'chore: bump decimal.js' },
  ];

  for (const [index, commit] of commitSeeds.entries()) {
    await prisma.commit.upsert({
      where: { pullRequestId_sha: { pullRequestId: analysedPr.id, sha: commit.sha } },
      update: {},
      create: {
        pullRequestId: analysedPr.id,
        sha: commit.sha,
        message: commit.message,
        authorName: 'Lena Ortiz',
        authorEmail: 'dev@acme.dev',
        authorLogin: 'lena-ortiz',
        authoredAt: hoursAgo(48 - index * 6),
      },
    });
  }

  // ------------------------------------------------------------- review run
  const idempotencyKey = `${analysedPr.id}:${analysedPr.headSha}:${PROMPT_VERSION}:1`;

  const existingRun = await prisma.reviewRun.findUnique({ where: { idempotencyKey } });

  const run =
    existingRun ??
    (await prisma.reviewRun.create({
      data: {
        organizationId: org.id,
        pullRequestId: analysedPr.id,
        status: ReviewRunStatus.COMPLETED,
        stage: ReviewStage.DONE,
        trigger: RunTrigger.USER,
        triggeredByUserId: developer.id,
        headSha: analysedPr.headSha,
        promptVersion: PROMPT_VERSION,
        featureSchemaVersion: 1,
        idempotencyKey,
        startedAt: hoursAgo(3),
        finishedAt: new Date(hoursAgo(3).getTime() + 74_000),
        durationMs: 74_000,
        promptTokens: 18_420,
        completionTokens: 3_180,
        costCents: 4,
        hadStaticAnalysis: true,
        hadMlRisk: true,
        hadRagContext: true,
        hadAiReview: true,
      },
    }));

  if (!existingRun) {
    // ---- tool runs: the audit spine every finding cites as evidence
    const toolSeeds: Array<{ tool: string; durationMs: number; output: unknown }> = [
      {
        tool: 'get_pr_diff',
        durationMs: 640,
        output: {
          files: diffTotals.changedFiles,
          additions: diffTotals.additions,
          deletions: diffTotals.deletions,
        },
      },
      { tool: 'get_repo_metadata', durationMs: 210, output: { primaryLanguage: 'TypeScript', indexed: true } },
      {
        tool: 'run_static_analysis',
        durationMs: 31_400,
        output: { analyzers: ['ESLINT', 'SEMGREP', 'NPM_AUDIT'], findings: 4 },
      },
      { tool: 'extract_ml_features', durationMs: 90, output: { featureSchemaVersion: 1 } },
      { tool: 'predict_pr_risk', durationMs: 340, output: { risk_score: 78, risk_level: 'HIGH' } },
      { tool: 'retrieve_code_context', durationMs: 1_120, output: { chunks: 3, totalTokens: 512 } },
      { tool: 'generate_ai_review', durationMs: 28_900, output: { findings: 5, recommendation: 'REQUEST_CHANGES' } },
      { tool: 'generate_test_suggestions', durationMs: 9_600, output: { testCases: 2 } },
      { tool: 'create_review_report', durationMs: 180, output: { persisted: true } },
      { tool: 'create_audit_log', durationMs: 20, output: { logged: true } },
    ];

    const toolRuns = [];
    for (const [index, seed] of toolSeeds.entries()) {
      toolRuns.push(
        await prisma.toolRun.create({
          data: {
            reviewRunId: run.id,
            tool: seed.tool,
            status: ToolRunStatus.SUCCESS,
            sequence: index + 1,
            input: { reviewRunId: run.id },
            output: seed.output as object,
            durationMs: seed.durationMs,
            startedAt: hoursAgo(3),
            finishedAt: new Date(hoursAgo(3).getTime() + seed.durationMs),
          },
        }),
      );
    }

    const staticAnalysisRun = toolRuns[2];
    if (!staticAnalysisRun) throw new Error('seed: expected the static analysis tool run');

    // ---- static findings
    //
    // Lines come from `anchors`, resolved out of the patch fixtures. Naming the line by its content
    // means extending a patch moves the finding with it instead of leaving it pointing at whatever
    // is now at that number.
    const findingSeeds = [
      {
        analyzer: AnalyzerKind.SEMGREP,
        ruleId: 'javascript.lang.security.audit.sqli.raw-query',
        severity: Severity.CRITICAL,
        category: FindingCategory.SECURITY,
        message:
          'Raw SQL built with string interpolation. `charge.id` and `total` are concatenated directly into the statement, which allows SQL injection if either value is attacker-influenced.',
        path: 'src/payments/refund.service.ts',
        line: anchors.rawSql,
        preexisting: false,
      },
      {
        analyzer: AnalyzerKind.SEMGREP,
        ruleId: 'codelens-no-raw-prisma-without-org-scope',
        severity: Severity.HIGH,
        category: FindingCategory.SECURITY,
        message:
          '$executeRawUnsafe bypasses the tenant-scoping extension and the statement does not filter on organizationId.',
        path: 'src/payments/refund.service.ts',
        line: anchors.rawSql,
        preexisting: false,
      },
      {
        analyzer: AnalyzerKind.ESLINT,
        ruleId: '@typescript-eslint/no-floating-promises',
        severity: Severity.MEDIUM,
        category: FindingCategory.BUG,
        message: 'Promise returned by recordRefund is not awaited on the error path.',
        path: 'src/payments/refund.service.ts',
        line: anchors.recordRefund,
        preexisting: false,
      },
      {
        analyzer: AnalyzerKind.NPM_AUDIT,
        ruleId: 'GHSA-xxxx-decimal-precision',
        severity: Severity.LOW,
        category: FindingCategory.DEPENDENCY,
        message:
          'decimal.js 10.6.0 changes rounding behaviour for values above 2^53. Monetary arithmetic in the ledger relies on the previous default.',
        path: 'package.json',
        line: anchors.dependency,
        preexisting: false,
      },
    ];

    for (const finding of findingSeeds) {
      const fingerprint = sha256(
        `${finding.analyzer}:${finding.ruleId}:${finding.path}:${finding.message}`,
      ).slice(0, 32);

      await prisma.staticFinding.upsert({
        where: { reviewRunId_fingerprint: { reviewRunId: run.id, fingerprint } },
        update: {},
        create: {
          organizationId: org.id,
          reviewRunId: run.id,
          sourceToolRunId: staticAnalysisRun.id,
          analyzer: finding.analyzer,
          ruleId: finding.ruleId,
          severity: finding.severity,
          category: finding.category,
          message: finding.message,
          path: finding.path,
          line: finding.line,
          fingerprint,
          preexisting: finding.preexisting,
        },
      });
    }
    console.log(`  findings      ${findingSeeds.length} static findings`);

    // ---- metrics (the persisted ML feature vector)
    // These match what a real `run_static_analysis` over the four patch fixtures above produces —
    // checked by running one and comparing — rather than plausible-looking numbers invented
    // alongside them. It matters because the merge gate reads `linesAdded + linesDeleted` for its
    // "no test file changed while N lines of code did" blocker, so an invented N here contradicts
    // the diff the same screen is showing.
    await prisma.prMetrics.create({
      data: {
        reviewRunId: run.id,
        linesAdded: diffTotals.additions,
        linesDeleted: diffTotals.deletions,
        filesChanged: diffTotals.changedFiles,
        commitCount: 3,
        // Complexity is estimated from the content reconstructed out of the patches; one function
        // body changed, and its branching goes from 4 to 7.
        functionsChanged: 1,
        complexityBefore: 4,
        complexityAfter: 7,
        complexityDelta: 3,
        maxFunctionComplexity: 5,
        // Two of the seeded findings are SECURITY at HIGH or above, which is what this counts.
        securityFindingsCount: 2,
        testFilesChanged: 0,
        testToCodeRatio: 0,
        dependencyChanged: true,
        authFileChanged: false,
        databaseFileChanged: true,
        configFileChanged: false,
        paymentFileChanged: true,
        infraFileChanged: false,
        // One of the four changed files, refund.service.ts, has prior trouble in this repository.
        previousRiskyFileCount: 1,
        titleText: analysedPr.title,
        commitText: commitSeeds.map((c) => c.message).join(' \n '),
        featureSchemaVersion: 1,
      },
    });

    // ---- ML prediction
    await prisma.mlPrediction.create({
      data: {
        organizationId: org.id,
        reviewRunId: run.id,
        status: MlStatus.OK,
        riskScore: 78,
        riskLevel: RiskLevel.HIGH,
        probability: 0.78,
        confidence: 0.64,
        isBaseline: true,
        predictedReviewTimeMinutes: 52,
        reviewTimeLowerMinutes: 31,
        reviewTimeUpperMinutes: 88,
        topRiskReasons: [
          {
            feature: 'security_findings_count',
            label: 'Security findings',
            value: 2,
            contribution: 0.31,
            direction: 'INCREASES_RISK',
            explanation:
              'Two critical or high severity findings on lines this PR touched, both in the raw SQL path.',
          },
          {
            feature: 'test_files_changed',
            label: 'Tests changed',
            value: 0,
            contribution: 0.22,
            direction: 'INCREASES_RISK',
            explanation:
              'No test file was modified even though refund guard behaviour changed.',
          },
          {
            feature: 'payment_file_changed',
            label: 'Payment code changed',
            value: 1,
            contribution: 0.14,
            direction: 'INCREASES_RISK',
            explanation: 'Touches payment orchestration, where defects have direct financial impact.',
          },
          {
            feature: 'previous_risky_file_count',
            label: 'Historically risky files',
            value: 1,
            contribution: 0.11,
            direction: 'INCREASES_RISK',
            explanation:
              'One changed file, refund.service.ts, has appeared in prior hotfixes in this repository.',
          },
          {
            feature: 'lines_added',
            label: 'Lines added',
            value: diffTotals.additions,
            contribution: -0.04,
            direction: 'DECREASES_RISK',
            explanation: 'The change is small enough to review carefully in one sitting.',
          },
        ],
        similarPullRequests: [
          {
            pullRequestId: null,
            reference: 'acme-engineering/payments-api#287',
            title: 'Skip idempotency check on manual refunds',
            number: 287,
            similarity: 0.89,
            outcome: 'REVERTED',
            riskScore: 81,
          },
          {
            pullRequestId: null,
            reference: 'acme-engineering/payments-api#341',
            title: 'Add goodwill credit endpoint',
            number: 341,
            similarity: 0.76,
            outcome: 'CHANGES_REQUESTED',
            riskScore: 68,
          },
        ],
        issueClusters: [
          {
            cluster_id: 2,
            label: 'Raw SQL and injection risk',
            member_indices: [0, 1],
            top_terms: ['raw', 'sql', 'interpolation', 'query', 'unsafe'],
            size: 2,
          },
        ],
        modelName: 'xgboost',
        modelVersion: 'bootstrap-v1',
        featureSchemaVersion: 1,
      },
    });
    console.log('  ml risk       78 / HIGH (bootstrap-v1)');

    // ---- retrieved context snapshot
    const chunks = await prisma.ragChunk.findMany({ where: { repositoryId: repo.id } });
    for (const [index, chunk] of chunks.entries()) {
      await prisma.retrievedContext.create({
        data: {
          reviewRunId: run.id,
          forFilePath: 'src/payments/refund.service.ts',
          chunkId: chunk.id,
          path: chunk.path,
          symbol: chunk.symbol,
          kind: chunk.kind,
          content: chunk.content,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          tokenCount: chunk.tokenCount,
          score: 0.91 - index * 0.12,
          vectorScore: 0.88 - index * 0.1,
          lexicalScore: index === 0 ? 0.74 : null,
          sources: index === 0 ? ['VECTOR', 'LEXICAL'] : index === 1 ? ['CONVENTION'] : ['VECTOR'],
          rationale:
            index === 0
              ? 'The method being modified, retrieved by both vector and identifier match.'
              : index === 1
                ? 'Existing test for the guard this PR removes, found via the test-convention strategy.'
                : 'Repository error-handling convention, relevant to the new raw SQL path.',
          rank: index + 1,
        },
      });
    }

    // ---- AI review
    const aiReviewRun = toolRuns[6];
    const npmAuditEvidence = staticAnalysisRun.id;

    await prisma.aiReview.create({
      data: {
        organizationId: org.id,
        reviewRunId: run.id,
        executiveSummary:
          'This change enables refunds beyond the original charge amount, but it introduces a SQL injection vector and removes the only safeguard against double refunds without adding a test. It should not merge in its current form.',
        technicalSummary:
          'The `ALREADY_REFUNDED` guard is now conditional on a new `allowOvercredit` flag, and the refunded total is written with `$executeRawUnsafe` using string interpolation rather than the existing Prisma model API. The migration adds `overcredit_allowed` to `charges`, but the service never reads it — the flag is taken from the request body instead, so any caller can bypass the guard regardless of the column. The existing test asserting double-refund rejection was not updated, so it will now fail or silently pass depending on the default.',
        beginnerExplanation:
          "A refund normally cannot exceed what the customer originally paid. This PR adds a way to go past that limit. Two things went wrong. First, the database update is built by gluing strings together, which lets a crafted value change the query — this is called SQL injection, and it's why the repository uses the Prisma query builder everywhere else. Second, the new permission flag comes from the API request rather than the database column the migration just added, so the caller decides their own permission. The repository already has a `Result<T, E>` convention for domain errors documented in docs/architecture.md; following it here would make the failure explicit instead of relying on a raw write.",
        recommendationRationale:
          'A CRITICAL injection finding on a touched line, combined with an authorization flag sourced from client input and no test coverage for the changed guard.',
        modelRecommendation: ApprovalRecommendation.REQUEST_CHANGES,
        effectiveRecommendation: ApprovalRecommendation.REQUEST_CHANGES,
        policyOverridden: false,
        policyReasons: [
          '1 finding(s) at or above the HIGH policy threshold',
          'Risk score 78 meets the organization gate of 70',
        ],
        confidence: 0.86,
        fileExplanations: [
          {
            path: 'src/payments/refund.service.ts',
            whatChanged:
              'The double-refund guard became conditional on `input.allowOvercredit`, and the refunded total is now persisted with a raw interpolated SQL statement.',
            whyItMatters:
              'This is the only code path that protects against refunding more than a customer paid. Sourcing the override from the request body means the caller grants themselves the permission, and the raw write bypasses both the ORM and the tenant-scoping extension described in docs/architecture.md.',
            concerns: [
              'SQL injection via interpolated `total` and `charge.id`',
              'Authorization flag read from client input rather than the `overcredit_allowed` column',
              'Raw write skips the tenant scope guard',
              'Existing double-refund test not updated',
            ],
            relatedContextPaths: [
              'src/payments/refund.service.test.ts',
              'docs/architecture.md',
            ],
          },
          {
            path: 'prisma/migrations/20260918_add_overcredit_flag/migration.sql',
            whatChanged: 'Adds `overcredit_allowed` to the `charges` table, defaulting to false.',
            whyItMatters:
              'The column is the right design, but nothing reads it. Wiring the guard to this column instead of the request body would make the feature safe as intended.',
            concerns: ['Column added but never queried'],
            relatedContextPaths: ['src/payments/refund.service.ts'],
          },
        ],
        findings: [
          {
            category: 'SECURITY',
            severity: 'CRITICAL',
            title: 'SQL injection in the refunded-total update',
            explanation:
              'The UPDATE is assembled with template interpolation, placing `total` and `charge.id` directly into the statement. Use a parameterized query or the Prisma model API, which the rest of this service already uses.',
            path: 'src/payments/refund.service.ts',
            line: anchors.rawSql,
            suggestedFix:
              'await this.db.charge.update({\n  where: { id: charge.id },\n  data: { refundedCents: total },\n});',
            evidence: [staticAnalysisRun.id],
            confidence: 0.95,
          },
          {
            category: 'SECURITY',
            severity: 'HIGH',
            title: 'Overcredit permission is taken from client input',
            explanation:
              '`input.allowOvercredit` arrives in the request body, so any caller can set it. The migration adds `charges.overcredit_allowed` for exactly this purpose — read the guard from the record, not the request.',
            path: 'src/payments/refund.service.ts',
            line: anchors.clientFlag,
            suggestedFix:
              'if (!charge.overcreditAllowed && charge.refundedCents >= charge.amountCents) {\n  return err(new RefundError("ALREADY_REFUNDED"));\n}',
            evidence: [staticAnalysisRun.id],
            confidence: 0.88,
          },
          {
            category: 'TESTING',
            severity: 'HIGH',
            title: 'Double-refund test not updated for the new behaviour',
            explanation:
              "`refund.service.test.ts` asserts that a fully refunded charge is rejected. That assertion now depends on a flag the test does not set, so it no longer verifies the guard it was written for.",
            path: 'src/payments/refund.service.test.ts',
            line: null,
            suggestedFix: null,
            evidence: [],
            confidence: 0.82,
          },
          {
            category: 'MAINTAINABILITY',
            severity: 'MEDIUM',
            title: 'Raw write diverges from the Result convention',
            explanation:
              'docs/architecture.md states that domain failures return `Result<T, E>` and that throwing is reserved for infrastructure errors. A raw statement that can throw mid-method breaks that contract for callers.',
            path: 'src/payments/refund.service.ts',
            line: anchors.rawSql,
            suggestedFix: null,
            evidence: [],
            confidence: 0.71,
          },
          {
            category: 'DEPENDENCY',
            severity: 'LOW',
            title: 'decimal.js bump changes rounding above 2^53',
            explanation:
              'The ledger relies on the previous default rounding. Confirm ledger totals are unaffected, or pin the rounding mode explicitly.',
            path: 'package.json',
            line: anchors.dependency,
            suggestedFix: null,
            evidence: [npmAuditEvidence],
            confidence: 0.6,
          },
        ],
        missingTests: [
          'Overcredit is rejected when charges.overcredit_allowed is false',
          'Overcredit succeeds and records the correct ledger entry when the column is true',
          'A malicious charge id cannot alter the UPDATE statement',
        ],
        suggestedTestCases: [
          {
            description: 'Rejects overcredit when the charge does not permit it',
            path: 'src/payments/refund.service.test.ts',
            code: [
              "it('rejects overcredit when the charge does not allow it', async () => {",
              '  const charge = buildCharge({',
              '    amountCents: 1000,',
              '    refundedCents: 1000,',
              '    overcreditAllowed: false,',
              '  });',
              '  charges.findById.mockResolvedValue(charge);',
              '',
              '  const result = await service.issueRefund({',
              '    chargeId: charge.id,',
              '    amountCents: 500,',
              '    allowOvercredit: true,',
              '  });',
              '',
              '  expect(result.ok).toBe(false);',
              "  expect(result.error.code).toBe('ALREADY_REFUNDED');",
              '});',
            ].join('\n'),
            rationale:
              'Proves the permission comes from the record rather than the request, which is the core of the HIGH authorization finding.',
            priority: 'HIGH',
          },
          {
            description: 'Charge id containing SQL metacharacters is handled safely',
            path: 'src/payments/refund.service.test.ts',
            code: [
              "it('does not allow the charge id to alter the update statement', async () => {",
              '  const charge = buildCharge({',
              '    id: "abc\\\' OR 1=1 --",',
              '    amountCents: 1000,',
              '    refundedCents: 0,',
              '    overcreditAllowed: true,',
              '  });',
              '  charges.findById.mockResolvedValue(charge);',
              '',
              '  await service.issueRefund({ chargeId: charge.id, amountCents: 100 });',
              '',
              '  expect(db.charge.update).toHaveBeenCalledWith({',
              '    where: { id: charge.id },',
              '    data: { refundedCents: 100 },',
              '  });',
              '});',
            ].join('\n'),
            rationale: 'Locks in the parameterized write and prevents a regression to raw SQL.',
            priority: 'HIGH',
          },
        ],
        reviewerChecklist: [
          {
            item: 'No secrets, tokens or credentials in the diff',
            rationale: 'Secret scan found nothing in the added lines.',
            fromPolicy: true,
            status: 'LIKELY_SATISFIED',
          },
          {
            item: 'Tests cover the new behaviour',
            rationale: 'No test file was modified despite a guard behaviour change.',
            fromPolicy: true,
            status: 'NEEDS_ATTENTION',
          },
          {
            item: 'Public API or schema changes are backward compatible',
            rationale:
              'The DTO field is optional and the column defaults to false, so existing callers are unaffected.',
            fromPolicy: true,
            status: 'LIKELY_SATISFIED',
          },
          {
            item: 'Confirm whether finance intended overcredit to be per-charge or per-request',
            rationale:
              'The migration and the implementation disagree on where the permission lives; the answer determines which one is wrong.',
            fromPolicy: false,
            status: 'CANNOT_DETERMINE',
          },
        ],
        openQuestions: [
          'Should overcredit require an approval workflow, or is the per-charge column sufficient?',
          'Does the ledger need a distinct entry type for goodwill credits versus refunds?',
        ],
        droppedFindingCount: 1,
        usedMapReduce: false,
        provider: 'OPENAI',
        model: 'gpt-4o-mini',
        promptVersion: PROMPT_VERSION,
        promptTokens: 18_420,
        completionTokens: 3_180,
        costCents: 4,
      },
    });
    console.log(`  ai review     REQUEST_CHANGES (${aiReviewRun ? 'evidence linked' : 'no tool run'})`);

    // ---- human collaboration
    await prisma.review.create({
      data: {
        organizationId: org.id,
        pullRequestId: analysedPr.id,
        reviewerId: reviewer.id,
        verdict: ReviewVerdict.CHANGES_REQUESTED,
        summary:
          'Agreed with the injection finding. Also: please read the permission from charges.overcredit_allowed rather than the request body, and restore the double-refund test.',
        headSha: analysedPr.headSha,
        acknowledgedChecklistItems: [
          'No secrets, tokens or credentials in the diff',
          'Public API or schema changes are backward compatible',
        ],
        dismissedFindingCount: 0,
      },
    });

    const rootComment = await prisma.comment.create({
      data: {
        organizationId: org.id,
        pullRequestId: analysedPr.id,
        authorId: reviewer.id,
        body: 'Use the Prisma model API here. We removed every raw write from this service in #298 for exactly this reason.',
        path: 'src/payments/refund.service.ts',
        line: anchors.rawSql,
        side: 'RIGHT',
      },
    });

    await prisma.comment.create({
      data: {
        organizationId: org.id,
        pullRequestId: analysedPr.id,
        authorId: developer.id,
        parentId: rootComment.id,
        body: 'Good catch, switching to charge.update. I was working around a type error on refundedCents.',
        path: 'src/payments/refund.service.ts',
        line: anchors.rawSql,
        side: 'RIGHT',
      },
    });
    console.log('  collaboration 1 review, 2 comments');
  }

  // ------------------------------------------------------------- PR #2 (unanalysed)
  const pendingPr = await prisma.pullRequest.upsert({
    where: { repositoryId_number: { repositoryId: repo.id, number: 415 } },
    update: {},
    create: {
      organizationId: org.id,
      repositoryId: repo.id,
      number: 415,
      title: 'Add structured logging to the ledger writer',
      body: 'Replaces console.log with the shared logger and adds a traceId to every ledger entry.',
      state: PullRequestState.OPEN,
      htmlUrl: 'https://github.com/acme-engineering/payments-api/pull/415',
      authorLogin: 'samir-patel',
      authorAvatarUrl: 'https://avatars.githubusercontent.com/u/2?v=4',
      authorUserId: reviewer.id,
      headRef: 'chore/ledger-logging',
      headSha: 'cc11dd22ee33ff4455667788990011aabbccddee',
      baseRef: 'main',
      baseSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      additions: 34,
      deletions: 12,
      changedFiles: 3,
      commitCount: 1,
      mergeable: true,
      labels: ['observability'],
      githubCreatedAt: hoursAgo(5),
      githubUpdatedAt: hoursAgo(1),
    },
  });
  console.log(`  pull request  #${pendingPr.number} ${pendingPr.title} (awaiting analysis)`);

  // ------------------------------------------------------------- audit trail
  const auditSeeds = [
    { action: 'org.created', resourceType: 'Organization', resourceId: org.id, description: 'Organization Acme Engineering created' },
    { action: 'repo.connected', resourceType: 'Repository', resourceId: repo.id, description: 'Connected acme-engineering/payments-api' },
    { action: 'repo.index_completed', resourceType: 'Repository', resourceId: repo.id, description: 'Indexed 3 chunks' },
    { action: 'review_run.completed', resourceType: 'ReviewRun', resourceId: run.id, description: 'Review run completed for PR #412 with risk 78 (HIGH)' },
    { action: 'review.submitted', resourceType: 'PullRequest', resourceId: analysedPr.id, description: 'Samir Patel requested changes on PR #412' },
  ];

  const existingAuditCount = await prisma.auditLog.count({ where: { organizationId: org.id } });
  if (existingAuditCount === 0) {
    for (const [index, entry] of auditSeeds.entries()) {
      await prisma.auditLog.create({
        data: {
          organizationId: org.id,
          action: entry.action,
          actorId: index === 4 ? reviewer.id : owner.id,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          description: entry.description,
          metadata: {},
          traceId: randomBytes(8).toString('hex'),
          createdAt: hoursAgo(auditSeeds.length - index),
        },
      });
    }
    console.log(`  audit log     ${auditSeeds.length} entries`);
  }

  console.log('\nSeed complete.\n');
  console.log('  Sign in with any of:');
  console.log(`    owner@acme.dev     / ${DEMO_PASSWORD}   (OWNER)`);
  console.log(`    reviewer@acme.dev  / ${DEMO_PASSWORD}   (REVIEWER)`);
  console.log(`    dev@acme.dev       / ${DEMO_PASSWORD}   (DEVELOPER)\n`);
}

interface PatchLine {
  /** Position in the post-change file. Null for a removed line. */
  newLine: number | null;
  added: boolean;
  content: string;
}

/**
 * Walk a unified patch, tracking each line's position in the post-change file.
 *
 * A miniature of `parseUnifiedPatch` from `@codelens/github`. The seed is a standalone script and
 * importing the GitHub client into it — with its HTTP layer and token handling — to read four
 * string literals is not a trade worth making. The formats it has to agree on are the two the
 * production parser reads: the `@@ -a,b +c,d @@` header and the one-character line markers.
 */
function parsePatchLines(patch: string): PatchLine[] {
  const result: PatchLine[] = [];
  let newLine = 0;

  for (const raw of patch.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);

    if (header) {
      newLine = Number(header[1]);
      continue;
    }

    // File headers and "\ No newline at end of file" are metadata, not content.
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('\\')) continue;

    const content = raw.slice(1);

    if (raw.startsWith('+')) {
      result.push({ newLine, added: true, content });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      result.push({ newLine: null, added: false, content });
    } else {
      result.push({ newLine, added: false, content });
      newLine += 1;
    }
  }

  return result;
}

/**
 * Everything about a changed file that can be read off its patch.
 *
 * Every line number the demo shows traces back to these patches: the analyzer sums per-file
 * additions and deletions into `linesAdded`/`linesDeleted`, and the merge gate turns those into
 * "No test file changed while N lines of code did". When the counts were written by hand beside the
 * patches they drifted from them — the pull request header claimed +96/−23 over four patches
 * holding 16 added lines, so the header and the merge gate contradicted each other on one screen.
 *
 * `touchedLines` is derived for the same reason, and matters more than the counts: it is what
 * `markPreexisting` uses to decide whether a finding belongs to this change. Written by hand it
 * listed two lines past the end of a hunk and omitted two inside it.
 */
function patchStats(patch: string): {
  additions: number;
  deletions: number;
  touchedLines: number[];
} {
  const lines = parsePatchLines(patch);
  const added = lines.filter((line) => line.added);

  return {
    additions: added.length,
    deletions: lines.filter((line) => line.newLine === null).length,
    touchedLines: added.map((line) => line.newLine as number),
  };
}

/**
 * The post-change line number of the line containing `needle`.
 *
 * Lets a seeded finding say "the `$executeRawUnsafe(` line" instead of "line 69". Hand-written
 * anchors are the same drift problem as hand-written counts: they pointed at line 71 of a hunk that
 * ended at 67, and at line 24 of a file whose changed line was 22.
 *
 * Throws rather than falling back. A fixture edit that moves the anchor out of the patch should stop
 * the seed, not quietly relabel a finding.
 */
function patchLineOf(patch: string, needle: string): number {
  const match = parsePatchLines(patch).find(
    (line) => line.newLine !== null && line.content.includes(needle),
  );

  if (!match?.newLine) {
    throw new Error(`seed: no line in the patch contains ${JSON.stringify(needle)}`);
  }

  return match.newLine;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function daysAgo(days: number): Date {
  return hoursAgo(days * 24);
}

main()
  .catch((error) => {
    console.error('\nSeed failed:', error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });

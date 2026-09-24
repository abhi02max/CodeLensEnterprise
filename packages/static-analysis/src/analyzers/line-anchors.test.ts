import { describe, expect, it } from 'vitest';
import { FileFlag } from '@codelens/shared';
import { runPatternScan } from './pattern-scan';
import { runSecretScan } from './secret-scan';
import { dedupeFindings } from '../runner';
import type { AnalyzerFile, AnalyzerInput } from '../types';

/**
 * Where a finding says it is.
 *
 * Analyzers see `content` reconstructed from diff hunks, which is a *fragment*: its index 0 is
 * wherever the first hunk starts, not line 1 of the file. `contentLineNumbers` carries each line's
 * real position, and these tests pin the mapping, because the previous implementation resolved a
 * line as `touchedLines[findings.length]` — a global finding counter — and was wrong in ways that
 * only showed up as plausible-looking numbers.
 */

/**
 * The refund-service hunk from the demo fixture, as the diff parser hands it over.
 *
 * Built by hand rather than by calling `parseUnifiedPatch`: this package deliberately does not
 * depend on `@codelens/github`. The numbers mirror `@@ -55,8 +55,13 @@` — three context lines from
 * 55, eight added lines at 58–65, two context lines at 66–67.
 */
const REFUND_SERVICE_AFTER: ReadonlyArray<{ line: number; text: string }> = [
  { line: 55, text: '  async issueRefund(input: IssueRefundInput): Promise<Result<Refund, RefundError>> {' },
  { line: 56, text: '    const charge = await this.charges.findById(input.chargeId);' },
  { line: 57, text: '    if (!charge) return err(new RefundError("CHARGE_NOT_FOUND"));' },
  { line: 58, text: '    if (!input.allowOvercredit && charge.refundedCents >= charge.amountCents) {' },
  { line: 59, text: '      return err(new RefundError("ALREADY_REFUNDED"));' },
  { line: 60, text: '    }' },
  { line: 61, text: '' },
  { line: 62, text: '    const total = charge.refundedCents + input.amountCents;' },
  { line: 63, text: '    await this.db.$executeRawUnsafe(' },
  { line: 64, text: '      `UPDATE charges SET refunded_cents = ${total} WHERE id = \'${charge.id}\'`,' },
  { line: 65, text: '    );' },
  { line: 66, text: '    return ok(await this.ledger.recordRefund(charge, input.amountCents));' },
  { line: 67, text: '  }' },
];

function fragment(
  path: string,
  lines: ReadonlyArray<{ line: number; text: string }>,
  overrides: Partial<AnalyzerFile> = {},
): AnalyzerFile {
  return {
    path,
    content: lines.map((entry) => entry.text).join('\n'),
    contentLineNumbers: lines.map((entry) => entry.line),
    previousContent: '',
    language: 'typescript',
    flags: [],
    analyzable: true,
    touchedLines: new Set(lines.map((entry) => entry.line)),
    additions: lines.length,
    deletions: 0,
    ...overrides,
  };
}

function input(files: AnalyzerFile[]): AnalyzerInput {
  return { files, repoConfigFiles: [], manifests: {}, extraSemgrepRulesets: [] };
}

function lineOf(findings: ReturnType<typeof runPatternScan>['findings'], ruleId: string) {
  return findings.find((finding) => finding.ruleId === ruleId)?.line;
}

describe('pattern scan line anchoring', () => {
  const refundService = fragment('src/payments/refund.service.ts', REFUND_SERVICE_AFTER);

  it('anchors a finding to the line the pattern matched, not to a fragment index', () => {
    const { findings } = runPatternScan(input([refundService]));

    // `await this.db.$executeRawUnsafe(` is the ninth line of a fragment that starts at 55.
    // Reporting the index would say 9; the old counter-based resolution said 60.
    expect(lineOf(findings, 'codelens/raw-sql-interpolation')).toBe(63);
  });

  it('puts every finding on the line its own snippet came from', () => {
    const { findings } = runPatternScan(input([refundService]));

    for (const finding of findings) {
      const source = REFUND_SERVICE_AFTER.find((entry) => entry.line === finding.line);
      expect(source, `no fixture line ${String(finding.line)}`).toBeDefined();
      expect(finding.snippet).toBe(source?.text.trim().slice(0, 300));
    }
  });

  it('anchors the guard and authorization findings to their own lines', () => {
    const { findings } = runPatternScan(input([refundService]));

    expect(lineOf(findings, 'codelens/client-controlled-authorization')).toBe(58);
    expect(lineOf(findings, 'codelens/dropped-guard-clause')).toBe(59);
  });

  it('gives two rules matching the same line the same line number', () => {
    const { findings } = runPatternScan(input([refundService]));

    // Both raw-SQL rules match `$executeRawUnsafe(`. They describe different defects — injection
    // and a missing tenant filter — but they are on one line, and previously they were reported
    // three lines apart purely because one was emitted after the other.
    expect(lineOf(findings, 'codelens/raw-sql-interpolation')).toBe(63);
    expect(lineOf(findings, 'codelens/raw-sql-without-tenant-scope')).toBe(63);
  });

  it('does not renumber findings in one file because of findings in another', () => {
    const migration = fragment(
      'prisma/migrations/20260918_add_flag/migration.sql',
      [
        { line: 1, text: 'ALTER TABLE "charges"' },
        { line: 2, text: '  ADD COLUMN "overcredit_allowed" BOOLEAN NOT NULL;' },
      ],
      { language: 'sql' },
    );

    const alone = runPatternScan(input([migration]));
    const after = runPatternScan(input([refundService, migration]));

    expect(lineOf(alone.findings, 'codelens/sql-migration-without-default')).toBe(2);

    // The counter-based resolution indexed the *current* file's touched lines by the number of
    // findings emitted across all previous files, so preceding files silently moved this one.
    expect(lineOf(after.findings, 'codelens/sql-migration-without-default')).toBe(2);
  });

  it('treats an index as a line number when content is a whole file', () => {
    const wholeFile: AnalyzerFile = {
      ...fragment('src/db.ts', []),
      content: ['const a = 1;', 'const b = 2;', 'await this.db.$executeRawUnsafe(`x ${a}`);'].join('\n'),
      touchedLines: new Set([1, 2, 3]),
    };
    delete (wholeFile as { contentLineNumbers?: unknown }).contentLineNumbers;

    const { findings } = runPatternScan(input([wholeFile]));

    expect(lineOf(findings, 'codelens/raw-sql-interpolation')).toBe(3);
  });

  it('reports a file-level finding when the line cannot be mapped', () => {
    const unmappable = fragment('src/db.ts', [{ line: 1, text: 'await this.db.$executeRawUnsafe(`x ${a}`);' }]);

    const { findings } = runPatternScan(
      input([{ ...unmappable, contentLineNumbers: [null] }]),
    );

    // Null rather than a number that happened to be reachable. A finding that cannot say where it
    // is should say nothing, not something wrong.
    expect(lineOf(findings, 'codelens/raw-sql-interpolation')).toBeNull();
  });
});

describe('secret scan over reconstructed content', () => {
  it('detects a secret added inside a hunk', () => {
    // The scanner used to index the fragment *by* new-file line number, so for a hunk starting at
    // line 55 every lookup ran past the end of the array and the scan silently found nothing.
    // Avoids substrings the scanner treats as placeholders — "123456" in an otherwise
    // plausible-looking token is enough to suppress the hit, by design.
    const token = 'ghp_A1b2C3d4E5f6G7h8J9k0LmNpQrStVwXyZa9B';

    const file = fragment('src/config.ts', [
      { line: 55, text: 'export const config = {' },
      { line: 56, text: `  token: "${token}",` },
      { line: 57, text: '};' },
    ]);

    const result = runSecretScan(input([file]));

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.line).toBe(56);
    expect(result.findings[0]?.line).toBe(56);
    // The finding must never carry the credential itself.
    expect(result.findings[0]?.snippet).toBeNull();
    expect(JSON.stringify(result.findings)).not.toContain(token);
  });

  it('ignores a secret on a line the change did not touch', () => {
    const file = fragment(
      'src/config.ts',
      [
        { line: 55, text: '  token: "ghp_A1b2C3d4E5f6G7h8J9k0LmNpQrStVwXyZa9B",' },
        { line: 56, text: '  other: 1,' },
      ],
      // Only line 56 was added; 55 is inherited context.
      { touchedLines: new Set([56]) },
    );

    expect(runSecretScan(input([file])).hits).toHaveLength(0);
  });
});

describe('dedupe across and within analyzers', () => {
  const base = {
    id: '',
    endLine: null,
    column: null,
    helpUrl: null,
    snippet: null,
    preexisting: false,
    sourceToolRunId: '',
    path: 'src/payments/refund.service.ts',
    line: 63,
    category: 'SECURITY',
    message: 'm',
  } as const;

  it('collapses the same location reported by two different analyzers', () => {
    const deduped = dedupeFindings([
      { ...base, analyzer: 'ESLINT', ruleId: 'no-raw-sql', severity: 'HIGH' },
      { ...base, analyzer: 'SEMGREP', ruleId: 'sqli.raw-query', severity: 'CRITICAL' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.severity).toBe('CRITICAL');
  });

  it('keeps two distinct rules from one analyzer on the same line', () => {
    const deduped = dedupeFindings([
      { ...base, analyzer: 'PATTERN_SCAN', ruleId: 'codelens/raw-sql-interpolation', severity: 'CRITICAL' },
      { ...base, analyzer: 'PATTERN_SCAN', ruleId: 'codelens/raw-sql-without-tenant-scope', severity: 'HIGH' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);

    // Injection and a missing tenant filter are two defects that happen to share a line. Fixing
    // the interpolation leaves the cross-tenant read in place, so collapsing them loses a real
    // finding. Before line anchoring was correct these landed on different lines and the question
    // never arose.
    expect(deduped).toHaveLength(2);
  });
});

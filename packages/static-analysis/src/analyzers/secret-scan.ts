import {
  Analyzer,
  AnalyzerStatus,
  FindingCategory,
  Severity,
  scanAddedLinesForSecrets,
  type AnalyzerResult,
  type SecretHit,
  type StaticFinding,
} from '@codelens/shared';
import { fingerprintFinding } from '../fingerprint';
import type { AnalyzerFile, AnalyzerInput } from '../types';

/**
 * Secret detection over added lines.
 *
 * This analyzer is special in two ways.
 *
 * First, it runs in-process rather than as a subprocess: it must complete before
 * any diff content reaches an LLM provider, and its result gates that call. A
 * leaked credential forwarded to a third party while reviewing the commit that
 * leaked it would be a self-inflicted incident.
 *
 * Second, findings never carry the secret value — only a masked excerpt. The
 * detection is recorded in the database and shown in the UI, and neither should
 * become a second copy of the credential.
 */

export function runSecretScan(input: AnalyzerInput): AnalyzerResult & { hits: SecretHit[] } {
  const startedAt = Date.now();
  const findings: StaticFinding[] = [];
  const allHits: SecretHit[] = [];

  for (const file of input.files) {
    if (!file.analyzable) continue;

    // Only added lines. A PR that removes a hardcoded key is the behaviour we
    // want to encourage, and flagging it would be perverse.
    const added = collectAddedLines(file);
    if (added.length === 0) continue;

    const hits = scanAddedLinesForSecrets(file.path, added);
    allHits.push(...hits);

    for (const hit of hits) {
      const ruleId = `secret/${hit.kind.toLowerCase().replace(/\s+/g, '-')}`;

      findings.push({
        id: '',
        analyzer: Analyzer.SECRET_SCAN,
        ruleId,
        // HIGH-confidence patterns match a specific provider prefix and are
        // effectively never false positives, so they block. Entropy-based
        // guesses are reported but must not gate a merge on their own.
        severity: hit.confidence === 'HIGH' ? Severity.CRITICAL : Severity.MEDIUM,
        category: FindingCategory.SECURITY,
        message:
          `Possible ${hit.kind} committed in this change (${hit.maskedExcerpt}). ` +
          `Rotate the credential immediately — it is in git history even if removed in a ` +
          `follow-up commit — and load it from configuration instead.`,
        path: hit.path,
        line: hit.line,
        endLine: null,
        column: null,
        helpUrl: 'https://docs.github.com/code-security/secret-scanning',
        // Deliberately null: a snippet here would persist the secret.
        snippet: null,
        fingerprint: fingerprintFinding({
          analyzer: Analyzer.SECRET_SCAN,
          ruleId,
          path: hit.path,
          message: hit.maskedExcerpt,
        }),
        preexisting: false,
        sourceToolRunId: '',
      });
    }
  }

  return {
    analyzer: Analyzer.SECRET_SCAN,
    status: AnalyzerStatus.SUCCESS,
    findings,
    durationMs: Date.now() - startedAt,
    error: null,
    version: 'builtin',
    filesAnalyzed: input.files.filter((f) => f.analyzable).length,
    hits: allHits,
  };
}

/**
 * Extract the lines this PR added.
 *
 * Walks the content and keeps the lines whose mapped new-file position this change touched.
 *
 * It used to index `content` *by* the touched line numbers — `lines[lineNumber - 1]` — which is
 * only correct when `content` is a whole file. Reconstructed content is a fragment starting at the
 * first hunk, so for a hunk beginning at line 55 every lookup for lines 58 and up landed past the
 * end of a 13-element array and returned undefined. The scanner then found nothing, silently, on
 * every file whose content came from a diff. That is the normal case: a secret added inside a hunk
 * was not detected, and the analyzer reported success.
 */
function collectAddedLines(file: AnalyzerFile): Array<{ line: number; content: string }> {
  if (file.touchedLines.size === 0) return [];

  const lines = file.content.split('\n');
  const result: Array<{ line: number; content: string }> = [];

  for (const [index, text] of lines.entries()) {
    // Absent mapping means `content` is a whole file, where index + 1 is the line number.
    const lineNumber = file.contentLineNumbers === undefined
      ? index + 1
      : file.contentLineNumbers[index];

    if (lineNumber === null || lineNumber === undefined) continue;
    if (!file.touchedLines.has(lineNumber)) continue;

    result.push({ line: lineNumber, content: text });
  }

  return result;
}

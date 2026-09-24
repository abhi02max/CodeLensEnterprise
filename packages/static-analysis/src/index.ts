export {
  runStaticAnalysis,
  markPreexisting,
  dedupeFindings,
  blockingFindings,
  shouldBlockOnSecrets,
  sensitiveFlags,
} from './runner';

export {
  extractMetrics,
  toPrFeatures,
  normalizeText,
  countPreviousRiskyFiles,
} from './features';

export {
  analyzeComplexity,
  complexityDelta,
  stripCommentsAndStrings,
  type ComplexityResult,
  type FunctionComplexity,
} from './complexity';

export {
  AnalysisSandbox,
  fingerprintFinding,
  type ExecResult,
  type SandboxFile,
} from './sandbox';

export { runEslint, categorizeRule } from './analyzers/eslint';
export { runSemgrep, categorizeSemgrepRule, mapSemgrepSeverity } from './analyzers/semgrep';
export { BUILTIN_SEMGREP_RULES, BUILTIN_RULES_FILENAME } from './analyzers/builtin-rules';
export { runNpmAudit, mapAuditSeverity } from './analyzers/npm-audit';
export { runSecretScan } from './analyzers/secret-scan';
export { runPatternScan } from './analyzers/pattern-scan';

export {
  DEFAULT_STATIC_ANALYSIS_OPTIONS,
  type AnalyzerFile,
  type AnalyzerInput,
  type StaticAnalysisOptions,
} from './types';

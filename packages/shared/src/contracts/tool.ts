import type { z } from 'zod';
import type { Role, ToolName, ToolSideEffect } from '../enums';
import type { JsonValue, Result } from './common';

/**
 * MCP-style tool contract.
 *
 * Every capability the review agent has is expressed as one of these. The same
 * registry serves the internal orchestrator today and can be exposed over a real
 * MCP server later without touching tool implementations.
 *
 * Two properties make this more than a function table:
 *
 *   - `requiredRole` means authorization is enforced at the tool boundary, so a
 *     DEVELOPER cannot reach a REVIEWER-only capability by any path.
 *   - `sideEffects` means the orchestrator can refuse external writes on a
 *     speculative or replayed run.
 */
export interface ToolContext {
  readonly organizationId: string;
  readonly userId: string | null;
  readonly userRole: Role;
  readonly reviewRunId: string | null;
  readonly traceId: string;
  /**
   * Set on replay and dry-run executions. Tools with external side effects must
   * become no-ops when this is true.
   */
  readonly dryRun: boolean;
  /** Remaining LLM budget for this run, in cents. */
  readonly remainingBudgetCents: number;
  readonly signal: AbortSignal;
  /** Structured logger already bound to traceId and reviewRunId. */
  readonly logger: ToolLogger;
}

export interface ToolLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface ToolExecutionMeta {
  durationMs: number;
  cacheHit: boolean;
  tokenUsage: { prompt: number; completion: number; total: number } | null;
  costCents: number;
}

export interface ToolOutcome<O> {
  output: O;
  meta: ToolExecutionMeta;
}

export interface McpTool<I = unknown, O = unknown> {
  readonly name: ToolName;
  /** Shown to the model during function calling; keep it precise. */
  readonly description: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly requiredRole: Role;
  readonly sideEffects: ToolSideEffect;
  /**
   * Whether the model may invoke this tool at its own discretion during the
   * follow-up phase. Deterministic pipeline stages are false: they run in a
   * fixed DAG so results stay reproducible.
   */
  readonly modelInvocable: boolean;
  /** Hard timeout. The orchestrator records a TIMED_OUT ToolRun past this. */
  readonly timeoutMs: number;
  execute(input: I, ctx: ToolContext): Promise<ToolOutcome<O>>;
}

/** JSON Schema shape for provider-native function calling. */
export interface ToolFunctionDefinition {
  name: string;
  description: string;
  parameters: JsonValue;
}

export interface ToolRegistry {
  register<I, O>(tool: McpTool<I, O>): void;
  get(name: ToolName): McpTool | undefined;
  list(): McpTool[];
  /** Only the tools the model is allowed to call itself, for a given role. */
  listModelInvocable(role: Role): McpTool[];
  toFunctionDefinitions(role: Role): ToolFunctionDefinition[];
  /**
   * Validate input, enforce role and dry-run rules, execute, validate output.
   * Returns a Result rather than throwing: a failed tool is data the
   * orchestrator records and works around, not an exception that kills the run.
   */
  invoke(
    name: ToolName,
    rawInput: unknown,
    ctx: ToolContext,
  ): Promise<Result<ToolOutcome<unknown>, ToolInvocationError>>;
}

export type ToolErrorCode =
  | 'UNKNOWN_TOOL'
  | 'INVALID_INPUT'
  | 'INVALID_OUTPUT'
  | 'FORBIDDEN_ROLE'
  | 'BLOCKED_DRY_RUN'
  | 'BUDGET_EXCEEDED'
  | 'TIMED_OUT'
  | 'ABORTED'
  | 'UPSTREAM_ERROR'
  | 'EXECUTION_ERROR';

export class ToolInvocationError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly toolName: ToolName | string,
    readonly details?: JsonValue,
  ) {
    super(message);
    this.name = 'ToolInvocationError';
  }
}

/**
 * A node in the deterministic pipeline DAG.
 *
 * `dependsOn` is what lets the orchestrator both order execution and decide what
 * to skip: if `run_static_analysis` fails, `extract_ml_features` still runs with
 * zeroed finding counts, but `predict_pr_risk` is marked DEGRADED. Declaring the
 * graph rather than hardcoding a sequence keeps that logic in one place.
 */
export interface PipelineNode {
  tool: ToolName;
  dependsOn: ToolName[];
  /** When true, a failure here fails the whole run. */
  critical: boolean;
  /** Skip the node when this returns false, e.g. RAG on an unindexed repo. */
  condition?: (state: PipelineState) => boolean;
}

export interface PipelineState {
  readonly outputs: Map<ToolName, JsonValue>;
  readonly failures: Map<ToolName, string>;
  readonly toolRunIds: Map<ToolName, string>;
  /** All successful ToolRun ids, the valid evidence set for AI findings. */
  readonly validEvidenceIds: Set<string>;
}

import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  ToolInvocationError,
  ToolSideEffect,
  err,
  ok,
  roleAtLeast,
  toErrorMessage,
  withTimeout,
  type JsonValue,
  type McpTool,
  type Result,
  type Role,
  type ToolContext,
  type ToolFunctionDefinition,
  type ToolName,
  type ToolOutcome,
  type ToolRegistry,
} from '@codelens/shared';

/**
 * MCP-style tool registry.
 *
 * Every capability the review agent has passes through `invoke`, which applies the
 * same five checks in the same order regardless of caller:
 *
 *   1. the tool exists
 *   2. the caller's role satisfies `requiredRole`
 *   3. external writes are blocked on dry runs and replays
 *   4. input validates against the tool's schema
 *   5. output validates against the tool's schema
 *
 * Centralising this is the point. Authorization enforced at the tool boundary
 * cannot be bypassed by reaching a capability through a different code path, and
 * output validation means a tool that returns the wrong shape fails loudly here
 * rather than corrupting a review three stages later.
 *
 * `invoke` returns a Result rather than throwing. A failed tool is data the
 * orchestrator records as a ToolRun and works around, not an exception that
 * destroys an otherwise salvageable review.
 */

export class McpToolRegistry implements ToolRegistry {
  private readonly tools = new Map<ToolName, McpTool<unknown, unknown>>();

  register<I, O>(tool: McpTool<I, O>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool as unknown as McpTool<unknown, unknown>);
  }

  get(name: ToolName): McpTool | undefined {
    return this.tools.get(name);
  }

  list(): McpTool[] {
    return [...this.tools.values()];
  }

  /**
   * Tools the model may call at its own discretion.
   *
   * Deterministic pipeline stages are excluded: they run in a fixed DAG so a
   * review is reproducible from its inputs. Letting the model decide whether to
   * run static analysis would make two runs of the same commit incomparable.
   */
  listModelInvocable(role: Role): McpTool[] {
    return this.list().filter(
      (tool) => tool.modelInvocable && roleAtLeast(role, tool.requiredRole),
    );
  }

  toFunctionDefinitions(role: Role): ToolFunctionDefinition[] {
    return this.listModelInvocable(role).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.inputSchema, {
        target: 'openApi3',
        $refStrategy: 'none',
      }) as JsonValue,
    }));
  }

  async invoke(
    name: ToolName,
    rawInput: unknown,
    ctx: ToolContext,
  ): Promise<Result<ToolOutcome<unknown>, ToolInvocationError>> {
    const tool = this.tools.get(name);

    if (!tool) {
      return err(
        new ToolInvocationError('UNKNOWN_TOOL', `No tool registered as "${name}"`, name),
      );
    }

    // ---- authorization
    if (!roleAtLeast(ctx.userRole, tool.requiredRole)) {
      return err(
        new ToolInvocationError(
          'FORBIDDEN_ROLE',
          `${tool.name} requires the ${tool.requiredRole} role; caller has ${ctx.userRole}`,
          name,
        ),
      );
    }

    // ---- side-effect containment
    //
    // A replayed or speculative run must not post to GitHub again. Enforced here
    // rather than inside each tool so a new external-write tool inherits the
    // protection by declaring its side effect honestly.
    if (ctx.dryRun && tool.sideEffects === ToolSideEffect.EXTERNAL_WRITE) {
      return err(
        new ToolInvocationError(
          'BLOCKED_DRY_RUN',
          `${tool.name} performs an external write and was skipped on a dry run`,
          name,
        ),
      );
    }

    if (ctx.signal.aborted) {
      return err(new ToolInvocationError('ABORTED', 'Run was cancelled before execution', name));
    }

    // ---- input validation
    const parsedInput = tool.inputSchema.safeParse(rawInput);

    if (!parsedInput.success) {
      return err(
        new ToolInvocationError(
          'INVALID_INPUT',
          `Input to ${tool.name} failed validation: ${formatZodError(parsedInput.error)}`,
          name,
          parsedInput.error.issues as unknown as JsonValue,
        ),
      );
    }

    // ---- execute
    let outcome: ToolOutcome<unknown>;

    try {
      outcome = await withTimeout(
        tool.execute(parsedInput.data, ctx),
        tool.timeoutMs,
        tool.name,
      );
    } catch (error) {
      const message = toErrorMessage(error);

      if (/timed out after/.test(message)) {
        return err(
          new ToolInvocationError(
            'TIMED_OUT',
            `${tool.name} exceeded its ${tool.timeoutMs}ms budget`,
            name,
          ),
        );
      }

      if (ctx.signal.aborted) {
        return err(new ToolInvocationError('ABORTED', 'Run was cancelled', name));
      }

      return err(new ToolInvocationError('EXECUTION_ERROR', message, name));
    }

    // ---- output validation
    //
    // Catches a drifting upstream contract at the boundary. Without this, a
    // service returning an unexpected shape surfaces as a confusing failure in a
    // later stage that has nothing to do with the real cause.
    const parsedOutput = tool.outputSchema.safeParse(outcome.output);

    if (!parsedOutput.success) {
      return err(
        new ToolInvocationError(
          'INVALID_OUTPUT',
          `Output from ${tool.name} failed validation: ${formatZodError(parsedOutput.error)}`,
          name,
          parsedOutput.error.issues as unknown as JsonValue,
        ),
      );
    }

    // ---- budget accounting
    if (outcome.meta.costCents > ctx.remainingBudgetCents) {
      return err(
        new ToolInvocationError(
          'BUDGET_EXCEEDED',
          `${tool.name} cost ${outcome.meta.costCents} cents, exceeding the remaining ` +
            `budget of ${ctx.remainingBudgetCents} cents for this run`,
          name,
        ),
      );
    }

    return ok({ output: parsedOutput.data, meta: outcome.meta });
  }
}

interface ZodLikeError {
  issues: Array<{ path: Array<string | number>; message: string }>;
}

function formatZodError(error: ZodLikeError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Helper for defining a tool with correct inference at the call site. */
export function defineTool<I, O>(tool: McpTool<I, O>): McpTool<I, O> {
  return tool;
}

/** No-op meta for tools that neither cache nor call a model. */
export function plainMeta(durationMs: number): ToolOutcome<never>['meta'] {
  return { durationMs, cacheHit: false, tokenUsage: null, costCents: 0 };
}

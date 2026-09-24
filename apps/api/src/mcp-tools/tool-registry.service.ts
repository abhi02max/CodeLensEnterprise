import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { McpToolRegistry } from '@codelens/ai-agent';
import { ToolName, type Role } from '@codelens/shared';
import { ToolsFactory } from './tools.factory';

/**
 * Holds the single {@link McpToolRegistry} instance and registers the eleven tools into it at
 * startup.
 *
 * Registration is verified against the {@link ToolName} union rather than assumed: a tool that
 * exists in the enum but was never registered would silently become a permanently-skipped
 * pipeline stage, and the run would look successful while quietly doing less. Failing at boot
 * is much better than discovering it from a missing section in a review.
 */
@Injectable()
export class ToolRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ToolRegistryService.name);
  readonly registry = new McpToolRegistry();

  constructor(private readonly factory: ToolsFactory) {}

  onModuleInit(): void {
    for (const tool of this.factory.build()) {
      this.registry.register(tool);
    }

    const registered = new Set(this.registry.list().map((tool) => tool.name));
    const expected = Object.values(ToolName);
    const missing = expected.filter((name) => !registered.has(name));

    if (missing.length > 0) {
      throw new Error(
        `MCP tool registry is incomplete. Missing implementations for: ${missing.join(', ')}. ` +
          `Every ToolName must be registered, otherwise its pipeline stage is silently skipped.`,
      );
    }

    this.logger.log(
      `Registered ${registered.size} MCP tools ` +
        `(${this.registry.list().filter((t) => t.modelInvocable).length} model-invocable, ` +
        `${this.registry.list().filter((t) => t.sideEffects === 'external-write').length} with external writes)`,
    );
  }

  /** Tool catalogue for the UI and for provider function calling. */
  describe(role: Role) {
    return this.registry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      requiredRole: tool.requiredRole,
      sideEffects: tool.sideEffects,
      modelInvocable: tool.modelInvocable,
      timeoutMs: tool.timeoutMs,
      /** Whether the caller's role is sufficient to invoke it. */
      available: this.registry
        .listModelInvocable(role)
        .some((candidate) => candidate.name === tool.name),
    }));
  }

  functionDefinitions(role: Role) {
    return this.registry.toFunctionDefinitions(role);
  }
}

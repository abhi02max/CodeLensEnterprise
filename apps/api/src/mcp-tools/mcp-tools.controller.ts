import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@codelens/shared';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators';
import { ToolRegistryService } from './tool-registry.service';

/**
 * Read-only introspection of the tool registry.
 *
 * Deliberately offers no endpoint to invoke a tool directly. Tools run inside an orchestrated
 * run so that every execution is recorded as a ToolRun with provenance; an "invoke arbitrary
 * tool" endpoint would let a caller produce findings with no run to attribute them to, which
 * would undermine the evidence model the whole review depends on.
 */
@ApiTags('mcp-tools')
@ApiBearerAuth('access-token')
@Controller('mcp-tools')
export class McpToolsController {
  constructor(private readonly registry: ToolRegistryService) {}

  @Get()
  @ApiOperation({ summary: 'Describe the registered MCP tools and their authorization' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return {
      tools: this.registry.describe(user.role ?? Role.DEVELOPER),
      note:
        'Tools execute only as part of an orchestrated analysis run, so every execution is ' +
        'recorded as a ToolRun that findings can cite as evidence.',
    };
  }

  @Get('function-definitions')
  @ApiOperation({
    summary: 'JSON Schema function definitions for provider-native function calling',
  })
  functionDefinitions(@CurrentUser() user: AuthenticatedUser) {
    return this.registry.functionDefinitions(user.role ?? Role.DEVELOPER);
  }
}

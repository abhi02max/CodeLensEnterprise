import { Global, Module, forwardRef } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { MlModule } from '../ml/ml.module';
import { PullRequestsModule } from '../pull-requests/pull-requests.module';
import { RagModule } from '../rag/rag.module';
import { McpToolsController } from './mcp-tools.controller';
import { ToolRegistryService } from './tool-registry.service';
import { ToolsFactory } from './tools.factory';

/**
 * forwardRef on AnalysisModule because the dependency is genuinely circular: the tools need the
 * scratchpad and report writer that live in AnalysisModule, and AnalysisService needs the tool
 * registry to run the pipeline. Splitting the scratchpad into a third module would remove the
 * cycle but scatter closely-related pieces for no real benefit.
 */
@Global()
@Module({
  imports: [MlModule, RagModule, PullRequestsModule, forwardRef(() => AnalysisModule)],
  controllers: [McpToolsController],
  providers: [ToolsFactory, ToolRegistryService],
  exports: [ToolRegistryService, ToolsFactory],
})
export class McpToolsModule {}

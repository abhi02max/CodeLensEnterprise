import { Global, Module, forwardRef } from '@nestjs/common';
import { McpToolsModule } from '../mcp-tools/mcp-tools.module';
import { MlModule } from '../ml/ml.module';
import { RagModule } from '../rag/rag.module';
import { AnalysisController } from './analysis.controller';
import { AnalysisReportService } from './analysis-report.service';
import { AnalysisService } from './analysis.service';
import { ReportWriter } from './report-writer.service';
import { RunScratchpad } from './run-scratchpad';

/**
 * RunScratchpad is a singleton by necessity: tools within one run must observe the same
 * instance to compose. Nest providers are singletons per application by default, which is
 * exactly what is needed here.
 */
@Global()
@Module({
  imports: [MlModule, RagModule, forwardRef(() => McpToolsModule)],
  controllers: [AnalysisController],
  providers: [AnalysisService, AnalysisReportService, ReportWriter, RunScratchpad],
  exports: [AnalysisService, AnalysisReportService, ReportWriter, RunScratchpad],
})
export class AnalysisModule {}

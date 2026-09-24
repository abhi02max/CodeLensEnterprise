import { Global, Module } from '@nestjs/common';
import { AuditLogsController } from './audit-logs.controller';
import { AuditService } from './audit.service';

/**
 * Global because almost every module records audit entries. Making each one import
 * AuditLogsModule explicitly would add noise without adding clarity.
 */
@Global()
@Module({
  controllers: [AuditLogsController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditLogsModule {}

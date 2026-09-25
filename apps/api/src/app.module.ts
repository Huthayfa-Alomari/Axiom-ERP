import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard.js';
import { HealthModule } from './modules/health/health.module.js';
import { PosModule } from './modules/pos/pos.module.js';
import { ReportingModule } from './modules/reporting/reporting.module.js';
import { WorkspaceModule } from './modules/workspace/workspace.module.js';

@Module({
  imports: [DatabaseModule, HealthModule, PosModule, ReportingModule, WorkspaceModule],
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from './infrastructure/database/database.module';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { HealthModule } from './modules/health/health.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { WorkspaceModule } from './modules/workspace/workspace.module';

@Module({
  imports: [DatabaseModule, HealthModule, ReportingModule, WorkspaceModule],
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}

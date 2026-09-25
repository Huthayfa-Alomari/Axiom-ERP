import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard.js';
import { FixedAssetsModule } from './modules/fixed-assets/fixed-assets.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { PayrollModule } from './modules/payroll/payroll.module.js';
import { PosModule } from './modules/pos/pos.module.js';
import { ReportingModule } from './modules/reporting/reporting.module.js';
import { TreasuryModule } from './modules/treasury/treasury.module.js';
import { WorkspaceModule } from './modules/workspace/workspace.module.js';

@Module({
  imports: [
    DatabaseModule,
    FixedAssetsModule,
    HealthModule,
    InventoryModule,
    PayrollModule,
    PosModule,
    ReportingModule,
    TreasuryModule,
    WorkspaceModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}

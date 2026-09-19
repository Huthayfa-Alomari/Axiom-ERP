import { Module } from '@nestjs/common';
import { FinancialReportingService } from './application/financial-reporting.service.js';
import { FinancialReportingRepository } from './infrastructure/financial-reporting.repository.js';
import { ReportingController } from './reporting.controller.js';

@Module({
  controllers: [ReportingController],
  providers: [FinancialReportingService, FinancialReportingRepository],
})
export class ReportingModule {}

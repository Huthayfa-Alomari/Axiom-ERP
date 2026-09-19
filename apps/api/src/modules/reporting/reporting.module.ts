import { Module } from '@nestjs/common';
import { ReportingController } from './reporting.controller';
@Module({ controllers: [ReportingController] })
export class ReportingModule {}

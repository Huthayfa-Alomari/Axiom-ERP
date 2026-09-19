import { Module } from '@nestjs/common';
import { ReportingController } from './reporting.controller.js';

@Module({ controllers: [ReportingController] })
export class ReportingModule {}

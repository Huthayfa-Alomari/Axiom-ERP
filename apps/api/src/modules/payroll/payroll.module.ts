import { Module } from '@nestjs/common';
import { PayrollController } from './payroll.controller.js';

@Module({ controllers: [PayrollController] })
export class PayrollModule {}

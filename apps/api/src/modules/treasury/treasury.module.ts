import { Module } from '@nestjs/common';
import { TreasuryController } from './treasury.controller.js';

@Module({ controllers: [TreasuryController] })
export class TreasuryModule {}

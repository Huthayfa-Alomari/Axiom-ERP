import { Module } from '@nestjs/common';
import { PosScaleController } from './pos-scale.controller.js';
import { PosLiveScaleController } from './pos-live-scale.controller.js';
import { PosTenantService } from './pos-tenant.service.js';

@Module({
  controllers: [PosScaleController, PosLiveScaleController],
  providers: [PosTenantService],
})
export class PosModule {}

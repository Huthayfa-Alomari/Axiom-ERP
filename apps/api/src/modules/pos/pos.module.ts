import { Module } from '@nestjs/common';
import { PosScaleController } from './pos-scale.controller.js';

@Module({
  controllers: [PosScaleController],
})
export class PosModule {}

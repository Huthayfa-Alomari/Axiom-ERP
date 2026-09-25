import { Module } from '@nestjs/common';
import { FixedAssetsController } from './fixed-assets.controller.js';

@Module({ controllers: [FixedAssetsController] })
export class FixedAssetsModule {}

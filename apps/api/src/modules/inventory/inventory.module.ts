import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller.js';

@Module({ controllers: [InventoryController] })
export class InventoryModule {}

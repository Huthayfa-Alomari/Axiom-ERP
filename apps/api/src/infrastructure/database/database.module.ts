import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { TenantDatabaseService } from './tenant-database.service.js';

@Global()
@Module({
  providers: [DatabaseService, TenantDatabaseService],
  exports: [DatabaseService, TenantDatabaseService],
})
export class DatabaseModule {}

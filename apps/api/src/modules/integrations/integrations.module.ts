import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationInboxService } from './integration-inbox.service.js';
import { IntegrationTokenGuard } from './integration-token.guard.js';
import { IntegrationInboxWorker } from './integration-inbox.worker.js';

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationInboxService, IntegrationTokenGuard, IntegrationInboxWorker],
})
export class IntegrationsModule {}

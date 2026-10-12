import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationInboxService } from './integration-inbox.service.js';
import { IntegrationTokenGuard } from './integration-token.guard.js';

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationInboxService, IntegrationTokenGuard],
})
export class IntegrationsModule {}

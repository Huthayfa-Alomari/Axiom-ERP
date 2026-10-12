import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../../common/auth/public.decorator.js';
import {
  integrationEventSchema,
} from './integration-event.schema.js';
import { IntegrationInboxService } from './integration-inbox.service.js';
import { IntegrationTokenGuard } from './integration-token.guard.js';

@Public()
@UseGuards(IntegrationTokenGuard)
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly inbox: IntegrationInboxService) {}

  @Post('events')
  @HttpCode(HttpStatus.ACCEPTED)
  async acceptEvent(@Body() body: unknown) {
    const parsed = integrationEventSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'INVALID_INTEGRATION_EVENT',
        issues: parsed.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    return this.inbox.accept(parsed.data);
  }
}

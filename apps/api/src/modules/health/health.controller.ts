import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { Public } from '../../common/auth/public.decorator.js';

@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}
  @Public() @Get('live') live() { return { status: 'ok', service: 'axiom-api' }; }
  @Public() @Get('ready') async ready() {
    try { await sql`select 1`.execute(this.database.db); return { status: 'ready', database: 'ok' }; }
    catch { throw new ServiceUnavailableException({ status: 'not_ready', database: 'unavailable' }); }
  }
}

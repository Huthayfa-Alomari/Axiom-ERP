import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

export interface DatabaseSchema {
  [table: string]: unknown;
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  public readonly pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
  public readonly db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: this.pool }) });

  public async onModuleDestroy() {
    await this.db.destroy();
  }
}

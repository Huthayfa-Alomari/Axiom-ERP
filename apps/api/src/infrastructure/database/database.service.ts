import { ForbiddenException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Kysely, PostgresDialect, Transaction, sql } from 'kysely';
import { Pool } from 'pg';

export interface DatabaseSchema {
  [table: string]: unknown;
}

export interface TenantRequestContext {
  organizationId: string;
  userId: string;
  requestId: string;
}

export interface TenantTransactionOptions {
  readOnly?: boolean;
  isolationLevel?: 'read_committed' | 'repeatable_read' | 'serializable';
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  public readonly pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX ?? 20),
    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 30_000),
    idle_in_transaction_session_timeout: Number(process.env.DB_IDLE_TX_TIMEOUT_MS ?? 30_000),
  });

  public readonly db = new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({ pool: this.pool }),
  });

  async runInTenantContext<T>(
    ctx: TenantRequestContext,
    work: (trx: Transaction<DatabaseSchema>) => Promise<T>,
    options: TenantTransactionOptions = {},
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      switch (options.isolationLevel) {
        case 'repeatable_read':
          await sql`set transaction isolation level repeatable read`.execute(trx);
          break;
        case 'serializable':
          await sql`set transaction isolation level serializable`.execute(trx);
          break;
        case 'read_committed':
        case undefined:
          break;
      }

      if (options.readOnly) {
        await sql`set transaction read only`.execute(trx);
      }

      await sql`
        select
          set_config('app.organization_id', ${ctx.organizationId}, true),
          set_config('app.user_id', ${ctx.userId}, true),
          set_config('app.request_id', ${ctx.requestId}, true)
      `.execute(trx);

      const membership = await sql<{ allowed: boolean }>`
        select exists (
          select 1
          from app.memberships
          where organization_id=${ctx.organizationId}::uuid
            and user_id=${ctx.userId}::uuid
            and is_active
        ) as allowed
      `.execute(trx);

      if (!membership.rows[0]?.allowed) {
        throw new ForbiddenException('Active organization membership required');
      }

      return work(trx);
    });
  }

  async onModuleDestroy() {
    await this.db.destroy();
  }
}

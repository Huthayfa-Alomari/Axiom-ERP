import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DatabaseService } from './database.service.js';

const uuidSchema = z.string().uuid();

@Injectable()
export class TenantDatabaseService {
  constructor(private readonly database: DatabaseService) {}

  async run<T>(
    organizationIdRaw: string | undefined,
    userIdRaw: string | undefined,
    permission: string | null,
    work: (client: PoolClient, organizationId: string, userId: string) => Promise<T>,
  ): Promise<T> {
    const organizationId = uuidSchema.safeParse(organizationIdRaw);
    const userId = uuidSchema.safeParse(userIdRaw);

    if (!organizationId.success) {
      throw new BadRequestException('Valid x-organization-id header is required.');
    }
    if (!userId.success) {
      throw new ForbiddenException('Authenticated principal required.');
    }

    const client = await this.database.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.organization_id',$1,true), set_config('app.user_id',$2,true)",
        [organizationId.data, userId.data],
      );

      const access = await client.query<{ member: boolean; permitted: boolean }>(
        `SELECT
           EXISTS(
             SELECT 1 FROM app.memberships
             WHERE organization_id=$1 AND user_id=$2 AND is_active
           ) AS member,
           CASE WHEN $3::text IS NULL THEN true
                ELSE app.user_has_permission($3,$1)
           END AS permitted`,
        [organizationId.data, userId.data, permission],
      );

      if (!access.rows[0]?.member) {
        throw new ForbiddenException('User is not an active organization member.');
      }
      if (!access.rows[0]?.permitted) {
        throw new ForbiddenException(`Permission required: ${permission}`);
      }

      const result = await work(client, organizationId.data, userId.data);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

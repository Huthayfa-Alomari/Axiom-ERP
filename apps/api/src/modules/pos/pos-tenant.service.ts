import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';

export interface PosRequest {
  principal?: { id: string; email: string | null };
}

export const uuidSchema = z.string().uuid();

@Injectable()
export class PosTenantService {
  constructor(private readonly database: DatabaseService) {}

  async run<T>(
    organizationIdRaw: string | undefined,
    request: PosRequest,
    permission: string,
    work: (client: PoolClient, organizationId: string) => Promise<T>,
  ): Promise<T> {
    const organizationId = uuidSchema.safeParse(organizationIdRaw);
    if (!organizationId.success) {
      throw new BadRequestException('Valid x-organization-id header is required.');
    }
    const userId = request.principal?.id;
    if (!userId || !uuidSchema.safeParse(userId).success) {
      throw new ForbiddenException('Authenticated principal required.');
    }

    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.organization_id',$1,true), set_config('app.user_id',$2,true)",
        [organizationId.data, userId],
      );
      const access = await client.query<{ member: boolean; permitted: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM app.memberships
           WHERE organization_id=$1 AND user_id=$2 AND is_active
         ) AS member, app.user_has_permission($3,$1) AS permitted`,
        [organizationId.data, userId, permission],
      );
      if (!access.rows[0]?.member) {
        throw new ForbiddenException('User is not an active organization member.');
      }
      if (!access.rows[0]?.permitted) {
        throw new ForbiddenException(`Permission required: ${permission}`);
      }
      const result = await work(client, organizationId.data);
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

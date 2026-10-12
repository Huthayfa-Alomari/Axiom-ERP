import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { IntegrationEvent } from './integration-event.schema.js';

interface MappingRow {
  id: string;
  organization_id: string;
}

interface InboxRow {
  id: string;
  status: string;
  raw_event: unknown;
}

export interface AcceptEventResult {
  accepted: true;
  duplicate: boolean;
  eventId: string;
  inboxId: string;
  status: string;
}

@Injectable()
export class IntegrationInboxService {
  constructor(private readonly database: DatabaseService) {}

  async accept(event: IntegrationEvent): Promise<AcceptEventResult> {
    const client = await this.database.pool.connect();

    try {
      await client.query('BEGIN');

      const mapping = await client.query<MappingRow>(
        `SELECT id, organization_id
           FROM integration.tenant_mappings
          WHERE source=$1
            AND external_tenant_id=$2
            AND COALESCE(external_branch_id, '')=COALESCE($3::text, '')
            AND is_active
          FOR SHARE`,
        [event.source, event.tenant.externalTenantId, event.tenant.externalBranchId ?? null],
      );

      const tenant = mapping.rows[0];
      if (!tenant) {
        throw new NotFoundException('No active organization mapping exists for this integration tenant.');
      }

      const inserted = await client.query<InboxRow>(
        `INSERT INTO integration.inbox_events (
           organization_id, tenant_mapping_id, source,
           external_tenant_id, external_branch_id, event_id,
           event_type, schema_version, occurred_at, raw_event
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         ON CONFLICT (
           source, external_tenant_id, (COALESCE(external_branch_id, '')), event_id
         ) DO NOTHING
         RETURNING id, status, raw_event`,
        [
          tenant.organization_id,
          tenant.id,
          event.source,
          event.tenant.externalTenantId,
          event.tenant.externalBranchId ?? null,
          event.eventId,
          event.type,
          event.schemaVersion,
          event.occurredAt,
          JSON.stringify(event),
        ],
      );

      if (inserted.rows[0]) {
        await client.query('COMMIT');
        return {
          accepted: true,
          duplicate: false,
          eventId: event.eventId,
          inboxId: inserted.rows[0].id,
          status: inserted.rows[0].status,
        };
      }

      const prior = await client.query<InboxRow>(
        `SELECT id, status, raw_event
           FROM integration.inbox_events
          WHERE source=$1
            AND external_tenant_id=$2
            AND COALESCE(external_branch_id, '')=COALESCE($3::text, '')
            AND event_id=$4
          LIMIT 1`,
        [event.source, event.tenant.externalTenantId, event.tenant.externalBranchId ?? null, event.eventId],
      );

      const existing = prior.rows[0];
      if (!existing) {
        throw new ConflictException('Event idempotency conflict; retry safely.');
      }

      const existingJson = JSON.stringify(existing.raw_event);
      const incomingJson = JSON.stringify(event);
      // PostgreSQL JSONB normalizes object-key order; compare JSONB in SQL rather
      // than relying on JavaScript property order.
      const identical = await client.query<{ identical: boolean }>(
        'SELECT raw_event = $2::jsonb AS identical FROM integration.inbox_events WHERE id=$1',
        [existing.id, incomingJson],
      );
      if (!identical.rows[0]?.identical) {
        throw new ConflictException('Event ID was already used with a different payload.');
      }

      await client.query('COMMIT');
      return {
        accepted: true,
        duplicate: true,
        eventId: event.eventId,
        inboxId: existing.id,
        status: existing.status,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

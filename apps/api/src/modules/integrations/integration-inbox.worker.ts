import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { integrationEventSchema, type IntegrationEvent } from './integration-event.schema.js';

interface PendingInboxRow {
  id: string;
  organization_id: string;
  tenant_mapping_id: string;
  raw_event: unknown;
}

interface TenantMappingRow {
  id: string;
  organization_id: string;
  source: string;
  external_tenant_id: string;
  external_branch_id: string | null;
  warehouse_id: string;
  default_customer_id: string | null;
  base_currency_code: string;
}

interface ProductMappingRow {
  product_id: string;
  product_type: string;
  is_active: boolean;
}

interface OrderLinkRow {
  sales_order_id: string;
  status: string;
}

class IntegrationProcessingError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'IntegrationProcessingError';
  }
}

function currencyExponent(currency: string): number {
  if (['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'].includes(currency)) return 3;
  if (['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'].includes(currency)) return 0;
  return 2;
}

function minorUnitsToDecimal(amount: number, currency: string): string {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new IntegrationProcessingError('INVALID_UNIT_PRICE');
  }
  const exponent = currencyExponent(currency);
  const integer = BigInt(amount);
  const factor = 10n ** BigInt(exponent);
  const whole = integer / factor;
  if (exponent === 0) return whole.toString();
  const fraction = (integer % factor).toString().padStart(exponent, '0');
  return whole.toString() + '.' + fraction;
}

function errorCode(error: unknown): string {
  if (error instanceof IntegrationProcessingError) return error.code;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return 'DATABASE_' + error.code.slice(0, 40);
  }
  return 'INTEGRATION_PROCESSING_FAILED';
}

@Injectable()
export class IntegrationInboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntegrationInboxWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly database: DatabaseService) {}

  onModuleInit(): void {
    if (process.env.INTEGRATION_WORKER_ENABLED !== 'true') return;
    const configured = Number(process.env.INTEGRATION_WORKER_POLL_MS ?? 5000);
    const intervalMs = Number.isFinite(configured) ? Math.max(1000, Math.min(60000, configured)) : 5000;
    this.timer = setInterval(() => {
      void this.processBatch().catch(() => this.logger.error('Integration inbox poll failed.'));
    }, intervalMs);
    this.timer.unref();
    this.logger.log(`Integration inbox worker enabled (poll interval ${intervalMs}ms).`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Public for controlled tests and operator tooling; processes at most one batch. */
  async processBatch(batchSize = 10): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      let processed = 0;
      const safeBatchSize = Math.max(1, Math.min(50, Math.trunc(batchSize)));
      for (let index = 0; index < safeBatchSize; index += 1) {
        const didWork = await this.processOne();
        if (!didWork) break;
        processed += 1;
      }
      return processed;
    } finally {
      this.running = false;
    }
  }

  private async processOne(): Promise<boolean> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<PendingInboxRow>(
        `SELECT id, organization_id, tenant_mapping_id, raw_event
           FROM integration.inbox_events
          WHERE status='received'
             OR (status='failed' AND next_attempt_at <= clock_timestamp())
          ORDER BY next_attempt_at, received_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
      );
      const inbox = selected.rows[0];
      if (!inbox) {
        await client.query('COMMIT');
        return false;
      }

      await client.query("SELECT set_config('app.organization_id',$1,true)", [inbox.organization_id]);
      await client.query('SAVEPOINT integration_business_effect');
      try {
        const event = integrationEventSchema.parse(inbox.raw_event);
        const result = await this.applyEvent(client, inbox, event);
        await client.query(
          `UPDATE integration.inbox_events
              SET status='processed', processed_at=clock_timestamp(),
                  attempt_count=attempt_count+1, last_error_code=NULL, result=$2::jsonb
            WHERE id=$1`,
          [inbox.id, JSON.stringify(result)],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT integration_business_effect');
        const code = errorCode(error);
        await client.query(
          `UPDATE integration.inbox_events
              SET status='failed',
                  attempt_count=attempt_count+1,
                  last_error_code=$2,
                  next_attempt_at=clock_timestamp()
                    + make_interval(secs => LEAST(3600, (30 * power(2, LEAST(attempt_count, 7)))::integer))
            WHERE id=$1`,
          [inbox.id, code],
        );
        await client.query('COMMIT');
        this.logger.warn(`Integration event processing deferred (event ${inbox.id}, code ${code}).`);
      }
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async applyEvent(
    client: PoolClient,
    inbox: PendingInboxRow,
    event: IntegrationEvent,
  ): Promise<Record<string, unknown>> {
    const mappingResult = await client.query<TenantMappingRow>(
      `SELECT tm.id, tm.organization_id, tm.source, tm.external_tenant_id,
              tm.external_branch_id, tm.warehouse_id, tm.default_customer_id,
              o.base_currency_code
         FROM integration.tenant_mappings tm
         JOIN app.organizations o ON o.id=tm.organization_id
        WHERE tm.id=$1 AND tm.organization_id=$2 AND tm.is_active
        FOR SHARE OF tm`,
      [inbox.tenant_mapping_id, inbox.organization_id],
    );
    const mapping = mappingResult.rows[0];
    if (!mapping) throw new IntegrationProcessingError('TENANT_MAPPING_INACTIVE');
    if (
      mapping.source !== event.source ||
      mapping.external_tenant_id !== event.tenant.externalTenantId ||
      (mapping.external_branch_id ?? undefined) !== event.tenant.externalBranchId
    ) {
      throw new IntegrationProcessingError('TENANT_MAPPING_MISMATCH');
    }

    if (event.type === 'commerce.order.created') {
      return this.createSalesOrder(client, inbox, mapping, event);
    }
    return this.cancelSalesOrder(client, mapping, event);
  }

  private async createSalesOrder(
    client: PoolClient,
    inbox: PendingInboxRow,
    mapping: TenantMappingRow,
    event: Extract<IntegrationEvent, { type: 'commerce.order.created' }>,
  ): Promise<Record<string, unknown>> {
    const externalOrderId = event.payload.externalOrderId;

    const prior = await client.query<OrderLinkRow>(
      `SELECT sales_order_id, status
         FROM integration.external_order_links
        WHERE tenant_mapping_id=$1 AND external_order_id=$2
        FOR UPDATE`,
      [mapping.id, externalOrderId],
    );
    if (prior.rows[0]) {
      return {
        salesOrderId: prior.rows[0].sales_order_id,
        externalOrderId,
        status: prior.rows[0].status,
        duplicateOrder: true,
      };
    }

    if (event.payload.currency !== mapping.base_currency_code) {
      throw new IntegrationProcessingError('ORDER_CURRENCY_NOT_SUPPORTED');
    }

    let customerId = mapping.default_customer_id;
    if (event.payload.customerReference) {
      const customer = await client.query<{ customer_id: string }>(
        `SELECT customer_id FROM integration.customer_mappings
          WHERE tenant_mapping_id=$1 AND organization_id=$2 AND external_customer_id=$3`,
        [mapping.id, mapping.organization_id, event.payload.customerReference],
      );
      customerId = customer.rows[0]?.customer_id ?? null;
      if (!customerId) throw new IntegrationProcessingError('CUSTOMER_MAPPING_MISSING');
    }
    if (!customerId) throw new IntegrationProcessingError('DEFAULT_CUSTOMER_NOT_CONFIGURED');

    const products: Array<{ productId: string; quantity: number; unitPrice: string }> = [];
    for (const line of event.payload.lines) {
      const mapped = await client.query<ProductMappingRow>(
        `SELECT p.id AS product_id, p.product_type::text AS product_type, p.is_active
           FROM integration.product_mappings pm
           JOIN inventory.products p
             ON p.organization_id=pm.organization_id AND p.id=pm.product_id
          WHERE pm.tenant_mapping_id=$1
            AND pm.organization_id=$2
            AND pm.external_product_id=$3`,
        [mapping.id, mapping.organization_id, line.externalProductId],
      );
      const product = mapped.rows[0];
      if (!product || !product.is_active || product.product_type !== 'stocked') {
        throw new IntegrationProcessingError('PRODUCT_MAPPING_MISSING_OR_NOT_STOCKED');
      }
      products.push({
        productId: product.product_id,
        quantity: line.quantity,
        unitPrice: minorUnitsToDecimal(line.unitPriceMinor, event.payload.currency),
      });
    }

    const order = await client.query<{ id: string; order_number: string }>(
      `INSERT INTO sales.sales_orders
         (organization_id, customer_id, order_date, status, currency_code, exchange_rate)
       VALUES ($1,$2,$3,'draft',$4,1)
       RETURNING id, order_number::text`,
      [mapping.organization_id, customerId, event.occurredAt.slice(0, 10), event.payload.currency],
    );
    const salesOrder = order.rows[0];
    if (!salesOrder) throw new IntegrationProcessingError('SALES_ORDER_CREATE_FAILED');

    for (let index = 0; index < products.length; index += 1) {
      const product = products[index]!;
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended($1::text||':'||$2::text||':'||$3::text,0)
         )`,
        [mapping.organization_id, product.productId, mapping.warehouse_id],
      );
      const stock = await client.query<{ enough: boolean }>(
        `SELECT COALESCE((
           SELECT available_quantity
             FROM inventory.available_stock
            WHERE organization_id=$1 AND product_id=$2 AND warehouse_id=$3
         ),0) >= $4::numeric AS enough`,
        [mapping.organization_id, product.productId, mapping.warehouse_id, String(product.quantity)],
      );
      if (!stock.rows[0]?.enough) {
        throw new IntegrationProcessingError('INSUFFICIENT_STOCK');
      }

      const reservation = await client.query<{ reservation_id: string }>(
        `SELECT (inventory.reserve_stock($1::uuid,$2::uuid,$3::numeric,'sales_order',$4::text,NULL)).id::text AS reservation_id`,
        [product.productId, mapping.warehouse_id, product.quantity, salesOrder.id],
      );
      const reservationId = reservation.rows[0]?.reservation_id;
      if (!reservationId) throw new IntegrationProcessingError('STOCK_RESERVATION_FAILED');

      await client.query(
        `INSERT INTO sales.sales_order_lines
           (organization_id, sales_order_id, line_number, product_id, warehouse_id, quantity, unit_price, reservation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          mapping.organization_id,
          salesOrder.id,
          index + 1,
          product.productId,
          mapping.warehouse_id,
          product.quantity,
          product.unitPrice,
          reservationId,
        ],
      );
    }

    await client.query(
      `UPDATE sales.sales_orders SET status='reserved'
        WHERE organization_id=$1 AND id=$2`,
      [mapping.organization_id, salesOrder.id],
    );
    await client.query(
      `INSERT INTO integration.external_order_links
         (tenant_mapping_id, organization_id, external_order_id, sales_order_id, status)
       VALUES ($1,$2,$3,$4,'reserved')`,
      [mapping.id, mapping.organization_id, externalOrderId, salesOrder.id],
    );
    const outboundEventId = randomUUID();
    await client.query(
      `INSERT INTO integration.outbox_events
         (organization_id, event_id, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1,$2,'commerce.order.reserved','sales_order',$3,$4::jsonb)`,
      [
        mapping.organization_id,
        outboundEventId,
        salesOrder.id,
        JSON.stringify({
          schemaVersion: 1,
          eventId: outboundEventId,
          type: 'commerce.order.reserved',
          occurredAt: new Date().toISOString(),
          source: 'axiom',
          tenant: {
            externalTenantId: event.tenant.externalTenantId,
            externalBranchId: event.tenant.externalBranchId,
          },
          correlationId: event.correlationId,
          payload: {
            externalOrderId,
            salesOrderId: salesOrder.id,
            orderNumber: salesOrder.order_number,
            status: 'reserved',
          },
        }),
      ],
    );

    return {
      salesOrderId: salesOrder.id,
      orderNumber: salesOrder.order_number,
      externalOrderId,
      status: 'reserved',
      sourceInboxId: inbox.id,
    };
  }

  private async cancelSalesOrder(
    client: PoolClient,
    mapping: TenantMappingRow,
    event: Extract<IntegrationEvent, { type: 'commerce.order.cancelled' }>,
  ): Promise<Record<string, unknown>> {
    const externalOrderId = event.payload.externalOrderId;
    const linkResult = await client.query<OrderLinkRow>(
      `SELECT sales_order_id, status
         FROM integration.external_order_links
        WHERE tenant_mapping_id=$1 AND external_order_id=$2
        FOR UPDATE`,
      [mapping.id, externalOrderId],
    );
    const link = linkResult.rows[0];
    if (!link) throw new IntegrationProcessingError('EXTERNAL_ORDER_NOT_FOUND');
    if (link.status === 'cancelled') {
      return { salesOrderId: link.sales_order_id, externalOrderId, status: 'cancelled', duplicateCancellation: true };
    }

    const order = await client.query<{ status: string }>(
      `SELECT status::text AS status FROM sales.sales_orders
        WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [mapping.organization_id, link.sales_order_id],
    );
    const currentStatus = order.rows[0]?.status;
    if (!currentStatus) throw new IntegrationProcessingError('SALES_ORDER_NOT_FOUND');
    if (['delivered', 'closed'].includes(currentStatus)) {
      throw new IntegrationProcessingError('ORDER_ALREADY_FULFILLED');
    }

    await client.query(
      `UPDATE inventory.stock_reservations
          SET status='released'
        WHERE organization_id=$1 AND source_type='sales_order'
          AND source_id=$2 AND status='active'`,
      [mapping.organization_id, link.sales_order_id],
    );
    await client.query(
      `UPDATE sales.sales_orders SET status='cancelled'
        WHERE organization_id=$1 AND id=$2`,
      [mapping.organization_id, link.sales_order_id],
    );
    await client.query(
      `UPDATE integration.external_order_links
          SET status='cancelled', updated_at=clock_timestamp()
        WHERE tenant_mapping_id=$1 AND external_order_id=$2`,
      [mapping.id, externalOrderId],
    );
    const outboundEventId = randomUUID();
    await client.query(
      `INSERT INTO integration.outbox_events
         (organization_id, event_id, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1,$2,'commerce.order.cancelled','sales_order',$3,$4::jsonb)`,
      [
        mapping.organization_id,
        outboundEventId,
        link.sales_order_id,
        JSON.stringify({
          schemaVersion: 1,
          eventId: outboundEventId,
          type: 'commerce.order.cancelled',
          occurredAt: new Date().toISOString(),
          source: 'axiom',
          tenant: {
            externalTenantId: event.tenant.externalTenantId,
            externalBranchId: event.tenant.externalBranchId,
          },
          correlationId: event.correlationId,
          payload: { externalOrderId, salesOrderId: link.sales_order_id, status: 'cancelled' },
        }),
      ],
    );

    return { salesOrderId: link.sales_order_id, externalOrderId, status: 'cancelled' };
  }
}

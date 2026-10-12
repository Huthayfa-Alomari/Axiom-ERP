import { describe, expect, it } from 'vitest';
import {
  integrationEventDedupeKey,
  integrationEventSchema,
} from './integration-event.schema.js';

const validOrderEvent = {
  schemaVersion: 1,
  eventId: 'c3a1d0a6-85a0-4b8c-8d3f-3b0e0f4c5a01',
  type: 'commerce.order.created',
  occurredAt: '2026-10-12T12:00:00Z',
  source: 'altayebat',
  tenant: {
    source: 'altayebat',
    externalTenantId: 'store-001',
    externalBranchId: 'branch-01',
  },
  payload: {
    externalOrderId: 'order-1001',
    currency: 'JOD',
    lines: [{
      externalProductId: 'product-01',
      sku: 'SKU-01',
      quantity: 2,
      unitPriceMinor: 350,
      currency: 'JOD',
    }],
  },
};

describe('integrationEventSchema', () => {
  it('accepts a valid versioned order-created event', () => {
    expect(integrationEventSchema.safeParse(validOrderEvent).success).toBe(true);
  });

  it('rejects unsupported schema versions', () => {
    expect(integrationEventSchema.safeParse({ ...validOrderEvent, schemaVersion: 2 }).success).toBe(false);
  });

  it('rejects unknown fields instead of silently accepting them', () => {
    expect(integrationEventSchema.safeParse({ ...validOrderEvent, organizationId: 'attacker-controlled' }).success).toBe(false);
  });

  it('rejects non-positive quantities', () => {
    const event = {
      ...validOrderEvent,
      payload: {
        ...validOrderEvent.payload,
        lines: [{ ...validOrderEvent.payload.lines[0], quantity: 0 }],
      },
    };
    expect(integrationEventSchema.safeParse(event).success).toBe(false);
  });

  it('rejects line currency that differs from order currency', () => {
    const event = {
      ...validOrderEvent,
      payload: {
        ...validOrderEvent.payload,
        lines: [{ ...validOrderEvent.payload.lines[0], currency: 'USD' }],
      },
    };
    expect(integrationEventSchema.safeParse(event).success).toBe(false);
  });

  it('accepts a valid cancellation event', () => {
    const event = {
      ...validOrderEvent,
      type: 'commerce.order.cancelled',
      payload: { externalOrderId: 'order-1001', reason: 'Customer request' },
    };
    expect(integrationEventSchema.safeParse(event).success).toBe(true);
  });
});

describe('integrationEventDedupeKey', () => {
  it('scopes the event identifier to its producer tenant and branch', () => {
    const parsed = integrationEventSchema.parse(validOrderEvent);
    expect(integrationEventDedupeKey(parsed)).toBe('altayebat:store-001:branch-01:c3a1d0a6-85a0-4b8c-8d3f-3b0e0f4c5a01');
  });

  it('uses an explicit placeholder when no branch is provided', () => {
    const parsed = integrationEventSchema.parse({
      ...validOrderEvent,
      tenant: { source: 'altayebat', externalTenantId: 'store-001' },
    });
    expect(integrationEventDedupeKey(parsed)).toContain('altayebat:store-001:_:');
  });
});

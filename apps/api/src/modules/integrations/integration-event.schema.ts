import { z } from 'zod';

/**
 * Versioned service-to-service event contract for commerce integrations.
 *
 * This module validates message shape only. It does not authenticate producers,
 * authorize tenant mappings, persist events, or make event handling idempotent.
 * Those guarantees must be enforced by the integration transport and database.
 */
const nonEmptyId = z.string().trim().min(1).max(200);
const isoTimestamp = z.string().datetime({ offset: true });

export const integrationSourceSchema = z.enum(['altayebat', 'axiom', 'external']);

export const integrationTenantSchema = z.object({
  externalTenantId: nonEmptyId,
  externalBranchId: nonEmptyId.optional(),
}).strict();

export const commerceOrderLineSchema = z.object({
  externalProductId: nonEmptyId,
  sku: nonEmptyId.optional(),
  quantity: z.number().finite().positive(),
  unitPriceMinor: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();

export const commerceOrderCreatedPayloadSchema = z.object({
  externalOrderId: nonEmptyId,
  orderNumber: nonEmptyId.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  lines: z.array(commerceOrderLineSchema).min(1).max(500),
  customerReference: nonEmptyId.optional(),
  notes: z.string().max(2000).optional(),
}).strict().superRefine((payload, context) => {
  payload.lines.forEach((line, index) => {
    if (line.currency !== payload.currency) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines', index, 'currency'],
        message: 'Line currency must match order currency.',
      });
    }
  });
});

export const integrationEventSchema = z.discriminatedUnion('type', [
  z.object({
    schemaVersion: z.literal(1),
    eventId: z.string().uuid(),
    type: z.literal('commerce.order.created'),
    occurredAt: isoTimestamp,
    source: integrationSourceSchema,
    tenant: integrationTenantSchema,
    correlationId: nonEmptyId.optional(),
    payload: commerceOrderCreatedPayloadSchema,
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    eventId: z.string().uuid(),
    type: z.literal('commerce.order.cancelled'),
    occurredAt: isoTimestamp,
    source: integrationSourceSchema,
    tenant: integrationTenantSchema,
    correlationId: nonEmptyId.optional(),
    payload: z.object({
      externalOrderId: nonEmptyId,
      reason: z.string().max(1000).optional(),
    }).strict(),
  }).strict(),
]);

export type IntegrationEvent = z.infer<typeof integrationEventSchema>;
export type CommerceOrderCreatedPayload = z.infer<typeof commerceOrderCreatedPayloadSchema>;

/**
 * Canonical, collision-resistant composite key for inbox deduplication.
 * Each free-form identifier is URI-encoded so delimiter characters in an
 * external tenant or branch ID cannot produce ambiguous composite keys.
 */
export function integrationEventDedupeKey(event: Pick<IntegrationEvent, 'source' | 'tenant' | 'eventId'>): string {
  return [
    event.source,
    encodeURIComponent(event.tenant.externalTenantId),
    event.tenant.externalBranchId === undefined
      ? 'no-branch'
      : 'branch=' + encodeURIComponent(event.tenant.externalBranchId),
    event.eventId,
  ].join(':');
}

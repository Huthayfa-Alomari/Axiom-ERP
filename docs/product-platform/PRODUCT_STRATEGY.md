# Axiom Business Cloud — Product Strategy

Date: 2026-10-12
Status: Product/architecture proposal; not a production implementation.

## Product thesis

Package the existing Axiom ERP core and Altayebat commerce/delivery capabilities as a multi-tenant business platform with industry-specific workspaces and customer-facing apps. Do not fork the ERP for every industry and do not merge the two production databases directly.

## Product layers

1. **Shared business core (Axiom):** accounting, inventory, purchasing, sales/order-to-cash, treasury, fixed assets, payroll/HR, manufacturing, POS synchronization and financial reconciliation.
2. **Commerce and fulfillment (Altayebat):** customer catalog, online checkout, customer orders, delivery integrations, store branding and customer app.
3. **Industry packs:** configuration and purpose-built modules for restaurants, retail/supermarkets, and malls/commercial property.
4. **Platform operations:** tenant onboarding, plans, entitlements, support, audit, backups, observability and billing.

## First target segments

### 1. Supermarkets and multi-branch retail — first pilot
- Product/barcode and weighted-product catalog
- POS, price/offer management, inventory, warehouse transfers and purchasing
- Customer ordering, delivery and loyalty
- Daily cash reconciliation and accounting postings
- Branch-level access and consolidated reporting

Why first: Altayebat already has grocery catalog/order/delivery context, and Axiom has inventory, POS and scale/barcode foundations. This is a fit hypothesis, not proof that all workflows are production-ready.

### 2. Restaurants and cafés — second industry pack
Required capabilities:
- Dine-in tables, tabs, reservations and takeaway/delivery order channels
- Kitchen display / prep queue and order status
- Menu modifiers, combos and availability windows
- Recipes/BOM, ingredient consumption, yield and waste
- Purchasing, stock, food-cost, payroll/shift management and accounting
- Customer ordering, loyalty and branch-aware menus

Do not market these restaurant-specific capabilities as complete until built and tested. Existing manufacturing BOM/WIP may inform recipe costing, but restaurant recipe and kitchen workflows require their own UX and operational rules.

### 3. Malls and commercial property — enterprise pack
Required capabilities:
- Mall/property/building/floor/unit hierarchy
- Tenant directory, leases, renewals, deposits and escalation clauses
- Rent/service-charge schedules, invoices, receivables and arrears
- Occupancy and lease-expiry dashboards
- Maintenance/facilities work orders and asset management
- Tenant portal and visitor app for directory, offers, events, parking and participating-store ordering

Axiom currently documents accounting, AR/AP, treasury and fixed assets that can support parts of this pack. A dedicated lease/property-management domain is required; do not assume it exists today.

## Commercial packaging

Offer:
- SaaS subscription by organization and enabled modules
- Per-branch / terminal / user limits where appropriate
- One-time onboarding, data import, training and hardware integration
- Optional branded customer app and custom domain
- Enterprise annual contracts for multi-branch groups and malls

Any JOD price remains a hypothesis until hosting, support, payment, messaging, onboarding and hardware costs are estimated and customer interviews validate willingness to pay.

## Product principles

- One accounting source of truth; no shadow ledgers.
- One authoritative inventory posting path; no double stock deduction.
- Every write scoped to a verified tenant and authorized role.
- Idempotent external event processing and auditable retries.
- Industry packs share core primitives but retain workflows specific to their business.
- Arabic/English, RTL, Jordanian currency/tax/accounting settings and local payment/delivery adapters are release requirements to verify, not assumed complete.
- No live database migration or customer cutover until staging and rollback gates pass.

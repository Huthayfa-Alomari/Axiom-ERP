# Axiom + Altayebat Module Readiness Matrix

Date: 2026-10-12
Scope: Static repository review of Axiom ERP `main`, plus the documented Altayebat SaaS branch. This is not a runtime penetration test, deployment test, accounting certification or full code audit.

## Evidence-based status labels

- **Foundation present:** schema/API/code exists in the reviewed repository, but production completeness is not established.
- **Partial/product gap:** some backend foundation exists; workflow, UX, integration, controls or tests are not yet sufficient to claim a complete commercial module.
- **Not evidenced:** the reviewed paths do not establish that the capability exists. This does not prove no code exists elsewhere.

## Matrix

| Capability | Repository evidence | Readiness | Work before selling as complete |
|---|---|---|---|
| Multi-tenant organizations and memberships | `database/migrations/0001_core.sql` has organizations, memberships, roles and permissions; tenant context helpers exist | Foundation present; security verification required | Test cross-tenant access through every API path; verify authenticated identity cannot spoof organization context |
| Double-entry accounting / GL | README and core migration include chart of accounts, fiscal periods, journal entries and accounting types | Foundation present | Run full release gate; verify posting/reversal, fiscal locks, tax handling, opening balances and external accountant review |
| Inventory and costing | Migrations `0002_operations.sql` and `0008_inventory_posting_kernel.sql` define stock ledger, FIFO layers, costing and inventory posting | Foundation present | End-to-end receipt/sale/return/transfer/count tests; concurrency, negative stock, reconciliation and API authorization |
| Purchasing / vendors | Schema and workspace query for purchase orders/vendors are present | Partial/product gap | Verify vendor onboarding, approval, receipt matching, returns, payment terms and GL reconciliation UX |
| Sales / customer orders | Sales schema and workspace list query exist | Partial/product gap | Confirm complete quote/order/fulfillment/invoice/return lifecycle and channel integration |
| POS / scale / barcode | POS module, scale configuration endpoints, EAN-13 parsing and offline sync contracts exist | Foundation present; hardware compatibility unverified | Test real terminal/scanner/scale models, offline replay, duplicate event handling, shift/cash closure and price integrity |
| Treasury / bank reconciliation | Treasury module/controller and bank statement workspace query exist | Partial/product gap | Test imports, matching, reconciliation controls, bank formats and permissions |
| Fixed assets | Schema/API module and workspace query exist | Partial/product gap | Test asset lifecycle, depreciation schedules, disposals, revaluation policy and accounting periods |
| Payroll / HR | Payroll module and migration exist | Partial/product gap | Validate Jordan labor/payroll requirements, employee records, approvals, privacy, end-of-service and payroll posting with local specialist |
| Manufacturing / BOM / WIP | README, operations migration and workspace query refer to manufacturing and WIP | Foundation present; retail/restaurant fit unverified | Verify production execution and costing; design a restaurant recipe/ingredient workflow rather than assuming manufacturing equals kitchen operations |
| Executive dashboard | Dashboard UI renders named KPI cards but currently displays em dashes | UI shell only | Implement real API metrics, date ranges, branch filters and reconciliations |
| Operational workspaces | Generic module route renders tables from API; current list covers sales, purchasing, inventory, treasury, fixed assets, payroll and manufacturing | Partial | Add real workflows/forms/validation, pagination, search, actions, loading/error states and permission-based UI |
| Altayebat customer commerce | Existing separate repository has catalog, checkout, order and delivery code | Existing product; integration unverified | Map products, prices, branches, orders, payment state and stock reservations; test cancellation/refund paths |
| Restaurant-specific operations | Not established by the reviewed Axiom module list | Not evidenced as a complete pack | Build tables and workflows for tables/tabs, kitchen queue, modifiers, menu availability, recipes, waste and shifts |
| Mall leasing/property management | Not established by the reviewed Axiom module list | Not evidenced as a complete pack | Build property/unit/lease, rent schedules, deposits, service charges, tenant portal and facilities work orders |
| SaaS plan/subscription administration | Documented in Altayebat feature branch PR #19, still a draft | Prototype/foundation only | Cross-tenant RLS tests, staging validation, billing webhooks, admin bootstrap and human release approval |
| Customer-branded apps | Altayebat supports store-aware branding/routing in its SaaS feature branch | Partial | Verify tenant authorization separately from URL routing; enforce tenant isolation in database policies and storage |

## Highest-priority blockers

1. Tenant isolation and trusted organization context across Axiom API controllers.
2. End-to-end accounting/inventory release gate with realistic integration fixtures.
3. Idempotent order-to-inventory/accounting posting bridge.
4. Real KPI calculations and usable operational workflows in the ERP web UI.
5. A real staging environment with backups, restore drills, monitoring and migration rollback.
6. Industry-specific product gaps before claiming restaurant or mall ERP completeness.

## Acceptance evidence required

Every module should have:
- Migration test on disposable PostgreSQL
- API authorization tests for allowed and denied roles
- Cross-tenant read/write tests
- Domain lifecycle tests, including reversal/cancellation
- Accounting/inventory reconciliation checks where applicable
- UI error/loading/empty states
- Operational runbook and backup/restore plan

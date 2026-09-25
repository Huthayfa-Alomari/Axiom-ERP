# Axiom ERP

Axiom ERP is a multi-tenant enterprise ERP monorepo centered on an immutable double-entry accounting kernel and a perpetual inventory engine.

## Modules

- Accounting / GL / fiscal periods / reversals
- AR / AP and customer/vendor subledgers
- Purchasing and three-way matching
- Sales and order-to-cash
- Inventory with FIFO / moving average costing
- Treasury and bank reconciliation
- Fixed assets and depreciation
- HR / payroll
- Manufacturing / BOM / WIP
- Offline-first POS client and sync contract (server posting pending)
- POS scale-label barcodes and a direct Web Serial weighing preview (`/pos`)
- Financial reporting and cross-module reconciliation
- Pre-posting risk/anomaly service
- Next.js executive/workspace UI

## Architecture principles

1. Accounting is the only financial source of truth.
2. Operational modules emit transactional payloads to Accounting and Inventory; they never maintain shadow ledgers.
3. Posted journals and stock movements are immutable; corrections use reversals/compensating movements.
4. Tenant isolation is enforced by PostgreSQL RLS plus application authorization.
5. Money and quantities are stored as NUMERIC in PostgreSQL and strings at the TypeScript API boundary.
6. POS sync is idempotent and sequence-based.
7. Release gates reconcile subledgers against the GL before deployment is considered healthy.

## Quick start

```bash
cp .env.example .env
pnpm install
docker compose -f infra/docker/docker-compose.yml up -d postgres
pnpm db:migrate
pnpm --filter @axiom/api dev
pnpm --filter @axiom/web dev
```

API: `http://localhost:3001/api/v1`

Web: `http://localhost:3000`

Direct scale setup and current checkout limitations: [docs/POS_LIVE_SCALE.md](docs/POS_LIVE_SCALE.md).

AI risk service: `http://localhost:8000`

## Database migrations

This repository uses a squashed release baseline rather than reproducing all historical conversation-era migrations. The baseline captures the final architecture in coherent dependency order.

## Release gate

```bash
pnpm release:gate
```

A release is not accepted unless the accounting equation, journal balance, inventory state, manufacturing WIP, and subledger-to-GL reconciliation checks pass.

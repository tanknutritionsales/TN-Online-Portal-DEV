# Hosted Migration Checklist

Use this when creating the Online Portal GitHub repo and Netlify project.

## Keep Out Of Git

- `.env`
- `data/*.json`
- `data/proofs/`
- `public/product-images/`
- `memory/`
- `*.log`

Only commit safe examples such as `data/*.example.json`.

## Netlify Environment Variables

Required before hosted testing:

```text
NODE_ENV=production
SESSION_SECRET=<long random value>
ADMIN_USERNAME=<private admin username>
ADMIN_PASSWORD=<private admin password>
INTERNAL_API_TOKEN=<long random token shared only with Retail Shark>
SHOPIFY_STORE_SUBDOMAIN=<subdomain only, not the full .myshopify.com URL>
SHOPIFY_ADMIN_API_VERSION=2026-07
SHOPIFY_ADMIN_ACCESS_TOKEN=<offline Admin API token>
SHOPIFY_ORDER_SYNC_ENABLED=false
SHOPIFY_ORDER_INVENTORY_BEHAVIOUR=DECREMENT_OBEYING_POLICY
SHOPIFY_ORDER_SEND_RECEIPT=false
DATABASE_URL=<Netlify Database connection string>
PROOF_STORAGE_MODE=blobs
PROOF_BLOB_STORE=op-payment-proofs
```

Optional when ready:

```text
RETAIL_SHARK_INTERNAL_URL=<Retail Shark internal API base URL>
RETAIL_SHARK_INTERNAL_TOKEN=<Retail Shark internal token>
MAX_JSON_BODY_BYTES=7000000
BANK_ACCOUNT_NAME=<customer-facing EFT account name>
BANK_NAME=<customer-facing bank name>
BANK_ACCOUNT_NUMBER=<customer-facing account number>
BANK_BRANCH_CODE=<customer-facing branch code>
```

## Current Hosted Prep State

- `netlify.toml` routes `/api/*` to `netlify/functions/app.mjs`.
- `server.js` exports the shared request handler and still runs locally with `npm start`.
- Production refuses unsafe default values for `SESSION_SECRET`, `INTERNAL_API_TOKEN`, and `ADMIN_PASSWORD`.
- Source no longer contains the real Shopify store subdomain.
- Local JSON files remain supported for development.

## Still Needed Before Production Use

- Add the database storage adapter for accounts, addresses, shop settings, orders, order items, POP metadata, status events, and tracking.
- POP file uploads use Netlify Blobs when `PROOF_STORAGE_MODE=blobs`; order/database records store only metadata and the private blob key.
- Seed/import only into a preview or explicitly approved production environment.
- Rotate any secret that was pasted in chat or used during local testing.
- Re-enable `SHOPIFY_ORDER_SYNC_ENABLED` only when paid-order hosted testing is approved.

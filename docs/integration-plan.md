# Online Portal Integration Plan

## Boundary

Online Portal is the customer-facing app and owner of customer order data. Retail Shark is the staff operations app. The two apps must integrate through protected APIs, not shared local files.

## Local Testing Phase

Current local storage:

```text
data/users.json
data/orders.json
data/proofs/
public/product-images/
```

During local testing:

- Shopify reads are allowed for catalog, product images, prices, and current stock.
- Shopify order writes are disabled by default. A guarded live test can be enabled with `SHOPIFY_ORDER_SYNC_ENABLED=true` after the app has `write_orders` scope and an offline Admin token.
- Retail Shark hosted data must not be touched.
- Retail Shark integration should be mocked or tested against local Online Portal endpoints only.

## Hosted Phase

Planned hosted shape:

```text
Online Portal Netlify site
  -> Online Portal backend
  -> Online Portal database/storage

Retail Shark Netlify site
  -> Online Portal internal API
  -> Online Portal database/storage
```

Online Portal should move from JSON files to hosted database tables:

```text
portal_accounts
portal_account_addresses
portal_orders
portal_order_items
portal_payment_proofs
portal_order_status_events
portal_tracking_updates
portal_internal_api_tokens
```

POP files should move to private Netlify Blobs storage for v0.1. Database rows should store file metadata, private blob keys, checksums where useful, uploader, and upload time. POP reads must go through authenticated API routes; blob keys must not be accepted from arbitrary client input.

## Hosted Storage Split

| Area | Hosted store | Why |
|---|---|---|
| Accounts, roles, password hashes, theme preferences | Netlify Database / Postgres | Needs querying, filtering, uniqueness, auditability, and safe multi-session reads. |
| Customer delivery addresses | Netlify Database / Postgres | Customers can keep multiple reusable delivery addresses and choose one at checkout. |
| Orders, order items, status events, tracking, special-order reviews | Netlify Database / Postgres | This is the transactional source of truth shared by Online Portal and Retail Shark. |
| Shop settings and featured slider config | Netlify Database / Postgres | Small structured records that admins edit and customers read. |
| Proof-of-payment uploads | Private blob/object storage | Files should not live in relational rows; the database stores metadata and private storage keys. |
| Cached Shopify product/collection images | Blob/object storage or build cache | Cache only; Shopify remains the source of truth. |
| Shopify products, prices, tags, collection images, stock availability | Shopify Admin API | Read-only source of truth for catalog and current availability. |

## System Map

| System | Owns | Reads from | Writes to |
|---|---|---|---|
| Online Portal | Customer accounts, EFT order requests, POP metadata, customer-visible statuses, featured shop settings | Shopify Admin API for catalog/availability; its own database/storage | Its own database/storage; Shopify orders only after admin payment confirmation when sync is explicitly enabled |
| Retail Shark | Staff packing/tracking/back-order workflow | Online Portal protected internal API for confirmed paid orders | Online Portal internal API for tracking, back-order, and shipped updates |
| Shopify | Product catalog, prices, tags, collection images, inventory availability, paid order record after POP verification | Shopify Admin data | Receives paid orders from Online Portal only after admin confirms POP/payment |

## Retail Shark Internal API

Retail Shark should authenticate with an internal token. Later, this can be replaced with signed service-to-service requests.

Current endpoints:

```text
GET /api/internal/orders/confirmed
POST /api/internal/orders/:id/tracking
POST /api/internal/orders/:id/back-order
POST /api/internal/orders/:id/ship
```

Expected Retail Shark behavior:

- List orders where `paymentStatus = confirmed` and `fulfillmentStatus != shipped`.
- When Shopify order sync is enabled, Retail Shark should only receive confirmed orders after Online Portal has successfully created the Shopify order.
- Show customer, delivery, items, total, payment confirmation time, and POP metadata.
- Add waybill/tracking details.
- Mark shipped when the parcel is packed and being sent same day.
- Send to back orders when stock or office flow blocks shipment.

## Shopify Integration

Current Shopify access:

- Active Shopify product catalog.
- Product price.
- Product availability only. Exact Shopify SOH should stay internal and should not be shown to customers.
- Product image.

Guarded paid-order sync:

- Customer order submission does not create a Shopify order.
- POP upload does not create a Shopify order.
- Admin payment confirmation is the first point where Shopify order creation can run.
- `orderCreate` creates the Shopify order as paid with `financialStatus: PAID`.
- The default inventory behavior is `DECREMENT_OBEYING_POLICY`.
- Online Portal stores the Shopify order ID/name/admin URL on the OP order so retrying cannot create a duplicate.
- If Shopify sync fails, OP keeps the payment confirmation and stores the sync error for admin retry.

## Go-Live Checklist Draft

- Rotate any secret pasted in chat before production.
- Replace `admin/admin` with secure admin auth.
- Set production `INTERNAL_API_TOKEN`.
- Configure banking details in hosted environment variables.
- Move JSON storage to hosted database.
- Move POP uploads to private hosted storage.
- Add rate limits and brute-force protection.
- Add email/order notifications if wanted.
- Add Retail Shark confirmed-orders page and internal API client.
- Test the full flow in preview before production domain cutover.

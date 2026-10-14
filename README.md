# Online Portal

Customer-facing order portal for Tank Nutrition.

Read `AGENTS.md` and `memory/online-portal-app.md` before changing this app.

## Current Flow

- Customers log in or create an account.
- Account creation requires a scroll-to-bottom research-use-only terms disclaimer and 18+ confirmation before the account is saved.
- Customers browse Shopify-backed products with brand tiles, search, type filters, availability, featured products, and 30-product pagination.
- Normal cart orders are capped by Shopify availability without exposing exact SOH.
- Special orders can request larger quantities or out-of-stock products.
- Admin reviews each order before payment details are released.
- The active payment module is currently Yoco payment links. Admin attaches the link after review.
- Customer pays through the link, can copy the payment reference/details, and can mark the order as paid.
- Admin verifies payment. Shopify order creation can only run after that confirmation and only when `SHOPIFY_ORDER_SYNC_ENABLED=true`.
- Retail Shark reads confirmed, Shopify-ready orders through protected internal APIs and writes tracking/back-order/shipped updates back to Online Portal.

## Local Start

```powershell
npm start
```

Or double-click `Start Online Portal.cmd`.

Open `http://127.0.0.1:3141`.

Test logins:

```text
Customer: user / user
Admin: admin / admin
```

To stop the local server, double-click `Stop Online Portal.cmd`.

## Verification

```powershell
npm run check:all
```

With the local server running:

```powershell
npm run smoke:local
```

The smoke test creates a temporary local order, attaches a Yoco test link, confirms payment as admin, and verifies the Retail Shark internal endpoint. Run `npm run reset:local` afterward when you want clean local test data.

## Storage

Local development uses JSON files under `data/`.

Hosted production uses Netlify Database/Postgres for runtime records when:

```text
DATA_STORAGE_MODE=postgres
DATABASE_URL=...
```

Runtime database records include users/admins, addresses, orders, shop settings, payment settings, status events, and tracking.

Legacy proof upload support still exists behind authenticated routes, but the production payment flow no longer asks customers for POP uploads. File/blob storage is only for legacy proof files or future private documents.

## Key Environment Variables

```text
SESSION_SECRET=...
INTERNAL_API_TOKEN=...
DATA_STORAGE_MODE=postgres
DATABASE_URL=...
SHOPIFY_STORE_SUBDOMAIN=<your-shopify-store-subdomain>
SHOPIFY_ADMIN_API_VERSION=2026-07
SHOPIFY_ADMIN_ACCESS_TOKEN=...
SHOPIFY_ORDER_SYNC_ENABLED=false
SHOPIFY_ORDER_INVENTORY_BEHAVIOUR=DECREMENT_OBEYING_POLICY
SHOPIFY_ORDER_SEND_RECEIPT=false
```

Keep Shopify order sync disabled until the final go-live switch.

## Shopify Access

Read access:

- `read_products`
- `read_inventory`

Order creation after admin payment verification:

- `write_orders`

The portal reads inventory to enforce customer cart limits. Customers only see `In stock` or `Out of stock`.

## Retail Shark Internal API

Retail Shark calls Online Portal with:

```text
X-Internal-Token: <INTERNAL_API_TOKEN>
```

Endpoints:

```text
GET /api/internal/orders/confirmed
POST /api/internal/orders/:id/tracking
POST /api/internal/orders/:id/back-order
POST /api/internal/orders/:id/ship
```

When Shopify sync is enabled, Online Portal only exposes confirmed orders to Retail Shark after the Shopify order exists. This prevents staff from packing orders that failed Shopify creation.

## Payment Module

Admin settings include a provider module:

- `yoco` is the active provider now.
- `eft` and `manual` are retained as configurable future providers.
- The module stores customer/admin copy, payment button labels, copy labels, optional EFT account details, review window, and default payment note.
- Future Yoco webhook support should update the same payment status path that admin confirmation uses today.

## Safety Rules

- Never commit `.env`, customer/order runtime data, database dumps, payment links, access tokens, or local cached private files.
- Do not route customers through Shopify checkout.
- Do not enable Shopify mutations unless the user explicitly asks.
- Do not show exact SOH to customers.
- Keep Retail Shark and Online Portal integrated through protected APIs, not shared files.

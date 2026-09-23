# Online Portal App Memory

Last updated: 2026-09-17

## Purpose

Online Portal is Tank Nutrition's customer-facing order request portal. It exists so customers can create an account, browse approved products, submit an EFT order request, upload proof of payment, and later check order status and tracking without using the public Shopify storefront checkout.

Retail Shark remains the internal staff dashboard. Online Portal owns customer accounts, customer order requests, proof-of-payment uploads, and customer-visible order status. Retail Shark will later consume confirmed paid orders through protected internal APIs and write fulfillment/tracking updates back to Online Portal.

## Current Local Scope

- Folder: `Online Portal`
- GitHub repo: `https://github.com/tanknutritionsales/TN-Online-Portal.git`
- Local URL: `http://127.0.0.1:3141`
- Hosted Netlify URL: `https://online-portal-tn.netlify.app/`
- Runtime: plain Node.js HTTP server with static HTML/CSS/JS.
- Current product slice: all active Shopify products available to the app.
- Shopify use: product/catalog/inventory/image/tag/collection-image reads through Admin GraphQL, plus a guarded paid-order sync that stays disabled unless `SHOPIFY_ORDER_SYNC_ENABLED=true`.
- Current local `.env` state after the 2026-09-16 test: `SHOPIFY_ORDER_SYNC_ENABLED=false`, `SHOPIFY_ORDER_INVENTORY_BEHAVIOUR=DECREMENT_OBEYING_POLICY`, and `SHOPIFY_ORDER_SEND_RECEIPT=false`.
- Local storage: JSON files under `data/`.
- Local proof uploads: files under `data/proofs/`.
- Local cached Shopify product images: `public/product-images/`.
- Local shop display settings: `data/shop-settings.json`.
- Test customer login: `user` / `user`.
- Local test admin login remains the local `.env`/demo value. Hosted admin credentials are environment/account controlled and must not be stored in memory.

## Non-Negotiables

- Do not route customers through Shopify checkout.
- Do not create Shopify orders unless the user explicitly enables the guarded paid-order sync path for testing or production.
- Do not change Shopify inventory except through confirmed paid Shopify order creation when the guarded sync is enabled.
- Do not sync or mutate Retail Shark hosted production data from Online Portal during local testing.
- Do not show exact Shopify SOH to customers. Customer catalog cards should show only `In stock` or `Out of stock`.
- Normal customer carts/orders must not exceed Shopify availability. Exact quantities stay server-side.
- Special order requests may exceed current Shopify availability, but admin must approve, decline, or counter the requested quantities before payment confirmation.
- Treat all customer, proof-of-payment, address, and future payment data as sensitive.
- Keep secrets in `.env` or hosted environment variables only. Never commit app secrets, access tokens, customer records, POP files, or runtime order data.

## Customer Flow

1. Customer starts on the standard login screen.
2. Customer logs in or creates an account.
3. Account creation requires username, name, email, password, phone area code, phone number, and structured delivery address.
4. Customer lands on the Shop page, browses the featured slider, brand collection tiles, searches products, and filters by product type plus availability.
5. Customer adds products to the cart. The user nav shows a cart quantity bubble.
6. Customer opens the separate Cart page to review the cart, special order option, delivery details, and submit the EFT order request.
7. Normal carts are checked against Shopify availability without exposing exact SOH.
8. Customer may mark the cart as a special order request for larger quantities.
9. The order is stored locally with `paymentStatus: pending` and `fulfillmentStatus: not_ready`.
10. Customer sees EFT reference and total, then uploads proof of payment. Special orders only show payment/upload once admin approves or counters.
11. Admin confirms payment.
12. If Shopify order sync is enabled, Online Portal creates the Shopify order only at this point and stores the Shopify order ID/name/admin URL.
13. Customer sees payment confirmed.
14. After Retail Shark later adds tracking and marks shipped, customer sees tracking and `Shipped`.

## Staff/Admin Flow

The current Online Portal admin area is only for local testing payment confirmation.

- Admin logs in through the same login screen. Do not store hosted admin credentials in code or memory.
- Admin can view submitted orders in separate views for awaiting confirmation, ready to pack, and completed orders.
- Admin can view proof-of-payment files through protected admin routes.
- Admin can confirm payment.
- Admin payment confirmation is the only automatic Shopify order creation trigger when `SHOPIFY_ORDER_SYNC_ENABLED=true`.
- Admin can retry Shopify sync for a confirmed order if Shopify returned an error or sync was previously disabled.
- Admin can review special orders by approving, declining, or countering with supplied quantities.
- Admin can edit the customer Shop featured slider using a collection/tag query, currently defaulting to `Dex`, or a custom product selection.
- Admin should not handle packing/tracking in Online Portal long term. Retail Shark should own the office workflow after payment confirmation.

## Retail Shark Integration Plan

Online Portal owns the order database. Retail Shark should not read Online Portal's local files directly.

Retail Shark will call Online Portal's protected internal API with:

```text
X-Internal-Token: <INTERNAL_API_TOKEN>
```

Current internal API contract:

```text
GET /api/internal/orders/confirmed
POST /api/internal/orders/:id/tracking
POST /api/internal/orders/:id/back-order
POST /api/internal/orders/:id/ship
```

Office flow to support:

- Confirmed paid orders become visible in Retail Shark.
- When Shopify order sync is enabled, confirmed paid orders become visible in Retail Shark only after the Shopify order has been created successfully.
- Staff opens the order in Retail Shark.
- Staff either adds tracking and marks shipped, or sends it to back orders.
- If staff marks shipped, the customer portal shows `Shipped`.
- If staff sends to back orders, the customer portal shows `Not ready`.

## Status Model

Internal fields:

- `paymentStatus: pending | confirmed | rejected`
- `fulfillmentStatus: not_ready | back_order | shipped`

Customer-facing status:

- `Payment pending` while payment is not confirmed.
- `Payment confirmed` once payment is confirmed and the order is not shipped/back order.
- `Not ready` for back orders or other office delays.
- `Shipped` once Retail Shark marks the order shipped.

## Data Model Notes

Local testing files:

- `data/users.json`: local customer accounts.
- `data/orders.json`: local order requests.
- `data/shop-settings.json`: local featured slider settings.
- `data/proofs/`: local proof-of-payment upload files.

Core order fields:

- `id`
- `reference`
- `customer`
- `delivery.address`
- `delivery.addressText`
- `items`
- `subtotal`
- `deliveryFee`
- `total`
- `paymentStatus`
- `fulfillmentStatus`
- `proof`
- `tracking`
- `specialOrder`
- `statusEvents`
- `createdAt`
- `updatedAt`

Core customer fields:

- `id`
- `username`
- `name`
- `email`
- `phoneArea`
- `phoneNumber`
- `phone`
- `defaultAddress`
- `preferences.theme`
- `passwordHash`
- `createdAt`

## Hosted Direction

The agreed hosted architecture is:

```text
Customer -> Online Portal site -> Online Portal backend/database
Retail Shark -> protected Online Portal internal API -> same Online Portal database
```

Online Portal has its own GitHub repository and Netlify site/project. Customers should never share the Retail Shark Netlify app. The current v0.1 hosted deployment uses Netlify Blobs for both runtime JSON data and proof uploads, while keeping local testing on JSON files:

- Runtime JSON storage v0.1: Netlify Blobs using `DATA_STORAGE_MODE=blobs` and `DATA_BLOB_STORE=op-runtime-data`.
- POP upload storage v0.1: Netlify Blobs using `PROOF_STORAGE_MODE=blobs` and `PROOF_BLOB_STORE=op-payment-proofs`.
- Future database target: Netlify Database/Postgres-style relational storage for users, orders, order items, proofs metadata, status events, and tracking updates.
- Cached product images can use blob/object storage or remain cache-only.
- Runtime secrets: Netlify environment variables.

Do not start database migration, Retail Shark hosted integration, or production data mutation until the user confirms hosted testing is ready.

## Environment Variables

Local `.env` and future hosted environment variables:

```text
PORT=3141
SHOPIFY_STORE_SUBDOMAIN=6w5iu6-hp
SHOPIFY_ADMIN_API_VERSION=2026-07
SHOPIFY_ADMIN_ACCESS_TOKEN=
SHOPIFY_APP_CLIENT_ID=
SHOPIFY_APP_CLIENT_SECRET=
INTERNAL_API_TOKEN=
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin
BANK_ACCOUNT_NAME=Tank Nutrition
BANK_NAME=
BANK_ACCOUNT_NUMBER=
BANK_BRANCH_CODE=
```

For the current Shopify app, the portal needs read scopes only:

- `read_products`
- `read_inventory`

For paid Shopify order creation after POP verification, the app also needs:

- `write_orders`

The app token was verified on 2026-09-16 with `read_inventory`, `read_orders`, `read_products`, and `write_orders`.

Paid-order sync environment variables:

```text
SHOPIFY_ORDER_SYNC_ENABLED=false
SHOPIFY_ORDER_INVENTORY_BEHAVIOUR=DECREMENT_OBEYING_POLICY
SHOPIFY_ORDER_SEND_RECEIPT=false
```

Hosted storage environment variables:

```text
DATA_STORAGE_MODE=blobs
DATA_BLOB_STORE=op-runtime-data
PROOF_STORAGE_MODE=blobs
PROOF_BLOB_STORE=op-payment-proofs
```

Hosted auth notes:

- Production refuses unsafe defaults for `SESSION_SECRET`, `INTERNAL_API_TOKEN`, and `ADMIN_PASSWORD`.
- Admin credentials should be changed through a deliberate admin-account flow or environment reset plan. Once a persisted hosted admin account exists in Blob data, changing `ADMIN_USERNAME` or `ADMIN_PASSWORD` environment variables alone does not necessarily rotate that stored admin's password hash.
- As of 2026-09-21, admin login includes a break-glass env recovery path: if the saved admin login fails but `ADMIN_USERNAME` plus `ADMIN_PASSWORD` match the submitted credentials, Online Portal repairs/creates the persisted admin Blob account to match the env username/password and logs the admin in. This preserves customer/order/proof/settings data.
- Do not store hosted admin usernames, passwords, session secrets, internal tokens, Shopify tokens, or temporary Netlify tokens in memory.

## Local Maintenance

Use:

```powershell
npm run reset:local
```

This clears prototype order history and proof uploads, then restores only the demo `user` account.

Use:

```powershell
npm run check:all
npm run smoke:local
```

Run the smoke test only while the local server is already running. The smoke test creates a temporary local order and confirms payment through local APIs, so run `npm run reset:local` afterward if a clean data state is needed.

## Current Testing Notes

- Current UI starts at a single login form.
- `user` logs into the customer catalog/order flow.
- `admin` logs into the payment-confirmation queue.
- Shopify product images are cached locally after catalog load.
- Catalog filtering uses a featured product slider, brand collection tiles, search, product type checkboxes for vials/orals/pens/nasal, and an availability checkbox.
- Customer product grids show a maximum of 30 products per page with Prev/Next controls above and below the grid.
- Customer navigation includes Shop, Cart with a quantity bubble, My orders, and My account.
- Customer theme preference is saved on the local customer account as `preferences.theme`.
- Brand collection tiles should use matching Shopify collection images where available, falling back to initials when no collection image matches the vendor.
- Some Shopify products may have no image; those cards use a black/red initials fallback badge.
- Product cards keep media clipped to fixed image rows so images cannot overlap names or intercept add buttons.
- Live Shopify order sync was tested successfully on 2026-09-16: a customer order stayed local until POP/payment confirmation, then admin `Confirm payment` created the paid Shopify order through `orderCreate`; the user reversed the test Shopify order afterward to restore stock levels.
- After that successful test, Shopify order creation was disabled again locally with `SHOPIFY_ORDER_SYNC_ENABLED=false`. Re-enable only when the user explicitly asks to test or go live.
- When `SHOPIFY_ORDER_SYNC_ENABLED=true`, Retail Shark should only receive confirmed orders from `GET /api/internal/orders/confirmed` after the Shopify order has been created successfully; this prevents a paid OP order with a failed Shopify sync from entering the packing queue.
- This app is intentionally not production-auth hardened yet. Before hosting, replace demo credentials with proper user/session handling, persistent sessions, rate limits, CSRF protections, secure cookies over HTTPS, and database-backed auth.

## 2026-09-17 Hosted Migration Notes

- Online Portal was pushed to `https://github.com/tanknutritionsales/TN-Online-Portal.git` and deployed to Netlify as `online-portal-tn` at `https://online-portal-tn.netlify.app/`.
- Netlify secret scanning initially blocked deployment because environment variable names appeared in the repository; the deploy succeeded after the user configured Netlify appropriately.
- Hosted login initially failed because the Netlify function bundle could not safely evaluate the local module path/startup check. Commit `0f7ac06` fixed Netlify function startup.
- Hosted runtime data was moved to Netlify Blobs in commit `6a81cc2`, keeping local JSON-file testing intact.
- Netlify Blobs required the modern Netlify Functions request/response adapter rather than the older event-shaped Lambda adapter. Commit `320df44` switched the adapter.
- Netlify's bundle declared its own `__dirname`, so the server module now uses `appRootDir` instead. Commit `5e80940` fixed that bundle collision.
- Live hosted checks passed after the fixes: the portal home loaded, admin login returned a valid admin session, customer login returned a valid customer session, and `/api/auth/me` returned the persisted signed-cookie session.
- The temporary Netlify access token used for diagnosis was revoked by the user after the fix. Do not store or reuse it.

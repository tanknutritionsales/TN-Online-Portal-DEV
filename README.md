# Online Portal

Product search supports approved compound names, brand aliases, umbrella categories, strict strength/code matching and optional spelling suggestions. Manage vocabulary, product classification and anonymous unmatched searches under **Admin → Product search**. Existing Shopify goal/form tags are preserved.

Customers can confirm receipt of fully shipped orders. The default Home check-in appears three days after final dispatch; **Received** removes the order from Home and marks it Completed in My orders. Timing is configurable in **Shop settings → Delivery confirmation**. Customer receipt is stored separately from Shark dispatch/payment data.

Use [the search and delivery QA checklist](docs/search-and-delivery-qa.md) for manual testing. `npm run preview:receipts` provides disposable aged orders for checking the prompt without waiting. `npm run smoke:local` now uses a credential-free disposable preview by default.

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

## Customer Experience and Support

- The research-use notice appears immediately after each successful customer sign-in, with a three-second acknowledgment delay before browsing. Admins go directly to their dashboard. Registration retains its separate terms and age confirmation.
- Shop search supports multiple words, sorting and removable filter chips. Mobile shows two product cards per row and a sticky search/filter toolbar.
- Customer baskets are saved per account on the current browser for 30 days. Only variant IDs and quantities are saved. Signing in is still required after a reload; current catalog prices and server-side stock checks apply before checkout. This is not cross-device cart storage.
- Product quick view shows Shopify images (up to eight), zoom controls, and strength/format/pack size when present. Admin > Shop settings > Product details can supply missing facts or override labels; leave fields blank to use explicit catalog labels. The portal does not invent dosage instructions.
- Home shows the next action for active orders. Signed-in visible tabs refresh order status and support replies once per minute.
- Help and each order's Need help button open a private support conversation. Staff reply in Admin > Customer support. Customers read replies in Help; email and WhatsApp contact links appear once configured under Shop settings > Customer communication.
- Account recovery is not included in this patch.

## Optional Order Emails

Order emails use the Resend API. Delivery is off by default. To configure after deploying:

1. Verify a sender domain with Resend and create a sending API key.
2. Set server-side Netlify variables `RESEND_API_KEY` (secret), `EMAIL_FROM` (the verified email address without a display name) and `PORTAL_PUBLIC_URL` (the public HTTPS portal address). Redeploy after changing environment variables. Never put the service key in public files.
3. In Admin > Shop settings > Customer communication, enter support contacts/display name, select notification events, enable Send order emails and save.
4. Check Admin > Customer support > Email delivery for setup status and results. Sent to email service means accepted by the provider, not confirmed inbox delivery. Delivery/bounce webhooks are not implemented.

Events cover order received, payment details ready, payment confirmed and shipment updates. Emails include the reference, total and a sign-in link to the order; product names and payment URLs stay in the portal. The admin payment-verification and Shopify mutation gates are unchanged.

The Postgres `op_customer_messages` table stores support conversations and email delivery records. It is created automatically using the existing database connection. The `customer-notifications` scheduled Netlify Function retries eligible messages every five minutes on published production deploys. Delivery uses short database row locks, a two-minute claim lease, provider idempotency keys and five automatic attempts. Retries expire after 23 hours to stay within the provider's 24-hour deduplication window. Obsolete payment prompts are skipped. Events from before emails were enabled are not backfilled automatically; interrupted recent queue inserts can be recovered from saved order events.

Local and deploy-preview runs never send email. Local messaging uses ignored `data/customer-messages.json`; hosted messaging requires Postgres. No email credentials or support contact values are bundled.

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

This includes a disposable credential-free server test for customer isolation, support replies, message concurrency, email retries, product facts and the existing order flow. It does not load this checkout's `.env`, call Shopify, or touch hosted Retail Shark data.

For a disposable browser preview, run `npm run preview:isolated` and use the URL it prints. Stop it with Ctrl+C to remove its temporary data. Its gallery photos are QA fixtures, not changes to Shopify.

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

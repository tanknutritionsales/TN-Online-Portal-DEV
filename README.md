# Online Portal

The infrastructure reliability patch adds shared catalogue caching, record-level
transactions, duplicate-safe submission/sync claims, current-account session
checks and paginated account/order views. See
[infrastructure readiness and release checks](docs/infrastructure-readiness.md).
Local changes do not open the hosted Portal or enable Shopify mutations.

The local [admin dashboard redesign](docs/admin-dashboard.md) adds date-filtered
order counts/values, all-date attention queues, system health and direct order
drilldowns while retaining the existing payment and fulfilment controls.

Product search supports approved compound names, brand aliases, umbrella categories, strict strength/code matching and optional spelling suggestions. Manage vocabulary, product classification and anonymous unmatched searches under **Admin → Product search**. Existing Shopify goal/form tags are preserved.

Customers can confirm receipt of fully shipped orders. The default Home check-in appears three days after final dispatch; **Received** removes the order from Home and marks it Completed in My orders. Timing is configurable in **Shop settings → Delivery confirmation**. Customer receipt is stored separately from Shark dispatch/payment data.

Use [the search and delivery QA checklist](docs/search-and-delivery-qa.md) for manual testing. `npm run preview:receipts` provides disposable aged orders for checking the prompt without waiting. `npm run smoke:local` now uses a credential-free disposable preview by default.

Customer-facing order portal for Tank Nutrition.

Read `AGENTS.md` and the local/dev `memory/online-portal-app.md` before changing
this app. Durable memory is retained in the dev repository; production excludes
memory, secrets and runtime data.

## Current Flow

- Customers log in or create an account.
- Account creation requires a scroll-to-bottom research-use-only terms disclaimer and 18+ confirmation before the account is saved.
- Customers browse Shopify-backed products with brand tiles, search, type filters, availability, featured products, and 30-product pagination.
- Normal cart orders check current Office/storage availability and configured external-vendor rules without exposing exact SOH.
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
- Home shows the next action for active orders. Active, visible customer tabs refresh order status and support replies once per minute; polling stops after five minutes without interaction or while the tab is hidden. Admin panels refresh when opened or through Refresh.
- Help and each order's Need help button open a private support conversation. Staff reply in Admin > Customer support. Customers read replies in Help; email and WhatsApp contact links appear once configured under Shop settings > Customer communication.
- Account email verification and password recovery are included in the local email patch. Customers can browse before verifying; submitting an order requires verification by default. Admins need a real verified recovery email. See [email rollout and QA](docs/email-launch-checklist.md).

## Account and Order Emails

Order emails use the Resend API. Delivery is off by default. To configure after deploying:

1. Verify a sender domain with Resend and create a sending API key.
2. Set server-side Netlify variables `RESEND_API_KEY` (secret), `EMAIL_FROM` (the verified email address without a display name) and `PORTAL_PUBLIC_URL` (the public HTTPS portal address). Redeploy after changing environment variables. Never put the service key in public files.
3. In Admin > Shop settings > Customer communication, enter support contacts/display name, select notification events, enable Send order emails and save.
4. Check Admin > Customer support > Email delivery for setup status, searchable/paginated history and safe retries. Sent to email service means provider acceptance; Delivered means receiving-server acceptance, not proof of reading.
5. Register `/api/webhooks/resend` with Resend and set Production `RESEND_WEBHOOK_SECRET` (secret) when deployment is authorized. Delivery, delay, bounce, complaint and failure feedback uses signed, duplicate-safe events. See the [email launch checklist](docs/email-launch-checklist.md) for exact setup and the already-saved sender variables.

Account emails have a separate setting from order notifications. Verification and
recovery links are single-use, expire after 24 hours / 15 minutes respectively,
and stay out of browser history and admin responses. Password resets revoke old
sessions and require normal sign-in afterward. Their encrypted private outbox and
account updates share the Postgres transaction. Netlify `context.waitUntil` keeps
delivery work alive after generic recovery responses; separate private hints
recover interrupted attempts. The worker does not scan account history.

Set the monitored support inbox in Customer communication for Reply-To.
`EMAIL_REPLY_TO` is an optional server-side fallback. Local and preview tests
never send email. No Resend key or webhook secret belongs in public files.

Events cover order received, payment details ready, payment confirmed and shipment updates. Emails include the reference, total and a sign-in link to the order; product names and payment URLs stay in the portal. The admin payment-verification and Shopify mutation gates are unchanged.

The Postgres `op_customer_messages` table stores support conversations and email delivery records. Order events and deterministic email records commit together. Delayed private hints recover interrupted delivery without scanning order history. The production notification worker checks once per minute with a shared execution budget. Paused, unconfigured, disabled and idle runs issue no SQL; scheduled invocations and Blob reads still cost resources. Delivery uses short row locks, claims and provider idempotency. A shared four-per-second sending gate queues bursts; provider throttling respects Retry-After without exhausting delivery attempts. Ordinary failures have five attempts and a 23-hour lifetime; security links retain their shorter expiry. Obsolete payment prompts are skipped. Email delivery, rather than the support inbox, refreshes pending hints on deliberate admin reads. Support requests have separate pagination.

See the [capacity and launch audit](docs/capacity-and-launch-audit.md) for local
burst-test results, remaining hosted checks and provider quota requirements.

Local and deploy-preview runs never send email. Local messaging uses ignored `data/customer-messages.json`; hosted messaging requires Postgres. No email credentials or support contact values are bundled.

## Portal Availability and Database Inactivity

Use **Admin → Portal availability** to pause the development portal. Pausing requires reviewing the effects, re-entering the current admin password and typing `PAUSE PORTAL`. Only an active admin can complete the change. Resume stays accessible through admin sign-in while paused. Each change records the admin and time.

While paused, customers see a temporary-unavailability page. Customer and Shark internal APIs return `503 PORTAL_PAUSED` before accessing Postgres. Requests already running when Pause is confirmed may finish. Admins retain access to their tools, and deliberate admin actions can still wake the database. Pausing preserves accounts, orders and settings.

Hosted availability, email-enabled checks and retry hints use the strongly consistent `op-runtime-control` Netlify Blobs store. Production shares one namespace across redeploys; previews use separate deployment namespaces. Both Netlify entry points initialize storage from the handler's trusted deployment context before importing the server. No new environment variables or database migration are required. Local equivalents live in ignored `data/portal-control.json`, `data/notification-settings.json` and `data/notification-retries.json`.

Retail Shark loads Portal orders on opening the Orders/Portal views or explicit Refresh. Home initially leaves Portal totals unchecked; Reload checks them explicitly. Unsaved tracking edits prevent a refresh from replacing the draft. This allows Postgres to sleep during inactivity; actual savings depend on customer traffic, deliberate admin use and queued retries.

## Local Start

Use Node.js 22.12 or newer.

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
npm run check:database
npm run check:bundle
```

This includes a disposable credential-free server test for customer isolation, support replies, message concurrency, email retries, product facts and the existing order flow. It does not load this checkout's `.env`, call Shopify, or touch hosted Retail Shark data.

For a disposable browser preview, run `npm run preview:isolated` and use the URL it prints. Stop it with Ctrl+C to remove its temporary data. Its gallery photos are QA fixtures, not changes to Shopify.

With the local server running:

```powershell
npm run smoke:local
```

The smoke test creates a disposable local order, attaches a Yoco test link, confirms payment as admin, and verifies the local Retail Shark internal endpoint. Its temporary data is removed automatically; it does not need a reset of your normal local data.

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

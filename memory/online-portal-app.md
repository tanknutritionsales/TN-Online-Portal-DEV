# Online Portal App Memory

Last updated: 2026-10-08

## Purpose

Online Portal is Tank Nutrition's customer-facing order portal. Customers create accounts, browse Shopify-backed products, submit normal or special order requests, receive payment instructions after staff review, mark payment as completed, and later view processing/shipping status.

Retail Shark remains the internal staff operations app. Online Portal owns customer accounts, addresses, order requests, payment status, customer-visible status, and payment settings. Retail Shark consumes confirmed orders through protected Online Portal APIs and writes tracking/back-order/shipped updates back.

## Repositories and URLs

- Folder: `Online Portal`
- Production repo: `https://github.com/tanknutritionsales/TN-Online-Portal.git`
- Dev repo: `https://github.com/tanknutritionsales/TN-Online-Portal-DEV.git`
- Hosted Netlify URL: `https://online-portal-tn.netlify.app/`
- Local URL: `http://127.0.0.1:3141`
- Runtime: plain Node.js HTTP server with Netlify Functions adapter.

## Non-Negotiables

- Do not route customers through Shopify checkout.
- Do not create Shopify orders unless `SHOPIFY_ORDER_SYNC_ENABLED=true` and payment has been verified by admin or a future trusted webhook.
- Do not show exact Shopify SOH to customers. Customers see only `In stock` or `Out of stock`.
- Normal carts cannot exceed server-side availability. Availability can combine Shopify Office SOH with Retail Shark secondary storage availability when the Retail Shark internal API is configured.
- Special orders can request more than availability or out-of-stock products, but admin must approve/decline/counter before payment details unlock.
- Keep secrets in `.env` or hosted environment variables only.
- Never commit tokens, admin passwords, customer/order data, database dumps, payment links, legacy proof files, or cached private assets.
- Online Portal and Retail Shark integrate through protected APIs, not shared local files.

## Current Customer Flow

1. Customer starts on the login screen.
2. Customer logs in or creates an account with required contact and delivery fields.
3. New customer registration is blocked behind a required terms/disclaimer modal. The customer must scroll to the bottom, confirm they are 18 years or older, and accept the research-use-only disclaimer before the account is created. The accepted terms version/timestamp is stored on the customer account.
4. Customer lands on Shop and browses Shopify products with featured slider, brand tiles, product search, type filters, availability filter, and 30-product pagination.
5. Customer adds normal in-stock products to cart. The user nav shows a cart quantity bubble.
6. Customer can add/manage multiple delivery addresses from My account or checkout.
7. Customer submits the cart as an order request.
8. Customer can submit a separate special order for larger quantities or out-of-stock products.
9. Customer sees that payment details will be provided after team review, typically within the configured review window.
10. Admin reviews the order and attaches payment details. The active production provider is Yoco payment link.
11. Customer pays, can copy payment reference/details, and can click `I have paid`.
12. Customer status becomes `Marked as paid, processing` until admin verifies payment.
13. After admin confirmation, the order can sync to Shopify if mutations are enabled and then becomes visible to Retail Shark.
14. If a normal order depends on Retail Shark storage stock, OP pauses it as `Storage transfer required` after payment confirmation. Staff must complete the Office stock transfer and click `Check stock transfer`; only then can OP create the Shopify order and release it to Retail Shark.
15. Retail Shark supplies tracking/back-order/shipped updates.
16. Customer can open My orders, view progress, and track shipped orders.

## Current Admin Flow

- Admin logs in through the same login screen.
- Admin order panels are collapsed by default and show reference, customer name/email, and status tag.
- Admin can filter orders by payment/details state, payment to verify, special review, and payment support.
- Admin can review special orders, split approved quantities between Retail Shark/Shopify allocation and external fulfillment, decline, or counter.
- Admin can enter external tracking for externally fulfilled special-order items.
- Admin attaches payment details after review. For Yoco, this is the Yoco payment link plus reference/customer note.
- Admin confirms payment only after payment has truly cleared.
- Admin can retry Shopify sync for confirmed orders if sync is enabled and previous sync failed or was disabled.
- For storage-backed orders, admin sees `Storage transfer required` and uses `Check stock transfer` after moving stock to Office. Customers do not see storage/transfer details.
- Admin can manage accounts, shop settings, system status, and payment provider settings.

## Payment Module

Payment settings live under `shopSettings.payment`.

Current providers:

- `yoco`: active provider, requires a payment URL.
- `eft`: inactive fallback provider, stores bank account fields and customer instructions.
- `manual`: inactive custom provider for future instructions or optional links.

The module stores:

- Active provider.
- Customer/admin titles and instructions.
- Payment button and copy labels.
- Review window.
- Default customer payment note.
- Confirmation labels.
- EFT bank fields if EFT is activated later.

Future Yoco webhook readiness: a webhook should call a trusted server-side path that marks the same order payment status as the current admin confirmation path, then triggers the existing Shopify sync gate.

## Status Model

Internal fields:

- `paymentStatus: pending | confirmed | rejected`
- `fulfillmentStatus: not_ready | back_order | shipped`
- `paymentIssue.type: paid_pending` means customer clicked `I have paid`; admin still needs to verify.

Customer-facing status:

- `Payment pending` for newly submitted orders without payment details.
- `Awaiting payment link` after review is needed but details are not attached.
- `Payment required` after payment details are attached.
- `Marked as paid, processing` after customer marks paid or admin confirms payment.
- `Shipped` after Retail Shark marks shipped.
- Special orders show review/declined/countered labels as appropriate.

## Storage

Local development:

- `data/users.json`
- `data/orders.json`
- `data/shop-settings.json`
- `data/proofs/` for legacy proof upload support
- `public/product-images/` for local Shopify image cache

Hosted production:

- `DATA_STORAGE_MODE=postgres`
- `DATABASE_URL=...`
- Netlify Database/Postgres stores accounts, addresses, orders, settings, payment module config, status events, and tracking.
- Blobs are not the primary order store anymore. Blob/file storage remains useful for legacy proof files or future private documents.

## Shopify

Read scopes:

- `read_products`
- `read_inventory`

Write scope for final go-live:

- `write_orders`

Guarded sync:

- `SHOPIFY_ORDER_SYNC_ENABLED=false` until the user explicitly enables it.
- Admin payment confirmation is the trigger point.
- `orderCreate` creates a paid Shopify order with `financialStatus: PAID`.
- Default inventory behavior is `DECREMENT_OBEYING_POLICY`.
- Online Portal stores Shopify order ID/name/admin URL so retries cannot duplicate orders.
- Retail Shark receives confirmed orders only after Shopify sync succeeds when sync is enabled.
- Storage-backed normal orders do not auto-create Shopify orders after payment confirmation. OP tags the internal line quantity that exceeded Office SOH, blocks shipping/processing, and clears the pause only after Office SOH is sufficient.

## Retail Shark Internal API

Retail Shark authenticates with:

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

Online Portal also reads Retail Shark storage availability through Retail Shark's protected internal API:

```text
GET <RETAIL_SHARK_INTERNAL_URL>/api/internal/storage-availability
X-Internal-Token: <RETAIL_SHARK_INTERNAL_TOKEN>
```

The storage availability response is used only server-side for customer availability and normal cart limits. Public catalog/order payloads must not expose exact SOH or storage quantities.

Office flow:

- Confirmed paid, Shopify-ready orders appear in Retail Shark.
- Storage-backed paid orders stay paused in OP until stock has been transferred to Office and OP's `Check stock transfer` succeeds.
- Staff adds courier/tracking or marks back order.
- Staff marks shipped when parcel is packed and leaving same day.
- Online Portal shows customer tracking and shipped status.

## Security and Runtime Notes

- Production refuses unsafe defaults for `SESSION_SECRET`, `INTERNAL_API_TOKEN`, and `ADMIN_PASSWORD`.
- Customer registration requires terms acceptance with the current research-use-only disclaimer version and age confirmation.
- Admin env credentials can repair/create the saved admin account through the break-glass login path if persisted admin credentials get out of sync.
- Browser write requests include `X-OP-Client: portal`; internal service routes are exempt and use `X-Internal-Token`.
- Basic route rate limits exist for login, registration, orders, and payment routes.
- Order creation uses an idempotency key to reduce duplicate submissions.
- Multiple hosted sessions are supported through signed stateless cookies and database-backed storage.

## Current Testing Notes

- Hosted flow has been tested end-to-end with Postgres storage.
- Online Portal to Retail Shark hosted integration has been tested successfully.
- Shopify mutations remain controlled by the Netlify env var and should be the final launch switch.
- Local smoke test creates a temporary order, attaches a Yoco test link, confirms payment, and verifies the Retail Shark internal endpoint.

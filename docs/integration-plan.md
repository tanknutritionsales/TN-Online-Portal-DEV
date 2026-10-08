# Online Portal Integration Plan

## Boundary

Online Portal is the customer-facing app and source of truth for customer accounts, delivery addresses, order requests, payment state, and customer-visible statuses. Retail Shark is the staff operations app for packing, back orders, and tracking. Shopify is the product, inventory, and final paid-order system.

The apps must integrate through protected APIs, not shared local files.

## Hosted Shape

```text
Customer
  -> Online Portal Netlify site
  -> Online Portal backend
  -> Netlify Database/Postgres

Retail Shark
  -> Online Portal protected internal API
  -> same Online Portal order data

Online Portal
  -> Shopify Admin API for catalog reads
  -> Shopify orderCreate only after payment confirmation and only when enabled
```

## Storage Split

| Area | Store | Notes |
|---|---|---|
| Accounts, roles, password hashes, theme preferences | Netlify Database/Postgres | Needs uniqueness, filtering, and concurrent hosted access. |
| Customer delivery addresses | Netlify Database/Postgres | Multiple saved addresses per customer. |
| Orders, order items, special-order reviews, payment state, status events, tracking | Netlify Database/Postgres | Transactional source of truth shared by OP and Shark. |
| Shop settings, featured slider, payment module config | Netlify Database/Postgres | Admin-editable runtime settings. |
| Legacy proof files or future private documents | Private blob/object storage | Files stay behind authenticated routes; customers no longer upload POP in the current payment flow. |
| Cached Shopify images | Local/build/blob cache | Cache only; Shopify remains source of truth. |
| Shopify products, prices, tags, collection images, availability | Shopify Admin API | Customer API must not expose exact SOH. |

## Payment Flow

Current provider: Yoco payment link.

1. Customer submits normal or special order request.
2. Online Portal stores the order as `paymentStatus: pending`.
3. Admin reviews order/availability.
4. Admin attaches payment details. For Yoco this is the payment link, reference, and customer note.
5. Customer pays through Yoco and can click `I have paid`.
6. Admin verifies the payment manually.
7. Payment confirmation unlocks the existing Shopify sync gate.
8. If `SHOPIFY_ORDER_SYNC_ENABLED=true`, Online Portal creates a paid Shopify order.
9. Retail Shark receives the confirmed order only after Shopify exists when sync is enabled.

Future Yoco webhook support should call the same server-side payment-confirmation logic used by admin confirmation, with webhook signature verification and idempotency.

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

Expected behavior:

- List orders where payment is confirmed and fulfillment is not shipped.
- If Shopify sync is enabled, only list confirmed orders after Shopify order creation succeeds.
- Show customer, delivery, delivery notes, items, total, payment confirmation time, and any external fulfillment split.
- Let staff add courier/tracking details.
- Let staff mark shipped when the parcel is packed and leaving same day.
- Let staff mark back order when the office cannot ship yet.

## Shopify Integration

Reads:

- Active product catalog.
- Product price.
- Product images.
- Tags, vendors, product types, and collection images.
- Availability for server-side cart limits.

Writes:

- No Shopify order is created on customer submission.
- No Shopify order is created when payment details are attached.
- Shopify order creation can run only after payment has been verified.
- `orderCreate` stores the paid order and decrements inventory according to `SHOPIFY_ORDER_INVENTORY_BEHAVIOUR`.
- OP stores Shopify order ID/name/admin URL to prevent duplicates.

## Launch Checklist

- Confirm `DATA_STORAGE_MODE=postgres` and `DATABASE_URL` are set.
- Confirm `SESSION_SECRET`, `INTERNAL_API_TOKEN`, Shopify token, and admin credentials are strong and secret.
- Confirm Retail Shark has `ONLINE_PORTAL_INTERNAL_URL` and the same internal token.
- Confirm admin payment module has the correct Yoco wording and review window.
- Confirm bank/EFT details are not active unless intentionally switching provider.
- Confirm Shopify order sync remains disabled until the final launch switch.
- Final switch: set `SHOPIFY_ORDER_SYNC_ENABLED=true`.
- Run one live controlled order after enabling, then confirm Shopify order, Retail Shark queue, and customer tracking flow.

# Online Portal App Memory

Last updated: 2026-11-03

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
4. Immediately after successful sign-in (including registration's automatic sign-in), the Research Use Notice blocks browsing until its three-second acknowledgment delay completes. The login screen itself has no notice. Customer then lands on Home, with a branded hero, Shop by Goal (`goal-*` Shopify tags), and Shop by Brand (Shopify vendors). The four goal groups are Lean muscle & Cutting, Mass & Strength, Recovery & Longevity, and Fat loss & Metabolic. Shop retains the featured slider, search, type and availability filters, and 30-product pagination. Protocol Manuals integrates Volume 1 Peptides and Volume 2 Performance using a compact page viewer with PDF open/download links.
5. Customer adds normal in-stock products to cart. The user nav shows a cart quantity bubble.
6. Customer can add/manage multiple delivery addresses from My account or checkout.
7. Customer submits the cart as an order request.
8. Customer can submit a separate special order for larger quantities or out-of-stock products.
9. Customer sees that payment details will be provided after team review, typically within the configured review window.
10. Admin reviews the order and attaches payment details. The active production provider is Yoco payment link.
11. Customer pays, can copy payment reference/details, and can click `I have paid`.
12. Customer status becomes `Marked as paid, processing` until admin verifies payment.
13. After admin confirmation, the order can sync to Shopify if mutations are enabled and then becomes visible to Retail Shark.
14. After payment confirmation, every Office-allocated line (normal or special order) is checked against live Shopify Office available stock through Shark. If short, OP pauses the order as `Storage transfer required`. Staff transfers stock to Office and clicks `Check stock transfer`; OP checks again and, when sufficient, creates the Shopify order and releases it to Retail Shark. Externally allocated lines are excluded from Shopify order creation.
15. Retail Shark supplies tracking/back-order/shipped updates.
16. Customer can open My orders, view progress, and track shipped orders.

## Current Admin Flow

- Admin logs in through the same login screen and goes directly to the dashboard without the customer Research Use Notice.
- Admin order panels are collapsed by default and show reference, customer name/email, and status tag.
- Admin can filter orders by payment/details state, payment to verify, special review, and payment support.
- Admin can review special orders, split approved quantities between Retail Shark/Shopify allocation and external fulfillment, decline, or counter.
- Expanding an order awaiting fulfillment review fetches a protected live stock snapshot: Shopify Office SOH and available units, Shark storage SOH, total SOH, timestamps, and a per-line transfer shortfall hint. A Refresh stock action repeats the check. Exact quantities stay admin-only.
- Admin can enter external tracking for externally fulfilled special-order items.
- Admin attaches payment details after review. For Yoco, this is the Yoco payment link plus reference/customer note.
- Admin confirms payment only after payment has truly cleared.
- Admin can retry Shopify sync for confirmed orders if sync is enabled and previous sync failed or was disabled.
- For Office allocations short on live available stock, admin sees `Storage transfer required` and uses `Check stock transfer` after moving stock to Office. Customers do not see storage/transfer details.
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
- `Marked as paid, processing` after the customer marks paid; `Processing` after admin verifies payment.
- `Shipped` after Retail Shark marks shipped.
- `Completed` after the customer explicitly confirms receipt; staff `fulfillmentStatus` remains `shipped`.
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
- Before creating a paid Shopify order, OP checks every Office allocation against live, location-specific Office available stock. Shortages pause the order, including special orders; a staff transfer check retries the gate and automatically continues when sufficient. Standard and special orders send only Office-allocated lines to Shopify.

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
POST <RETAIL_SHARK_INTERNAL_URL>/api/internal/fulfillment-stock
X-Internal-Token: <RETAIL_SHARK_INTERNAL_TOKEN>
Body: {"variantIds": ["gid://shopify/ProductVariant/..."]}
```

The storage availability response is used only server-side for customer availability and normal cart limits. The fulfillment-stock response is for admin review and the paid-order Office stock gate. Public catalog/order payloads must not expose exact SOH or storage quantities.

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

- 2026-11-03: User approved the Phase 1 catalog mappings and authorized Phases 2–5. Phase 2 is live in Shopify: the refreshed catalog had 430 records (422 active, 7 draft, 1 unlisted Courier); 394 products received additive compound/blend/search/class tags. A complete reread verified all expected tags and preservation of every pre-existing tag. Prices, titles, publication and inventory were not changed.
- Search vocabulary is seeded in `public/search-defaults.js` (102 groups) and normalized/shared by `public/catalog-search.js`. Shop, Special Orders, featured selection and Product details use the same search. Empty-query Recommended keeps catalog order; searches rank direct names/compound matches before aliases, prefixes and ingredient-containing blends, with stock only a tie-breaker. Codes, units, numeric strengths, brands and forms are constraints. GLP umbrella searches cover the verified Sema/Tirz/Reta/hybrid family; specific compound searches stay specific. True SARM classification is separate from MK-677/Cardarine/SR9009. Legacy broad `sarms`/`peptides` tags are retained but do not define the new search classes.
- The user requested alias-prefix matching on 2026-11-03: `oxan`/`anav` find the VAR/oxandrolone family and `diana` finds Dianabol/DB. Shared matching now checks approved alias words as well as product text, including verified blend ingredients at lower relevance. Numeric strengths, units and chemical codes remain exact constraints. Spelling suggestions handle single first-letter typos and rank by edit distance; valid named identities are not rewritten. Added regression coverage for prefixes, brand/strength combinations and spelling corrections.
- User-confirmed mappings: Sibutralean = sibutramine; HD 5 AMINO = 5-amino-1MQ; KF IVENOM belongs to KF ECYA (formula still deferred); KF GHK pack is GHK-Cu, with the catalogue ML/mg pack discrepancy left untouched; Oraltec Dynabolan is injectable Dianabol/DBol acetate as supplied by the user; Lipolax has merchant-supplied search alias Botox, kept as a named group without inferring a toxin ingredient; HU/Clinic Melanotan = MT2; KH Deca 100 = NPP; UPA kisspeptin = kisspeptin-10; KF/UPA HGH fragments = 176–191.
- Confirmed blends: Wolverine = BPC-157 + TB-500; GLOW = GHK-Cu + BPC-157 + TB-500; KLOW adds KPV; Clinic Deadpool = BPC-157 + TB-500 + KPV; CTI = CJC + tesamorelin + ipamorelin. CJC DAC state remains unspecified unless explicit in the title. Anabolicum = LGD4033, UPA Anadrine = Andarine/S4, UPA Stenabolic = SR9009, M1 Tesbol/M1T = methyl-1-testosterone, Ratigra = tadalafil + dapoxetine, from the prior product-label audit.
- Limitless remains name-only. User deferred DEX Tirzeta, IDUN cagrilintide, Relislim and unspecified oil/ECA/Helios/additional formulas. The newly added active DEX `CAGRILINITIDE` listing stays pending until confirmed. Do not silently alter the UPA M1 T 10mg title versus 15mg photo discrepancy. New single compounds can inherit unambiguous approved names; new blends do not inherit ingredient formulas. Admin can leave entries name-only or assign verified groups.
- Phases 3–5 and the subsequent search/notice refinements were accepted by the user on 2026-11-03, with publication authorized to both Online Portal GitHub repos. Admin > Product search edits groups, aliases, classes, ingredients, brand/category aliases and portal-only product assignments, with unsaved previews and a classification queue. Settings live in the existing Postgres settings record (local JSON remains supported). Anonymous unmatched catalog terms use kind `search_miss` in `op_customer_messages`, with no user/account identity, rejection of contact details/URLs and 30-day expiry.
- Settings module patches now serialize locally and use a Postgres transaction/advisory lock plus row lock, preventing separate admins' module changes from erasing each other. The featured picker preserves open sections and unsaved form fields during search. Full checks, isolated smoke and browser QA passed; all 422 active catalog records were findable by their exact names. The normal local server was restarted with Shopify order sync explicitly false.
- Customer receipt uses kind `delivery_receipt` in the same transactional store, keyed per order. It never writes an orders snapshot and therefore cannot overwrite concurrent payment, fulfillment or Shark changes. GET customer/admin orders decorate the result with receipt state. Customer status becomes Completed while fulfillmentStatus stays shipped. Home no longer drops shipped orders after seven days; it removes them only after receipt. My orders/tracking/history remain available. Default prompt delay is 3 days after final dispatch, Not yet snoozes 24 hours, and admin can configure/disable it. One automatic prompt per Home visit; manual confirmation is available for fully shipped orders even before the delay. Legacy shipped records with no trustworthy timestamp allow manual confirmation but no invented automatic timer.
- Split-shipment chronological fix: external tracking alone cannot complete an order when Office has only entered tracking but has not dispatched. Office dispatch is required for final shipped state/receipt. Tracking corrections preserve an existing final shipped timestamp. Receipt confirmation is owner-checked and concurrent/idempotent; another tab's Not yet cannot undo Received.
- `docs/search-and-delivery-qa.md` contains the manual checklist. `scripts/test-search-and-receipts.mjs` covers identities/strengths/codes, aliases, classes, DAC, suggestions, single-compound inheritance, deferred blends, settings preservation, anonymous feedback, the timer boundary/snooze, ownership and concurrent receipts. `npm run preview:receipts` seeds disposable dated orders. Smoke tests default to a credential-free isolated preview and reject hosted URLs. No Netlify environment settings or Shopify order-sync switch were changed by this patch.

- 2026-10-29 UX batch approved by the user for the production repository. Account recovery was explicitly deferred.
- Image zoom uses vendored Panzoom with thumbnail gallery/next/previous photos (up to eight Shopify images). Product quick view shows explicit strength/format/pack size, with admin overrides in Shop settings > Product details.
- On 2026-11-03 the user moved the mandatory Research Use Notice to immediately after successful customer sign-in and explicitly exempted admin logins. Customers start a fresh three-second timer on every sign-in; admins go directly to the dashboard. Failed login and the logged-out screen have no notice. Customer browsing stays blocked until acknowledgment; Escape/outside click cannot dismiss it. Any due delivery receipt prompt follows the research notice. Existing registration terms/18+ gate remains separate. Header dropdowns are mutually exclusive and close on outside click/Escape.
- Shop search sits first, supports multiword matches, sorting and removable chips; mobile has a compact header, sticky controls and two product cards per row. Cart quantities can be edited with stock validation. Per-account browser baskets retain only variant IDs/quantities for 30 days and refresh catalog prices after login; not cross-device persistence. Reload still requires login.
- Home shows active order next actions and new support replies. Visible signed-in customer tabs poll orders/support once per minute. Customer Help and per-order Need help open private support threads; admin has Customer support with open/all requests and reply forms. Contacts/hours are admin-configurable and still await the user's preferred values.
- Optional Resend order emails are implemented but off/unconfigured until a verified sender/API key is supplied and admin enables them. New variables: RESEND_API_KEY, EMAIL_FROM, PORTAL_PUBLIC_URL. No real emails or Netlify environment changes were made in this batch.
- Support/email records use Postgres op_customer_messages (lazy schema creation); local JSON data/customer-messages.json remains ignored. Sending is production/Postgres only. Email records have atomic claims, deterministic provider idempotency, five retries, 23-hour expiry, and a five-minute scheduled retry/reconciliation function. Admin Email delivery view reports acceptance/errors and offers eligible retries; inbox delivery/bounce webhooks are not implemented.
- npm run check:all now includes isolated customer-experience tests (basket isolation, product facts, concurrent message updates/claims, support ownership/replies, safe email failures, settings preservation and paid-order flow). npm run smoke:local was also run against disposable local data with Shopify sync false and no external credentials. Gallery, stock-limit rejection, restored cart, support replies, admin settings and phone layout were checked in the browser.

- Hosted flow has been tested end-to-end with Postgres storage.
- Online Portal to Retail Shark hosted integration has been tested successfully.
- Shopify mutations remain controlled by the Netlify env var and should be the final launch switch.
- Local smoke test creates a temporary order, attaches a Yoco test link, confirms payment, and verifies the Retail Shark internal endpoint.

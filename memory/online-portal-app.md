# Online Portal App Memory

Last updated: 2026-11-10

## Current Handoff - Published, Portal Paused

- On 2026-11-10 the user authorized committing/pushing all reviewed OP changes to dev and production, explicitly keeping the Portal paused and Shopify mutations disabled. Common release `976eb71150ef5ee8c39c9f6de9282a3664c5f9b2` ("Release Portal dashboard, account email and capacity hardening") was pushed to `origin/main` and `dev/main`; both remote heads were verified. Netlify published this exact release successfully as deploy `6af2ee369964be4ac0b519f7` at `https://tank-nutrition.store`. GitHub Verify Portal passed on both repos: production run `42797272139`, dev run `42797254387` (Node 22/Linux). Current release/QA detail is in `docs/email-launch-checklist.md`, `docs/admin-dashboard.md`, and `docs/capacity-and-launch-audit.md`; older dated sections are historical.
- The hosted Portal's Check again action still returned Temporarily unavailable after deployment. Netlify's secret-masked Shopify sync flag was inspected as disabled before publication; no environment variables, Portal availability, payment state, customer data, real emails, Shopify orders or inventory were changed. No admin sign-in or hosted DB/account/schema check was performed in this release session; successful build/CI does not establish those runtime checks. Opening customer access and enabling Shopify sync remain separate future instructions.
- Publication excludes `.env`, all runtime `data/*` (except example JSON), local product-image cache and durable memory. The existing tracked memory file was removed from the production tree while preserved locally, ignored. This handoff is published through a dev-only follow-up; keep production and dev application source identical, with private memory only in dev. Do not merge a memory-only dev commit into production indiscriminately.
- Remaining hosted setup: admin sign-in while paused; confirm database/account/settings continuity and additive schema, backup/isolated restore and separate preview credentials; inspect both protected Shark connections and live Office/storage reads; configure support/reply Gmail in Shop settings > Customer communication; add signed Resend webhook and Production-only secret; check actual sender plan/quotas and Netlify credit headroom; review payment/Courier/vendor settings. No repeat real-order dry run is required by this handoff. Verification/recovery/delivery tests require designated recipients and later authorization to reopen customer access, since paused customer routes/workers do not send email.
- Resend domain `updates.tank-nutrition.store` was visibly Verified on 2026-11-10. Existing Production variables `RESEND_API_KEY`, `EMAIL_FROM`, and `PORTAL_PUBLIC_URL` were included by the new deployment; values were not copied into Git. Sender is `notifications@updates.tank-nutrition.store`, reply inbox `tanknutritionsales@gmail.com`, public URL `https://tank-nutrition.store`. `RESEND_WEBHOOK_SECRET` and `EMAIL_REPLY_TO` were absent from the inspected Netlify variable list; saved OP support email can provide Reply-To without the latter. Create webhook `https://tank-nutrition.store/api/webhooks/resend` for `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.failed`, `email.complained`, `email.suppressed`; store its signing secret only in Netlify Production and redeploy. No webhook/key/settings was created or changed in this session. Actual Resend plan was not checked. Netlify showed about 155 credits remaining before this deployment on the shared team; this is a dated observation, not current remaining credit or a traffic forecast.
- Account verification, password recovery, password-change notices and signed Resend delivery feedback are included in the published release. Existing users verify on demand; no bulk email/backfill. Unverified customers can correct a mistyped email with their password. Recovery/verification links are single-use, credential/email/role-bound; encrypted security-email bodies are private and admin projections omit tokens. Admin > Customer support > Email delivery reports outcomes. Hosted Reply-To, webhook signing secret and designated-recipient checks still need release setup; automated Yoco payment confirmation remains deferred.
- Admin now opens on Overview, including while paused. It shows lifetime and date-filtered counts/values, all-date attention queues, system-health snapshots, feature switches and recent orders. Drilldowns carry their exact status/date filters. Completed reporting means fully dispatched; customer receipt remains separate. Support requests now paginate independently instead of stopping at 200. Stalled Shopify claims and paid Office orders awaiting sync after re-enabling are included in attention; all retry actions retain existing reconciliation/mutation gates.
- Published audit fixes: coalesced database-pool initialization; trusted Netlify `context.ip` instead of caller forwarding headers; customer/session fencing for email responses; strict PDF/JPEG/PNG/WebP proof validation (4 MB) and sandboxed attachment downloads for all proofs. No new service credentials or schema changes were introduced by the final audit.
- Email recovery now runs every minute with bounded hint reads/batches and a shared 18-second work budget. A distributed four-per-second sending gate defers bursts; Retry-After is respected and throttling does not burn ordinary attempts. Expiring security retries are prioritised. Paused/unconfigured/disabled/idle workers still issue zero SQL, but the more frequent invocations and Blob reads cost resources. Resend quota failures remain visible to staff; the Free plan currently allows 100 emails/day, so actual plan/usage must be checked before opening registration for a 200-account influx.
- Final audit verification passed: full `check:all`, `check:database`, `check:bundle`, `check:capacity`, `smoke:local`, whitespace checks and production dependency audit (zero reported vulnerabilities). The disposable HTTP burst used 200 seeded verified customers, 200 concurrent logins, 200 catalogue reads and 400 submissions producing 200 distinct pending orders with correct ownership. Separate native Postgres tests cover 200 concurrent account/order writes, duplicate submissions, sync claims and atomic rollback. Record/sync tests now use pool max four; distributed-rate tests deliberately use sixteen for contention. These are local correctness/capacity observations, not a hosted SLA or unlimited-concurrency guarantee. Fixtures were cleaned up; no hosted load test occurred.

- Historical 2026-11-09 handoff: the infrastructure patch was accepted locally and remained unpublished on baseline `58bca15` until the explicit 2026-11-10 release instruction above. No hosted settings/data, real emails, Shopify orders/stock, Portal pause or Shopify-sync switches were changed during development.
- Start the next session with this section and `docs/infrastructure-readiness.md`. Publishing, verifying Netlify, reopening customer access and enabling Shopify sync are distinct release steps. The hosted Portal was last known paused and sync disabled; verify current hosted state when authorized rather than asserting it from local files.
- Shared catalogue caching is implemented in `lib/catalog-cache.mjs`: 60-second fresh lifetime, on-demand refresh, private Netlify Blobs store `op-catalog-cache`, in-process coalescing plus a conditional cross-instance refresh lease. Browsing may use the previous snapshot for five additional minutes after expiry if refreshing fails; failures never extend that deadline. Context/deployment/source namespaces isolate cached snapshots. Admin > System status > Refresh catalogue is deliberate and protected; customers cannot force refreshes.
- Checkout bypasses cached stock/prices and reads selected Shopify variants plus Courier and current Shark Office/storage availability. Duplicate variants are aggregated; quantities must be positive bounded integers. Current prices are reviewed before submission; a changed expected total returns a conflict and retains the basket. Saved approved merchandise/Courier prices are used for Shopify creation. The cache does not reserve stock or guarantee stock remains available while a payment link is outstanding.
- `lib/record-store.mjs` replaces whole-account/order snapshot writes with scoped SQL reads and locked record updates. Submission keys/fingerprints and orders commit together through `op_order_submissions`. Concurrent identical submissions return one order; conflicting reuse is rejected. Deleted accounts are not recreated by stale updates. Local JSON retains serialized read/change/atomic-replace support. Hosted primary records require Postgres; automatic legacy Blob account import is retired, with old snapshots preserved untouched.
- `lib/order-sync.mjs` persists one per-order claim and a dispatch marker before the Shopify request. Completion merges into the current record under token fencing. Uncertain network outcomes, abandoned dispatched claims and legacy attempted errors require reconciliation, never blind replay. Check Shopify order searches the exact source identifier and validates one uncancelled, fully paid order with matching Office/Courier quantities/prices. No match can mean delayed indexing and stays blocked; unresolved cases require staff investigation and audited recovery. Only proven noncreation permits a fresh create attempt. External-only orders remain outside Shark/Shopify even while sync is disabled.
- Payment/fulfillment guards prevent proof uploads or special-order review from changing confirmed payment/issued quotes. Office dispatch requires tracking and, when sync is enabled, successful Shopify processing. Shipped orders cannot return to back order. Identical tracking/payment-link saves do not add duplicate events or notifications. Split shipments and customer receipt remain separate from staff dispatch.
- All protected admin actions reload the saved account/role and compare a signed credential version; deletion, role/password changes invalidate old sessions. Editing own admin credentials renews that browser's cookie. Normal password hashing/verification is asynchronous and legacy-compatible. New/changed passwords require 12-128 characters; existing short passwords can still sign in. Login after reload remains required. Hosted rate limits use atomic Postgres counters with hashed identities; paused customer/internal traffic is rejected before rate limiting/SQL. Security headers, request-size bounds, safe tracking URLs and generic production failures were added.
- Admin orders/accounts use server-side filters/search and 50-record pages (API maximum 100); customer history loads older pages on demand and can fetch an individual owner-checked order. Home receives a separate bounded active-order set. Shark's internal order-list contract is preserved using filtered batches; no Shark runtime changes were needed for this patch. Preserve its existing manual refresh/draft protection.
- `lib/order-notifications.mjs` records deterministic email rows in the order's Postgres transaction. Unique delayed recovery hints outside Postgres recover interrupted delivery without a history scan. Payment-link event hashing canonicalizes object keys so PostgreSQL JSONB key ordering cannot change identity. Claims, provider idempotency, bounded retries and obsolete-prompt suppression remain. Idle/paused/unconfigured/disabled workers perform zero SQL; the scheduled function still has a request/function cost. Local order/email files are separate and do not promise a cross-file transaction.
- Runtime now requires Node 22.12+ (Netlify build pinned to 22); `@netlify/blobs` is upgraded to 11.1.8 because conditional writes are required. Pool size is bounded to four per function runtime, with connection/query/idle timeouts and safe idle-error handling. Additive migration `netlify/database/migrations/20261109090000_portal_reliability.sql` matches runtime schema initialization exactly; it preserves existing data. Check any hosted `AWS_LAMBDA_JS_RUNTIME` override before deploying. No additional mandatory service credentials are introduced.
- Verification passed: `npm run check:all`, `npm run check:database`, `npm run check:bundle`, `npm run smoke:local`, production dependency audit (zero reported vulnerabilities), whitespace/credential-pattern checks, and all six GraphQL operations against the official configured 2026-07 schema. Real disposable PostgreSQL tests cover 200 concurrent accounts/orders, same-row updates, identical submissions, sync claims, transaction rollback and distributed rate limits. Catalogue tests cover 200 readers across 40 instances. Native database, bundle and browser tests used isolated credentials/data, blocked real application writes and removed their owned fixtures. These prove correctness under contention, not a hosted capacity/SLA measurement. The GitHub verification workflow also passed remotely for the published release on both repositories.
- Desktop/mobile checks covered collapsed admin pages, account totals/filtering, customer older history, live-price review, session-expiry cleanup, required fresh login, notice rules and manuals/CSP. No browser errors were observed. Temporary preview tabs/servers and native test clusters were cleaned up.
- Remaining runtime/reopening checks are listed in the current handoff above and in `docs/infrastructure-readiness.md` and `docs/capacity-and-launch-audit.md`. Publication/build checks are complete; account/schema continuity, backups, preview isolation, mail setup/quotas and launch configuration still need hosted review. Set a staff policy for outstanding quotes when stock sells out; do not silently introduce reservations. Automated Yoco confirmation remains deferred.
- Durable memory stays ignored in the production checkout and is distributed through dev-only commits. Never broadly force-add secrets/runtime data or infer permission to publish them from this handoff.

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
- Online Portal stores Shopify order ID/name/admin URL. Durable claims, dispatch markers and verified reconciliation protect concurrent retries and uncertain responses; see the current handoff.
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
- Hosted route rate limits use distributed Postgres counters; local development uses bounded in-process limits.
- Order creation reserves a customer idempotency key/fingerprint transactionally with the saved order.
- Multiple hosted sessions are supported through signed stateless cookies and database-backed storage.

## Current Testing Notes

- 2026-11-05: User accepted the Portal pause/on-demand refresh implementation and authorized committing and pushing OP and Shark to their production GitHub repositories. Portal is still in development and should be able to sleep between deliberate testing/admin use. Do not reactivate continuous admin polling or the old notification history scan.
- Admin > Portal availability pauses customer access through three server-enforced steps: acknowledge effects, verify the current admin password, then type `PAUSE PORTAL`. Confirmation tokens expire after five minutes, are bound to the admin/session/current revision, and stale/replayed confirmations are rejected. Final pause/resume rechecks the saved admin role. Admin sign-in and Open Portal remain available while paused; changes retain admin/time history. Accounts, orders and settings remain saved. Already-running requests may finish.
- Availability, email-enabled checks and per-message retry hints live outside Postgres in strongly consistent Netlify Blobs store `op-runtime-control`. Production namespace persists across redeploys; previews use deployment-specific namespaces. Both function entry points initialize from trusted handler deployment metadata before importing the server; do not rely on build-only CONTEXT/DEPLOY_ID variables being available at runtime. Local control files under data remain ignored. No new environment variables or database migration are required.
- The public status endpoint and paused customer/internal API rejection do not read Postgres. Signed admins retain deliberate access, so opening admin tools can still wake the database. Notification worker checks pause/configuration/email-enabled/retry hints before SQL and makes zero database queries when paused, unconfigured, disabled or idle. It retains the five-minute schedule only for lightweight checks and genuinely due retries; no full order-history reconciliation runs in the background.
- New order emails attempt delivery during the order action and save retry hints first. Preserve atomic claims, provider idempotency, five attempts, 23-hour expiry and obsolete-event suppression. Opening Customer support refreshes eligible pending hints from records already loaded there, recovering old/interrupted hints without idle SQL scans. Existing records and manual retry remain available.
- Admin views refresh on opening the relevant panel or pressing Refresh. Admin sign-in does not eagerly load the catalogue. Customer order/support polling stays once per minute only while visible and active, stops after five minutes idle, and resumes on returning/interacting; active customer functionality remains available while the Portal is open.
- Shark reads Portal orders on opening Orders/Portal views or explicit refresh. Home no longer requests Portal data automatically; Reload checks its Portal totals explicitly. Paused Portal results show a paused status with unknown totals rather than zero. See Shark memory for the corresponding guards.
- OP check:all and disposable smoke passed, including three-step enforcement, revoked admin permissions, stale confirmations, paused customer/internal gates, admin recovery, preview separation, deployment initialization, pending-hint recovery and zero-SQL idle/paused workers. Desktop/mobile browser checks used disposable fixtures. No hosted data, settings, real email, Shopify stock or order-sync switch was changed. GitHub publication is distinct from verifying Netlify deployment completion.

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
- Home shows active order next actions and new support replies. Visible active signed-in customer tabs poll orders/support once per minute, pausing after five minutes idle (2026-11-05 refinement). Customer Help and per-order Need help open private support threads; admin has Customer support with open/all requests and reply forms. Contacts/hours are admin-configurable and still await the user's preferred values.
- Optional Resend order emails are implemented but off/unconfigured until a verified sender/API key is supplied and admin enables them. New variables: RESEND_API_KEY, EMAIL_FROM, PORTAL_PUBLIC_URL. No real emails or Netlify environment changes were made in this batch.
- Support/email records use Postgres op_customer_messages (lazy schema creation); local JSON data/customer-messages.json remains ignored. Sending is production/Postgres only. Email records have atomic claims, deterministic provider idempotency, five attempts and 23-hour expiry. The five-minute worker now uses external retry hints with zero idle SQL; the old reconciliation scan was removed on 2026-11-05. Admin Email delivery view reports acceptance/errors and offers eligible retries; inbox delivery/bounce webhooks are not implemented.
- npm run check:all now includes isolated customer-experience tests (basket isolation, product facts, concurrent message updates/claims, support ownership/replies, safe email failures, settings preservation and paid-order flow). npm run smoke:local was also run against disposable local data with Shopify sync false and no external credentials. Gallery, stock-limit rejection, restored cart, support replies, admin settings and phone layout were checked in the browser.

- Hosted flow has been tested end-to-end with Postgres storage.
- Online Portal to Retail Shark hosted integration has been tested successfully.
- Shopify mutations remain controlled by the Netlify env var and should be the final launch switch.
- Local smoke test creates a temporary order, attaches a Yoco test link, confirms payment, and verifies the Retail Shark internal endpoint.

# Infrastructure reliability patch — local review

Accepted locally by the user on 2026-11-09. Publication was authorized on
2026-11-10 with the Portal paused and Shopify mutations disabled.
Resume context is recorded in `memory/online-portal-app.md`.

This patch is prepared locally. Publishing code, checking the Netlify deployment,
opening the Portal and enabling Shopify order sync are separate release steps.
It preserves accounts, orders and inventory. The pause and mutation switches
remain off throughout publication and hosted setup.

## Runtime and persistence

- Node.js 22.12 or newer; Netlify build is pinned to Node 22.
- Hosted accounts/orders/settings require Postgres. A missing database is an
  error, never a silent fallback to an ephemeral filesystem or sample products.
- Local development keeps its JSON files. Local mutations serialize the complete
  read/change/atomic-replace operation. Local email fixtures are separate files;
  only Postgres provides a transaction across orders and email records.
- Account and order changes lock/reload and update one record. Customer reads
  select by customer ID; authentication selects one account. Missing records are
  never recreated by updates. New account identities are normalized and unique.
- `op_order_submissions` reserves a customer/request key and fingerprint in the
  same transaction as the order. Concurrent retries return one saved order;
  reusing a key for a different request returns a conflict.
- Existing accounts, addresses, password hashes, orders and settings remain.
  Automatic legacy Blob-to-account import has been retired; old Blob snapshots
  remain untouched. Empty-store administrator bootstrap is protected by a lock.
- The migration `20261109090000_portal_reliability.sql` is additive. Runtime schema
  initialization uses the same definitions under an advisory lock. It adds
  indexes, the submission ledger and distributed rate-limit records, with no
  seed, reset or deletion of business records.

## Catalogue cache and live checkout

One server-side catalogue snapshot is shared by every customer/session. A warm
function first uses memory; new function instances use the private Netlify Blobs
store `op-catalog-cache`. Conditional writes claim a refresh lease, so a burst of
visitors does not trigger a full Shopify pull for each visitor. Cache keys include
the deployment context, deployment ID and catalogue source, isolating previews.

- Fresh lifetime: **60 seconds**. Refresh happens on demand, never on a schedule.
- Browsing-only fallback: up to **five additional minutes** if a refresh fails.
  Its age is never extended by failures. A cold cache cannot invent products.
- Admin > System status > Refresh catalogue performs a deliberate refresh.
  Customers cannot force upstream refreshes through URL parameters.
- Checkout bypasses cached stock/prices: only the chosen variant IDs and Courier
  are fetched from Shopify, with current Office/storage quantities from Shark.
  Duplicate variant lines are aggregated before validating quantities.
- Updated prices appear before order review. A price change between review and
  submission returns a conflict while preserving the basket.
- Shopify creation uses the saved approved merchandise and courier prices.
  Final Office stock checks remain live, and storage transfers remain required.
- Public catalogue responses expose availability, never exact stock quantities.

## Payment and Shopify sync safety

Payment is still confirmed manually. Clicking **I have paid** does not authorize
Shopify creation. The existing `SHOPIFY_ORDER_SYNC_ENABLED` switch remains the
final mutation gate. External-only orders remain outside Shopify and Shark.

Sync commits an exclusive per-order claim before network work, checks Office
stock, then commits a dispatch marker before calling Shopify. Completion merges
into the current row and is fenced by the claim token. Concurrent staff retries
cannot create independently. No database row lock spans a Shopify request.

Reads have bounded timeout/backoff. An uncertain mutation is never automatically
replayed. If Shopify may have created an order but its response was lost, OP shows
**Shopify check required**. **Check Shopify order** searches by the exact source
identifier and verifies Office quantities/prices before linking a match.
Only an uncancelled, fully paid Shopify match is eligible. Legacy attempted
failures without proof of noncreation also require reconciliation.

An empty search is not proof of absence: indexing may be delayed. The order stays
blocked rather than creating a duplicate. If it remains unmatched, staff must
investigate Shopify and escalate for an audited recovery. Do not reset the saved
sync state or create a second order blindly. There is no unsafe automatic reset.

Confirmed payment and issued quotes cannot be changed by proof upload or special
order review. Office dispatch requires tracking; dispatched orders cannot move
back to back orders. Split-shipment and customer receipt behavior remains intact.

## Authentication and abuse protection

- Every protected admin action checks the current saved account/role and signed
  credential version. Deletion, role changes and password changes invalidate old
  cookies. Editing your own credentials renews only the current browser cookie.
- Existing account passwords continue to work. Newly chosen passwords require
  12–128 characters, including through admin account creation/editing.
- Regular hashing/verification uses asynchronous scrypt compatible with existing
  hashes. Login after page reload remains required.
- Hosted rate limits are atomic Postgres counters shared by all function
  instances; identities are HMAC digests. Cleanup is bounded and demand-driven.
- Paused customer/internal traffic is rejected before rate limiting or SQL.
- CSP, frame restrictions, safe tracking URLs, bounded request bodies and generic
  server errors reduce exposure. Private details remain in server storage.

## Notifications and idle costs

An order event and its deterministic email record commit in one Postgres
transaction. Unique, delayed recovery hints are saved outside Postgres before the
action. An interrupted request can therefore recover a committed email without
scanning order history. Provider claims, idempotency, expiry and bounded retries
are retained; obsolete payment prompts are suppressed.

Paused, unconfigured, disabled and idle workers make **zero database queries**.
The once-per-minute worker still has a request/function and Blob-read cost; it is
not free. Recovery is bounded by a shared time budget and sending-capacity gate.
Admin lists refresh on demand. Visible active customer tabs retain their
once-per-minute updates and five-minute idle cutoff. Lists paginate rather than
transmitting all account/order records. Customer Home uses separate active orders
so older outstanding orders remain visible outside the loaded history page.

## Verification and release checklist

Run with development dependencies installed:

```powershell
npm ci
npm run check:all
npm run check:database
npm run check:bundle
npm run smoke:local
```

Database checks create a real, temporary PostgreSQL cluster on a random loopback
port with generated credentials and a guarded cleanup path. They never read
`.env`, connect to hosted databases or call Shopify. Tests cover 200 concurrent
accounts/orders, same-record updates, same-key submissions, sync claims, uncertain
outcomes, transaction rollback, notification recovery and distributed limits.
Local timings establish correctness under contention, not hosted latency/SLA.
The GitHub verification workflow runs these checks without deployment secrets.

Before release:

- [x] Review and authorize commit/push (2026-11-10; Portal paused, sync disabled).
- [ ] Confirm Netlify deploy succeeds using Node 22.12+ for Functions. If a
  separately configured `AWS_LAMBDA_JS_RUNTIME` overrides the build version,
  select a supported Node 22/24 runtime in Netlify and redeploy.
- [ ] Confirm hosted `DATA_STORAGE_MODE=postgres`, the intended pooled database
  connection, backup retention, sleep/autoscaling and account/setting continuity.
- [ ] Verify recovery from a database backup using an isolated restore target.
  Keep deploy previews on separate databases/credentials; cache namespaces alone
  do not isolate account/order data when a database URL is shared.
- [ ] Check the additive schema/indexes on the hosted deployment.
- [ ] Inspect System status; refresh the shared catalogue once deliberately.
- [ ] Confirm both internal API connections and current Office/storage stock.
- [ ] Configure customer communication/verified email delivery if required.
- [ ] Verify payment instructions, courier charge and external-vendor rules.
- [ ] Confirm credit alerts/headroom for the shared OP/Shark Netlify team.
- [ ] Establish alerts and staff escalation for database failures, Shopify
  reconciliation-required orders and failed email delivery. Confirm who handles
  these; existing log records alone are not an alerting service.
- [ ] Record the previous deploy for rollback. Preserve additive schema and
  submission/dispatch records; never drop the ledger or reset sync state as a
  rollback shortcut.
- [ ] Set a staff policy for payment links outstanding while stock sells out;
  catalogue caching is not a stock reservation system.
- [ ] Check desktop/mobile sign-in, basket, older history and admin pagination.
- [ ] Open customer access deliberately; enable Shopify sync last.

The subsequent local account-email patch adds verification, password recovery
and signed delivery/bounce callbacks; follow `docs/email-launch-checklist.md` for
its extra additive migration and hosted setup. Automatic Yoco confirmation
remains deferred. Confirm the published commit/deployment before proceeding.

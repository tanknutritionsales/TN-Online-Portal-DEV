# Portal capacity and launch audit — 2026-11-10

This is the code audit of the reliability, account-email and dashboard release.
The user authorized publication to both repositories on 2026-11-10 while keeping
the Portal paused and Shopify mutations disabled. No customer data, real emails,
Shopify orders or stock were changed by the checks. Publication and opening
customer access remain separate.

## Gaps corrected

- Database initialization shares one promise across concurrent callers,
  including asynchronous credential/driver loading. Two hundred cold callers
  receive one pool capped at four connections; failed initialization can retry.
- Request limits use Netlify's trusted `context.ip`, never caller-supplied
  forwarding headers. Local tests use the actual socket address. The bundled
  handler test rotates forged headers and confirms the shared limit still holds.
- A shared database-backed sending gate permits one email per 250 ms. Burst
  overflow is queued without burning attempts. Provider 429 throttling respects
  Retry-After; quota exhaustion is separately visible to staff. No real emails
  were used to test this.
- Email recovery runs every minute, replacing two-message/five-minute recovery.
  Batches are capped at 100 hints and share an 18-second start-work budget, with
  headroom before starting another delivery. Blob hint reads have concurrency
  eight. Expiring security links are prioritised. Durable claims/idempotency
  preserve safety if execution stops; this budget does not interrupt SQL/HTTP
  work already in flight or promise a delivery time during provider outages.
- Paused, unconfigured, disabled and idle workers retain zero SQL. More frequent
  scheduled invocations and Blob reads have a cost: approximately 43,200 worker
  invocations in a 30-day month, before customer requests. No background database
  polling or customer-history scan was introduced.
- Support pages now use server filters, complete counts and 50-record pages;
  older requests beyond 200 remain reachable. Empty last pages return to the
  preceding page after a request is resolved elsewhere.
- The dashboard includes expired in-flight Shopify claims and confirmed Office
  orders awaiting sync after sync is enabled. Its actions use the existing safe
  reconciliation path; no mutation switch or dispatch guard was bypassed.
- Email verification/correction responses are fenced by customer/session so a
  late response cannot restore a previous customer's state after sign-out.
- The legacy proof endpoint accepts only size-bounded PDF/JPEG/PNG/WebP with
  matching file signatures, rejecting HTML, script, SVG and disguised content.
  All saved proofs, including old files, download as attachments with restrictive
  sandbox policy and a content type derived from bytes. This prevents uploaded
  documents from being rendered as active Portal pages. It is not a malware scan.

## Reproducible checks

Run `npm run check:all`, `npm run check:database`, `npm run check:capacity`,
`npm run check:bundle`, `npm run smoke:local`, and `npm audit --omit=dev`.

All of these passed in the final local audit. The production dependency audit
reported zero vulnerabilities. Functions packaging included 110 code/dependency
modules and excluded runtime data/development database binaries. Only disposable
fixtures and fake upstream transports were used, and owned fixtures were removed.

The capacity scenario seeds 200 disposable, email-verified customer fixtures,
then performs 200 simultaneous real HTTP logins, 200 simultaneous catalogue
reads and 400 submissions (two per customer). It verifies exactly 200 saved
pending orders, correct ownership, correct admin totals and no Shopify creation.
It uses local JSON and a mock catalogue; it does not measure the hosted network,
Shopify capacity or 200 newly emailed registrations. Separate real Postgres
checks exercise concurrent account creation, identity uniqueness, scoped reads,
updates, submission idempotency and sync claims. Record/sync suites use a
four-connection pool; the distributed limiter suite deliberately uses sixteen
connections to exercise stronger database contention across eight instances.

Representative second local burst: login p95 2.13 s, catalogue p95 1.05 s,
submission p95 3.97 s while other local checks ran. These are observations, not a
production latency guarantee. Native tests and fake transports do not replace a
hosted deployment check. There is no unlimited-concurrency claim.

## Hosted release gates

1. Authorize publication/deployment. Confirm the intended Node 22.12+ Functions
   runtime and additive schema; preserve accounts and order/dispatch ledgers.
2. Confirm the pooled production DB URL, provider connection/compute limits,
   backups and an isolated restore; previews must use separate data/credentials.
3. Complete sender/reply routing, signed delivery webhooks and designated-address
   email checks. Confirm Resend's actual plan/usage. Its Free plan currently has
   a 100-email daily cap; 200 new verification emails alone exceed it. Order and
   account messages share capacity. Choose sufficient capacity before launch.
4. Confirm Netlify team credits/limits and alerts. Database sleep/autoscaling,
   total concurrent function instances and provider quotas determine hosted
   capacity beyond these local checks. Retain operational escalation for failed
   email, stock transfers and uncertain Shopify outcomes.
5. Verify the deployed customer entry points and OP/Shark health in both
   directions. Recheck payment, delivery, external vendor and support settings.
6. Keep the staff policy for unpaid quotes explicit: stock is checked again and
   is not reserved by an unpaid request. Open access deliberately and enable
   Shopify mutations as the separate final step.

Intentional abuse limits remain, including 100 registrations per hour from one
network address. Ordinary customers on distinct networks do not share that
quota. Do not remove abuse controls to interpret “as many people” as unlimited.

Primary references checked 2026-11-10:

- [Netlify request context](https://docs.netlify.com/build/functions/api/)
- [Scheduled Functions limits](https://docs.netlify.com/build/functions/scheduled-functions/)
- [Resend limits](https://resend.com/docs/api-reference/rate-limit)
- [Resend pricing / quotas](https://resend.com/pricing)

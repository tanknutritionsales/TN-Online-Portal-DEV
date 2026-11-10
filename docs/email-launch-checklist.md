# Account email and delivery release checklist

This batch builds on the accepted infrastructure patch. Publication to both
repositories was authorized on 2026-11-10; keep the Portal paused and Shopify sync
disabled. Opening customer access and enabling mutations require separate
instructions. No real customer emails are sent by development tests or preview.

## Setup already completed by the user

- Resend domain `updates.tank-nutrition.store` is verified through GoDaddy.
- Sender: `notifications@updates.tank-nutrition.store`.
- Chosen reply inbox: `tanknutritionsales@gmail.com`.
- Netlify Production has `RESEND_API_KEY` (secret), `EMAIL_FROM` and
  `PORTAL_PUBLIC_URL=https://tank-nutrition.store`. These were saved without a
  deployment. Do not store the key in Git or memory.

## Included behavior

- New accounts receive a verification email after registration. Existing
  customers see a verification banner on sign-in and request email on demand;
  there is no bulk-send/backfill. Browsing and saved baskets remain available.
- An unverified customer can correct a mistyped address by re-entering their
  current password. Unique-email rules still apply, old action links are revoked
  and verification goes to the corrected address. Changes to a verified address
  require support until a separate verified-address-change flow is implemented.
- Order submission requires a verified current email by default, including
  special orders. Admin > Shop settings > Customer communication controls that
  policy. Account emails have a separate switch from order emails; the settings
  reject disabling account emails while verification is still required.
- Verification links last 24 hours. Recovery links last 15 minutes. Both are
  single-use, tied to the saved email, role and credential version, and consumed
  atomically under the account row lock. Loading a link never consumes it.
- Forgot password returns the same generic response for eligible/missing users;
  account lookup and delivery run after the HTTP response through Netlify
  `context.waitUntil`. Rate limits apply to both network and normalized email.
- A successful reset requires matching 12–128 character passwords, invalidates
  existing signed sessions and earlier action links, verifies the email used for
  recovery, and queues a password-changed notice. Sign-in is required afterward.
- Admin accounts need a real, verified recovery email before email recovery is
  available. Admin > Accounts can edit an admin email and request verification.
  The existing environment-admin break-glass login remains separate.
- Token fingerprints live in account JSON. Security email bodies are encrypted
  in the private outbox with a purpose-derived key from SESSION_SECRET, then
  cleared after provider acceptance. Admin APIs never expose reset links,
  encrypted payloads, token hashes or passwords. Changing SESSION_SECRET
  invalidates outstanding sessions/links and makes old encrypted emails unusable.
- Order emails retain their event gates/retries. All messages carry an opaque
  correlation tag for delivery feedback. Temporary failures retry; permanent
  provider rejection stops automatic retry. Expired or obsolete security links
  are not resent; request a fresh link instead.
- The scheduled worker now runs once per minute. A shared 18-second work budget,
  bounded batches and a database-backed four-per-second sending gate protect
  burst recovery. Queue deferrals and provider throttling do not consume the
  ordinary failure-attempt allowance. Provider Retry-After is respected. Quota
  exhaustion remains visible to staff and requires checking provider capacity.
- Admin > Customer support > Email delivery has search, purpose/status filters,
  50-row pages, setup state, recipient/reference, attempts, failure explanations
  and event history. Delivered means the receiving mail server accepted it,
  not that the customer read it. Open/click tracking is not used.
- `/api/webhooks/resend` verifies the exact raw body using Svix, rejects invalid
  signatures/timestamps before SQL, correlates one saved recipient/message and
  deduplicates signed event IDs. Older events cannot overwrite terminal outcomes.
  Delivery callbacks can be recorded while the Portal is paused; they never
  change payment, Shopify or fulfillment state and never send email.
- The additive `20261110090000_account_email_delivery.sql` adds a delivery-event
  ledger and lookup index, preserving accounts/orders/settings. Runtime schema
  initialization includes these definitions. Security retry hints use a separate
  private runtime-control namespace; idle/paused/unconfigured/disabled checks do
  not scan users or order history.

## Hosted steps after publication is authorized

1. Deploy the reviewed code and confirm both additive migrations/runtime schema.
2. In OP > Shop settings > Customer communication set the support/reply email to
   the chosen Gmail inbox and save. Alternatively `EMAIL_REPLY_TO` provides a
   server-side fallback; an admin-saved support address takes precedence.
3. Keep order email delivery off until designated-recipient tests are authorized.
   Account-email settings are independent; keep the Portal paused until ready.
4. In Resend create a webhook for
   `https://tank-nutrition.store/api/webhooks/resend`, subscribing to `email.sent`,
   `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.failed`,
   `email.complained` and `email.suppressed`.
5. Store its signing secret as Production `RESEND_WEBHOOK_SECRET` in Netlify
   (secret), then redeploy when authorized. Do not put this value in OP settings.
6. Test verification, reset/expiry/replay, old-session revocation, sender/reply
   routing and delivered/bounced feedback with designated accounts. Check that
   paused/preview/local runs do not send email. A preview must use its own DB.
7. Check provider daily limits, staff attention handling and customer support
   contacts. Then deliberately enable the chosen order events and customer access.
   Shopify sync remains its own final launch switch.

Resend's Free sending tier currently permits 100 emails per UTC day. Account
verification, recovery and order updates share this quota. Two hundred new
accounts alone need more than that. Confirm the actual plan/usage and choose
adequate capacity before opening registration; the app cannot increase a
provider quota. See https://resend.com/docs/api-reference/rate-limit and
https://resend.com/pricing (checked 2026-11-10).

## Local checks

`npm run check:all` includes the account/email suite. Native Postgres checks cover
account/outbox rollback, concurrent token use and delivery-event deduplication;
fake HTTP transports ensure no provider, Shopify or hosted data is touched.
Also run `npm run check:database`, `npm run check:bundle` and `npm run smoke:local`.

For browser QA, start `npm run preview:isolated`, then use its exact printed URL
and temporary directory with:

```text
node scripts/seed-email-preview.mjs <printed-loopback-url> <printed-temp-directory>
```

Only the owned OS-temp preview is accepted. It seeds synthetic email history and
prints disposable verification/reset links. No email is sent. Use the normal
demo admin login or the `email-preview` account with `preview-password-twelve`.
Stop the preview afterward to delete its data. Do not use this seed on hosted or
normal local data.

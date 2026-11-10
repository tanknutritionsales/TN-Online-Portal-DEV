# Admin operations dashboard

Admins now land on Overview, including while customer access is paused. The
existing availability controls and confirmation steps remain in place.

## Reporting

The selected date range applies to the date an order was placed, using South
Africa time (UTC+02:00). Today, last 7/30/90 days, all time and inclusive custom
dates are available. Current order status is reported for that cohort; this is
not a historical status-at-date report. An overall lifetime order count remains
visible alongside the selected period.

- Unprocessed: payment has not yet been confirmed; excludes declined/rejected
  and shipped orders. A customer's “I have paid” does not confirm payment.
- In fulfilment: payment confirmed, full dispatch outstanding.
- Completed: all parts dispatched. Customer confirmation of receipt remains a
  separate existing step.
- Declined/rejected: counted separately and excluded from displayed values.

Order value, payment-confirmed value, outstanding confirmation value and average
order value include delivery. These are saved OP order totals, not bank
reconciliation or Shopify refund accounting. A payment-confirmed amount does
not claim that an automated payment-provider settlement check was performed.

Summary cards open the exact period and status in All orders. Lists have search,
date controls, a visible queue indicator, complete matching counts and existing
50-record pagination. References, customer details, dates, totals and readable
status tags are visible while order contents remain collapsed.

## Attention and health

Attention counts always cover all dates, so a current reporting filter cannot
hide older unresolved work. The queues cover payment verification, fulfilment
review, payment details, stock transfers, sync exceptions, Office tracking,
packing, external tracking, back orders and payment support. Split orders can
appear in multiple queues; these counts must not be summed as unique orders.
Support and email are independently aggregated; email failures/delays open the
new Needs attention email filter.

Health checks run separately from reporting. Changing reporting dates reuses the
displayed health result; Check now or the main Refresh explicitly checks again.
There is no new polling worker. Shopify sync is shown as a separate enabled/off
state. Email configuration is labelled Configured, not Online or Delivered;
delivery outcomes are reported by the email history/webhook integration. Order
and account-email switches are shown independently.

Postgres performs aggregate counts and sums server-side in one order query;
only eight recent-order summaries are returned. Local JSON uses the same rules.
All endpoints require a current admin. Partial failures show unavailable panels
instead of invented zero totals. No schema migration, service credential,
Shopify mutation, payment confirmation or fulfilment write is introduced here.

## Verification

- `npm run check:all` includes date-boundary, native Postgres/local parity,
  queue-count/drilldown, financial totals, >50-record and authorization tests.
- `npm run smoke:local` retains the existing guarded order-flow check.
- `npm run check:bundle` checks production-shaped Functions packaging.
- `node scripts/preview-admin-dashboard.mjs` starts an owned disposable local
  preview with synthetic orders/messages and no external credentials. Use
  `admin` / `admin`, then stop the helper to remove its fixture.

Publication of the dashboard and preceding reliability/email patches was
authorized on 2026-11-10. The Portal must remain paused and Shopify sync disabled
while hosted setup is completed. Durable memory is retained in the dev repo.

# Online Portal Workspace

Use this folder exclusively for the customer-facing Tank Nutrition order portal.

- Read `memory/online-portal-app.md` before any Online Portal change.
- Keep the customer-facing portal separate from Retail Shark. Retail Shark remains the internal staff dashboard.
- Treat Shopify access as read-only unless the user explicitly authorizes a separate write operation.
- This app must not create Shopify orders or change Shopify inventory during local testing except through the guarded paid-order sync path after admin POP/payment confirmation and `SHOPIFY_ORDER_SYNC_ENABLED=true`.
- This app must not touch Retail Shark hosted production data during local testing.
- Local testing data lives under `data/` and is disposable unless the user says otherwise.
- Use `npm run reset:local` to clear prototype orders and proof uploads while restoring the demo `user` account.
- Use `npm run check:all` and `npm run smoke:local` after material backend or order-flow changes.

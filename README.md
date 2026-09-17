# Online Portal

Customer-facing order request portal for Tank Nutrition local testing.

Read `AGENTS.md` and `memory/online-portal-app.md` before changing this app.

## What this PoC does

- Shows active Shopify products from the Admin API when read credentials are configured.
- Adds a clean Shop page with a featured slider, brand collection tiles, product search, type filters, an in-stock filter, and 30 products per page.
- Keeps checkout on a separate Cart page with a customer-side quantity badge in the nav.
- Adds a My account page for customer contact and default delivery details.
- Lets customers add and edit multiple saved delivery addresses, then select one during checkout.
- Lets customers remove saved delivery addresses while keeping at least one valid address.
- Saves customer and admin light/dark theme preferences.
- Uses matching Shopify collection images for brand tiles when available.
- Shows only `In stock` or `Out of stock` to customers, not exact SOH.
- Caches Shopify product images locally under `public/product-images/` for local UI testing.
- Falls back to local mock products when credentials are missing.
- Starts on a standard username/password login screen.
- Supports a temporary test customer login: `user` / `user`.
- Supports a temporary admin login: `admin` / `admin`.
- Opens account creation on a separate screen with required contact and delivery fields.
- Uses basic phone and postal-code input masks.
- Lets a customer create an EFT order request.
- Blocks normal carts/orders that exceed Shopify availability without showing exact SOH.
- Lets a customer submit a special order request for larger quantities.
- Lets a customer upload proof of payment for the order.
- Lets an admin review orders by awaiting confirmation, ready to pack, and completed views.
- Lets an admin view, filter, create, and remove customer/admin accounts with password confirmation on removal.
- Opens admin account creation in a popup so the account list stays clean.
- Lets an admin view system status for Retail Shark, Shopify, and the orders database.
- Lets an admin edit the featured Shop slider by collection/tag query or custom product selection.
- Lets an admin edit displayed EFT payment details, customer payment note, and separate standard/special order reference formats.
- Lets an admin confirm payment in the awaiting-confirmation view.
- Lets an admin approve, decline, or counter special order quantities.
- Keeps special orders separate from normal cart checkout through a dedicated special-order popup.
- Exposes protected internal endpoints that Retail Shark can call later for confirmed orders, tracking, shipped status, and back orders.
- Keeps all current order, user, and POP data local while testing.

## What this PoC does not do

- It does not create Shopify orders unless the guarded paid-order sync is explicitly enabled and an admin confirms payment.
- It does not change Shopify stock.
- It does not touch Retail Shark production data.
- It does not process card payments.
- It still needs the final Netlify Functions/database adapter before hosted production.

## Local start

```powershell
npm start
```

Or double-click:

```text
Start Online Portal.cmd
```

Open:

```text
http://127.0.0.1:3141
```

Test logins:

```text
Customer: user / user
Admin: admin / admin
```

To stop the local server, double-click:

```text
Stop Online Portal.cmd
```

## Local reset and verification

Clear prototype order history, proof uploads, and extra test users:

```powershell
npm run reset:local
```

Check scripts:

```powershell
npm run check:all
```

With the local server running, verify the main API flow:

```powershell
npm run smoke:local
```

The smoke test creates a temporary local order, uploads a tiny demo POP file, confirms payment as admin, and checks the Retail Shark internal endpoint. Run `npm run reset:local` afterward when you want a clean testing slate.

## Shopify read access

For the first working version, give the app read access to:

- `read_products`
- `read_inventory`

The portal reads inventory only to calculate availability and enforce normal-cart limits. Exact SOH is kept out of the customer-facing API response.

For a Dev Dashboard app that acts only on this store, set the app credentials:

```text
SHOPIFY_STORE_SUBDOMAIN=<your-shopify-subdomain>
SHOPIFY_ADMIN_API_VERSION=2026-07
SHOPIFY_APP_CLIENT_ID=...
SHOPIFY_APP_CLIENT_SECRET=...
```

If you already have a valid Admin API access token from an existing app, this PoC can use that directly instead:

```text
SHOPIFY_ADMIN_ACCESS_TOKEN=...
```

## Retail Shark internal API contract

Retail Shark will call these with:

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

## Hosting direction

When local testing is approved, Online Portal should become its own GitHub repo and its own Netlify project. The hosted version should keep Online Portal as the owner of customer/order data and let Retail Shark call protected Online Portal APIs. Local JSON files should be replaced with hosted database tables, and POP uploads should move to private hosted object/blob storage.

Before the first Netlify deploy, copy `.env.example` into Netlify environment variables and set at minimum:

```text
SESSION_SECRET
SHOPIFY_STORE_SUBDOMAIN
SHOPIFY_ADMIN_ACCESS_TOKEN or SHOPIFY_APP_CLIENT_ID / SHOPIFY_APP_CLIENT_SECRET
INTERNAL_API_TOKEN
DATABASE_URL
DATA_STORAGE_MODE=blobs
DATA_BLOB_STORE=op-runtime-data
PROOF_STORAGE_MODE=blobs
PROOF_BLOB_STORE=op-payment-proofs
```

The current local server now uses signed stateless cookies, so multiple browser sessions and future serverless instances can share the same session format once `SESSION_SECRET` is configured.

Local testing uses JSON files under `data/`. Hosted v0.1 can use Netlify Blobs for runtime JSON data with `DATA_STORAGE_MODE=blobs` until the database adapter is added. Local POP uploads use `data/proofs/`; hosted POP uploads should use private Netlify Blobs through the protected app API.

Keep `.env`, `data/*.json`, `data/proofs/`, `public/product-images/`, and `memory/` out of GitHub. Those are ignored locally because they may contain private runtime settings, customer records, POP files, cached images, or project memory.

Do not start hosted setup, production deployment, Retail Shark integration, or database migration until local testing is signed off.

See `docs/integration-plan.md`, `docs/hosted-schema-draft.sql`, and `docs/hosted-migration-checklist.md` for the database/blob split, Netlify setup notes, and the Online Portal -> Retail Shark -> Shopify system map.

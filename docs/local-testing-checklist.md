# Local Testing Checklist

Use this before deciding the portal is ready for hosted setup.

## Reset

```powershell
npm run reset:local
npm start
```

## Customer

- Login with `user` / `user`.
- Confirm the first screen after login is the Shop page.
- Confirm the featured slider appears when matching products exist.
- Confirm brand collection tiles appear above the product grid.
- Confirm the product grid shows no more than 30 products per page.
- Confirm the Prev/Next page buttons work above and below the grid.
- Confirm product images load where Shopify has images.
- Confirm single-variant products have no variant selector.
- Confirm product cards show only `In stock` or `Out of stock`, not SOH.
- Confirm product images do not overlap product titles or block Add buttons.
- Open the filter button and confirm the Type and Availability checkbox sections appear.
- Select Vials, Orals, Pens, Nasal, and In stock in different combinations and confirm the grid narrows down.
- Search for a product name and confirm the grid narrows down.
- Add one in-stock product to cart.
- Confirm the cart quantity bubble appears in the user nav.
- Toggle dark/light mode beside Logout and confirm the customer preference stays after refresh/login.
- Open Cart and confirm the cart items, total, delivery form, and submit button are shown there.
- Open My account and confirm customer contact and default delivery details are shown.
- Try an unusually large normal quantity and confirm it is blocked.
- Enable Special order request, add a larger quantity or out-of-stock product, and submit the request.
- Submit an order with the prefilled delivery address.
- Open `My orders`.
- Confirm the order shows `Payment pending`.
- Confirm EFT reference and total are visible.
- Upload a proof-of-payment file.
- Confirm the order shows the POP filename.

## Admin

- Logout.
- Login with `admin` / `admin`.
- Confirm only the admin queue is visible.
- Confirm the admin area has Awaiting confirmation, Ready to pack, and Completed tabs.
- Open Shop settings and confirm the featured slider can be saved as a collection/tag query or custom product selection.
- Confirm the submitted order appears under Awaiting confirmation.
- For a special order, approve, decline, or counter the request.
- Open the POP link if a proof was uploaded.
- Confirm payment.
- Confirm the order moves to Ready to pack.

## Internal API

Call:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3141/api/internal/orders/confirmed" -Headers @{ "x-internal-token" = "dev-internal-token" }
```

Confirmed orders should appear here for future Retail Shark integration.

## Cleanup

```powershell
npm run reset:local
```

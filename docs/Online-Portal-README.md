# Online Portal Staff Flow

This guide explains how Online Portal orders move from the customer to payment, then to Retail Shark for packing and tracking.

## What Online Portal Does

Online Portal is where customers:

- Create an account.
- Browse products.
- Submit normal orders.
- Submit special orders for larger quantities or out-of-stock products.
- Receive a Yoco payment link.
- View payment status, order status, and tracking.

Customers do not use Shopify checkout.

## Normal Order Flow

1. Customer logs into Online Portal.
2. Customer adds in-stock products to cart.
3. Customer chooses a delivery address and submits the order.
4. The order appears in the Online Portal admin panel under `Awaiting confirmation`.
5. Staff reviews the order total and customer details.
6. Staff creates a Yoco payment link for the exact order total in Yoco.
7. Staff pastes the Yoco payment link into the order in Online Portal.
8. Customer opens `My orders` and clicks `Pay now`.
9. Once Yoco shows the payment as successful, staff clicks `Confirm payment` in Online Portal.
10. After payment is confirmed, Online Portal can create the Shopify order if Shopify sync is enabled.
11. The confirmed order becomes available to Retail Shark.
12. Retail Shark staff packs the order, adds tracking, sends it to back orders, or marks it shipped.
13. Online Portal shows the customer the final status and tracking details.

## Special Order Flow

Special orders are for larger quantities or products that are out of stock.

1. Customer opens `Special order`.
2. Customer selects products, quantities, delivery address, and submits the request.
3. The order appears in Online Portal admin as a special order requiring review.
4. Staff chooses one of three actions:
   - Approve the request.
   - Decline the request.
   - Counter the request with adjusted quantities.
5. When approving or countering, staff splits each product between:
   - `Retail Shark / Shopify`: stock supplied from the office and synced to Shopify stock.
   - `External`: stock fulfilled outside Retail Shark and not deducted from Shopify SOH.
6. The combined `Retail Shark / Shopify` plus `External` quantity cannot exceed the customer requested quantity.
7. After approval or counter, staff creates a Yoco payment link for the final approved total.
8. Staff pastes the Yoco link into the order.
9. Customer pays through Yoco.
10. Once Yoco confirms payment, staff clicks `Confirm payment`.
11. Retail Shark receives only the `Retail Shark / Shopify` portion.
12. Any `External` portion stays in Online Portal, where staff can add external tracking from the Online Portal admin panel.
13. Customer sees normal shipment tracking without seeing the internal split.

## Payment Rules

- Do not confirm payment until Yoco shows the payment as successful.
- Do not send an order to Retail Shark before payment is confirmed.
- Do not create or sync Shopify orders before payment is confirmed.
- If the Yoco link was created with the wrong amount, create a new Yoco link and update the order before the customer pays.

## Payment Support

Customers have two payment support actions once a Yoco payment link is available:

- `I have paid`: customer says payment was completed, but the order still shows pending.
- `Payment link not working`: customer reports a link or payment problem.

Both actions flag the order in the Online Portal admin panel. Staff should:

1. Open the order in Online Portal admin.
2. Check the issue message and the Yoco app.
3. Recreate or update the Yoco payment link if needed.
4. If payment is visible as successful in Yoco, click `Confirm payment`.
5. If the issue is solved but payment is not complete, click `Mark resolved`.

These support actions do not confirm payment automatically. Staff must still verify the payment in Yoco.

## Retail Shark Rules

Retail Shark only handles confirmed paid orders.

Retail Shark is responsible for:

- Ready to pack orders.
- Adding courier and tracking details for office-fulfilled orders.
- Sending orders to back orders when needed.
- Marking orders shipped when packed and sent.

Online Portal is responsible for:

- Customer accounts.
- Customer order requests.
- Yoco payment link display.
- Payment confirmation gate.
- Customer-visible order status.
- External tracking for special-order external fulfillment.

## Status Meaning

- `Awaiting payment link`: Staff still needs to attach the Yoco payment link.
- `Payment required`: Customer has a Yoco link and must pay.
- `Marked as paid, processing`: Customer marked payment as completed, or staff has confirmed payment and the order is moving through the processing chain.
- `Ready to pack`: Retail Shark can process the order.
- `Not ready`: Order was moved to back orders.
- `Shipped`: Order has tracking and has been marked shipped.

## Important

If anything looks wrong, stop before confirming payment. Payment confirmation is the gate that can trigger Shopify sync and Retail Shark processing.

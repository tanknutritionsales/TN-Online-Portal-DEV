// Disposable receipt QA. Uses generated accounts/orders and never loads project credentials.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startIsolatedPortal } from "./isolated-portal.mjs";

const preview = await startIsolatedPortal({ photos: true });
const now = Date.now(), at = (days) => new Date(now - days * 86400000).toISOString();
const base = {
  customer: { id: "demo-user", name: "Test Customer", email: "user@example.com" },
  paymentStatus: "confirmed", fulfillmentStatus: "shipped", fulfillmentReview: { status: "reviewed" },
  createdAt: at(6), updatedAt: at(4), shippedAt: at(4), officeShippedAt: at(4),
  items: [{ variantId: "mock-hd-reta-default", productTitle: "HD VIAL RETATRUTIDE 32MG", quantity: 1, price: 1350 }],
  subtotal: 1350, deliveryFee: 150, total: 1500,
  tracking: { courier: "Courier Guy", number: "QA-PARCEL-1", url: "https://example.com/tracking" },
};
const orders = [
  { ...base, id: "qa-receipt-due", reference: "QA-RECEIPT-DUE" },
  { ...base, id: "qa-recent-shipment", reference: "QA-RECENT-SHIPMENT", shippedAt: at(1), officeShippedAt: at(1), updatedAt: at(1) },
  { ...base, id: "qa-processing", reference: "QA-PROCESSING", fulfillmentStatus: "not_ready", shippedAt: null, officeShippedAt: null, tracking: null },
];
await mkdir(path.join(preview.directory, "data"), { recursive: true });
await writeFile(path.join(preview.directory, "data", "orders.json"), JSON.stringify({ orders }));
console.log(`Disposable receipt QA: ${preview.url}\nCustomer: user / user\nAdmin: admin / admin\nShopify sync is disabled. Press Ctrl+C to stop and discard this preview.`);
process.once("SIGINT", async () => { await preview.close(); process.exit(); });
process.once("SIGTERM", async () => { await preview.close(); process.exit(); });
setInterval(() => {}, 60_000);

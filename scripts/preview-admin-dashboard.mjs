// Owned, disposable local data only; no checkout .env, provider or hosted writes.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startIsolatedPortal } from "./isolated-portal.mjs";
const preview = await startIsolatedPortal();
try {
await mkdir(path.join(preview.directory, "data"), { recursive: true });
const date = days => new Date(Date.now() - days * 86400000).toISOString();
const names = ["Alex Morgan", "Jordan Smith", "Casey Taylor", "Robin Adams"];
const states = ["review", "verify", "details", "storage", "external", "packing", "tracking", "sync", "complete", "backorder"];
const orders = Array.from({ length: 64 }, (_, index) => {
  const stage = states[index % states.length], paid = !["review", "verify", "details"].includes(stage);
  const number = `OP-${String(1042 - index)}`;
  return { id: `dashboard-preview-${index}`, reference: number,
    customer: { id: `preview-${index % 4}`, name: names[index % 4], email: `customer${index % 4}@example.test` },
    items: [{ variantId: "mock-hd-reta-default", productTitle: "Sample research product", quantity: 2, price: 350, sku: "DEMO" }],
    subtotal: 700, deliveryFee: 150, total: 850, paymentStatus: paid ? "confirmed" : "pending", fulfillmentStatus: stage === "complete" ? "shipped" : stage === "backorder" ? "back_order" : "not_ready",
    fulfillmentReview: { status: stage === "review" ? "pending" : "reviewed" },
    paymentLink: stage === "verify" ? { provider: "yoco", url: "https://example.test", reference: number } : null,
    paymentIssue: stage === "verify" ? { type: "paid_pending", status: "open" } : null,
    ...(stage === "external" ? { fulfillmentAllocations: [{ variantId: "mock-hd-reta-default", officeQuantity: 0, externalQuantity: 2 }] } : {}),
    tracking: stage === "packing" ? { courier: "Courier Guy", number: "DEMO-TRACK", url: "https://example.test" } : null,
    shopifySync: { status: stage === "storage" ? "storage_pending" : stage === "sync" ? "reconciliation_required" : "disabled" },
    createdAt: date(index < 18 ? index / 6 : index + 20), statusEvents: [] };
});
const messages = [{ id: "preview-support", kind: "support", status: "open", customerName: "Alex Morgan", customerEmail: "customer@example.test", topic: "Delivery", message: "Please check my tracking update.", replies: [], reference: "OP-1042" },
  { id: "preview-email", kind: "email", status: "failed", category: "order", event: "payment_ready", to: "customer@example.test", subject: "Payment details ready", reference: "OP-1041", attempts: 1, lastError: "Temporary email service failure" }]
  .map(entry => ({ ...entry, customerId: "preview-0", createdAt: date(0), updatedAt: date(0) }));
await writeFile(path.join(preview.directory, "data/orders.json"), JSON.stringify({ orders }));
await writeFile(path.join(preview.directory, "data/customer-messages.json"), JSON.stringify({ messages }));
} catch (error) { await preview.close(); throw error; }
console.log(JSON.stringify({ url: preview.url, directory: preview.directory, pid: process.pid, note: "Synthetic dashboard data. Admin login: admin / admin" }));
process.once("SIGINT", async () => { await preview.close(); process.exit(); });
process.once("SIGTERM", async () => { await preview.close(); process.exit(); });
setInterval(() => {}, 60000);

// Browser API contracts on disposable files. PostgreSQL concurrency has its own
// real-cluster suite; this checks routing, ownership and transition regressions.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { startIsolatedPortal } from "./isolated-portal.mjs";

const portal = await startIsolatedPortal();
class Session {
  cookie = "";
  async request(path, { method = "GET", body, status = 200 } = {}) {
    const response = await fetch(portal.url + path, { method, headers: {
      "content-type": "application/json", "x-op-client": "portal", cookie: this.cookie,
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.headers.get("set-cookie")) this.cookie = response.headers.get("set-cookie").split(";")[0];
    const payload = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(payload)}`);
    return payload;
  }
  post(path, body, status = 200) { return this.request(path, { method: "POST", body, status }); }
}

try {
  const admin = new Session(), customer = new Session(), removed = new Session(), peer = new Session();
  await admin.post("/api/auth/admin-login", { username: "admin", password: "admin" });
  await customer.post("/api/auth/login", { login: "user", password: "user" });
  await admin.post("/api/admin/accounts", { role: "admin", username: "weak", name: "Weak", password: "1234" }, 400);
  const account = (await admin.post("/api/admin/accounts", { role: "admin", username: "temporary", name: "Temporary", password: "temporary-password-12" }, 201)).account;
  await removed.post("/api/auth/admin-login", { username: "temporary", password: "temporary-password-12" });
  await peer.post("/api/auth/admin-login", { username: "temporary", password: "temporary-password-12" });
  await removed.request(`/api/admin/accounts/${account.id}`, { method: "PUT", body: { username: "temporary", name: "Updated", password: "new-password-at-least-12" } });
  await removed.request("/api/admin/accounts"); // Own credential change renews this cookie.
  await peer.request("/api/admin/accounts", { status: 401 });
  await admin.request(`/api/admin/accounts/${account.id}`, { method: "DELETE", body: { password: "admin" } });
  await removed.request("/api/admin/accounts", { status: 401 });
  await removed.post("/api/admin/shop-settings", { courier: { amount: 1 } }, 401);

  const catalog = await customer.request("/api/catalog");
  assert.ok(!JSON.stringify(catalog).includes('"availableQuantity"'));
  assert.ok(!JSON.stringify(catalog).includes('"storageQuantity"'));
  const variantId = catalog.products[0].variant.id;
  for (const quantity of [0, -1, 1.5, "invalid", 10001]) {
    await customer.post("/api/cart/check", { items: [{ variantId, quantity }] }, 400);
  }
  await customer.post("/api/cart/check", { items: [{ variantId, quantity: 999 }, { variantId, quantity: 999 }] }, 409);
  await customer.post("/api/cart/check", { items: [{ variantId: "deleted-product", quantity: 1 }] }, 409);
  const items = [{ variantId, quantity: 1 }];
  const quote = await customer.post("/api/cart/check", { items });
  await customer.post("/api/orders", { items, idempotencyKey: randomUUID(), expectedTotal: quote.total + 1 }, 409);
  const input = { items, idempotencyKey: randomUUID(), expectedTotal: quote.total };
  // Stay within the intentional per-customer HTTP abuse quota. The native SQL
  // suite separately exercises 200 same-key retries under database contention.
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => customer.post("/api/orders", input, 201)));
  assert.equal(new Set(concurrent.map(result => result.order.id)).size, 1);
  const order = concurrent[0].order;
  await customer.post("/api/orders", { ...input, items: [{ variantId, quantity: 2 }] }, 409);
  assert.equal((await customer.request("/api/orders")).orders.length, 1);

  const internal = async (action, body, status = 200) => {
    const response = await fetch(`${portal.url}/api/internal/orders/${order.id}/${action}`, { method: "POST", headers: { "content-type": "application/json", "x-internal-token": "dev-internal-token" }, body: JSON.stringify(body) });
    assert.equal(response.status, status, await response.text());
  };
  await internal("back-order", {}, 409);
  await admin.post(`/api/admin/orders/${order.id}/fulfillment`, { allocations: [{ variantId, officeQuantity: 1, externalQuantity: 0 }] });
  const payment = { provider: "yoco", url: "https://pay.yoco.com/isolated-qa", note: "Payment test" };
  const first = (await admin.post(`/api/admin/orders/${order.id}/payment-link`, payment)).order;
  const again = (await admin.post(`/api/admin/orders/${order.id}/payment-link`, payment)).order;
  assert.equal(first.paymentLink.attachedAt, again.paymentLink.attachedAt);
  await Promise.all(Array.from({ length: 12 }, () => admin.post(`/api/admin/orders/${order.id}/confirm-payment`, {})));
  await customer.post(`/api/orders/${order.id}/proof`, {}, 409);
  await internal("ship", {}, 409);
  await internal("tracking", { courier: "Courier Guy", number: "QA-TRACK", url: "javascript:bad" }, 400);
  await internal("tracking", { courier: "Courier Guy", number: "QA-TRACK", url: "https://example.com/track" });
  await internal("ship", {});
  await internal("back-order", {}, 409);
  await internal("ship", {});
  const final = (await customer.request(`/api/orders/${order.id}`)).order;
  assert.equal(final.paymentStatus, "confirmed");
  assert.equal(final.fulfillmentStatus, "shipped");
  const adminOrder = (await admin.request("/api/admin/orders?view=completed&limit=1")).orders[0];
  assert.equal(adminOrder.id, order.id);
  const saved = JSON.parse(await readFile(path.join(portal.directory,"data/orders.json"),"utf8")).orders.find(entry=>entry.id===order.id);
  assert.equal(saved.statusEvents.filter(event => event.type === "payment_confirmed").length, 1);
  assert.equal(saved.statusEvents.filter(event => event.type === "shipped").length, 1);

  const status = await admin.request("/api/admin/system-status");
  assert.ok(status.systems.some(entry => entry.id === "catalog-cache"));
  await customer.post("/api/admin/catalog/refresh", {}, 401);
  const refresh = await admin.post("/api/admin/catalog/refresh", {});
  assert.equal(refresh.cache.fresh, true);
  console.log("Infrastructure API checks passed: concurrent idempotency, current admin authorization, credential revocation, bounded quantities, quote totals, immutable payment/shipping transitions, private stock and cache controls.");
} finally { await portal.close(); }

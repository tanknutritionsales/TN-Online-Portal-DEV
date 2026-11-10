import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { saveCart, readSavedCart, cartStorageKey } from "../public/cart-storage.js";
import { productFacts, normalizeProductContent } from "../public/product-content.js";
import { createCustomerMessageStore } from "../lib/customer-message-store.mjs";
import { normalizeCustomerCare, createOrderEmail, deliverQueuedEmail, emailSetupStatus } from "../lib/customer-notifications.mjs";
import { startIsolatedPortal } from "./isolated-portal.mjs";

const memory = new Map();
const storage = { getItem: (key) => memory.get(key), setItem: (key, value) => memory.set(key, value), removeItem: (key) => memory.delete(key) };
assert.equal(saveCart(storage, "a", [{ variantId: "one", quantity: 2, price: 1, title: "private" }], 1000), true);
assert.deepEqual(readSavedCart(storage, "a", 2000), [{ variantId: "one", quantity: 2 }]);
assert.deepEqual(readSavedCart(storage, "b", 2000), []);
assert.ok(!memory.get(cartStorageKey("a")).includes("private"));
assert.deepEqual(readSavedCart(storage, "a", 31 * 86400000), []);
storage.setItem(cartStorageKey("a"), "invalid JSON");
assert.deepEqual(readSavedCart(storage, "a"), []);
saveCart(storage, "a", [{ variantId: "bad", quantity: -1 }, { variantId: "one", quantity: 4 }, { variantId: "one", quantity: 5 }]);
assert.deepEqual(readSavedCart(storage, "a"), [{ variantId: "one", quantity: 5 }]);
assert.equal(saveCart({ setItem() { throw new Error("Storage full"); } }, "a", [{ variantId: "one", quantity: 1 }]), false);
assert.deepEqual(normalizeProductContent(null), {});
assert.deepEqual(productFacts({ title: "Plain product" }), []);
assert.equal(productFacts({ title: "HD VIAL RETA 32MG" }).find((fact) => fact.label === "Strength").value, "32MG");
assert.ok(!productFacts({ title: "Blend 10MG + 20MG" }).some((fact) => fact.label === "Strength"));
assert.equal(productFacts({ title: "Oral 20MG 100 tablets" }).find((fact) => fact.label === "Pack size").value, "100 tablets");
assert.equal(productFacts({ title: "Plain product" }, { strength: "5 mg/mL" })[0].value, "5 mg/mL");
assert.deepEqual(normalizeProductContent(JSON.parse('{"__proto__":{"strength":"bad"},"one":{"strength":"10MG"}}')), { one: { strength: "10MG", format: "", packSize: "" } });

const directory = await mkdtemp(path.join(tmpdir(), "op-messages-test-"));
try {
  const store = createCustomerMessageStore({ useDatabase: () => false, localAllowed: true, filePath: path.join(directory, "messages.json") });
  const timestamp = new Date().toISOString();
  const entry = { id: "thread", kind: "support", customerId: "a", status: "open", replies: [], createdAt: timestamp, updatedAt: timestamp };
  const inserted = await Promise.all(Array.from({ length: 10 }, () => store.insert(entry)));
  assert.equal(inserted.filter((result) => result.created).length, 1);
  assert.deepEqual([...await store.existingIds(["thread", "missing"])], ["thread"]);
  await Promise.all(Array.from({ length: 15 }, (_, index) => store.update("thread", (current) => ({ ...current, replies: [...current.replies, index] }))));
  assert.equal((await store.list({ customerId: "a" }))[0].replies.length, 15);
  assert.deepEqual(await store.list({ customerId: "b" }), []);
  const care = normalizeCustomerCare({ supportEmail: "help@example.com" });
  const order = { id: "order-1", reference: '<script>alert("x")</script>', total: 150, customer: { id: "a", email: "a@example.com" } };
  const email = createOrderEmail(order, "order_received", { portalUrl: "https://example.com/", care, eventId: "received" });
  assert.ok(!email.html.includes("<script>"));
  assert.equal(createOrderEmail(order, "order_received", { portalUrl: "https://example.com/", care, eventId: "received" }).id, email.id);
  await store.insert(email);
  let calls = 0;
  const config = { apiKey: "isolated-placeholder", from: "sender@example.com", senderName: "Store", fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(options.headers["idempotency-key"], email.id);
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { ok: true, json: async () => ({ id: "provider-id" }) };
  } };
  await Promise.all(Array.from({ length: 10 }, () => deliverQueuedEmail(store, email.id, config)));
  assert.equal(calls, 1);
  await deliverQueuedEmail(store, email.id, config);
  assert.equal(calls, 1);
  const failed = { ...email, id: "failed", status: "pending", attempts: 0 };
  await store.insert(failed);
  await deliverQueuedEmail(store, "failed", { ...config, fetchImpl: async () => ({ ok: false, status: 401, text: async () => "secret provider response" }) });
  const result = (await store.list({ kind: "email" })).find((message) => message.id === "failed");
  assert.equal(result.status, "failed");
  assert.ok(!result.lastError.includes("secret"));
  assert.equal(result.attempts, 1);
  for (const status of ["superseded", "disabled", "expired"]) {
    await store.insert({ ...email, id: status, status });
    assert.equal(await deliverQueuedEmail(store, status, config), null);
  }
  await store.insert({ ...email, id: "old", createdAt: new Date(Date.now() - 24 * 3600000).toISOString() });
  assert.equal((await deliverQueuedEmail(store, "old", config)).status, "expired");
  assert.equal(emailSetupStatus({ apiKey: "key", from: "sender@example.com", portalUrl: "https://example.com", allowed: false }).configured, false);
} finally {
  if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("op-messages-test-")) throw new Error("Unexpected test path.");
  await rm(directory, { recursive: true, force: true });
}

// Exercise the database transaction contract, including rollback/release on failure.
const statements = [];
let releases = 0;
const databaseClient = {
  query: async (sql) => { statements.push(sql); return { rows: sql.includes("FOR UPDATE") ? [{ data: { id: "db-thread", status: "open" } }] : [] }; },
  release: () => releases++,
};
const databaseStore = createCustomerMessageStore({ useDatabase: () => true, localAllowed: false, database: async () => ({ connect: async () => databaseClient, query: async () => ({ rows: [] }) }) });
await assert.rejects(databaseStore.update("db-thread", () => { throw new Error("Aborted update"); }), /Aborted update/);
assert.equal(releases, 2); // Schema and update each release their connection.
assert.ok(statements.some((sql) => sql.includes("pg_advisory_xact_lock")));
assert.ok(statements.some((sql) => sql.includes("FOR UPDATE")));
assert.equal(statements.at(-1), "ROLLBACK");
await databaseStore.update("db-thread", (entry) => ({ ...entry, status: "resolved", updatedAt: new Date().toISOString() }));
assert.equal(statements.filter((sql) => sql.includes("CREATE TABLE")).length, 1);
assert.equal(statements.at(-1), "COMMIT");

const portal = await startIsolatedPortal();
class Session {
  cookie = "";
  async request(route, { status = 200, ...options } = {}) {
    const response = await fetch(portal.url + route, { ...options, headers: { "content-type": "application/json", "x-op-client": "portal", cookie: this.cookie, ...options.headers } });
    if (response.headers.get("set-cookie")) this.cookie = response.headers.get("set-cookie").split(";")[0];
    const payload = await response.json();
    assert.equal(response.status, status, `${route}: ${JSON.stringify(payload)}`);
    return payload;
  }
  post(route, body, status = 200) { return this.request(route, { method: "POST", body: JSON.stringify(body), status }); }
}
try {
  const customer = new Session(), second = new Session(), admin = new Session(), anonymous = new Session();
  await customer.post("/api/auth/login", { login: "user", password: "user" });
  await admin.post("/api/auth/admin-login", { username: "admin", password: "admin" });
  await second.post("/api/auth/register", { username: "second", email: "second@example.com", name: "Second Customer", password: "test-pass-123", phoneArea: "+27", phoneNumber: "821234567", defaultAddress: { label: "Home", line1: "2 Test Road", suburb: "Menlyn", city: "Pretoria", province: "Gauteng", postalCode: "0001", country: "South Africa" }, terms: { accepted: true, ageConfirmed: true, version: "research-use-v1-2026-10-08" } }, 201);
  await second.post("/api/auth/login", { login: "second", password: "test-pass-123" });
  const request = await customer.post("/api/support", { message: "Please help with my delivery.", topic: "Delivery", idempotencyKey: "test-thread" }, 201);
  const duplicate = await customer.post("/api/support", { message: "Please help with my delivery.", idempotencyKey: "test-thread" }, 201);
  assert.equal(duplicate.request.id, request.request.id);
  assert.equal((await customer.request("/api/support")).requests.length, 1);
  assert.equal((await second.request("/api/support")).requests.length, 0);
  await anonymous.request("/api/support", { status: 401 });
  await customer.request("/api/admin/customer-care", { status: 401 });
  await customer.post("/api/support", { orderId: "someone-elses-order", message: "Attempt to access another order" }, 404);
  const reply = { reply: "We will help you here.", status: "resolved", idempotencyKey: "reply-once" };
  await admin.post(`/api/admin/support/${request.request.id}/reply`, reply);
  await admin.post(`/api/admin/support/${request.request.id}/reply`, reply);
  assert.equal((await customer.request("/api/support")).requests[0].replies.length, 1);
  const initial = (await customer.request("/api/shop-settings")).settings;
  await admin.post("/api/admin/shop-settings", { customerCare: { supportEmail: "help@example.com", emailEnabled: true, emailEnabledAt: "2000-01-01" }, productContent: { "mock-hd-reta": { strength: "32 mg", packSize: "1 vial" } } });
  const settings = (await customer.request("/api/shop-settings")).settings;
  assert.deepEqual(settings.payment, initial.payment);
  assert.ok(Date.parse(settings.customerCare.emailEnabledAt) > Date.parse("2026-01-01"));
  const catalog = await customer.request("/api/catalog");
  assert.equal(catalog.products.find((product) => product.id === "mock-hd-reta").facts.find((fact) => fact.label === "Pack size").value, "1 vial");
  assert.ok(!JSON.stringify(catalog).includes('"availableQuantity"'));
  await customer.post("/api/cart/check", { items: [{ variantId: "mock-hd-reta-default", quantity: 999 }] }, 409);
  const smoke = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "smoke-local.mjs")], { env: { ...process.env, ONLINE_PORTAL_URL: portal.url, INTERNAL_API_TOKEN: "dev-internal-token" }, encoding: "utf8", windowsHide: true });
  assert.equal(smoke.status, 0, smoke.stdout + smoke.stderr);
  console.log("Existing order/fulfillment smoke passed on isolated local data.");
  const care = await admin.request("/api/admin/notifications");
  assert.equal(care.emailSetup.configured, false);
  assert.ok(care.emails.length >= 3);
  assert.ok(care.emails.every((email) => email.status === "setup_required"));
  assert.ok(!JSON.stringify(care).includes("apiKey"));
  const ownOrders = (await customer.request("/api/orders")).orders;
  assert.equal(ownOrders[0].customerStatus, "Processing");
  await second.post("/api/support", { orderId: ownOrders[0].id, message: "Cross-customer order test" }, 404);
  const shipOptions = { method: "POST", body: "{}", headers: { "x-internal-token": "dev-internal-token" } };
  await admin.request(`/api/internal/orders/${ownOrders[0].id}/ship`, { ...shipOptions, status: 409 });
  await admin.request(`/api/internal/orders/${ownOrders[0].id}/tracking`, { ...shipOptions, body: JSON.stringify({courier:"Courier Guy",number:"QA-TRACK",url:"https://example.com/track"}) });
  await admin.request(`/api/internal/orders/${ownOrders[0].id}/ship`, shipOptions);
  const firstShipmentCount = (await admin.request("/api/admin/notifications")).emails.length;
  await admin.request(`/api/internal/orders/${ownOrders[0].id}/ship`, shipOptions);
  assert.equal((await admin.request("/api/admin/notifications")).emails.length, firstShipmentCount);
  console.log("Customer experience checks passed: basket isolation, catalog facts, message concurrency, safe email retries, support ownership, settings preservation and order flow.");
} finally { await portal.close(); }

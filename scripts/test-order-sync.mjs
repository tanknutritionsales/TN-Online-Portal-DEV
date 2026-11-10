import assert from "node:assert/strict";
import { createOrderSync, orderSyncFingerprint } from "../lib/order-sync.mjs";

const copy = (value) => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const fixture = () => ({
  id: "order-1", reference: "OP-TEST", customer: { id: "customer-1", name: "Test", email: "test@example.com" },
  items: [{ variantId: "variant-1", quantity: 2, price: 125, storageBackedQuantity: 1 }],
  delivery: { address: { line1: "1 Test Road" } }, deliveryFee: 150,
  paymentStatus: "confirmed", paymentProvider: "yoco", fulfillmentStatus: "not_ready",
  fulfillmentReview: { status: "reviewed" }, statusEvents: [], shopifySync: { status: "not_started" },
});

// Shared atomic store: separate sync instances coordinate through this transaction,
// never through a factory-local mutex. No filesystem, database or network is used.
function recordStore(record = fixture()) {
  let current = copy(record), queue = Promise.resolve(), locked = false;
  return {
    beforeCommit: null,
    get locked() { return locked; },
    async get(id) { return current?.id === id ? copy(current) : null; },
    update(id, transform) {
      const result = queue.then(() => {
        if (current?.id !== id) return null;
        locked = true;
        try {
          const next = transform(copy(current));
          assert.ok(!next?.then, "Store transforms must be synchronous.");
          if (next !== null) { this.beforeCommit?.(next); current = copy(next); }
          return copy(current);
        } finally { locked = false; }
      });
      queue = result.catch(() => {});
      return result;
    },
  };
}

function harness(record = fixture(), overrides = {}) {
  const orders = recordStore(record), calls = { stock: 0, create: 0, find: 0 };
  let time = Date.parse("2026-11-09T12:00:00Z"), enabled = true;
  const options = {
    orders, enabled: () => enabled, officeItems: (order) => order.items.filter((item) => item.route !== "external"),
    now: () => time, leaseMs: 90_000,
    checkStock: async () => [], createRemote: async () => ({ id: "remote-1", name: "#1001" }), findRemote: async () => null,
    ...overrides,
  };
  for (const [name, counter] of [["checkStock", "stock"], ["createRemote", "create"], ["findRemote", "find"]]) {
    const injected = options[name];
    options[name] = async (...args) => { assert.equal(orders.locked, false, `${name} ran in a transaction`); calls[counter]++; return injected(...args); };
  }
  return { orders, calls, options, sync: createOrderSync(options), advance: (ms) => { time += ms; }, disable: () => { enabled = false; }, enable: () => { enabled = true; } };
}

let tests = 0;
async function test(name, run) { await run(); tests++; console.log(`ok ${tests} - ${name}`); }

await test("200 concurrent calls across two instances claim once; unrelated changes survive", async () => {
  const entered = deferred(), release = deferred();
  const h = harness(fixture(), { createRemote: async (order) => { assert.ok(order.shopifySync.dispatchedAt); entered.resolve(); await release.promise; return { id: "remote-1" }; } });
  const second = createOrderSync(h.options);
  const pending = Array.from({ length: 200 }, (_, index) => (index % 2 ? h.sync : second)("order-1", { username: "admin" }));
  await entered.promise;
  const inFlight = await h.orders.get("order-1");
  assert.equal(inFlight.shopifySync.status, "syncing");
  assert.ok(inFlight.shopifySync.claimToken);
  assert.ok(inFlight.shopifySync.dispatchedAt);
  assert.equal((await h.sync("order-1")).shopifySync.status, "syncing");
  await h.orders.update("order-1", (order) => { order.tracking = { number: "TRACK" }; order.externalTracking = { number: "EXT" }; order.fulfillmentStatus = "back_order"; order.statusEvents.push({ id: "staff-event" }); return order; });
  release.resolve();
  await Promise.all(pending);
  const result = await h.orders.get("order-1");
  assert.deepEqual(h.calls, { stock: 1, create: 1, find: 0 });
  assert.equal(result.shopifySync.status, "synced");
  assert.equal(result.tracking.number, "TRACK"); assert.equal(result.externalTracking.number, "EXT");
  assert.equal(result.fulfillmentStatus, "back_order");
  assert.equal(result.statusEvents.filter((entry) => entry.id.startsWith("order-sync:")).length, 1);
  assert.ok(result.statusEvents.some((entry) => entry.id === "staff-event"));
  assert.ok(!("storageBackedQuantity" in result.items[0]));
  assert.deepEqual(await h.sync("order-1"), result);
});

await test("uncertain response and empty or failed lookups NEVER create again", async () => {
  let lookup = "empty";
  const h = harness(fixture(), { createRemote: async () => { throw new Error("Response lost"); }, findRemote: async () => { if (lookup === "failed") throw new Error("Lookup unavailable"); return lookup === "found" ? { id: "remote-1" } : null; } });
  assert.equal((await h.sync("order-1")).shopifySync.status, "reconciliation_required");
  for (let index = 0; index < 5; index++) assert.equal((await h.sync("order-1")).shopifySync.status, "reconciliation_required");
  lookup = "failed";
  assert.match((await h.sync("order-1")).shopifySync.message, /lookup failed/i);
  h.disable(); assert.equal((await h.sync("order-1")).shopifySync.status, "disabled");
  h.enable(); lookup = "found";
  const result = await h.sync("order-1");
  assert.equal(result.shopifyOrder.id, "remote-1"); assert.equal(result.shopifySync.status, "synced");
  assert.equal(h.calls.create, 1); assert.equal(h.calls.stock, 1);
  assert.equal(result.statusEvents.filter((entry) => entry.id.startsWith("order-sync:")).length, 1);
});

await test("legacy attempted errors and unknown states reconcile without creating, even without old dispatch markers", async () => {
  const attemptedAt = "2026-11-01T12:00:00Z";
  for (const state of [
    { status: "error", attemptedAt },
    { status: "syncing", attemptedAt },
    { status: "unknown-legacy-state", attemptedAt },
    { attemptedAt },
    { status: "error" },
    { status: "unknown-legacy-state" },
    { status: "error", attemptedAt, noOrderCreated: "true" },
    { status: "disabled", attemptedAt },
    { status: "not_started", attemptedAt },
  ]) {
    const order = fixture(); order.shopifySync = state;
    let mode = "empty";
    const h = harness(order, { findRemote: async () => {
      if (mode === "failed") throw new Error("Legacy lookup unavailable");
      return mode === "found" ? { id: "legacy-remote" } : null;
    } });
    assert.equal((await h.sync(order.id)).shopifySync.status, "reconciliation_required", JSON.stringify(state));
    assert.equal((await h.sync(order.id)).shopifySync.status, "reconciliation_required");
    mode = "failed"; assert.match((await h.sync(order.id)).shopifySync.message, /lookup failed/i);
    h.disable();
    const disabled = await h.sync(order.id);
    assert.equal(disabled.shopifySync.status, "disabled"); assert.equal(disabled.shopifySync.reconciliationRequired, true);
    h.enable(); h.advance(90_001); mode = "found";
    const saved = await h.sync(order.id);
    assert.equal(saved.shopifyOrder.id, "legacy-remote"); assert.equal(saved.shopifySync.status, "synced");
    assert.deepEqual(h.calls, { stock: 0, create: 0, find: 4 });
  }
});

await test("known pre-dispatch legacy outcomes and explicit noncreation still permit a fresh stock check", async () => {
  const attemptedAt = "2026-11-01T12:00:00Z";
  for (const state of [
    { status: "storage_pending", attemptedAt },
    { status: "external", attemptedAt, syncedAt: attemptedAt },
    { status: "disabled", attemptedAt: null },
    { status: "not_started" },
    {},
    { status: "error", attemptedAt, noOrderCreated: true },
    { status: "unknown-legacy-state", attemptedAt, noOrderCreated: true },
    { status: "syncing", attemptedAt, phase: "checking_stock", claimToken: "expired", leaseExpiresAt: attemptedAt, noOrderCreated: true },
  ]) {
    const order = fixture(); order.shopifySync = state;
    const h = harness(order);
    assert.equal((await h.sync(order.id)).shopifySync.status, "synced", JSON.stringify(state));
    assert.deepEqual(h.calls, { stock: 1, create: 1, find: 0 });
  }
});

await test("dispatch evidence overrides contradictory safe-state or noOrderCreated flags", async () => {
  const attemptedAt = "2026-11-01T12:00:00Z";
  for (const state of [
    { status: "error", attemptedAt, noOrderCreated: true, dispatchedAt: attemptedAt },
    { status: "storage_pending", attemptedAt, dispatchedAt: attemptedAt },
    { status: "storage_pending", phase: "creating", noOrderCreated: true },
    { status: "external", reconciliationRequired: true, noOrderCreated: true },
    { status: "error", remoteCandidate: { id: "earlier-remote" }, noOrderCreated: true },
    { status: "storage_pending", attemptedAt, noOrderCreated: false },
  ]) {
    const order = fixture(); order.shopifySync = state;
    const h = harness(order);
    assert.equal((await h.sync(order.id)).shopifySync.status, "reconciliation_required", JSON.stringify(state));
    assert.deepEqual(h.calls, { stock: 0, create: 0, find: 1 });
  }
});

await test("expired dispatched lease reconciles and fences late completion", async () => {
  const entered = deferred(), release = deferred(); let found = null;
  const h = harness(fixture(), { createRemote: async () => { entered.resolve(); await release.promise; return { id: "remote-1" }; }, findRemote: async () => found });
  const first = h.sync("order-1"); await entered.promise; h.advance(90_001);
  assert.equal((await h.sync("order-1")).shopifySync.status, "reconciliation_required");
  release.resolve(); assert.equal((await first).shopifySync.status, "reconciliation_required");
  found = { id: "remote-1" }; assert.equal((await h.sync("order-1")).shopifySync.status, "synced");
  assert.equal(h.calls.create, 1);
});

await test("expired pre-dispatch lease can be reclaimed; stale stock completion cannot create", async () => {
  const entered = deferred(), release = deferred(); let checks = 0;
  const h = harness(fixture(), { checkStock: async () => { if (++checks === 1) { entered.resolve(); await release.promise; } return []; } });
  const first = h.sync("order-1"); await entered.promise; h.advance(90_001);
  assert.equal((await h.sync("order-1")).shopifySync.status, "synced");
  release.resolve(); await first; assert.equal(h.calls.create, 1);
});

await test("insufficient stock pauses and a stock exception is a retryable pre-dispatch error", async () => {
  let mode = "short";
  const h = harness(fixture(), { checkStock: async () => { if (mode === "throw") throw new Error("Stock unavailable"); return mode === "short" ? [{ productTitle: "Test", required: 2, officeAvailable: 1 }] : []; } });
  assert.equal((await h.sync("order-1")).shopifySync.status, "storage_pending"); assert.equal(h.calls.create, 0);
  mode = "throw"; const failed = await h.sync("order-1");
  assert.equal(failed.shopifySync.status, "error"); assert.equal(failed.shopifySync.dispatchedAt, null);
  mode = "ready"; assert.equal((await h.sync("order-1")).shopifySync.status, "synced");
});

await test("only explicit noOrderCreated errors allow another create", async () => {
  let fail = true;
  const h = harness(fixture(), { createRemote: async () => { if (fail) throw Object.assign(new Error("Rejected before creation"), { noOrderCreated: true }); return { id: "remote-1" }; } });
  const failed = await h.sync("order-1"); assert.equal(failed.shopifySync.status, "error"); assert.equal(failed.shopifySync.dispatchedAt, null);
  fail = false; assert.equal((await h.sync("order-1")).shopifySync.status, "synced"); assert.equal(h.calls.create, 2); assert.equal(h.calls.find, 0);
});

await test("disabled has no network; external-only wins even disabled; existing IDs are preserved", async () => {
  const h = harness(); h.disable(); assert.equal((await h.sync("order-1")).shopifySync.status, "disabled"); assert.deepEqual(h.calls, { stock: 0, create: 0, find: 0 });
  await h.orders.update("order-1", (order) => { order.items[0].route = "external"; return order; });
  const external = await h.sync("order-1"); assert.equal(external.shopifySync.status, "external");
  assert.deepEqual(await h.sync("order-1"), external); assert.equal(external.statusEvents.length, 1);
  const saved = fixture(); saved.shopifyOrder = { id: "existing" }; saved.paymentStatus = "pending";
  const existing = harness(saved); existing.disable(); assert.deepEqual(await existing.sync("order-1"), saved); assert.deepEqual(existing.calls, { stock: 0, create: 0, find: 0 });
});

await test("payment, special review, fulfillment review and invalid Office allocations block all network", async () => {
  for (const modify of [
    (order) => { order.paymentStatus = "pending"; },
    (order) => { order.specialOrder = { status: "pending" }; },
    (order) => { order.specialOrder = { status: "declined" }; },
    (order) => { order.fulfillmentReview.status = "pending"; },
    (order) => { delete order.fulfillmentReview; },
    (order) => { order.items[0].quantity = "bad"; },
    (order) => { order.items.push(copy(order.items[0])); },
  ]) {
    const order = fixture(); modify(order); const h = harness(order);
    await assert.rejects(h.sync("order-1"), (error) => error.status === 409); assert.deepEqual(h.calls, { stock: 0, create: 0, find: 0 });
  }
  for (const status of ["accepted", "countered"]) { const order = fixture(); order.specialOrder = { status }; assert.equal((await harness(order).sync("order-1")).shopifySync.status, "synced"); }
  await assert.rejects(harness().sync("missing"), (error) => error.status === 404);
});

await test("fingerprints are stable and exclude unrelated fields", async () => {
  const order = fixture(), changed = copy(order);
  changed.customer = { email: order.customer.email, name: order.customer.name, id: order.customer.id };
  changed.externalTracking = { number: "EXTERNAL" }; changed.tracking = { number: "OFFICE" }; changed.fulfillmentStatus = "shipped";
  assert.equal(orderSyncFingerprint(order, order.items), orderSyncFingerprint(changed, changed.items));
  changed.items[0].price++; assert.notEqual(orderSyncFingerprint(order, order.items), orderSyncFingerprint(changed, changed.items));
});

await test("changed payload before dispatch blocks create; changed payload after dispatch requires reconciliation", async () => {
  for (const stage of ["stock", "create"]) {
    const entered = deferred(), release = deferred();
    const gate = async () => { entered.resolve(); await release.promise; };
    const h = harness(fixture(), stage === "stock" ? { checkStock: async () => { await gate(); return []; } } : { createRemote: async () => { await gate(); return { id: "remote-1" }; } });
    const pending = h.sync("order-1"); await entered.promise;
    await h.orders.update("order-1", (order) => { order.items[0].price++; return order; });
    release.resolve(); const result = await pending;
    assert.equal(result.shopifySync.status, stage === "stock" ? "error" : "reconciliation_required");
    assert.equal(h.calls.create, stage === "stock" ? 0 : 1); assert.equal(result.shopifyOrder, undefined);
    if (stage === "create") { assert.equal(result.shopifySync.remoteCandidate.id, "remote-1"); await h.sync("order-1"); assert.equal(h.calls.create, 1); assert.equal(h.calls.find, 0); }
  }
});

await test("payment revoked or switch disabled during stock check blocks dispatch", async () => {
  for (const revoke of [true, false]) {
    const entered = deferred(), release = deferred();
    const h = harness(fixture(), { checkStock: async () => { entered.resolve(); await release.promise; return []; } });
    const pending = h.sync("order-1"); await entered.promise;
    if (revoke) await h.orders.update("order-1", (order) => { order.paymentStatus = "pending"; return order; }); else h.disable();
    release.resolve(); assert.equal((await pending).shopifySync.status, revoke ? "error" : "disabled"); assert.equal(h.calls.create, 0);
  }
});

await test("successful remote creation followed by database failure propagates and later reconciles", async () => {
  let found = null;
  const h = harness(fixture(), { findRemote: async () => found });
  h.orders.beforeCommit = (order) => { if (order.shopifySync.status === "synced") throw new Error("Database finalization failed"); };
  await assert.rejects(h.sync("order-1"), /Database finalization failed/);
  const durable = await h.orders.get("order-1"); assert.equal(durable.shopifySync.phase, "creating"); assert.ok(durable.shopifySync.dispatchedAt);
  h.orders.beforeCommit = null; h.advance(90_001);
  assert.equal((await h.sync("order-1")).shopifySync.status, "reconciliation_required"); assert.equal(h.calls.create, 1);
  found = { id: "remote-1" }; assert.equal((await h.sync("order-1")).shopifySync.status, "synced"); assert.equal(h.calls.create, 1);
});

console.log(`Order sync: ${tests} tests passed (isolated in-memory record store; no remote calls).`);

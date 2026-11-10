// Native, disposable loopback PostgreSQL. No server import, .env, hosted URLs,
// notification hooks or Shopify requests. Run: node scripts/test-order-sync-postgres.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { createRecordStore } from "../lib/record-store.mjs";
import { portalSchemaSql } from "../lib/database-schema.mjs";
import { createOrderSync } from "../lib/order-sync.mjs";
import { findOfficeShortfalls } from "../lib/fulfillment-stock.mjs";
import { startIsolatedPostgres } from "./isolated-postgres.mjs";

const copy = (value) => structuredClone(value);
const epoch = Date.parse("2026-11-09T12:00:00Z");
const actor = { userId: "test-admin", username: "test-admin" };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function bounded(promise, label, milliseconds = 15_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function parallel(count, action) {
  // Drain all operations before reporting errors or shutting down the owned pool.
  const results = await Promise.allSettled(Array.from({ length: count }, (_, index) => action(index)));
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, `${errors.length} concurrent operations failed.`);
  return results.map((result) => result.value);
}
function fixture(id) {
  return {
    id, reference: `OP-${id}`, customer: { id: "test-customer", name: "Test Customer", email: "test@example.test" },
    items: [
      { variantId: "office-variant", productTitle: "Office fixture", quantity: 2, price: 125, storageBackedQuantity: 1 },
      { variantId: "external-variant", productTitle: "External fixture", quantity: 3, price: 75 },
    ],
    fulfillmentAllocations: [
      { variantId: "office-variant", officeQuantity: 2, externalQuantity: 0 },
      { variantId: "external-variant", officeQuantity: 0, externalQuantity: 3 },
    ],
    delivery: { address: { line1: "1 Fixture Road", city: "Pretoria" } }, deliveryFee: 150, subtotal: 475, total: 625,
    paymentStatus: "confirmed", paymentProvider: "yoco", paymentConfirmedAt: new Date(epoch).toISOString(), paymentConfirmedBy: "test-admin",
    fulfillmentStatus: "not_ready", fulfillmentReview: { status: "reviewed" },
    specialOrder: { status: "accepted" }, shopifySync: { status: "not_started" }, statusEvents: [],
    createdAt: new Date(epoch).toISOString(), updatedAt: new Date(epoch).toISOString(),
  };
}
function officeItems(order) {
  return order.items.map((item) => ({ ...item, quantity: order.fulfillmentAllocations.find((entry) => entry.variantId === item.variantId)?.officeQuantity || 0 }))
    .filter((item) => item.quantity > 0);
}

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Network HTTP is forbidden in native order-sync tests."); };
let isolated, checks = 0, queryCount = 0;
async function check(name, run) {
  const started = performance.now(), queries = queryCount;
  await run();
  console.log(`ok ${++checks} - ${name} (${Math.round(performance.now() - started)} ms; ${queryCount - queries} native SQL statements)`);
}

try {
  console.log("Starting a fresh isolated native PostgreSQL cluster for order sync...");
  isolated = await startIsolatedPostgres({ onQuery: () => { queryCount++; } });
  const { pool } = isolated;
  // Deliberately omit onOrderWrite: these are repository/sync tests, without an outbox.
  const stores = Array.from({ length: 8 }, () => createRecordStore({ database: async () => pool, useDatabase: true }));
  const orders = stores[0].orders;
  async function sqlOrder(id) {
    const { rows } = await pool.query("SELECT payment_status, fulfillment_status, data FROM op_orders WHERE id = $1", [id]);
    assert.equal(rows.length, 1);
    return rows[0];
  }
  async function assertRowUnlocked(id) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // NOWAIT proves the remote/stock callback runs after the repository commit.
      await client.query("SELECT id FROM op_orders WHERE id = $1 FOR UPDATE NOWAIT", [id]);
    } finally {
      try { await client.query("ROLLBACK"); } finally { client.release(); }
    }
  }
  function harness(overrides = {}) {
    let time = epoch;
    const calls = { stock: 0, create: 0, find: 0 };
    const injected = {
      checkStock: async () => [],
      createRemote: async (order) => ({ id: `fake-remote-${order.id}`, sourceIdentifier: order.id }),
      findRemote: async () => null,
      ...overrides,
    };
    const transports = {};
    for (const [name, counter] of [["checkStock", "stock"], ["createRemote", "create"], ["findRemote", "find"]]) {
      transports[name] = async (order) => { calls[counter]++; return injected[name](order); };
    }
    const syncs = stores.map((store) => createOrderSync({ orders: store.orders, enabled: true, officeItems, now: () => time, leaseMs: 90_000, ...transports }));
    return { calls, syncs, advance: (milliseconds = 90_001) => { time += milliseconds; } };
  }

  await check("identity-guarded native PostgreSQL and portal schema only", async () => {
    const { rows: [identity] } = await pool.query("SELECT version() AS version, current_setting('data_directory') AS directory, host(inet_server_addr()) AS host, inet_server_port() AS port");
    assert.match(identity.version, /^PostgreSQL /);
    assert.equal(identity.host, "127.0.0.1"); assert.equal(identity.port, pool.options.port);
    assert.equal(path.resolve(identity.directory).toLowerCase(), path.resolve(isolated.directory).toLowerCase());
    await pool.query(portalSchemaSql);
  });

  await check("eight instances / 200 simultaneous syncs create once and preserve concurrent tracking", async () => {
    const id = "pg-sync-concurrent", sideId = "pg-sync-unrelated";
    await orders.insert(fixture(id)); await orders.insert(fixture(sideId));
    const entered = deferred(), release = deferred(), otherCallsDone = deferred();
    let completed = 0;
    const h = harness({
      checkStock: async () => [],
      createRemote: async (order) => {
        assert.deepEqual(officeItems(order).map((item) => item.variantId), ["office-variant"]);
        const durable = (await sqlOrder(id)).data;
        assert.equal(durable.shopifySync.claimToken, order.shopifySync.claimToken);
        assert.equal(durable.shopifySync.phase, "creating"); assert.ok(durable.shopifySync.dispatchedAt);
        entered.resolve(); await release.promise;
        return { id: "fake-concurrent-remote", sourceIdentifier: id };
      },
    });
    const jobs = Array.from({ length: 200 }, (_, index) => h.syncs[index % 8](id, actor).then((result) => {
      if (++completed === 199) otherCallsDone.resolve();
      return result;
    }));
    // Attach rejection handlers immediately, even while the first fake create is held.
    const settled = Promise.allSettled(jobs);
    try {
      await bounded(entered.promise, "first create reaches the committed dispatch");
      await bounded(otherCallsDone.promise, "199 competing claims return without creating");
      // Competing claims themselves briefly lock this row. Probe only after
      // they drain, while the single fake remote call is still suspended.
      await assertRowUnlocked(id);
      assert.deepEqual(h.calls, { stock: 1, create: 1, find: 0 });
      assert.equal((await sqlOrder(id)).data.shopifySync.status, "syncing");
      await parallel(40, (index) => stores[index % 8].orders.update(id, (order) => {
        order.tracking = { courier: "Fixture", number: "TRACK", changes: [...(order.tracking?.changes || []), index] };
        order.externalTracking = { courier: "Fixture", number: "EXTERNAL" };
        order.fulfillmentStatus = "back_order";
        order.statusEvents.push({ id: `tracking-${index}`, type: "tracking_added" });
        return order;
      }));
      await stores[7].orders.update(sideId, (order) => { order.tracking = { number: "UNRELATED" }; return order; });
    } finally { release.resolve(); await settled; }
    const results = await settled;
    assert.ok(results.every((result) => result.status === "fulfilled"), "All 200 native SQL sync requests must succeed.");
    const { data: saved, payment_status, fulfillment_status } = await sqlOrder(id);
    assert.equal(saved.shopifyOrder.id, "fake-concurrent-remote"); assert.equal(saved.shopifySync.status, "synced");
    assert.equal(saved.shopifySync.claimToken, null); assert.equal(saved.shopifySync.leaseExpiresAt, null);
    assert.equal(payment_status, "confirmed"); assert.equal(fulfillment_status, "back_order");
    assert.equal(saved.paymentConfirmedAt, fixture(id).paymentConfirmedAt); assert.equal(saved.paymentConfirmedBy, "test-admin");
    assert.equal(saved.tracking.number, "TRACK"); assert.equal(saved.externalTracking.number, "EXTERNAL");
    assert.deepEqual([...saved.tracking.changes].sort((a, b) => a - b), Array.from({ length: 40 }, (_, index) => index));
    assert.equal(saved.statusEvents.filter((entry) => entry.id.startsWith("tracking-")).length, 40);
    assert.equal(saved.statusEvents.filter((entry) => entry.type === "shopify_order_created").length, 1);
    assert.equal((await sqlOrder(sideId)).data.tracking.number, "UNRELATED");
    assert.deepEqual(h.calls, { stock: 1, create: 1, find: 0 });
  });

  await check("Office shortage preserves concurrent updates and retries only the Office allocation", async () => {
    const id = "pg-sync-stock"; await orders.insert(fixture(id));
    const entered = deferred(), release = deferred(); let available = 1, first = true;
    const h = harness({ checkStock: async (order) => {
      if (first) { first = false; await assertRowUnlocked(id); entered.resolve(); await release.promise; }
      return findOfficeShortfalls(officeItems(order), [{ variantId: "office-variant", officeAvailable: available }]);
    } });
    const pending = h.syncs[0](id, actor);
    const drained = Promise.allSettled([pending]);
    try {
      await bounded(entered.promise, "Office stock check starts");
      await stores[4].orders.update(id, (order) => {
        order.tracking = { number: "STOCK-TRACK" }; order.externalTracking = { number: "STOCK-EXT" };
        order.officeStockSnapshot = { available: 1 }; order.statusEvents.push({ id: "stock-staff-event" }); return order;
      });
    } finally { release.resolve(); await drained; }
    const paused = await pending;
    assert.equal(paused.shopifySync.status, "storage_pending"); assert.equal(paused.shopifySync.dispatchedAt, null);
    assert.deepEqual(paused.shopifySync.shortfalls, [{ productTitle: "Office fixture", required: 2, officeAvailable: 1 }]);
    assert.equal(paused.tracking.number, "STOCK-TRACK"); assert.equal(paused.externalTracking.number, "STOCK-EXT");
    assert.equal(h.calls.create, 0);
    available = 2; await parallel(8, (index) => h.syncs[index](id, actor));
    const saved = (await sqlOrder(id)).data;
    assert.equal(saved.shopifySync.status, "synced"); assert.deepEqual(saved.shopifySync.shortfalls, []);
    assert.equal(saved.tracking.number, "STOCK-TRACK"); assert.equal(saved.externalTracking.number, "STOCK-EXT");
    assert.deepEqual(saved.officeStockSnapshot, { available: 1 });
    assert.ok(saved.statusEvents.some((entry) => entry.id === "stock-staff-event")); assert.equal(h.calls.create, 1);
  });

  await check("fake remote creation succeeds then loses its response; later lookup reconciles without a second create", async () => {
    const id = "pg-sync-uncertain-found"; await orders.insert(fixture(id));
    const remoteOrders = new Map();
    const h = harness({
      createRemote: async (order) => { remoteOrders.set(order.id, { id: "fake-uncertain-remote", sourceIdentifier: order.id }); throw new Error("Fake response lost after remote commit"); },
      findRemote: async (order) => copy(remoteOrders.get(order.id) || null),
    });
    const uncertain = await h.syncs[0](id, actor);
    assert.equal(uncertain.shopifySync.status, "reconciliation_required"); assert.ok(uncertain.shopifySync.dispatchedAt);
    h.advance(); await parallel(200, (index) => h.syncs[index % 8](id, actor));
    const saved = (await sqlOrder(id)).data;
    assert.equal(saved.shopifyOrder.id, "fake-uncertain-remote"); assert.equal(saved.shopifySync.status, "synced");
    assert.equal(saved.statusEvents.filter((entry) => entry.type === "shopify_order_reconciled").length, 1);
    assert.equal(h.calls.create, 1); assert.equal(h.calls.stock, 1); assert.equal(remoteOrders.size, 1);
  });

  await check("empty indexed lookup and failed lookup remain blocked across concurrent retries", async () => {
    const id = "pg-sync-uncertain-empty"; await orders.insert(fixture(id));
    const remoteOrders = new Map(); let lookupFailed = false;
    const h = harness({
      createRemote: async (order) => { remoteOrders.set(order.id, { id: "fake-not-indexed", sourceIdentifier: order.id }); throw new Error("Fake uncertain response"); },
      findRemote: async () => { if (lookupFailed) throw new Error("Fake lookup unavailable"); return null; },
    });
    await h.syncs[0](id, actor);
    for (let round = 0; round < 3; round++) {
      h.advance(); const results = await parallel(200, (index) => h.syncs[index % 8](id, actor));
      assert.ok(results.every((order) => order.shopifySync.status === "reconciliation_required"));
      assert.equal(h.calls.create, 1); assert.equal(h.calls.stock, 1);
    }
    lookupFailed = true; h.advance();
    assert.match((await h.syncs[7](id, actor)).shopifySync.message, /lookup failed/i);
    const saved = (await sqlOrder(id)).data;
    assert.equal(saved.shopifySync.status, "reconciliation_required"); assert.equal(saved.shopifyOrder, undefined);
    assert.ok(saved.shopifySync.dispatchedAt); assert.equal(saved.shopifySync.reconciliationRequired, true);
    assert.equal(remoteOrders.size, 1); assert.equal(h.calls.create, 1);
  });

  await check("expired dispatched SQL claim fences a late success until verified reconciliation", async () => {
    const id = "pg-sync-stale"; await orders.insert(fixture(id));
    const entered = deferred(), release = deferred(); let found = false;
    const remote = { id: "fake-stale-remote", sourceIdentifier: id };
    const h = harness({
      createRemote: async () => { entered.resolve(); await release.promise; return copy(remote); },
      findRemote: async () => found ? copy(remote) : null,
    });
    const pending = h.syncs[0](id, actor), drained = Promise.allSettled([pending]);
    try {
      await bounded(entered.promise, "first dispatched create pauses"); h.advance();
      assert.equal((await h.syncs[7](id, actor)).shopifySync.status, "reconciliation_required");
      await stores[6].orders.update(id, (order) => { order.tracking = { number: "LATE-TRACK" }; return order; });
    } finally { release.resolve(); await drained; }
    assert.equal((await pending).shopifySync.status, "reconciliation_required");
    assert.equal((await sqlOrder(id)).data.shopifyOrder, undefined);
    found = true; assert.equal((await h.syncs[3](id, actor)).shopifySync.status, "synced");
    assert.equal((await sqlOrder(id)).data.tracking.number, "LATE-TRACK"); assert.equal(h.calls.create, 1);
  });

  await check("native finalization constraint failure rolls back; durable dispatch reconciles without another create", async () => {
    const id = "pg-sync-db-failure"; await orders.insert(fixture(id));
    const remote = { id: "fake-db-failure-remote", sourceIdentifier: id };
    const h = harness({ createRemote: async () => copy(remote), findRemote: async () => copy(remote) });
    // Fail real PostgreSQL UPDATE, not a JS/mock SQL implementation or outbox hook.
    await pool.query("ALTER TABLE op_orders ADD CONSTRAINT op_sync_test_reject_finalization CHECK (id <> 'pg-sync-db-failure' OR COALESCE(data->'shopifySync'->>'status', '') <> 'synced')");
    try {
      await assert.rejects(h.syncs[0](id, actor), (error) => error.code === "23514");
      const durable = (await sqlOrder(id)).data;
      assert.equal(durable.shopifySync.phase, "creating"); assert.ok(durable.shopifySync.dispatchedAt);
      assert.equal(durable.shopifyOrder, undefined); assert.equal(durable.statusEvents.length, 0);
      assert.equal((await h.syncs[1](id, actor)).shopifySync.status, "syncing");
      assert.equal(h.calls.create, 1); assert.equal(h.calls.find, 0);
    } finally { await pool.query("ALTER TABLE op_orders DROP CONSTRAINT op_sync_test_reject_finalization"); }
    h.advance(); const saved = await h.syncs[7](id, actor);
    assert.equal(saved.shopifyOrder.id, remote.id); assert.equal(saved.shopifySync.status, "synced");
    assert.equal(saved.statusEvents.filter((entry) => entry.type === "shopify_order_reconciled").length, 1);
    assert.deepEqual(h.calls, { stock: 1, create: 1, find: 1 });
  });

  await check("legacy attempted errors/unknown states reconcile across eight instances without stock checks or creates", async () => {
    const legacyStates = ["error", "syncing", "unknown-legacy-state", undefined];
    for (const [index, status] of legacyStates.entries()) {
      const id = `pg-sync-legacy-uncertain-${index}`, order = fixture(id);
      order.shopifySync = { ...(status ? { status } : {}), attemptedAt: new Date(epoch - 86_400_000).toISOString(), message: "Legacy creation outcome was not recorded" };
      await orders.insert(order);
      let mode = "empty";
      const remote = { id: `fake-legacy-remote-${index}`, sourceIdentifier: id };
      const h = harness({ findRemote: async () => {
        if (mode === "failed") throw new Error("Fake legacy lookup unavailable");
        return mode === "found" ? copy(remote) : null;
      } });
      const results = await parallel(200, (request) => h.syncs[request % 8](id, actor));
      assert.ok(results.every((record) => record.shopifySync.status === "reconciliation_required"));
      assert.equal(h.calls.stock, 0); assert.equal(h.calls.create, 0);
      const uncertain = (await sqlOrder(id)).data;
      assert.equal(uncertain.shopifySync.reconciliationRequired, true);
      assert.equal(uncertain.shopifySync.dispatchedAt, null); assert.equal(uncertain.shopifyOrder, undefined);
      mode = "failed"; h.advance();
      assert.match((await h.syncs[7](id, actor)).shopifySync.message, /lookup failed/i);
      mode = "found"; h.advance();
      const saved = await h.syncs[3](id, actor);
      assert.equal(saved.shopifyOrder.id, remote.id); assert.equal(saved.shopifySync.status, "synced");
      assert.equal(saved.statusEvents.filter((entry) => entry.type === "shopify_order_reconciled").length, 1);
      assert.equal(h.calls.stock, 0); assert.equal(h.calls.create, 0);
    }
  });

  await check("legacy shortages/external outcomes and proven noncreation still create once after a fresh stock check", async () => {
    const attemptedAt = new Date(epoch - 86_400_000).toISOString();
    const safeStates = [
      { status: "storage_pending", attemptedAt },
      { status: "external", attemptedAt, syncedAt: attemptedAt },
      { status: "error", attemptedAt, noOrderCreated: true },
    ];
    for (const [index, state] of safeStates.entries()) {
      const id = `pg-sync-legacy-safe-${index}`, order = fixture(id);
      order.shopifySync = state; await orders.insert(order);
      const h = harness();
      await parallel(200, (request) => h.syncs[request % 8](id, actor));
      const saved = (await sqlOrder(id)).data;
      assert.equal(saved.shopifySync.status, "synced"); assert.equal(saved.shopifyOrder.id, `fake-remote-${id}`);
      assert.equal(saved.statusEvents.filter((entry) => entry.type === "shopify_order_created").length, 1);
      assert.deepEqual(h.calls, { stock: 1, create: 1, find: 0 });
    }
  });

  await check("indexed SQL state matches JSON and notification hooks were never used", async () => {
    const { rows: [counts] } = await pool.query(`SELECT count(*) AS total,
      count(*) FILTER (WHERE payment_status <> data->>'paymentStatus' OR fulfillment_status <> data->>'fulfillmentStatus') AS inconsistent
      FROM op_orders`);
    assert.equal(Number(counts.total), 14); assert.equal(Number(counts.inconsistent), 0);
    assert.equal(Number((await pool.query("SELECT count(*) FROM op_customer_messages")).rows[0].count), 0);
  });

  console.log(`Order sync PostgreSQL: ${checks} checks passed; eight repository/sync instances; 200 simultaneous claims; native SQL rollback; fake remote transports only.`);
} finally {
  try { if (isolated) await isolated.close(); }
  finally { globalThis.fetch = previousFetch; }
}

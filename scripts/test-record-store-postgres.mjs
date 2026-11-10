// Real, disposable loopback PostgreSQL only. No mocks, hosted URLs, or .env reads.
// Run: node scripts/test-record-store-postgres.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { startIsolatedPostgres } from "./isolated-postgres.mjs";
import { portalSchemaSql } from "../lib/database-schema.mjs";
import { createRecordStore } from "../lib/record-store.mjs";

const startedAt = performance.now();
const epoch = Date.parse("2026-01-01T00:00:00.000Z");
const stamp = new Date(epoch).toISOString();
const pad = (number) => String(number).padStart(3, "0");
const copy = (value) => structuredClone(value);
const queries = [];
const timings = [];
let checks = 0;
const environmentBefore = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:DATABASE_URL|PG[A-Z_]*|ONLINE_PORTAL_URL)$/.test(key)));
const isError = (status, code) => (error) => error.status === status && (!code || error.code === code);

function makeUser(id, extra = {}) {
  return { id, username: id, email: `${id}@example.test`, role: "customer", name: `Account ${id}`,
    passwordHash: "synthetic-test-hash", preferences: { theme: "light" }, addresses: [], createdAt: stamp, ...extra };
}

function makeOrder(id, extra = {}) {
  return { id, reference: `REF-${id}`, customer: { id: "demo-user", name: "Test Customer", email: "user@example.test" },
    items: [{ variantId: "variant-a", productTitle: "Test Product", sku: "SYNTHETIC", quantity: 3, price: 10 }],
    paymentStatus: "pending", fulfillmentStatus: "not_ready", fulfillmentReview: { status: "reviewed" },
    statusEvents: [], staffNotes: "original", savedDetails: { address: "Synthetic test address", quote: 30 },
    createdAt: stamp, updatedAt: stamp, ...extra };
}

function normalizeUser(user) {
  return { ...user, username: String(user.username).trim().toLowerCase(), email: String(user.email).trim().toLowerCase(),
    role: user.role === "admin" ? "admin" : "customer", preferences: user.preferences || { theme: "light" }, addresses: user.addresses || [] };
}

async function check(name, action) {
  const start = performance.now(), queryStart = queries.length;
  await action();
  console.log(`ok ${++checks} - ${name} (${Math.round(performance.now() - start)} ms, ${queries.length - queryStart} SQL statements)`);
}

async function simultaneous(label, items, action) {
  const start = performance.now(), samples = [];
  // Drain every operation before propagating failure so cleanup never abandons
  // outstanding writes or borrowed clients from this test's own pool.
  const settled = await Promise.allSettled(items.map(async (item, index) => {
    const begin = performance.now();
    try { return await action(item, index); }
    finally { samples.push(performance.now() - begin); }
  }));
  samples.sort((a, b) => a - b);
  timings.push({ label, operations: items.length, elapsed: Math.round(performance.now() - start),
    p50: Math.round(samples[Math.ceil(samples.length * .50) - 1]), p95: Math.round(samples[Math.ceil(samples.length * .95) - 1]), max: Math.round(samples.at(-1)) });
  const failures = settled.filter((result) => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), `${label}: ${failures.length} operations failed.`);
  return settled.map((result) => result.value);
}

// Override attempts must fail before starting a process or making a connection.
await assert.rejects(startIsolatedPostgres({ connectionString: "postgresql://127.0.0.1:5432/postgres" }), TypeError);
await assert.rejects(startIsolatedPostgres({ port: 5432 }), TypeError);

const isolated = await startIsolatedPostgres({ onQuery({ text, values }) {
  queries.push({ text: String(text).replace(/\s+/g, " ").trim(), values: copy(values || []) });
} });
const { pool } = isolated;
let seedCalls = 0;
const config = { database: async () => pool, useDatabase: () => true, normalizeUser, seedUsers: () => {
  seedCalls++;
  return [makeUser("demo-user", { username: "user", email: "user@example.test" }), makeUser("demo-admin", { username: "admin", email: "admin@example.test", role: "admin" })];
} };
const stores = Array.from({ length: 8 }, () => createRecordStore(config));
const store = stores[0];
const customerRecords = Array.from({ length: 200 }, (_, index) => makeUser(`account-${pad(index)}`));
const orderRecords = customerRecords.map((customer, index) => makeOrder(`batch-${pad(index)}`, {
  customer: { id: customer.id, name: customer.name, email: customer.email },
  createdAt: new Date(epoch + index * 1000).toISOString(),
}));
let currentAdmin = "demo-admin";

try {
  await check("harness verifies this temporary loopback cluster and never uses default PostgreSQL settings", async () => {
    assert.equal(pool.options.host, "127.0.0.1");
    assert.notEqual(pool.options.port, 5432);
    const { rows: [identity] } = await pool.query("SELECT current_setting('data_directory') AS directory, host(inet_server_addr()) AS host, inet_server_port() AS port");
    assert.equal(path.resolve(identity.directory).toLowerCase(), path.resolve(isolated.directory).toLowerCase());
    assert.equal(identity.host, "127.0.0.1");
    assert.equal(identity.port, pool.options.port);
    assert(queries.some(({ text }) => text.includes("current_user AS username")), "The harness identity guard ran before test writes.");
    assert.deepEqual(Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:DATABASE_URL|PG[A-Z_]*|ONLINE_PORTAL_URL)$/.test(key))), environmentBefore);
    await pool.query(portalSchemaSql);
  });

  await check("200 concurrent distinct accounts survive across eight store instances with one bootstrap", async () => {
    const inserted = await simultaneous("200 distinct user inserts", customerRecords, (user, index) => stores[index % stores.length].users.insert(user));
    assert.equal(new Set(inserted.map((user) => user.id)).size, 200);
    assert.equal(seedCalls, 1);
    assert.equal(queries.filter(({ text }) => text === "SELECT id FROM op_users LIMIT 1").length, 1);
    assert.deepEqual(await store.users.counts(), { all: 202, admin: 1, customer: 201 });
    assert.equal((await store.users.list()).length, 200);
    const pages = [];
    for (let offset = 0; offset < 202; offset += 37) pages.push(...await stores[offset % stores.length].users.list({ limit: 37, offset }));
    assert.equal(pages.length, 202);
    assert.equal(new Set(pages.map((user) => user.id)).size, 202);
    assert.deepEqual(new Set(pages.map((user) => user.id)), new Set(["demo-admin", "demo-user", ...customerRecords.map((user) => user.id)]));
    assert.deepEqual(await store.users.list({ role: "admin" }), [normalizeUser(makeUser("demo-admin", { username: "admin", email: "admin@example.test", role: "admin" }))]);
  });

  await check("200 concurrent orders survive and 200 independent updates preserve unrelated fields", async () => {
    const inserted = await simultaneous("200 distinct order inserts", orderRecords, (order, index) => stores[index % stores.length].orders.insert(order));
    assert(inserted.every((entry) => entry.created));
    assert.equal(await store.orders.count(), 200);
    await simultaneous("200 updates to different orders", orderRecords, (order, index) => stores[index % stores.length].orders.update(order.id, async (current) => {
      await Promise.resolve();
      return { ...current, paymentStatus: "confirmed", staffNotes: `updated-${index}` };
    }));
    const updated = new Map((await store.orders.list({ ids: orderRecords.map((order) => order.id), limit: 500 })).map((order) => [order.id, order]));
    assert.equal(updated.size, 200);
    for (const [index, original] of orderRecords.entries()) assert.deepEqual(updated.get(original.id), { ...original, paymentStatus: "confirmed", staffNotes: `updated-${index}` });
  });

  await check("100 simultaneous updates to one row append every event without stale snapshots", async () => {
    await simultaneous("100 event appends to one order", Array.from({ length: 100 }, (_, index) => index), (index) => stores[index % stores.length].orders.update("batch-000", async (order) => {
      await Promise.resolve();
      order.statusEvents.push({ id: `event-${index}`, at: stamp, type: "test_append" });
      return order;
    }));
    const order = await store.orders.get("batch-000");
    assert.equal(order.statusEvents.length, 100);
    assert.deepEqual(new Set(order.statusEvents.map((event) => event.id)), new Set(Array.from({ length: 100 }, (_, index) => `event-${index}`)));
    assert.equal(order.paymentStatus, "confirmed");
    assert.equal(order.staffNotes, "updated-0");
    assert.deepEqual(order.savedDetails, orderRecords[0].savedDetails);
    assert.deepEqual(order.items, orderRecords[0].items);
  });

  await check("200 simultaneous same-key submissions create exactly one order and durable ledger row", async () => {
    const before = await store.orders.count();
    const outcomes = await simultaneous("200 same-key submission attempts", Array.from({ length: 200 }, (_, index) => index), (index) => stores[index % stores.length].orders.insert(makeOrder(`submission-${pad(index)}`, { idempotencyKey: "same-key" }), { requestHash: "same-request-hash" }));
    assert.equal(outcomes.filter((result) => result.created).length, 1);
    const winner = outcomes.find((result) => result.created).order;
    assert(outcomes.every((result) => result.order.id === winner.id));
    assert.equal(await store.orders.count(), before + 1);
    const { rows } = await pool.query("SELECT customer_id, request_key, request_hash, order_id FROM op_order_submissions WHERE customer_id=$1 AND request_key=$2", ["demo-user", "same-key"]);
    assert.deepEqual(rows, [{ customer_id: "demo-user", request_key: "same-key", request_hash: "same-request-hash", order_id: winner.id }]);
    assert.equal((await store.orders.findSubmission("demo-user", "same-key", "same-request-hash")).id, winner.id);
    await assert.rejects(store.orders.insert(makeOrder("changed-hash", { idempotencyKey: "same-key" }), { requestHash: "different-request-hash" }), isError(409, "ORDER_IDEMPOTENCY_CONFLICT"));
    await assert.rejects(store.orders.findSubmission("demo-user", "same-key", "different-request-hash"), isError(409, "ORDER_IDEMPOTENCY_CONFLICT"));
    assert.equal(await store.orders.get("changed-hash"), null);
    assert.equal(await store.orders.count(), before + 1);
  });

  await check("reference conflicts roll back inserts, submissions, and updates without poisoning retries", async () => {
    const original = await store.orders.get("batch-001");
    const before = await pool.query("SELECT data, updated_at FROM op_orders WHERE id=$1", [original.id]);
    await assert.rejects(store.orders.insert(makeOrder("reference-conflict", { reference: original.reference, idempotencyKey: "reference-key" }), { requestHash: "reference-hash" }), isError(409, "ORDER_REFERENCE_CONFLICT"));
    assert.equal(await store.orders.get("reference-conflict"), null);
    assert.equal((await pool.query("SELECT count(*)::integer AS count FROM op_order_submissions WHERE customer_id=$1 AND request_key=$2", ["demo-user", "reference-key"])).rows[0].count, 0);
    await assert.rejects(store.orders.update(original.id, (order) => ({ ...order, reference: "REF-batch-002", staffNotes: "must roll back" })), isError(409, "ORDER_REFERENCE_CONFLICT"));
    assert.deepEqual((await pool.query("SELECT data, updated_at FROM op_orders WHERE id=$1", [original.id])).rows, before.rows);
    const retry = await store.orders.insert(makeOrder("reference-conflict", { idempotencyKey: "reference-key" }), { requestHash: "reference-hash" });
    assert.equal(retry.created, true);
    await assert.rejects(store.orders.insert(makeOrder("reference-conflict", { reference: "unused-reference" })), isError(409, "ORDER_ID_CONFLICT"));
  });

  await check("normalized username/email and cross-namespace uniqueness hold under races", async () => {
    const owner = await store.users.insert(makeUser("namespace-owner", { username: " Owner ", email: " OWNER@EXAMPLE.TEST " }));
    assert.equal(owner.username, "owner");
    assert.equal(owner.email, "owner@example.test");
    for (const [id, fields] of [["duplicate-name", { username: "OWNER" }], ["duplicate-email", { email: "Owner@Example.Test" }], ["username-email", { username: owner.email }], ["email-username", { email: owner.username }]]) {
      await assert.rejects(store.users.insert(makeUser(id, fields)), isError(409));
      assert.equal(await store.users.get(id), null);
    }
    const raced = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => stores[index % stores.length].users.insert(makeUser(`raced-${index}`, { username: "same-name", email: "same-email@example.test" }))));
    assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
    assert(raced.filter((result) => result.status === "rejected").every((result) => result.reason.status === 409));
    await assert.rejects(store.users.update("account-000", (user) => ({ ...user, username: owner.email })), isError(409));
    assert.equal((await store.users.get("account-000")).username, "account-000");
  });

  await check("deleted users stay deleted when a stale update arrives", async () => {
    const stale = await store.users.insert(makeUser("deleted-customer"));
    assert.equal((await stores[1].users.remove(stale.id, { actorId: currentAdmin })).id, stale.id);
    let transforms = 0;
    assert.equal(await stores[2].users.update(stale.id, () => { transforms++; return stale; }), null);
    assert.equal(transforms, 0);
    await stores[3].users.update("account-000", (user) => ({ ...user, name: "Unrelated update" }));
    assert.equal(await store.users.get(stale.id), null);
    assert.equal((await pool.query("SELECT count(*)::integer AS count FROM op_users WHERE id=$1", [stale.id])).rows[0].count, 0);
    assert.equal(seedCalls, 1);
  });

  await check("current admin membership, self-removal, last-admin and concurrent role guards hold", async () => {
    await assert.rejects(store.users.remove(currentAdmin, { actorId: currentAdmin }), isError(409));
    await assert.rejects(store.users.update(currentAdmin, (user) => ({ ...user, role: "customer" })), isError(409));
    await store.users.insert(makeUser("second-admin", { role: "admin" }));
    const removals = await Promise.allSettled([stores[0].users.remove("second-admin", { actorId: currentAdmin }), stores[1].users.remove(currentAdmin, { actorId: "second-admin" })]);
    assert.equal(removals.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(removals.find((result) => result.status === "rejected").reason.status, 401);
    let admins = await store.users.list({ role: "admin" });
    assert.equal(admins.length, 1);
    currentAdmin = admins[0].id;
    await store.users.insert(makeUser("demotion-admin", { role: "admin" }));
    const adminBeforeDemotion = currentAdmin;
    const demotions = await Promise.allSettled([stores[2].users.update(currentAdmin, (user) => ({ ...user, role: "customer" })), stores[3].users.update("demotion-admin", (user) => ({ ...user, role: "customer" }))]);
    assert.equal(demotions.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(demotions.find((result) => result.status === "rejected").reason.status, 409);
    admins = await store.users.list({ role: "admin" });
    assert.equal(admins.length, 1);
    currentAdmin = admins[0].id;
    const revoked = demotions[0].status === "fulfilled" ? adminBeforeDemotion : "demotion-admin";
    assert.equal((await store.users.get(revoked)).role, "customer");
    await assert.rejects(store.users.remove("account-001", { actorId: revoked }), isError(401));
    assert.notEqual(await store.users.get("account-001"), null);
    assert.equal((await store.users.counts()).admin, 1);
    assert.equal(seedCalls, 1);
  });

  await check("outbox hooks atomically commit and roll back orders, submission ledgers and message markers", async () => {
    let failHook = false;
    const calls = [];
    const hooked = createRecordStore({ ...config, onOrderWrite: async (client, next, previous) => {
      assert.equal(typeof client?.query, "function");
      calls.push({ next: copy(next), previous: copy(previous) });
      const inside = await client.query("SELECT data FROM op_orders WHERE id=$1", [next.id]);
      assert.deepEqual(inside.rows[0].data, next, "The hook sees the newly written order in its transaction.");
      const outside = await pool.query("SELECT data FROM op_orders WHERE id=$1", [next.id]);
      assert.deepEqual(outside.rows[0]?.data || null, previous, "Other connections still see the previous committed value.");
      await client.query("INSERT INTO op_customer_messages (id,kind,customer_id,order_id,status,data) VALUES ($1,'email',$2,$3,'pending',$4::jsonb)",
        [`outbox:${next.id}:${next.revision || 0}`, next.customer.id, next.id, JSON.stringify({ synthetic: true, revision: next.revision || 0, paymentStatus: next.paymentStatus })]);
      if (failHook) throw new Error("Intentional outbox hook failure after marker insert");
      next.staffNotes = "A hook receives detached copies";
      if (previous) previous.staffNotes = "A previous copy is detached too";
    } });
    const first = makeOrder("hook-order", { revision: 0, idempotencyKey: "hook-key" });
    assert.equal((await hooked.orders.insert(first, { requestHash: "hook-hash" })).created, true);
    assert.deepEqual(calls[0].previous, null);
    assert.deepEqual(await store.orders.get(first.id), first);
    const updated = await hooked.orders.update(first.id, (order) => ({ ...order, revision: 1, paymentStatus: "confirmed" }));
    assert.deepEqual(calls[1].previous, first);
    assert.equal(updated.staffNotes, "original");
    assert.equal((await pool.query("SELECT count(*)::integer AS count FROM op_customer_messages WHERE order_id=$1", [first.id])).rows[0].count, 2);

    failHook = true;
    const before = (await pool.query("SELECT data, updated_at FROM op_orders WHERE id=$1", [first.id])).rows;
    const failureStart = queries.length;
    await assert.rejects(hooked.orders.update(first.id, (order) => ({ ...order, revision: 2, paymentStatus: "rejected" })), /Intentional outbox hook failure/);
    assert.deepEqual((await pool.query("SELECT data, updated_at FROM op_orders WHERE id=$1", [first.id])).rows, before);
    assert.equal((await pool.query("SELECT count(*)::integer AS count FROM op_customer_messages WHERE id=$1", ["outbox:hook-order:2"])).rows[0].count, 0);
    const doomed = makeOrder("hook-doomed", { idempotencyKey: "hook-doomed-key" });
    await assert.rejects(hooked.orders.insert(doomed, { requestHash: "doomed-hash" }), /Intentional outbox hook failure/);
    assert.equal(await store.orders.get(doomed.id), null);
    assert.equal((await pool.query("SELECT count(*)::integer AS count FROM op_customer_messages WHERE order_id=$1", [doomed.id])).rows[0].count, 0);
    assert.equal((await pool.query("SELECT count(*)::integer AS count FROM op_order_submissions WHERE customer_id=$1 AND request_key=$2", ["demo-user", "hook-doomed-key"])).rows[0].count, 0);
    assert.equal(queries.slice(failureStart).filter(({ text }) => text === "ROLLBACK").length, 2);
    failHook = false;
    assert.equal((await hooked.orders.insert(doomed, { requestHash: "doomed-hash" })).created, true);

    const callCount = calls.length, noopStart = queries.length;
    assert.deepEqual(await hooked.orders.update(first.id, (order) => { order.staffNotes = "discarded"; return null; }), updated);
    assert.deepEqual(await hooked.orders.update(first.id, (order) => order), updated);
    assert.equal((await hooked.orders.insert(makeOrder("hook-retry", { idempotencyKey: "hook-key" }), { requestHash: "hook-hash" })).created, false);
    assert.equal(await hooked.orders.update("missing-hook-row", () => { throw new Error("Must not transform a missing row."); }), null);
    assert.equal(calls.length, callCount);
    assert(!queries.slice(noopStart).some(({ text }) => /^(?:INSERT|UPDATE|DELETE)\b/.test(text)), "Noops, duplicates and missing rows issue no writes.");
    assert.deepEqual((await pool.query("SELECT data, updated_at FROM op_orders WHERE id=$1", [first.id])).rows, before);
  });

  await check("paginated admin views, filters, literal search, active receipts and Shark scopes agree with counts", async () => {
    const customer = { id: "view-customer", name: "View Fixture", email: "view@example.test" };
    const paid = { paymentStatus: "confirmed" };
    const split = [{ variantId: "variant-a", officeQuantity: 2, externalQuantity: 1 }];
    const external = [{ variantId: "variant-a", officeQuantity: 0, externalQuantity: 3 }];
    const specs = [
      ["review", { fulfillmentReview: { status: "pending" } }],
      ["ready", { ...paid, fulfillmentAllocations: split, shopifyOrder: { id: "remote-ready" } }],
      ["unsynced", paid],
      ["external", { ...paid, fulfillmentAllocations: external }],
      ["shipped", { ...paid, fulfillmentStatus: "shipped", shopifyOrder: { id: "remote-shipped" } }],
      ["office-shipped", { ...paid, officeShippedAt: stamp }],
      ["declined", { specialOrder: { status: "declined" } }],
      ["verify", { paymentIssue: { type: "paid_pending" } }],
      ["special", { specialOrder: { status: "pending" } }],
      ["support", { paymentIssue: { type: "other", status: "open" } }],
      ["linked", { paymentLink: { reference: "test-link", url: "https://example.test/synthetic" } }],
      ["received", { ...paid, fulfillmentStatus: "shipped", shopifyOrder: { id: "remote-received" } }],
      ["literal", { reference: "VIEW-50%_\\-exact", customer: { ...customer, name: "Needle Person" }, items: [{ variantId: "variant-a", productTitle: "Cobalt Widget", sku: "literal", quantity: 3, price: 10 }] }],
      ["wildcard", { reference: "VIEW-500X-other" }],
    ];
    const fixtures = specs.map(([name, extra], index) => makeOrder(`view-${name}`, { customer, createdAt: new Date(epoch + 1_000_000 + index * 1000).toISOString(), ...extra }));
    await simultaneous("14 query/view fixtures", fixtures, (order, index) => stores[index % stores.length].orders.insert(order));
    await pool.query("INSERT INTO op_customer_messages (id,kind,customer_id,order_id,status,data) VALUES ($1,'delivery_receipt',$2,$3,'received',$4::jsonb)", ["receipt:view-received", customer.id, "view-received", JSON.stringify({ receivedAt: stamp })]);
    const scope = { customerId: customer.id, ids: fixtures.map((order) => order.id) };
    const expectedCases = [
      [{ view: "pending" }, ["review", "verify", "special", "support", "linked", "literal", "wildcard"]],
      [{ view: "ready" }, ["ready", "unsynced"]],
      [{ view: "external" }, ["ready", "external"]],
      [{ view: "completed" }, ["shipped", "declined", "received"]],
      [{ filter: "needs_payment_details" }, ["ready", "unsynced", "external", "shipped", "office-shipped", "verify", "support", "received", "literal", "wildcard"]],
      [{ filter: "payment_to_verify" }, ["verify"]],
      [{ filter: "special_review" }, ["special"]],
      [{ filter: "fulfillment_review" }, ["review", "declined"]],
      [{ filter: "support" }, ["support"]],
      [{ search: "50%_" }, ["literal"]],
      [{ search: "50%Z" }, []],
      [{ search: "\\" }, ["literal"]],
      [{ search: "needle person" }, ["literal"]],
      [{ search: "COBALT WIDGET" }, ["literal"]],
      [{ active: true }, ["review", "ready", "unsynced", "external", "shipped", "office-shipped", "verify", "special", "support", "linked", "literal", "wildcard"]],
      [{ internal: "confirmed" }, ["ready", "unsynced"]],
      [{ internal: "confirmed", shopifySyncRequired: true }, ["ready"]],
      [{ internal: "history" }, ["shipped", "office-shipped", "received"]],
      [{ internal: "history", shopifySyncRequired: true }, ["shipped", "received"]],
      [{ view: "ready", filter: "needs_payment_details", search: "remote-ready" }, ["ready"]],
    ];
    for (const [options, names] of expectedCases) {
      const expected = fixtures.filter((order) => names.includes(order.id.slice(5))).reverse().map((order) => order.id);
      const actual = [];
      for (let offset = 0; offset <= fixtures.length; offset += 2) {
        const batch = await store.orders.list({ ...scope, ...options, limit: 2, offset });
        actual.push(...batch.map((order) => order.id));
        if (batch.length < 2) break;
      }
      assert.deepEqual(actual, expected, JSON.stringify(options));
      assert.equal(await store.orders.count({ ...scope, ...options }), expected.length, JSON.stringify(options));
      assert.equal(new Set(actual).size, actual.length);
    }
    assert.equal((await store.orders.list()).length, 200);
    const queryStart = queries.length;
    await store.orders.list({ limit: 5000 });
    assert.deepEqual(queries.at(-1).values, [501, 0]);
    assert.equal(queries.length - queryStart, 1);
    assert.deepEqual(await store.orders.list({ ids: [] }), []);
    assert.equal(await store.orders.count({ ids: [] }), 0);
  });

  await check("targeted auth/order reads stay targeted and never repeat bootstrap or load snapshots", async () => {
    const start = queries.length;
    await simultaneous("200 targeted reads", Array.from({ length: 200 }, (_, index) => index), async (index) => {
      const records = stores[index % stores.length], user = customerRecords[index];
      if (index % 4 === 0) assert.equal((await records.users.get(user.id)).id, user.id);
      if (index % 4 === 1) assert.equal((await records.users.findLogin(user.email.toUpperCase(), { role: "customer" })).id, user.id);
      if (index % 4 === 2) assert.equal((await records.orders.get(orderRecords[index].id, { customerId: user.id })).id, orderRecords[index].id);
      if (index % 4 === 3) assert.equal(await records.orders.get(orderRecords[index].id, { customerId: "someone-else" }), null);
    });
    const observed = queries.slice(start).filter(({ text }) => !text.includes("current_setting('data_directory')"));
    assert.equal(observed.length, 200);
    assert(observed.every(({ text }) => /^SELECT data FROM op_(?:users|orders) WHERE /.test(text)));
    assert(!observed.some(({ text }) => /advisory|COUNT\(|FOR UPDATE|ORDER BY|SELECT id FROM op_users LIMIT/i.test(text)));
    assert(observed.filter(({ text }) => text.includes("FROM op_users")).every(({ text }) => /WHERE id = \$1$|WHERE \(username = \$1 OR email = \$1\) AND role = \$2 LIMIT 2$/.test(text)));
    assert(observed.filter(({ text }) => text.includes("FROM op_orders")).every(({ text }) => /WHERE id = \$1 AND customer_id = \$2$/.test(text)));
    const batchStart = queries.length;
    assert.equal((await store.orders.list({ ids: orderRecords.slice(0, 50).map((order) => order.id), limit: 50 })).length, 50);
    assert.equal(queries.length - batchStart, 1);
    assert.match(queries.at(-1).text, /id = ANY\(\$1::text\[\]\)/);
    const countStart = queries.length;
    await store.users.counts();
    await store.orders.count({ paymentStatus: "confirmed" });
    assert(queries.slice(countStart).every(({ text }) => /^SELECT count\(\*\)/.test(text)), "Health counts do not load JSON records.");
  });

  console.log(`Real PostgreSQL record-store checks passed (${checks}); 8 store instances, pool max ${pool.options.max}.`);
  for (const timing of timings) console.log(`${timing.label}: ${timing.operations} operations, batch ${timing.elapsed} ms, latency p50/p95/max ${timing.p50}/${timing.p95}/${timing.max} ms.`);
  console.log(`Elapsed before cleanup: ${Math.round(performance.now() - startedAt)} ms. Latencies include local pool/lock waiting; these representative local checks do not measure hosted capacity.`);
} finally {
  await isolated.close();
}

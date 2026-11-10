// Self-contained local and injected-SQL checks. No server, credentials, or services.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scryptSync } from "node:crypto";
import { createRecordStore } from "../lib/record-store.mjs";

const stamp = "2026-01-01T00:00:00.000Z";
const passwordHash = (password) => `test-salt:${scryptSync(password, "test-salt", 64).toString("hex")}`;
const makeUser = (id, extra = {}) => ({ id, username: id, email: `${id}@example.test`, role: "customer", name: id, createdAt: stamp, ...extra });
const demoSeeds = () => [makeUser("demo-user", { username: "user", passwordHash: passwordHash("user") }), makeUser("demo-admin", { username: "admin", role: "admin", passwordHash: passwordHash("admin") })];
const makeOrder = (id, extra = {}) => ({ id, reference: `REF-${id}`, customer: { id: "demo-user" }, paymentStatus: "pending", fulfillmentStatus: "not_ready", createdAt: stamp, updatedAt: stamp, ...extra });
const status = (expected, code) => (error) => error.status === expected && (!code || error.code === code);
const noopDatabase = () => { throw new Error("Local storage must not access SQL."); };
const directory = await mkdtemp(path.join(tmpdir(), "op-record-store-"));
let checked = 0;

function fixture(name, options = {}) {
  const usersPath = path.join(directory, `${name}-users.json`);
  const ordersPath = path.join(directory, `${name}-orders.json`);
  const config = { database: noopDatabase, useDatabase: () => false, usersPath, ordersPath, seedUsers: demoSeeds, ...options };
  return { usersPath, ordersPath, config, ...createRecordStore(config) };
}

async function check(name, action) {
  await action();
  checked++;
  console.log(`ok ${checked} - ${name}`);
}

async function localChecks() {
  await check("concurrent local bootstrap is shared and legacy user/admin passwords survive", async () => {
    let calls = 0;
    const store = fixture("bootstrap", { seedUsers: async () => { calls++; await Promise.resolve(); return demoSeeds(); } });
    const sibling = createRecordStore(store.config);
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? store : sibling).users.findLogin(" USER ")));
    assert.equal(calls, 1);
    assert(results.every((user) => user.id === "demo-user"));
    assert.equal(results[0].passwordHash, passwordHash("user"));
    const admin = await store.users.findLogin("ADMIN", { role: "admin" });
    assert.equal(admin.passwordHash, passwordHash("admin"));
    assert.equal(await store.users.findLogin("admin", { role: "customer" }), null);
    assert.equal(await store.users.get("missing"), null);
    assert.deepEqual((await store.users.list({ role: "admin" })).map((entry) => entry.id), ["demo-admin"]);
    assert.deepEqual((await store.users.list()).map((entry) => entry.role), ["admin", "customer"]);
  });

  await check("existing customer-only files are preserved and never seed a missing admin", async () => {
    const store = fixture("existing", { seedUsers: () => { throw new Error("Must not seed existing users."); } });
    const payload = { version: 1, updatedAt: "untouched", custom: "keep", users: [makeUser("existing", { preferences: { theme: "dark" }, addresses: [{ id: "address" }] })] };
    const original = JSON.stringify(payload);
    await writeFile(store.usersPath, original);
    assert.equal((await store.users.findLogin("existing@example.test")).id, "existing");
    assert.equal(await readFile(store.usersPath, "utf8"), original);
    await store.users.update("existing", (user) => ({ ...user, name: "Preserved" }));
    const saved = JSON.parse(await readFile(store.usersPath, "utf8"));
    assert.equal(saved.custom, "keep");
    assert.deepEqual(saved.users[0].addresses, payload.users[0].addresses);
    assert.equal(saved.users.length, 1);
    assert.equal((await store.users.list({ role: "admin" })).length, 0);
  });

  await check("bootstrap retries after failure and malformed files are not overwritten", async () => {
    let attempts = 0;
    const store = fixture("retry-bootstrap", { seedUsers: () => { if (++attempts === 1) throw new Error("bootstrap failed"); return demoSeeds(); } });
    await assert.rejects(store.users.get("demo-admin"), /bootstrap failed/);
    assert.equal((await store.users.get("demo-admin")).role, "admin");
    assert.equal(attempts, 2);
    const corrupt = fixture("corrupt");
    await writeFile(corrupt.usersPath, '{"users":"broken"}');
    await assert.rejects(corrupt.users.get("demo-admin"), /Invalid users store/);
    assert.equal(await readFile(corrupt.usersPath, "utf8"), '{"users":"broken"}');
    await writeFile(corrupt.usersPath, JSON.stringify({ users: [makeUser("repaired")] }));
    assert.equal((await corrupt.users.get("repaired")).id, "repaired");
  });

  await check("local inserts normalize identities, reject cross-namespace collisions, and serialize", async () => {
    const store = fixture("uniques", { normalizeUser: (user) => ({ ...user, normalized: true }) });
    const sibling = createRecordStore(store.config);
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => (i % 2 ? store : sibling).users.insert(makeUser(`race-${i}`, { username: " RACE ", email: ` RACE${i}@EXAMPLE.TEST ` }))));
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    assert(outcomes.filter((result) => result.status === "rejected").every((result) => result.reason.status === 409 && result.reason.message === "User already exists."));
    const race = await store.users.findLogin("rAcE");
    assert.equal(race.username, "race");
    assert.equal(race.normalized, true);
    await assert.rejects(store.users.insert(makeUser("duplicate-email", { email: race.email.toUpperCase() })), status(409));
    await assert.rejects(store.users.insert(makeUser("email-as-name", { username: race.email })), status(409));
    await assert.rejects(store.users.insert(makeUser("name-as-email", { email: race.username })), status(409));
    await assert.rejects(store.users.insert(makeUser(race.id, { username: "different", email: "different@example.test" })), status(409));
    const before = await readFile(store.usersPath, "utf8");
    await assert.rejects(store.users.update(race.id, (user) => ({ ...user, username: "admin" })), status(409));
    assert.equal(await readFile(store.usersPath, "utf8"), before);
    race.name = "A detached result";
    assert.notEqual((await store.users.get(race.id)).name, race.name);
  });

  await check("async local user transforms see current records and noop/error writes do not leak", async () => {
    const store = fixture("user-update");
    await store.users.insert(makeUser("counter", { count: 0 }));
    const sibling = createRecordStore(store.config);
    await Promise.all(Array.from({ length: 32 }, (_, i) => (i % 2 ? store : sibling).users.update("counter", async (user) => { await Promise.resolve(); user.count++; return user; })));
    assert.equal((await store.users.get("counter")).count, 32);
    assert.equal((await store.users.get("demo-admin")).username, "admin");
    const before = await readFile(store.usersPath, "utf8");
    assert.equal((await store.users.update("counter", (user) => { user.count = 999; return null; })).count, 32);
    assert.equal((await store.users.update("counter", (user) => user)).count, 32);
    assert.equal(await store.users.update("absent", () => { throw new Error("not called"); }), null);
    await assert.rejects(store.users.update("counter", async (user) => { user.count = 888; throw new Error("transform failed"); }), /transform failed/);
    await assert.rejects(store.users.update("counter", (user) => ({ ...user, id: "changed" })), status(400));
    assert.equal(await readFile(store.usersPath, "utf8"), before);
    assert.equal((await store.users.update("counter", (user) => ({ ...user, count: user.count + 1 }))).count, 33);
  });

  await check("removal rechecks current admin, blocks self-removal, and cannot resurrect stale users", async () => {
    const store = fixture("removal");
    await store.users.insert(makeUser("other-admin", { role: "admin" }));
    const stale = await store.users.get("demo-user");
    await assert.rejects(store.users.remove("demo-user"), status(401));
    await assert.rejects(store.users.remove("demo-user", { actorId: "demo-user" }), status(401));
    await assert.rejects(store.users.remove("demo-admin", { actorId: "demo-admin" }), status(409));
    assert.equal((await store.users.remove("demo-user", { actorId: "demo-admin" })).id, stale.id);
    assert.equal(await store.users.update(stale.id, () => stale), null);
    await store.users.update("other-admin", (user) => ({ ...user, role: "customer" }));
    await assert.rejects(store.users.remove("other-admin", { actorId: "other-admin" }), status(401));
    assert.equal(await store.users.remove("absent", { actorId: "demo-admin" }), null);
    await store.users.insert(makeUser("new-customer"));
    assert.equal(await store.users.get(stale.id), null);
    await assert.rejects(store.users.update("demo-admin", (user) => ({ ...user, role: "customer" })), status(409));
  });

  await check("competing admin deletions and demotions leave one admin", async () => {
    for (const mutation of ["delete", "demote"]) {
      const store = fixture(`membership-${mutation}`);
      await store.users.insert(makeUser("other-admin", { role: "admin" }));
      const sibling = createRecordStore(store.config);
      const outcomes = await Promise.allSettled(mutation === "delete" ? [store.users.remove("other-admin", { actorId: "demo-admin" }), sibling.users.remove("demo-admin", { actorId: "other-admin" })] : [store.users.update("demo-admin", (user) => ({ ...user, role: "customer" })), sibling.users.update("other-admin", (user) => ({ ...user, role: "customer" }))]);
      assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal((await store.users.list({ role: "admin" })).length, 1);
      assert.equal(outcomes.find((result) => result.status === "rejected").reason.status, mutation === "delete" ? 401 : 409);
    }
  });

  await check("local orders enforce ID/reference uniqueness and scoped reads", async () => {
    const store = fixture("orders");
    assert.equal((await store.orders.insert(makeOrder("one"))).created, true);
    await store.orders.insert(makeOrder("two"));
    await assert.rejects(store.orders.insert(makeOrder("one", { reference: "other-reference" })), status(409, "ORDER_ID_CONFLICT"));
    await assert.rejects(store.orders.insert(makeOrder("three", { reference: "REF-one" })), status(409, "ORDER_REFERENCE_CONFLICT"));
    await assert.rejects(store.orders.update("two", (order) => ({ ...order, reference: "REF-one" })), status(409, "ORDER_REFERENCE_CONFLICT"));
    assert.equal(await store.orders.get("one", { customerId: "different" }), null);
    assert.equal((await store.orders.get("one", { customerId: "demo-user" })).id, "one");
    assert.equal(await store.orders.get("absent"), null);
    assert.deepEqual(await store.orders.list({ ids: [] }), []);
    assert.deepEqual((await store.orders.list({ ids: ["one", "one", "absent"] })).map((order) => order.id), ["one"]);
  });

  await check("concurrent order submissions are durable, customer-scoped, and hash-checked", async () => {
    const store = fixture("submissions");
    const sibling = createRecordStore(store.config);
    const outcomes = await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? store : sibling).orders.insert(makeOrder(`retry-${i}`, { idempotencyKey: "same-key" }), { requestHash: "hash-one" })));
    assert.equal(outcomes.filter((result) => result.created).length, 1);
    const id = outcomes[0].order.id;
    assert(outcomes.every((result) => result.order.id === id));
    assert.equal((await store.orders.findSubmission("demo-user", "same-key", "hash-one")).id, id);
    assert.equal(await store.orders.findSubmission("other-customer", "same-key", "hash-one"), null);
    await assert.rejects(store.orders.findSubmission("demo-user", "same-key", "hash-two"), status(409, "ORDER_IDEMPOTENCY_CONFLICT"));
    await assert.rejects(store.orders.insert(makeOrder("mismatch", { idempotencyKey: "same-key" }), { requestHash: "hash-two" }), status(409, "ORDER_IDEMPOTENCY_CONFLICT"));
    assert.equal((await store.orders.insert(makeOrder("other-customer-order", { customer: { id: "other-customer" }, idempotencyKey: "same-key" }), { requestHash: "hash-two" })).created, true);
    await store.orders.update(id, (order) => { delete order.idempotencyKey; return { ...order, paymentStatus: "confirmed" }; });
    const restarted = createRecordStore(store.config);
    const retry = await restarted.orders.insert(makeOrder("after-restart", { idempotencyKey: "same-key" }), { requestHash: "hash-one" });
    assert.equal(retry.created, false);
    assert.equal(retry.order.paymentStatus, "confirmed");
    assert.equal((await restarted.orders.list()).length, 2);
    const saved = JSON.parse(await readFile(store.ordersPath, "utf8"));
    assert.equal(saved.version, 1);
    assert.equal(saved.submissions.length, 2);
  });

  await check("legacy submissions bind a ledger without changing the old order", async () => {
    const store = fixture("legacy-submission");
    const old = makeOrder("legacy", { idempotencyKey: "old-key", oldField: "preserved" });
    await writeFile(store.ordersPath, JSON.stringify({ version: 1, custom: "keep", orders: [old] }));
    assert.equal((await store.orders.findSubmission("demo-user", "old-key", "bound-hash")).id, "legacy");
    const saved = JSON.parse(await readFile(store.ordersPath, "utf8"));
    assert.deepEqual(saved.orders, [old]);
    assert.equal(saved.custom, "keep");
    assert.equal(saved.submissions[0].requestHash, "bound-hash");
    await assert.rejects(store.orders.findSubmission("demo-user", "old-key", "changed"), status(409));
    saved.orders = [];
    await writeFile(store.ordersPath, JSON.stringify(saved));
    await assert.rejects(store.orders.insert(makeOrder("replacement", { idempotencyKey: "old-key" }), { requestHash: "bound-hash" }), status(409, "ORDER_SUBMISSION_MISSING"));
  });

  await check("local order updates initialize missing events, preserve concurrent changes, and isolate queues", async () => {
    const store = fixture("order-update");
    await store.orders.insert(makeOrder("counter", { count: 0 }));
    await store.orders.insert(makeOrder("untouched", { statusEvents: [{ type: "original" }] }));
    const sibling = createRecordStore(store.config);
    await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? store : sibling).orders.update("counter", async (order) => { await Promise.resolve(); order.statusEvents.push({ type: `event-${i}` }); order.count++; return order; })));
    const counter = await store.orders.get("counter");
    assert.equal(counter.count, 24);
    assert.equal(counter.statusEvents.length, 24);
    assert.equal(counter.updatedAt, stamp);
    assert.deepEqual((await store.orders.get("untouched")).statusEvents, [{ type: "original" }]);
    const before = await readFile(store.ordersPath, "utf8");
    assert.equal((await store.orders.update("counter", (order) => { order.statusEvents.push({ type: "discard" }); return null; })).count, 24);
    assert.equal((await store.orders.update("counter", (order) => order)).count, 24);
    await assert.rejects(store.orders.update("counter", () => { throw new Error("order failed"); }), /order failed/);
    await assert.rejects(store.orders.update("counter", (order) => ({ ...order, id: "different" })), status(400));
    assert.equal(await store.orders.update("absent", () => { throw new Error("not called"); }), null);
    assert.equal(await readFile(store.ordersPath, "utf8"), before);
    let release, entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const held = store.orders.update("counter", async (order) => { entered(); await gate; return order; });
    await started;
    try { assert.equal((await store.users.get("demo-admin")).role, "admin"); }
    finally { release(); await held; }
    assert((await readdir(directory)).every((name) => !name.endsWith(".tmp")));
  });

  await check("lists default to 200, cap at 501, paginate stably, and combine filters", async () => {
    const store = fixture("pagination");
    const entries = Array.from({ length: 610 }, (_, i) => makeOrder(String(i).padStart(4, "0"), { customer: { id: i % 2 ? "a" : "b" }, paymentStatus: i % 3 ? "pending" : "confirmed", fulfillmentStatus: i % 5 ? "not_ready" : "shipped" }));
    await writeFile(store.ordersPath, JSON.stringify({ version: 1, orders: entries }));
    await writeFile(store.usersPath, JSON.stringify({ version: 1, users: entries.map((entry) => makeUser(entry.id)) }));
    for (const collection of [store.users, store.orders]) {
      assert.equal((await collection.list()).length, 200);
      assert.equal((await collection.list({ limit: 10000 })).length, 501);
      const all = [...await collection.list({ limit: 500 }), ...await collection.list({ limit: 500, offset: 500 })];
      assert.equal(all.length, 610);
      assert.equal(new Set(all.map((entry) => entry.id)).size, 610);
    }
    const options = { customerId: "a", ids: entries.map((entry) => entry.id), paymentStatus: ["confirmed"], fulfillmentStatus: "shipped", limit: 10, offset: 2 };
    const expected = entries.filter((entry) => entry.customer.id === "a" && entry.paymentStatus === "confirmed" && entry.fulfillmentStatus === "shipped").reverse().slice(2, 12);
    assert.deepEqual(await store.orders.list(options), expected);
    assert.equal((await store.orders.list({ customerId: "" })).length, 0);
    await assert.rejects(store.orders.list({ ids: "not-an-array" }), status(400));
    assert.deepEqual(await store.users.counts(), { all: 610, admin: 0, customer: 610 });
    assert.equal(await store.orders.count(), 610);
    assert.equal(await store.orders.count({ customerId: "a" }), 305);
  });

  await check("local views, literal search, payment filters, active receipts, and counts apply before pagination", async () => {
    const store = fixture("views");
    const items = [{ variantId: "v", quantity: 2, productTitle: "Literal 50%_\\ product" }];
    const allocations = [{ variantId: "v", officeQuantity: 1, externalQuantity: 1 }];
    const entries = [
      makeOrder("pending", { items, fulfillmentReview: { status: "pending" } }),
      makeOrder("ready", { items, paymentStatus: "confirmed", fulfillmentAllocations: allocations }),
      makeOrder("shipped", { items, paymentStatus: "confirmed", fulfillmentStatus: "shipped" }),
      makeOrder("declined", { items, specialOrder: { status: "declined" } }),
      makeOrder("verify", { items, paymentIssue: { type: "paid_pending" } }),
      makeOrder("special", { items, specialOrder: { status: "pending" } }),
      makeOrder("support", { items, paymentIssue: { type: "other", status: "open" } }),
      makeOrder("tracked", { items, paymentStatus: "confirmed", fulfillmentAllocations: allocations, externalTracking: { number: "tracking" }, officeShippedAt: stamp }),
    ];
    await writeFile(store.ordersPath, JSON.stringify({ version: 1, orders: entries }));
    await writeFile(path.join(directory, "customer-messages.json"), JSON.stringify({ messages: [{ kind: "delivery_receipt", orderId: "shipped", status: "received", receivedAt: stamp }] }));
    const ids = async (options) => (await store.orders.list(options)).map((order) => order.id).sort();
    assert.deepEqual(await ids({ view: "completed" }), ["declined", "shipped"]);
    assert.deepEqual(await ids({ view: "ready" }), ["ready"]);
    assert.deepEqual(await ids({ view: "external" }), ["ready"]);
    assert.deepEqual(await ids({ view: "pending" }), ["pending", "special", "support", "verify"]);
    assert.deepEqual(await ids({ filter: "payment_to_verify" }), ["verify"]);
    assert.deepEqual(await ids({ filter: "special_review" }), ["special"]);
    assert.deepEqual(await ids({ filter: "fulfillment_review" }), ["declined", "pending"]);
    assert.deepEqual(await ids({ filter: "support" }), ["support"]);
    assert.deepEqual(await ids({ filter: "needs_payment_details" }), ["ready", "shipped", "support", "tracked", "verify"]);
    assert.equal((await store.orders.list({ search: "50%_" })).length, entries.length);
    assert.equal((await store.orders.list({ active: true })).length, entries.length - 2);
    assert.equal(await store.orders.count({ active: true }), entries.length - 2);
    await assert.rejects(store.orders.list({ view: "invalid" }), status(400));
    await assert.rejects(store.orders.count({ filter: "invalid" }), status(400));
  });

  await check("local order hooks run only for real writes and failures preserve the file", async () => {
    const calls = [];
    let broken = false;
    const store = fixture("hooks", { onOrderWrite: async (client, order, current) => {
      calls.push({ order: structuredClone(order), current });
      assert.equal(client, null);
      order.reference = "hook cannot mutate the saved value";
      if (broken) throw new Error("hook failed");
    } });
    await store.orders.insert(makeOrder("hook", { idempotencyKey: "hook-key" }), { requestHash: "hash" });
    const original = await store.orders.get("hook");
    assert.deepEqual(await store.orders.update("hook", () => null), original);
    await store.orders.update("hook", (order) => ({ ...order, paymentStatus: "confirmed" }));
    const current = await store.orders.get("hook");
    assert.deepEqual(await store.orders.update("hook", (order) => order), current);
    await store.orders.insert(makeOrder("retry-hook", { idempotencyKey: "hook-key" }), { requestHash: "hash" });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].current, null);
    assert.deepEqual(calls[1].current, original);
    assert.equal(current.reference, "REF-hook");
    const before = await readFile(store.ordersPath, "utf8");
    broken = true;
    await assert.rejects(store.orders.update("hook", (order) => ({ ...order, paymentStatus: "rejected" })), /hook failed/);
    await assert.rejects(store.orders.insert(makeOrder("failed-hook")), /hook failed/);
    assert.equal(await readFile(store.ordersPath, "utf8"), before);
  });

  await check("local Shark scopes require paid Office items and separate current orders from history", async () => {
    const store = fixture("shark");
    const items = [{ variantId: "v", quantity: 2 }];
    const paid = { items, paymentStatus: "confirmed" };
    const entries = [
      makeOrder("pending", { items }),
      makeOrder("confirmed", paid),
      makeOrder("synced", { ...paid, shopifyOrder: { id: "remote" } }),
      makeOrder("shipped", { ...paid, fulfillmentStatus: "shipped", shopifyOrder: { id: "remote-shipped" } }),
      makeOrder("office-shipped", { ...paid, officeShippedAt: stamp }),
      makeOrder("external-only", { ...paid, fulfillmentAllocations: [{ variantId: "v", officeQuantity: 0, externalQuantity: 2 }] }),
      makeOrder("external-shipped", { ...paid, fulfillmentStatus: "shipped", fulfillmentAllocations: [{ variantId: "v", officeQuantity: 0, externalQuantity: 2 }] }),
    ];
    await writeFile(store.ordersPath, JSON.stringify({ version: 1, orders: entries }));
    const ids = async (options) => (await store.orders.list(options)).map((entry) => entry.id).sort();
    assert.deepEqual(await ids({ internal: "confirmed" }), ["confirmed", "synced"]);
    assert.deepEqual(await ids({ internal: "confirmed", shopifySyncRequired: true }), ["synced"]);
    assert.deepEqual(await ids({ internal: "history" }), ["office-shipped", "shipped"]);
    assert.deepEqual(await ids({ internal: "history", shopifySyncRequired: true }), ["shipped"]);
    assert.equal(await store.orders.count({ internal: "confirmed" }), 2);
    await assert.rejects(store.orders.list({ internal: "unknown" }), status(400));
  });
}

// The SQL mock deliberately asserts query order, parameters, transaction scope,
// and absence of unrelated row writes. It does not claim to emulate Postgres.
class ScriptPool {
  constructor() { this.steps = []; this.log = []; this.connections = 0; this.releases = 0; }
  add(...steps) { this.steps.push(...steps); return this; }
  async query(sql, values = []) { return this.execute("pool", sql, values); }
  async connect() {
    this.connections++;
    return { query: (sql, values = []) => this.execute("client", sql, values), release: () => { this.releases++; } };
  }
  async execute(via, sql, values) {
    const query = sql.replace(/\s+/g, " ").trim();
    this.log.push({ via, query, values });
    const step = this.steps.shift();
    assert(step, `Unexpected ${via} SQL: ${query}`);
    assert.equal(via, step.via || "client", query);
    assert.match(query, step.match, query);
    if (step.values) assert.deepEqual(values, step.values, query);
    if (step.check) step.check(values, query);
    if (step.error) throw step.error;
    return { rows: structuredClone(step.rows || []) };
  }
  done() {
    assert.equal(this.steps.length, 0, `Unconsumed SQL: ${this.steps.map((step) => step.match).join(", ")}`);
    assert.equal(this.connections, this.releases, "Every client is released.");
    assert(this.log.every(({ query }) => !/ON CONFLICT|CREATE TABLE|op_storage_meta/i.test(query)));
  }
}

const q = (match, extra = {}) => ({ match, ...extra });
const begin = () => q(/^BEGIN$/);
const commit = () => q(/^COMMIT$/);
const rollback = () => q(/^ROLLBACK$/);
const membership = () => q(/^SELECT pg_advisory_xact_lock/, { values: ["op_record_store_admin_membership"] });
const submissionLock = (customer = "demo-user", key = "key") => q(/^SELECT pg_advisory_xact_lock/, { values: [JSON.stringify(["op_order_submission", customer, key])] });
const noUserCollision = () => q(/^SELECT id FROM op_users WHERE \(\$2::text IS NULL/, { rows: [] });
const bootExisting = (pool) => pool.add(begin(), membership(), q(/^SELECT id FROM op_users LIMIT 1$/, { rows: [{ id: "existing" }] }), commit());
const dbFixture = (pool, extra = {}) => createRecordStore({ database: async () => pool, useDatabase: () => true, seedUsers: () => { throw new Error("Unexpected seeding."); }, ...extra });
const getUserQuery = (id, user) => q(/^SELECT data FROM op_users WHERE id = \$1$/, { via: "pool", values: [id], rows: user ? [{ data: user }] : [] });
const lockedUser = (user) => q(/^SELECT data FROM op_users WHERE id = \$1 FOR UPDATE$/, { values: [user?.id || "absent"], rows: user ? [{ data: user }] : [] });
const lockedOrder = (order) => q(/^SELECT data FROM op_orders WHERE id = \$1 FOR UPDATE$/, { values: [order?.id || "absent"], rows: order ? [{ data: order }] : [] });
const savedSubmission = (rows = []) => q(/^SELECT request_hash, order_id FROM op_order_submissions WHERE customer_id = \$1 AND request_key = \$2$/, { values: ["demo-user", "key"], rows });
const legacySubmission = (order) => q(/^SELECT data FROM op_orders WHERE customer_id = \$1 AND data->>'idempotencyKey' = \$2 ORDER BY created_at, id LIMIT 1$/, { values: ["demo-user", "key"], rows: order ? [{ data: order }] : [] });

async function sqlChecks() {
  await check("SQL bootstrap happens once per pool, even across instances and concurrent auth", async () => {
    const pool = new ScriptPool();
    bootExisting(pool);
    const user = makeUser("existing");
    const one = dbFixture(pool), two = dbFixture(pool);
    for (let i = 0; i < 8; i++) pool.add(getUserQuery("existing", user));
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? one : two).users.get("existing")));
    assert(results.every((entry) => entry.id === "existing"));
    assert.equal(pool.connections, 1);
    pool.add(q(/^SELECT data FROM op_users WHERE \(username = \$1 OR email = \$1\) AND role = \$2 LIMIT 2$/, { via: "pool", values: ["existing", "customer"], rows: [{ data: user }] }));
    assert.equal((await two.users.findLogin(" EXISTING ", { role: "customer" })).id, "existing");
    pool.done();
  });

  await check("SQL bootstrap retries after rollback and seeds only an empty table under the lock", async () => {
    const pool = new ScriptPool();
    const store = dbFixture(pool, { seedUsers: demoSeeds });
    pool.add(begin(), membership(), q(/^SELECT id FROM op_users LIMIT 1$/, { error: new Error("temporary schema failure") }), rollback());
    await assert.rejects(store.users.get("demo-user"), /temporary schema failure/);
    pool.add(begin(), membership(), q(/^SELECT id FROM op_users LIMIT 1$/));
    for (const user of demoSeeds()) pool.add(noUserCollision(), q(/^INSERT INTO op_users .* now\(\)\)$/, { check: (values) => {
      assert.deepEqual(values, [user.id, user.username, user.email, user.role, JSON.stringify(user), stamp]);
    } }));
    pool.add(commit(), getUserQuery("demo-user", demoSeeds()[0]), getUserQuery("demo-user", demoSeeds()[0]));
    assert.equal((await store.users.get("demo-user")).username, "user");
    await store.users.get("demo-user");
    assert.equal(pool.connections, 2);
    pool.done();
  });

  await check("SQL user inserts map unique failures and protect normalized login namespaces", async () => {
    const pool = new ScriptPool();
    bootExisting(pool);
    const store = dbFixture(pool);
    pool.add(begin(), membership(), q(/^SELECT id FROM op_users WHERE/, { values: [["new", "new@example.test"], null] }), q(/^INSERT INTO op_users /, { check: (values) => { assert.deepEqual(values.slice(0, 4), ["new", "new", "new@example.test", "customer"]); }, error: { code: "23505", constraint: "op_users_username_key" } }), rollback());
    await assert.rejects(store.users.insert(makeUser("new", { username: " NEW ", email: " NEW@EXAMPLE.TEST " })), (error) => error.status === 409 && error.message === "User already exists.");
    pool.add(begin(), membership(), q(/^SELECT id FROM op_users WHERE/, { rows: [{ id: "email-owner" }] }), rollback());
    await assert.rejects(store.users.insert(makeUser("other", { username: "new@example.test" })), status(409));
    pool.done();
  });

  await check("SQL user updates lock and update only the target and manage SQL timestamps", async () => {
    const pool = new ScriptPool();
    bootExisting(pool);
    const store = dbFixture(pool), user = makeUser("target", { name: "Before", privateField: "keep" });
    pool.add(begin(), membership(), lockedUser(user), noUserCollision(), q(/^UPDATE op_users SET .*updated_at = now\(\) WHERE id = \$1$/, { check: (values) => {
      assert.equal(values[0], "target");
      assert.equal(JSON.parse(values[4]).privateField, "keep");
      assert.equal(JSON.parse(values[4]).name, "After");
    } }), commit());
    const updated = await store.users.update("target", async (current) => { await Promise.resolve(); return { ...current, name: "After" }; });
    assert.equal(updated.name, "After");
    pool.add(begin(), membership(), lockedUser(null), commit());
    assert.equal(await store.users.update("absent", () => { throw new Error("not called"); }), null);
    pool.add(begin(), membership(), lockedUser(user), commit());
    assert.deepEqual(await store.users.update("target", () => null), user);
    pool.add(begin(), membership(), lockedUser(user), commit());
    assert.deepEqual(await store.users.update("target", (current) => current), user);
    pool.add(begin(), membership(), lockedUser(user), rollback());
    await assert.rejects(store.users.update("target", () => { throw new Error("transform failed"); }), /transform failed/);
    pool.done();
  });

  await check("SQL role changes and removals share membership locks and recheck current admins", async () => {
    const pool = new ScriptPool();
    bootExisting(pool);
    const store = dbFixture(pool), admin = makeUser("admin", { role: "admin" });
    pool.add(begin(), membership(), lockedUser(admin), q(/^SELECT id FROM op_users WHERE role = 'admin'$/, { rows: [{ id: "admin" }] }), rollback());
    await assert.rejects(store.users.update("admin", (current) => ({ ...current, role: "customer" })), status(409));
    pool.add(begin(), membership(), q(/^SELECT data FROM op_users WHERE id = \$1 AND role = 'admin'$/, { values: ["revoked"] }), rollback());
    await assert.rejects(store.users.remove("target", { actorId: "revoked" }), status(401));
    pool.add(begin(), membership(), q(/^SELECT data FROM op_users WHERE id = \$1 AND role = 'admin'$/, { rows: [{ data: admin }] }), lockedUser(admin), q(/^SELECT id FROM op_users WHERE role = 'admin'$/, { rows: [{ id: "admin" }] }), rollback());
    await assert.rejects(store.users.remove("admin", { actorId: "admin" }), status(409));
    const target = makeUser("target");
    pool.add(begin(), membership(), q(/^SELECT data FROM op_users WHERE id = \$1 AND role = 'admin'$/, { rows: [{ data: admin }] }), lockedUser(target), q(/^DELETE FROM op_users WHERE id = \$1$/, { values: ["target"] }), commit());
    assert.equal((await store.users.remove("target", { actorId: "admin" })).id, "target");
    pool.add(begin(), membership(), lockedUser(null), commit());
    assert.equal(await store.users.update("absent", () => target), null);
    pool.done();
  });

  await check("SQL order updates lock just the target, initialize legacy events, and rollback failures", async () => {
    const pool = new ScriptPool(), store = dbFixture(pool), order = makeOrder("target");
    pool.add(begin(), lockedOrder(order), q(/^UPDATE op_orders SET .*updated_at = now\(\) WHERE id = \$1$/, { check: (values) => {
      assert.equal(values[0], "target");
      assert.equal(values[3], "confirmed");
      const saved = JSON.parse(values[5]);
      assert.deepEqual(saved.statusEvents, [{ type: "confirmed" }]);
      assert.equal(saved.updatedAt, stamp);
    } }), commit());
    await store.orders.update("target", async (current) => { current.statusEvents.push({ type: "confirmed" }); return { ...current, paymentStatus: "confirmed" }; });
    pool.add(begin(), lockedOrder(order), commit());
    assert.deepEqual(await store.orders.update("target", () => null), order);
    pool.add(begin(), lockedOrder({ ...order, statusEvents: [] }), commit());
    assert.deepEqual(await store.orders.update("target", (current) => current), { ...order, statusEvents: [] });
    pool.add(begin(), lockedOrder(null), commit());
    assert.equal(await store.orders.update("absent", () => { throw new Error("not called"); }), null);
    pool.add(begin(), lockedOrder(order), rollback());
    await assert.rejects(store.orders.update("target", () => { throw new Error("failed"); }), /failed/);
    pool.add(begin(), lockedOrder(order), q(/^UPDATE op_orders /, { error: { code: "23505", constraint: "op_orders_reference_key" } }), rollback());
    await assert.rejects(store.orders.update("target", (current) => current), status(409, "ORDER_REFERENCE_CONFLICT"));
    pool.done();
  });

  await check("SQL order insertion and the durable ledger commit together under a scoped lock", async () => {
    const pool = new ScriptPool(), store = dbFixture(pool), order = makeOrder("new", { idempotencyKey: "key" });
    pool.add(begin(), submissionLock(), savedSubmission(), legacySubmission(), q(/^INSERT INTO op_orders /, { check: (values) => assert.deepEqual(values, [order.id, order.reference, "demo-user", "pending", "not_ready", JSON.stringify(order), stamp]) }), q(/^INSERT INTO op_order_submissions /, { values: ["demo-user", "key", "hash", "new"] }), commit());
    assert.deepEqual(await store.orders.insert(order, { requestHash: "hash" }), { created: true, order });
    pool.add(begin(), submissionLock(), savedSubmission([{ request_hash: "hash", order_id: "new" }]), q(/^SELECT data FROM op_orders WHERE id = \$1 AND customer_id = \$2$/, { values: ["new", "demo-user"], rows: [{ data: order }] }), commit());
    assert.deepEqual(await store.orders.insert(makeOrder("different", { idempotencyKey: "key" }), { requestHash: "hash" }), { created: false, order });
    pool.add(begin(), submissionLock(), savedSubmission([{ request_hash: "hash", order_id: "new" }]), rollback());
    await assert.rejects(store.orders.insert(order, { requestHash: "changed" }), status(409, "ORDER_IDEMPOTENCY_CONFLICT"));
    pool.add(begin(), submissionLock(), savedSubmission(), legacySubmission(), q(/^INSERT INTO op_orders /), q(/^INSERT INTO op_order_submissions /, { error: new Error("ledger write failed") }), rollback());
    await assert.rejects(store.orders.insert(order, { requestHash: "hash" }), /ledger write failed/);
    pool.done();
  });

  await check("SQL reference conflicts are retryable and non-idempotent inserts still transact", async () => {
    const pool = new ScriptPool(), store = dbFixture(pool);
    pool.add(begin(), q(/^INSERT INTO op_orders /, { error: { code: "23505", constraint: "op_orders_reference_key" } }), rollback());
    await assert.rejects(store.orders.insert(makeOrder("reference")), status(409, "ORDER_REFERENCE_CONFLICT"));
    pool.add(begin(), q(/^INSERT INTO op_orders /, { error: { code: "23505", constraint: "op_orders_pkey" } }), rollback());
    await assert.rejects(store.orders.insert(makeOrder("duplicate-id")), status(409, "ORDER_ID_CONFLICT"));
    pool.add(begin(), q(/^INSERT INTO op_orders /), commit());
    assert.equal((await store.orders.insert(makeOrder("valid"))).created, true);
    pool.done();
  });

  await check("SQL legacy retry binds only the ledger and durable missing orders cannot be recreated", async () => {
    const pool = new ScriptPool(), store = dbFixture(pool), legacy = makeOrder("legacy", { idempotencyKey: "key" });
    pool.add(begin(), submissionLock(), savedSubmission(), legacySubmission(legacy), q(/^INSERT INTO op_order_submissions /, { values: ["demo-user", "key", "hash", "legacy"] }), commit());
    assert.deepEqual(await store.orders.findSubmission("demo-user", "key", "hash"), legacy);
    pool.add(begin(), submissionLock(), savedSubmission([{ request_hash: "hash", order_id: "legacy" }]), q(/^SELECT data FROM op_orders WHERE id = \$1 AND customer_id = \$2$/), rollback());
    await assert.rejects(store.orders.findSubmission("demo-user", "key", "hash"), status(409, "ORDER_SUBMISSION_MISSING"));
    pool.add(begin(), submissionLock(), savedSubmission(), legacySubmission(), commit());
    assert.equal(await store.orders.findSubmission("demo-user", "key", "hash"), null);
    pool.done();
  });

  await check("SQL lists are bounded, paginated, scoped, and batch IDs in one query", async () => {
    const pool = new ScriptPool(), store = dbFixture(pool);
    pool.add(q(/^SELECT data FROM op_orders ORDER BY created_at DESC, id DESC LIMIT \$1 OFFSET \$2$/, { via: "pool", values: [200, 0] }));
    await store.orders.list();
    pool.add(q(/^SELECT data FROM op_orders WHERE customer_id = \$1 AND id = ANY\(\$2::text\[\]\) AND payment_status = ANY\(\$3::text\[\]\) AND fulfillment_status = \$4 ORDER BY .* LIMIT \$5 OFFSET \$6$/, { via: "pool", values: ["customer", ["a", "b"], ["confirmed", "pending"], "shipped", 501, 27] }));
    await store.orders.list({ customerId: "customer", ids: ["a", "b", "a"], paymentStatus: ["confirmed", "pending"], fulfillmentStatus: "shipped", limit: 9000, offset: 27 });
    assert.deepEqual(await store.orders.list({ ids: [] }), []);
    pool.add(q(/^SELECT data FROM op_orders WHERE id = \$1 AND customer_id = \$2$/, { via: "pool", values: ["a", "customer"] }));
    assert.equal(await store.orders.get("a", { customerId: "customer" }), null);
    bootExisting(pool);
    pool.add(q(/^SELECT data FROM op_users WHERE role = \$1 ORDER BY .* LIMIT \$2 OFFSET \$3$/, { via: "pool", values: ["admin", 501, 3] }));
    await store.users.list({ role: "admin", limit: 1000, offset: 3 });
    pool.done();
  });

  await check("SQL counts avoid record loading and admin filters escape literal search", async () => {
    const pool = new ScriptPool(), store = dbFixture(pool);
    bootExisting(pool);
    pool.add(q(/^SELECT count\(\*\) AS all, count\(\*\) FILTER \(WHERE role = 'admin'\) AS admin, count\(\*\) FILTER \(WHERE role = 'customer'\) AS customer FROM op_users$/, { via: "pool", rows: [{ all: "5", admin: "2", customer: "3" }] }));
    assert.deepEqual(await store.users.counts(), { all: 5, admin: 2, customer: 3 });
    pool.add(q(/^SELECT count\(\*\) AS count FROM op_orders WHERE payment_status = \$1$/, { via: "pool", values: ["confirmed"], rows: [{ count: "7" }] }));
    assert.equal(await store.orders.count({ paymentStatus: "confirmed" }), 7);
    pool.add(q(/^SELECT data FROM op_orders WHERE /, { via: "pool", check: (values, sql) => {
      assert.deepEqual(values, ["%50\\%\\_\\\\%", 501, 0]);
      assert.match(sql, /data::text ILIKE \$1/);
      assert.match(sql, /NOT EXISTS .*op_customer_messages AS receipt.*delivery_receipt/);
      assert.match(sql, /jsonb_array_elements/);
      assert.match(sql, /fulfillment_status = 'not_ready'/);
      assert.match(sql, /paid_pending/);
    } }));
    await store.orders.list({ view: "ready", filter: "payment_to_verify", search: "50%_\\", active: true, limit: 501 });
    assert.equal(await store.orders.count({ ids: [] }), 0);
    pool.done();
  });

  await check("SQL order hooks share the write transaction and hook failures roll back", async () => {
    const pool = new ScriptPool();
    const order = makeOrder("hook", { statusEvents: [] });
    const store = dbFixture(pool, { onOrderWrite: async (client, saved, previous) => {
      assert.equal(previous === null || previous.id === saved.id, true);
      assert.equal(saved.id, "hook");
      await client.query("INSERT INTO test_outbox (order_id) VALUES ($1)", [saved.id]);
    } });
    pool.add(begin(), q(/^INSERT INTO op_orders /), q(/^INSERT INTO test_outbox /, { values: ["hook"] }), commit());
    await store.orders.insert(order);
    pool.add(begin(), lockedOrder(order), commit());
    assert.deepEqual(await store.orders.update("hook", () => null), order);
    pool.add(begin(), lockedOrder(order), commit());
    assert.deepEqual(await store.orders.update("hook", (current) => current), order);
    pool.add(begin(), lockedOrder(order), q(/^UPDATE op_orders /), q(/^INSERT INTO test_outbox /, { error: new Error("outbox failed") }), rollback());
    await assert.rejects(store.orders.update("hook", (current) => ({ ...current, paymentStatus: "confirmed" })), /outbox failed/);
    pool.done();
  });

  await check("SQL Shark scopes filter paid Office orders before applying pagination", async () => {
    const pool = new ScriptPool(), store = dbFixture(pool);
    pool.add(q(/^SELECT data FROM op_orders WHERE /, { via: "pool", check: (values, sql) => {
      assert.deepEqual(values, [500, 1000]);
      assert.match(sql, /payment_status = 'confirmed'/);
      assert.match(sql, /officeQuantity/);
      assert.match(sql, /fulfillment_status <> 'shipped'/);
      assert.match(sql, /COALESCE\(data->>'officeShippedAt', ''\) = ''/);
      assert.match(sql, /COALESCE\(data->'shopifyOrder'->>'id', ''\) <> ''/);
      assert.match(sql, /ORDER BY created_at DESC, id DESC LIMIT \$1 OFFSET \$2$/);
    } }));
    await store.orders.list({ internal: "confirmed", shopifySyncRequired: true, limit: 500, offset: 1000 });
    pool.add(q(/^SELECT data FROM op_orders WHERE /, { via: "pool", check: (values, sql) => {
      assert.deepEqual(values, [200, 0]);
      assert.match(sql, /payment_status = 'confirmed'/);
      assert.match(sql, /officeQuantity/);
      assert.match(sql, /\(fulfillment_status = 'shipped' OR COALESCE\(data->>'officeShippedAt', ''\) <> ''\)/);
    } }));
    await store.orders.list({ internal: "history" });
    pool.done();
  });
}

try {
  await localChecks();
  await sqlChecks();
  console.log(`record store checks passed (${checked})`);
} finally {
  // Verify the resolved disposable directory before recursive Windows removal.
  if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("op-record-store-")) throw new Error("Unexpected test directory.");
  await rm(directory, { recursive: true, force: true });
}

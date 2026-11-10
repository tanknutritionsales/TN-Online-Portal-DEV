// No hosted data, real email, Shopify calls, .env or production connection URLs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createOrderNotifications } from "../lib/order-notifications.mjs";
import { createOrderEmail, normalizeCustomerCare } from "../lib/customer-notifications.mjs";
import { createCustomerMessageStore } from "../lib/customer-message-store.mjs";
import { createRecordStore } from "../lib/record-store.mjs";
import { portalSchemaSql } from "../lib/database-schema.mjs";
import { startIsolatedPostgres } from "./isolated-postgres.mjs";

const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("Real email/network calls are forbidden in notification tests."); };
after(() => { globalThis.fetch = originalFetch; });
const clone = (value) => structuredClone(value);
const turn = () => new Promise((resolve) => setImmediate(resolve));
const lifetimeMs = 23 * 60 * 60 * 1_000;
function clock() {
  let time = Date.now();
  return { now: () => time, advance: (ms) => { time += ms; }, iso: () => new Date(time).toISOString() };
}
function order(time, id = "order-1") {
  return { id, reference: `TEST-${id}`, customer: { id: "customer-1", name: "Private Customer", email: "private@example.com" }, total: 25,
    paymentStatus: "pending", fulfillmentStatus: "not_ready", createdAt: time.iso(), updatedAt: time.iso(),
    statusEvents: [{ type: "submitted", at: time.iso() }] };
}
function memoryMessages() {
  const rows = new Map(), locks = new Map();
  const calls = { inserts: 0, lists: 0, updates: 0 };
  return {
    rows, calls,
    async insert(message) {
      calls.inserts++;
      if (rows.has(message.id)) return { created: false, message: clone(rows.get(message.id)) };
      rows.set(message.id, clone(message));
      return { created: true, message: clone(message) };
    },
    async list({ orderId, kind, statuses, limit }) {
      calls.lists++;
      assert.ok(orderId, "Local pending queries must filter by orderId.");
      return [...rows.values()].filter((row) => row.orderId === orderId && row.kind === kind && statuses.includes(row.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit).map(clone);
    },
    async update(id, transform) {
      calls.updates++;
      const current = (locks.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
        const entry = rows.get(id);
        const next = entry ? await transform(clone(entry)) : null;
        if (next) rows.set(id, clone(next));
        return clone(next);
      });
      locks.set(id, current);
      try { return await current; }
      finally { if (locks.get(id) === current) locks.delete(id); }
    },
  };
}
function blobs() {
  const entries = new Map();
  const calls = { gets: 0, writes: 0, lists: 0, deletes: 0 };
  return {
    entries, calls,
    async get(key, options) { calls.gets++; assert.equal(options.consistency, "strong"); return clone(entries.get(key) || null); },
    async setJSON(key, value) { calls.writes++; entries.set(key, clone(value)); },
    async list({ prefix }) { calls.lists++; return { blobs: [...entries.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) }; },
    async delete(key) { calls.deletes++; entries.delete(key); },
  };
}
function harness({ sql = true, namespace = "production", filePath, blob = blobs() } = {}) {
  const time = clock();
  const messages = memoryMessages();
  const orders = new Map();
  const retryHints = new Map();
  const counts = { database: 0, queries: [], care: 0, orders: 0, sends: 0, retryWrites: 0 };
  const state = { paused: false, emailEnabled: true, care: normalizeCustomerCare({ emailEnabled: true }), allowed: true, apiKey: "fake-offline-key", failRetry: false, failProvider: false };
  const control = {
    read: async () => ({ paused: state.paused }),
    emailEnabled: async () => state.emailEnabled,
    setEmailEnabled: async (value) => { state.emailEnabled = value; },
    syncRetry: async (message) => {
      counts.retryWrites++;
      if (state.failRetry) throw new Error("Injected retry-hint persistence failure");
      if (!message) return;
      if (["pending", "failed", "sending"].includes(message.status) && message.attempts < 5 && time.now() - Date.parse(message.createdAt) < lifetimeMs) retryHints.set(message.id, clone(message));
      else retryHints.delete(message.id);
    },
  };
  const runtimeConfig = (care) => ({
    allowed: state.allowed, apiKey: state.apiKey, from: "sender@example.com", portalUrl: "https://portal.example.com", senderName: care.senderName,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.resend.com/emails");
      const id = options.headers["idempotency-key"];
      assert.ok(retryHints.has(id), "Retry hint MUST be durable before provider delivery.");
      assert.equal(messages.rows.get(id).status, "sending", "Delivery MUST hold the existing message claim.");
      counts.sends++;
      await turn();
      if (state.failProvider) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ id: `offline-${id}` }) };
    },
  });
  const pool = { query: async (text, values) => {
    counts.queries.push({ text, values });
    if (text.startsWith("SELECT data FROM op_customer_messages")) {
      assert.match(text, /order_id=\$1.*kind='email'.*status='pending'.*LIMIT 20/);
      assert.equal(values.length, 1);
      return { rows: [...messages.rows.values()].filter((row) => row.orderId === values[0] && row.kind === "email" && row.status === "pending").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, 20).map((data) => ({ data: clone(data) })) };
    }
    if (text === "SELECT data FROM op_orders WHERE id=$1") return { rows: orders.has(values[0]) ? [{ data: clone(orders.get(values[0])) }] : [] };
    throw new Error(`Unexpected database query: ${text}`);
  } };
  const database = async () => { counts.database++; return pool; };
  const readCare = async () => { counts.care++; return clone(state.care); };
  const getOrder = async (id) => { counts.orders++; return clone(orders.get(id) || null); };
  const options = { database, useDatabase: () => sql, messages, control, readCare, runtimeConfig,
    namespace, filePath, blobStore: filePath ? null : async () => blob, getOrder, now: time.now };
  const notifications = createOrderNotifications(options);
  const transactionQueries = [];
  const client = { query: async (text, values) => {
    transactionQueries.push({ text, values });
    if (text.startsWith("SELECT data->'customerCare'")) return { rows: [{ customer_care: clone(state.care) }] };
    assert.match(text, /INSERT INTO op_customer_messages[\s\S]*ON CONFLICT \(id\) DO NOTHING RETURNING id/);
    const value = JSON.parse(values[5]);
    if (messages.rows.has(value.id)) return { rows: [], rowCount: 0 };
    messages.rows.set(value.id, value);
    return { rows: [{ id: value.id }], rowCount: 1 };
  } };
  return { notifications, options, time, messages, orders, retryHints, counts, state, control, blob, client, transactionQueries };
}
async function save(h, next, previous = null) {
  h.orders.set(next.id, clone(next));
  return h.notifications.record(h.options.useDatabase() ? h.client : null, next, previous);
}

test("SQL record uses only the supplied transaction client, with deterministic duplicate-safe inserts", async () => {
  const h = harness();
  const next = order(h.time);
  h.options.database = () => assert.fail("SQL hook must not open another database connection.");
  const isolated = createOrderNotifications({ ...h.options,
    readCare: () => assert.fail("SQL hook must read care from its transaction client."),
    blobStore: () => assert.fail("No Blob network calls may happen inside the SQL hook."),
    control: { syncRetry: () => assert.fail("No retry hints may happen inside the SQL hook.") },
  });
  assert.deepEqual(await isolated.record(h.client, next, null), { recorded: 1 });
  const [message] = h.messages.rows.values();
  const expected = createOrderEmail(next, "order_received", { care: h.state.care, portalUrl: h.options.runtimeConfig({}).portalUrl, eventId: "submitted" });
  assert.equal(message.id, expected.id);
  assert.equal(message.eventId, "submitted");
  assert.equal(message.status, "pending");
  assert.deepEqual(await isolated.record(h.client, next, null), { recorded: 0 });
  assert.equal(h.messages.rows.size, 1);
  assert.equal(h.messages.calls.inserts, 0, "SQL hooks must not call standalone messages.insert.");
  assert.equal(h.counts.sends, 0);
  assert.equal(h.counts.database, 0);
  assert.equal(h.counts.care, 0);
  assert.equal(h.blob.calls.writes, 0);
  const count = h.transactionQueries.length;
  await isolated.record(h.client, next, next);
  assert.equal(h.transactionQueries.length, count, "No appended notification event means no settings SQL.");
  await assert.rejects(isolated.record(null, next, null), /transaction client/);
});

test("all supported event IDs are deterministic; identical payment-link resaves preserve a sent message", async () => {
  const h = harness();
  let previous = order(h.time);
  await save(h, previous);
  const add = async (type, properties) => {
    const next = { ...clone(previous), ...properties, statusEvents: [...previous.statusEvents, { type, at: h.time.iso() }] };
    const result = await save(h, next, previous);
    previous = next;
    return result;
  };
  const paymentLink = { url: "https://pay.example.com/private", attachedAt: h.time.iso(), amount: 25 };
  assert.equal((await add("payment_link_attached", { paymentLink })).recorded, 1);
  const ready = [...h.messages.rows.values()].find((row) => row.event === "payment_ready");
  assert.equal(ready.eventId, createHash("sha256").update(JSON.stringify({ amount: 25, attachedAt: h.time.iso(), url: paymentLink.url })).digest("hex"));
  h.messages.rows.set(ready.id, { ...ready, status: "sent", deliveryId: "accepted" });
  assert.equal((await add("payment_link_attached", { paymentLink })).recorded, 0);
  assert.equal(h.messages.rows.get(ready.id).status, "sent");
  assert.equal((await add("payment_confirmed", { paymentStatus: "confirmed" })).recorded, 1);
  assert.equal((await add("shipped", { officeShippedAt: h.time.iso() })).recorded, 1);
  assert.equal((await add("external_tracking_added", { externalTracking: { addedAt: h.time.iso() } })).recorded, 1);
  assert.deepEqual(new Set([...h.messages.rows.values()].map((row) => row.eventId)), new Set(["submitted", ready.eventId, "confirmed", `office:${h.time.iso()}`, `external:${h.time.iso()}`]));
  assert.equal((await add("back_order", {})).recorded, 0);
});

test("payment-ready identity survives reordered JSON keys, deduplicates resaves and preserves array order", async () => {
  const h = harness();
  const paymentLink = { url: "https://pay.example.com/current", attachedAt: h.time.iso(), amount: 25,
    metadata: { z: [{ b: 2, a: 1 }, { d: 4, c: 3 }], a: "fixture" } };
  const next = { ...order(h.time), paymentLink, statusEvents: [{ type: "payment_link_attached", at: h.time.iso() }] };
  await save(h, next);
  const original = clone([...h.messages.rows.values()][0]);
  const reversedKeys = (value) => Array.isArray(value) ? value.map(reversedKeys) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reversedKeys(entry)])) : value;
  const roundTrip = JSON.parse(JSON.stringify(reversedKeys(next)));
  assert.deepEqual(roundTrip.paymentLink, paymentLink);
  assert.notEqual(JSON.stringify(roundTrip.paymentLink), JSON.stringify(paymentLink), "Fixture must actually reorder serialized object keys.");
  h.orders.set(next.id, roundTrip);
  assert.equal((await h.notifications.afterWrite(next.id, await h.notifications.beforeWrite(next.id))).sent, 1);
  assert.equal(h.messages.rows.get(original.id).status, "sent", "Key order alone must never supersede a payment-ready email.");

  const resaved = { ...clone(roundTrip), statusEvents: [...roundTrip.statusEvents, { type: "payment_link_attached", at: h.time.iso() }] };
  assert.equal((await save(h, resaved, roundTrip)).recorded, 0);
  assert.equal(h.messages.rows.size, 1);
  assert.equal(h.messages.rows.get(original.id).attempts, 1);
  const changed = clone(resaved);
  changed.paymentLink.metadata.z.reverse();
  changed.statusEvents.push({ type: "payment_link_attached", at: h.time.iso() });
  assert.equal((await save(h, changed, resaved)).recorded, 1, "Changing array order changes the actual link value and must change its identity.");
  assert.equal(h.messages.rows.size, 2);
  assert.notEqual([...h.messages.rows.values()].at(-1).eventId, original.eventId);
});

test("event switches/enable time filter history; disabled and unconfigured/preview messages remain admin-visible", async () => {
  const h = harness();
  h.state.care.events.order_received = false;
  await save(h, order(h.time));
  assert.equal(h.messages.rows.size, 0);
  h.state.care.events.order_received = true;
  h.state.care.emailEnabledAt = new Date(h.time.now() + 1).toISOString();
  await save(h, order(h.time));
  assert.equal(h.messages.rows.size, 0, "Events before emailEnabledAt must not be replayed.");
  h.time.advance(1);
  await save(h, order(h.time));
  assert.equal(h.messages.rows.size, 1, "Event exactly at enable time is eligible.");
  h.state.care.emailEnabled = false;
  await save(h, order(h.time, "disabled-order"));
  assert.equal([...h.messages.rows.values()].find((row) => row.orderId === "disabled-order").status, "disabled");
  h.state.care.emailEnabled = true;
  h.state.allowed = false;
  await save(h, order(h.time, "preview-order"));
  assert.equal([...h.messages.rows.values()].find((row) => row.orderId === "preview-order").status, "setup_required");
  h.state.allowed = true;
  h.state.apiKey = "";
  await save(h, order(h.time, "unconfigured-order"));
  assert.equal([...h.messages.rows.values()].find((row) => row.orderId === "unconfigured-order").status, "setup_required");
  assert.equal(h.counts.sends, 0);
});

test("unconfigured invalid portal URL still records setup_required instead of aborting the order", async () => {
  const h = harness();
  const notifications = createOrderNotifications({ ...h.options, runtimeConfig: (care) => ({ ...h.options.runtimeConfig(care), portalUrl: "invalid" }) });
  assert.equal((await notifications.record(h.client, order(h.time), null)).recorded, 1);
  assert.equal([...h.messages.rows.values()][0].status, "setup_required");
  assert.equal(await notifications.beforeWrite("order-1"), null);
});

test("200 concurrent action hints are unique and contain no customer/email/payment metadata", async () => {
  const h = harness();
  const hints = await Promise.all(Array.from({ length: 200 }, () => h.notifications.beforeWrite("order-1")));
  assert.equal(new Set(hints.map((hint) => hint.id)).size, 200);
  assert.equal(h.blob.entries.size, 200);
  for (const hint of hints) {
    assert.deepEqual(Object.keys(hint).sort(), ["dueAt", "expiresAt", "id", "orderId"]);
    assert.equal(hint.dueAt, h.time.now() + 30_000);
    assert.equal(hint.expiresAt, h.time.now() + lifetimeMs);
  }
  assert.doesNotMatch(JSON.stringify([...h.blob.entries]), /private|customer|@|payment|TEST/);
  await h.notifications.afterWrite("order-1", hints[0]);
  assert.equal(h.blob.entries.size, 199, "One action may clear only its own UUID hint.");
  await Promise.all(hints.slice(1).map((hint) => h.notifications.afterWrite("order-1", hint)));
  assert.equal(h.blob.entries.size, 0);
  assert.equal(h.counts.care, 0);
  assert.equal(h.counts.orders, 0);
});

test("idle/future-hint recovery performs zero SQL, settings reads and order reads", async () => {
  const h = harness();
  assert.equal((await h.notifications.recover()).idle, true);
  await h.notifications.beforeWrite("order-1");
  h.time.advance(29_999);
  assert.equal((await h.notifications.recover()).idle, true);
  assert.equal(h.counts.database, 0);
  assert.equal(h.counts.queries.length, 0);
  assert.equal(h.counts.care, 0);
  assert.equal(h.counts.orders, 0);
});

test("paused/unconfigured/disallowed/disabled recovery performs zero SQL even with due hints", async () => {
  for (const flag of ["paused", "unconfigured", "disallowed", "disabled"]) {
    const h = harness();
    await h.notifications.beforeWrite("order-1");
    h.time.advance(30_000);
    if (flag === "paused") h.state.paused = true;
    if (flag === "unconfigured") h.state.apiKey = "";
    if (flag === "disallowed") h.state.allowed = false;
    if (flag === "disabled") h.state.emailEnabled = false;
    assert.equal((await h.notifications.recover()).paused, true);
    assert.equal(h.counts.database, 0, flag);
    assert.equal(h.counts.care, 0, flag);
    assert.equal(h.counts.orders, 0, flag);
    if (flag !== "paused") assert.equal(await h.notifications.beforeWrite("another-order"), null);
  }
});

test("expired hints are pruned without waking SQL", async () => {
  const h = harness();
  await h.notifications.beforeWrite("order-1");
  h.time.advance(lifetimeMs);
  assert.equal((await h.notifications.recover()).idle, true);
  assert.equal(h.blob.entries.size, 0);
  assert.equal(h.counts.database, 0);
  assert.equal(h.counts.care, 0);
});

test("commit followed by interrupted request is recovered after the delay; subsequent idle runs do zero SQL", async () => {
  const h = harness();
  const next = order(h.time);
  await h.notifications.beforeWrite(next.id);
  await save(h, next);
  assert.equal(h.counts.sends, 0);
  h.time.advance(30_000);
  const result = await h.notifications.recover();
  assert.equal(result.recovered, 1);
  assert.equal(result.sent, 1);
  assert.equal(h.counts.queries.length, 1);
  assert.equal(h.counts.care, 1);
  assert.equal(h.counts.orders, 1);
  assert.equal(h.blob.entries.size, 0);
  assert.equal(h.retryHints.size, 0);
  const previous = clone(h.counts);
  assert.equal((await h.notifications.recover()).idle, true);
  assert.deepEqual(h.counts, previous);
});

test("rolled-back/no-op order action clears its exact hint with one pending query and no settings/history read", async () => {
  const h = harness();
  await h.notifications.beforeWrite("order-1");
  h.time.advance(30_000);
  assert.equal((await h.notifications.recover()).processed, 0);
  assert.equal(h.counts.queries.length, 1);
  assert.equal(h.counts.care, 0);
  assert.equal(h.counts.orders, 0);
  assert.equal(h.blob.entries.size, 0);
});

test("retry-hint persistence failure prevents all delivery and retains the dirty hint for recovery", async () => {
  const h = harness();
  const next = order(h.time);
  const hint = await h.notifications.beforeWrite(next.id);
  await save(h, next);
  h.state.failRetry = true;
  await assert.rejects(h.notifications.afterWrite(next.id, hint), /retry-hint persistence/);
  assert.equal(h.counts.sends, 0);
  assert.equal(h.blob.entries.size, 1);
  h.state.failRetry = false;
  h.time.advance(30_000);
  assert.equal((await h.notifications.recover()).sent, 1);
});

test("all batch retry hints are durable before the first provider call", async () => {
  const h = harness();
  const next = { ...order(h.time), paymentStatus: "confirmed", officeShippedAt: h.time.iso(),
    statusEvents: ["submitted", "payment_confirmed", "shipped"].map((type) => ({ type, at: h.time.iso() })) };
  await save(h, next);
  const sync = h.control.syncRetry;
  h.control.syncRetry = async (message) => {
    if (message?.status === "sent") assert.equal(h.counts.retryWrites >= 3, true);
    return sync(message);
  };
  const notifications = createOrderNotifications({ ...h.options, runtimeConfig: (care) => {
    const config = h.options.runtimeConfig(care);
    return { ...config, fetchImpl: async (...args) => {
      if (!h.counts.sends) assert.equal(h.retryHints.size, 3, "Persist the whole batch before any send.");
      return config.fetchImpl(...args);
    } };
  } });
  assert.equal((await notifications.afterWrite(next.id, await notifications.beforeWrite(next.id))).sent, 3);
});

test("200 concurrent after-write attempts deliver a deterministic message only once", async () => {
  const h = harness();
  const next = order(h.time);
  await save(h, next);
  const hints = await Promise.all(Array.from({ length: 200 }, () => h.notifications.beforeWrite(next.id)));
  await Promise.all(hints.map((hint) => h.notifications.afterWrite(next.id, hint)));
  assert.equal(h.counts.sends, 1);
  assert.equal([...h.messages.rows.values()][0].status, "sent");
  assert.equal([...h.messages.rows.values()][0].attempts, 1);
  assert.equal(h.blob.entries.size, 0);
});

test("obsolete payment-ready messages are superseded using the current targeted order", async () => {
  for (const reason of ["confirmed", "declined", "changed-link", "deleted", "disabled-event"]) {
    const h = harness();
    const next = { ...order(h.time), paymentLink: { url: "https://pay.example.com/old", attachedAt: h.time.iso() }, statusEvents: [{ type: "payment_link_attached", at: h.time.iso() }] };
    const hint = await h.notifications.beforeWrite(next.id);
    await save(h, next);
    if (reason === "confirmed") h.orders.get(next.id).paymentStatus = "confirmed";
    if (reason === "declined") h.orders.get(next.id).specialOrder = { status: "declined" };
    if (reason === "changed-link") h.orders.get(next.id).paymentLink.url = "https://pay.example.com/new";
    if (reason === "deleted") h.orders.delete(next.id);
    if (reason === "disabled-event") h.state.care.events.payment_ready = false;
    assert.equal((await h.notifications.afterWrite(next.id, hint)).sent, 0, reason);
    assert.equal([...h.messages.rows.values()][0].status, "superseded", reason);
    assert.equal(h.counts.orders, 1, reason);
    assert.equal(h.counts.sends, 0, reason);
    assert.equal(h.retryHints.size, 0, reason);
  }
});

test("future pending, setup_required and terminal rows do not cause settings/order reads", async () => {
  const h = harness();
  const next = order(h.time);
  await save(h, next);
  const message = [...h.messages.rows.values()][0];
  message.nextAttemptAt = new Date(h.time.now() + 60_000).toISOString();
  h.messages.rows.set(message.id, message);
  const hint = await h.notifications.beforeWrite(next.id);
  assert.equal((await h.notifications.afterWrite(next.id, hint)).idle, true);
  assert.equal(h.retryHints.size, 1);
  assert.equal(h.counts.care, 0);
  assert.equal(h.counts.orders, 0);
  for (const status of ["setup_required", "disabled", "sent", "failed", "sending"]) {
    h.messages.rows.set(message.id, { ...message, status });
    await h.notifications.afterWrite(next.id, await h.notifications.beforeWrite(next.id));
  }
  assert.equal(h.counts.care, 0);
  assert.equal(h.counts.orders, 0);
});

test("provider failure leaves a normal retry hint and never requires an idle SQL scan", async () => {
  const h = harness();
  const next = order(h.time);
  await save(h, next);
  h.state.failProvider = true;
  const result = await h.notifications.afterWrite(next.id, await h.notifications.beforeWrite(next.id));
  assert.equal(result.sent, 0);
  assert.equal([...h.messages.rows.values()][0].status, "failed");
  assert.equal(h.retryHints.size, 1);
  assert.equal(h.blob.entries.size, 0, "The standard retry worker now owns recovery.");
  const count = h.counts.queries.length;
  assert.equal((await h.notifications.recover()).idle, true);
  assert.equal(h.counts.queries.length, count);
});

test("20-row pages retain the action hint until remaining pending messages are handed off", async () => {
  const h = harness();
  const next = order(h.time);
  h.orders.set(next.id, next);
  for (let index = 0; index < 21; index++) {
    const message = createOrderEmail(next, "order_received", { care: h.state.care, portalUrl: "https://portal.example.com", eventId: String(index) });
    Object.assign(message, { createdAt: h.time.iso(), updatedAt: h.time.iso(), nextAttemptAt: h.time.iso() });
    await h.messages.insert(message);
  }
  const hint = await h.notifications.beforeWrite(next.id);
  const first = await h.notifications.afterWrite(next.id, hint);
  assert.equal(first.processed, 20);
  assert.equal(first.remaining, true);
  assert.equal(h.blob.entries.size, 1);
  h.time.advance(30_000);
  assert.equal((await h.notifications.recover()).sent, 1);
  assert.equal(h.blob.entries.size, 0);
  assert.equal(h.counts.sends, 21);
});

test("production/preview dirty hints remain separate and recovery bounds due-order work", async () => {
  const h = harness();
  const other = createOrderNotifications({ ...h.options, namespace: "preview:deploy-a" });
  for (let index = 0; index < 103; index++) await h.notifications.beforeWrite(`order-${index}`);
  await other.beforeWrite("order-1");
  h.time.advance(30_000);
  const result = await h.notifications.recover();
  assert.equal(result.recovered, 100);
  assert.equal(result.remaining, true);
  assert.equal(h.counts.queries.length, 100);
  assert.equal(h.blob.entries.size, 4);
  await h.notifications.recover();
  assert.equal(h.blob.entries.size, 1);
  assert.ok([...h.blob.entries.keys()][0].startsWith("preview%3Adeploy-a/notification-orders/"));
  await other.recover();
  assert.equal(h.blob.entries.size, 0);
});

test("local atomic queue preserves 200 simultaneous hints across factory instances and isolates namespaces", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "op-notifications-test-"));
  try {
    const filePath = path.join(directory, "notification-orders.json");
    const h = harness({ sql: false, filePath });
    const second = createOrderNotifications(h.options);
    const preview = createOrderNotifications({ ...h.options, namespace: "preview" });
    const hints = await Promise.all(Array.from({ length: 200 }, (_, index) => (index % 2 ? second : h.notifications).beforeWrite("order-1")));
    const previewHint = await preview.beforeWrite("order-1");
    let stored = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(Object.keys(stored.namespaces["ns:production"]).length, 200);
    assert.equal(Object.keys(stored.namespaces["ns:preview"]).length, 1);
    await Promise.all(hints.slice(0, 25).map((hint) => second.afterWrite("order-1", hint)));
    stored = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(Object.keys(stored.namespaces["ns:production"]).length, 175);
    assert.equal(Object.keys(stored.namespaces["ns:preview"]).length, 1);
    await preview.afterWrite("order-1", previewHint);
    assert.equal(h.counts.database, 0);
    assert.equal(h.counts.care, 0);
    assert.equal(h.counts.orders, 0);
  } finally {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("op-notifications-test-")) throw new Error("Unexpected temporary path.");
    await rm(directory, { recursive: true, force: true });
  }
});

test("local recording uses messages.insert, and SQL fallback order lookup is targeted", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "op-notifications-test-"));
  try {
    const local = harness({ sql: false, filePath: path.join(directory, "dirty.json") });
    const next = order(local.time);
    local.orders.set(next.id, next);
    assert.equal((await local.notifications.record(null, next, null)).recorded, 1);
    assert.equal(local.messages.calls.inserts, 1);
    assert.equal((await local.notifications.afterWrite(next.id, await local.notifications.beforeWrite(next.id))).sent, 1);
    const sql = harness();
    const row = order(sql.time);
    await save(sql, row);
    const fallback = createOrderNotifications({ ...sql.options, getOrder: undefined });
    assert.equal((await fallback.afterWrite(row.id, await fallback.beforeWrite(row.id))).sent, 1);
    assert.equal(sql.counts.queries.length, 2);
    assert.equal(sql.counts.queries[1].text, "SELECT data FROM op_orders WHERE id=$1");
    assert.deepEqual(sql.counts.queries[1].values, [row.id]);
  } finally {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("op-notifications-test-")) throw new Error("Unexpected temporary path.");
    await rm(directory, { recursive: true, force: true });
  }
});

test("unset care disables recording safely; local enabled care with disallowed delivery records setup_required", async () => {
  const h = harness();
  h.state.care = undefined;
  assert.equal((await save(h, order(h.time))).recorded, 1);
  assert.equal([...h.messages.rows.values()][0].status, "disabled");
  const hint = await h.notifications.beforeWrite("order-1");
  await h.notifications.afterWrite("order-1", hint);
  assert.equal(h.counts.care, 0, "Terminal/disabled rows must not load missing care after commit.");
  const directory = await mkdtemp(path.join(tmpdir(), "op-notifications-test-"));
  try {
    const local = harness({ sql: false, filePath: path.join(directory, "dirty.json") });
    local.state.allowed = false;
    assert.equal(await local.notifications.beforeWrite("order-1"), null);
    assert.equal((await local.notifications.record(null, order(local.time), null)).recorded, 1);
    assert.equal([...local.messages.rows.values()][0].status, "setup_required");
    assert.equal((await local.notifications.afterWrite("order-1", null)).paused, true);
    assert.equal(local.counts.sends, 0);
    assert.equal(local.counts.database, 0);
  } finally {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("op-notifications-test-")) throw new Error("Unexpected temporary path.");
    await rm(directory, { recursive: true, force: true });
  }
});

test("transaction failure propagates; failed before-write hint cannot begin an unprotected action", async () => {
  const h = harness();
  const next = order(h.time);
  const client = { query: async (text) => {
    if (text.startsWith("SELECT")) return { rows: [{ customer_care: h.state.care }] };
    throw new Error("Injected SQL insert failure");
  } };
  await assert.rejects(h.notifications.record(client, next, null), /SQL insert failure/);
  h.blob.setJSON = async () => { throw new Error("Injected dirty-hint failure"); };
  await assert.rejects(h.notifications.beforeWrite(next.id), /dirty-hint failure/);
  assert.equal(h.counts.database, 0);
  assert.equal(h.counts.sends, 0);
  await assert.rejects(h.notifications.afterWrite("different-order", { id: "not-uuid", orderId: next.id }), /hint/);
});

test("real disposable PostgreSQL proves outbox rollback/commit and ON CONFLICT duplicate safety", async (t) => {
  const isolated = await startIsolatedPostgres();
  let client;
  try {
    await isolated.pool.query(portalSchemaSql);
    const time = clock();
    const next = order(time);
    const care = normalizeCustomerCare({ emailEnabled: true });
    await isolated.pool.query("INSERT INTO op_shop_settings(id,data) VALUES ('default',$1::jsonb)", [JSON.stringify({ customerCare: care })]);
    const noSideEffects = () => assert.fail("The SQL hook cannot perform non-transactional work.");
    const notifications = createOrderNotifications({ database: noSideEffects, useDatabase: true, messages: {},
      control: { syncRetry: noSideEffects }, readCare: noSideEffects,
      runtimeConfig: () => ({ allowed: true, apiKey: "fake", from: "sender@example.com", portalUrl: "https://portal.example.com" }),
      blobStore: noSideEffects, namespace: "production", now: time.now });
    client = await isolated.pool.connect();
    const insertOrder = () => client.query("INSERT INTO op_orders(id,reference,customer_id,data) VALUES ($1,$2,$3,$4::jsonb)", [next.id, next.reference, next.customer.id, JSON.stringify(next)]);
    await client.query("BEGIN");
    await insertOrder();
    await notifications.record(client, next, null);
    assert.equal(Number((await client.query("SELECT count(*) FROM op_customer_messages")).rows[0].count), 1);
    await client.query("ROLLBACK");
    assert.equal(Number((await isolated.pool.query("SELECT count(*) FROM op_orders")).rows[0].count), 0);
    assert.equal(Number((await isolated.pool.query("SELECT count(*) FROM op_customer_messages")).rows[0].count), 0);
    await client.query("BEGIN");
    await insertOrder();
    await notifications.record(client, next, null);
    await client.query("COMMIT");
    assert.equal(Number((await isolated.pool.query("SELECT count(*) FROM op_orders")).rows[0].count), 1);
    const saved = await isolated.pool.query("SELECT data FROM op_customer_messages");
    assert.equal(saved.rows.length, 1);
    const original = saved.rows[0].data;
    await client.query("BEGIN");
    assert.equal((await notifications.record(client, next, null)).recorded, 0);
    await client.query("COMMIT");
    assert.deepEqual((await isolated.pool.query("SELECT data FROM op_customer_messages")).rows[0].data, original);

    await t.test("record-store -> JSONB round trip -> afterWrite delivers payment-ready exactly once", async () => {
      const blob = blobs();
      const retries = new Map();
      const messages = createCustomerMessageStore({ database: async () => isolated.pool, useDatabase: () => true, localAllowed: false });
      let sends = 0;
      let outbox;
      const records = createRecordStore({ database: async () => isolated.pool, useDatabase: true,
        onOrderWrite: (transactionClient, savedOrder, previous) => outbox.record(transactionClient, savedOrder, previous) });
      outbox = createOrderNotifications({ database: async () => isolated.pool, useDatabase: true, messages,
        control: {
          read: async () => ({ paused: false }), emailEnabled: async () => true,
          syncRetry: async (message) => {
            if (!message) return;
            if (["pending", "failed", "sending"].includes(message.status)) retries.set(message.id, clone(message));
            else retries.delete(message.id);
          },
        },
        readCare: async () => (await isolated.pool.query("SELECT data->'customerCare' AS care FROM op_shop_settings WHERE id='default'")).rows[0].care,
        getOrder: (id) => records.orders.get(id), blobStore: async () => blob, namespace: "production", now: time.now,
        runtimeConfig: () => ({ allowed: true, apiKey: "offline", from: "sender@example.com", portalUrl: "https://portal.example.com",
          fetchImpl: async (url, options) => {
            assert.equal(url, "https://api.resend.com/emails");
            const id = options.headers["idempotency-key"];
            assert.ok(retries.has(id), "The real SQL message must have a durable retry hint before delivery.");
            const claimed = (await isolated.pool.query("SELECT status,data FROM op_customer_messages WHERE id=$1", [id])).rows[0];
            assert.equal(claimed.status, "sending");
            assert.equal(claimed.data.attempts, 1);
            sends++;
            return { ok: true, json: async () => ({ id: `offline-jsonb-${sends}` }) };
          },
        }),
      });
      const base = { ...order(time, "jsonb-payment-order"), statusEvents: [], paymentLink: null };
      await records.orders.insert(base);
      // This is the same field insertion order used by attachPaymentLink.
      const paymentLink = { provider: "yoco", url: "https://pay.example.com/fixture", reference: base.reference,
        note: "Fixture", amount: 25, attachedAt: time.iso(), attachedBy: "fixture-admin" };
      const hint = await outbox.beforeWrite(base.id);
      await records.orders.update(base.id, (current) => {
        current.paymentLink = clone(paymentLink);
        current.statusEvents.push({ type: "payment_link_attached", at: time.iso() });
        return current;
      });
      const roundTrip = await records.orders.get(base.id);
      assert.deepEqual(roundTrip.paymentLink, paymentLink);
      assert.notEqual(JSON.stringify(roundTrip.paymentLink), JSON.stringify(paymentLink), "PostgreSQL must actually reorder this fixture's JSONB keys.");
      const before = (await isolated.pool.query("SELECT data FROM op_customer_messages WHERE order_id=$1", [base.id])).rows;
      assert.equal(before.length, 1);
      assert.equal(before[0].data.event, "payment_ready");
      assert.equal(before[0].data.status, "pending");
      assert.equal((await outbox.afterWrite(base.id, hint)).sent, 1, "A valid JSONB round trip must deliver rather than supersede the message.");
      const delivered = (await isolated.pool.query("SELECT status,data FROM op_customer_messages WHERE order_id=$1", [base.id])).rows[0];
      assert.equal(delivered.status, "sent");
      assert.equal(delivered.data.status, "sent");
      assert.equal(delivered.data.attempts, 1);
      assert.equal(delivered.data.deliveryId, "offline-jsonb-1");
      assert.equal(sends, 1);
      assert.equal(retries.size, 0);
      assert.equal(blob.entries.size, 0);

      // Resaving a link fetched from JSONB must hit the SAME deterministic ID.
      const resaveHint = await outbox.beforeWrite(base.id);
      await records.orders.update(base.id, (current) => {
        current.statusEvents.push({ type: "payment_link_attached", at: time.iso() });
        return current;
      });
      assert.equal((await outbox.afterWrite(base.id, resaveHint)).sent, 0);
      const resaved = (await isolated.pool.query("SELECT data FROM op_customer_messages WHERE order_id=$1", [base.id])).rows;
      assert.equal(resaved.length, 1);
      assert.equal(resaved[0].data.id, before[0].data.id);
      assert.equal(resaved[0].data.status, "sent");
      assert.equal(resaved[0].data.attempts, 1);
      assert.equal(sends, 1);
    });
  } finally {
    if (client) { await client.query("ROLLBACK").catch(() => {}); client.release(); }
    await isolated.close();
  }
});

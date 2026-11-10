import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { reportingPeriod } from "../lib/admin-period.mjs";
import { createRecordStore } from "../lib/record-store.mjs";
import { createCustomerMessageStore } from "../lib/customer-message-store.mjs";
import { portalSchemaSql } from "../lib/database-schema.mjs";
import { startIsolatedPostgres } from "./isolated-postgres.mjs";
import { startIsolatedPortal } from "./isolated-portal.mjs";

const now = Date.parse("2026-11-10T12:00:00Z");
const period = reportingPeriod(new URLSearchParams("period=today"), { now });
const order = (id, extra = {}) => ({ id, reference: `OP-${id}`, customer: { id: "demo-user", name: "Fixture Customer", email: "customer@portal.test" },
  items: [{ variantId: "variant", quantity: 1, price: 100 }], total: 250, paymentStatus: "pending", fulfillmentStatus: "not_ready", fulfillmentReview: { status: "reviewed" },
  createdAt: "2026-11-10T10:00:00Z", ...extra });
const fixtures = [
  order("review", { fulfillmentReview: { status: "pending" } }), order("details"),
  order("verify", { paymentLink: { url: "https://pay.test" }, paymentIssue: { type: "paid_pending" } }),
  order("awaiting", { paymentLink: { url: "https://pay.test" } }),
  order("storage", { paymentStatus: "confirmed", shopifySync: { status: "storage_pending" } }),
  order("uncertain", { paymentStatus: "confirmed", shopifySync: { status: "reconciliation_required" } }),
  order("tracking", { paymentStatus: "confirmed", shopifyOrder: { id: "remote-1" } }),
  order("packing", { paymentStatus: "confirmed", shopifyOrder: { id: "remote-2" }, tracking: { number: "TRACK-2" } }),
  order("external", { paymentStatus: "confirmed", fulfillmentAllocations: [{ variantId: "variant", officeQuantity: 0, externalQuantity: 1 }] }),
  order("split", { paymentStatus: "confirmed", shopifyOrder: { id: "remote-3" }, fulfillmentAllocations: [{ variantId: "variant", officeQuantity: 1, externalQuantity: 1 }] }),
  order("backorder", { paymentStatus: "confirmed", fulfillmentStatus: "back_order" }),
  order("rejected", { paymentStatus: "rejected", paymentIssue: { type: "paid_pending" } }),
  order("declined", { specialOrder: { status: "declined" } }),
  order("completed", { paymentStatus: "confirmed", fulfillmentStatus: "shipped" }),
  order("old-work", { createdAt: "2025-01-01T00:00:00Z", fulfillmentReview: { status: "pending" } }),
  order("boundary-start", { createdAt: period.from }), order("boundary-last", { createdAt: "2026-11-10T21:59:59.999Z" }),
  order("before", { createdAt: "2026-11-09T21:59:59.999Z" }), order("after", { createdAt: period.to }),
  ...Array.from({ length: 60 }, (_, index) => order(`history-${index}`, { createdAt: "2025-02-01T00:00:00Z", paymentStatus: "confirmed", fulfillmentStatus: "shipped" })),
];

test("reporting uses South Africa day boundaries, inclusive end dates, leap dates and strict range validation", () => {
  assert.equal(period.from, "2026-11-09T22:00:00.000Z"); assert.equal(period.to, "2026-11-10T22:00:00.000Z");
  const last7 = reportingPeriod(new URLSearchParams("period=7d"), { now }); assert.equal(last7.fromDate, "2026-11-04");
  assert.equal(reportingPeriod(new URLSearchParams("period=custom&from=2024-02-29&to=2024-03-01"), { now }).to, "2024-03-01T22:00:00.000Z");
  for (const query of ["period=nope", "period=custom&from=2026-02-30&to=2026-03-05", "period=custom&from=2026-11-11&to=2026-11-10", "period=custom"]) assert.throws(() => reportingPeriod(new URLSearchParams(query), { now }), error => error.status === 400);
});

test("Postgres and local dashboard totals agree across all records and every queue drills down to its exact count", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "op-dashboard-"));
  const pg = await startIsolatedPostgres();
  try {
    await pg.pool.query(portalSchemaSql);
    const local = createRecordStore({ database: () => { throw new Error("Unexpected DB access"); }, ordersPath: path.join(directory, "orders.json"), usersPath: path.join(directory, "users.json") });
    const sql = createRecordStore({ database: async () => pg.pool, useDatabase: true });
    for (const entry of fixtures) { await local.orders.insert(entry); await sql.orders.insert(entry); }
    const scoped = await local.orders.overview({ ...period, shopifySyncRequired: true });
    assert.deepEqual(await sql.orders.overview({ ...period, shopifySyncRequired: true }), scoped);
    assert.equal(scoped.total, 16); assert.equal(scoped.total, scoped.unprocessed + scoped.processing + scoped.completed + scoped.closed);
    assert.equal(scoped.closed, 2); assert.equal(scoped.completed, 1); assert.equal(scoped.value, 3500);
    assert.equal(scoped.attention.review, 2, "Old unresolved work remains visible outside the selected reporting period");
    assert.equal(scoped.attention.external, 2); assert.equal(scoped.attention.tracking, 2); assert.equal(scoped.attention.packing, 1);
    for (const [key, count] of Object.entries(scoped.attention)) {
      const options = { queue: key, shopifySyncRequired: true, limit: 200 };
      const actual = await sql.orders.list(options), expected = await local.orders.list(options);
      assert.deepEqual(actual.map(row => row.id).sort(), expected.map(row => row.id).sort(), key);
      assert.equal(actual.length, count, key); assert.equal(await sql.orders.count(options), count);
    }
    for (const key of ["unprocessed", "processing", "completed", "closed"]) assert.equal(await sql.orders.count({ ...period, queue: key }), scoped[key]);
    assert.equal((await sql.orders.overview()).total, fixtures.length); assert.ok((await sql.orders.overview()).completed > 50);
    const localMessages = createCustomerMessageStore({ useDatabase: () => false, localAllowed: true, filePath: path.join(directory, "messages.json") });
    const sqlMessages = createCustomerMessageStore({ useDatabase: () => true, database: async () => pg.pool });
    const messages = [
      { id: "support-1", kind: "support", status: "open" }, { id: "support-2", kind: "support", status: "resolved" },
      { id: "email-1", kind: "email", status: "sent", deliveryStatus: "bounced" }, { id: "email-2", kind: "email", status: "sent", deliveryStatus: "delivered" },
      { id: "email-3", kind: "email", status: "sent", deliveryStatus: "delayed" },
    ].map(message => ({ ...message, customerId: "demo-user", to: "customer@portal.test", createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }));
    for (const entry of messages) { await localMessages.insert(entry); await sqlMessages.insert(entry); }
    assert.deepEqual(await sqlMessages.overview(), { support: 1, email: 2 });
    assert.deepEqual(await localMessages.overview(), await sqlMessages.overview());
    assert.equal((await sqlMessages.emailPage({ status: "attention" })).counts.total, 2);
    assert.equal((await localMessages.emailPage({ status: "attention" })).counts.total, 2);
    for (let index=0;index<225;index++) {
      const entry={id:`support-extra-${String(index).padStart(3,"0")}`,kind:"support",status:"open",customerId:"demo-user",createdAt:new Date(now+index+1).toISOString(),updatedAt:new Date(now+index+1).toISOString()};
      await localMessages.insert(entry);await sqlMessages.insert(entry);
    }
    const lastPage=await sqlMessages.supportPage({offset:200});
    assert.equal(lastPage.counts.open,226);assert.equal(lastPage.requests.length,26);assert.equal(lastPage.page.hasMore,false);
    assert.deepEqual(await localMessages.supportPage({offset:200}),lastPage);
    const extra=[order("retry-disabled",{paymentStatus:"confirmed",shopifySync:{status:"disabled"}}),
      order("retry-stale",{paymentStatus:"confirmed",shopifySync:{status:"creating",leaseExpiresAt:new Date(Date.now()-10000).toISOString()}}),
      order("sync-live",{paymentStatus:"confirmed",shopifySync:{status:"creating",leaseExpiresAt:new Date(Date.now()+60000).toISOString()}})];
    for(const entry of extra){await local.orders.insert(entry);await sql.orders.insert(entry);}
    for(const required of [true,false]) {
      const options={queue:"sync",shopifySyncRequired:required,ids:extra.map(entry=>entry.id)};
      const actual=await sql.orders.list(options),expected=await local.orders.list(options);
      assert.deepEqual(actual.map(entry=>entry.id).sort(),expected.map(entry=>entry.id).sort());
      assert.equal(actual.length,required?2:1);assert.ok(actual.some(entry=>entry.id==="retry-stale"));
    }
  } finally {
    await pg.close();
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("op-dashboard-")) throw new Error("Unexpected fixture directory");
    await rm(directory, { recursive: true, force: true });
  }
});

test("dashboard and dated drilldowns require a current admin and return complete counts with bounded private data", async () => {
  const portal = await startIsolatedPortal(); let cookie = "";
  async function api(url, body, expected = 200) {
    const response = await fetch(portal.url + url, { method: body ? "POST" : "GET", headers: { cookie, "x-op-client": "portal", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
    const payload = await response.json(); assert.equal(response.status, expected, JSON.stringify(payload)); return payload;
  }
  try {
    await api("/api/admin/dashboard", null, 401);
    await api("/api/auth/login", { login: "user", password: "user" });
    await api("/api/admin/dashboard", null, 401);
    await api("/api/auth/admin-login", { username: "admin", password: "admin" });
    await writeFile(path.join(portal.directory, "data/orders.json"), JSON.stringify({ orders: fixtures }));
    const result = await api("/api/admin/dashboard?period=custom&from=2026-11-10&to=2026-11-10");
    assert.equal(result.orders.total, 16); assert.equal(result.recent.length, 8); assert.deepEqual(result.unavailable, []);
    assert.equal(result.shopifySyncEnabled, false); assert.equal(JSON.stringify(result.recent).includes("paymentLink"), false);
    const all = await api("/api/admin/orders?period=all&view=all&limit=50");
    assert.equal(all.total, fixtures.length); assert.equal(all.orders.length, 50); assert.equal(all.page.hasMore, true);
    const completed = await api("/api/admin/orders?period=custom&from=2026-11-10&to=2026-11-10&queue=completed");
    assert.equal(completed.total, result.orders.completed);
    await api("/api/admin/dashboard?period=custom&from=2026-11-11&to=2026-11-10", null, 400);
    await api("/api/admin/orders?queue=unknown", null, 400);
  } finally { await portal.close(); }
});

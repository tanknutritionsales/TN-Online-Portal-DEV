import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// These are shared by store instances in this process, not by separate processes.
const fileQueues = new Map();
const fileBootstraps = new Map();
const databaseBootstraps = new WeakMap();
const membershipLock = "op_record_store_admin_membership";
const copy = (value) => structuredClone(value);
const present = (value) => value !== undefined && value !== null;
const fail = (message, status = 409, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const userConflict = () => fail("User already exists.");
const referenceConflict = () => fail("Order reference already exists.", 409, "ORDER_REFERENCE_CONFLICT");
const hashConflict = () => fail("This submission key was already used for a different request.", 409, "ORDER_IDEMPOTENCY_CONFLICT");
const missingSubmission = () => fail("The submitted order is no longer available.", 409, "ORDER_SUBMISSION_MISSING");

function fileKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function queued(filePath, action) {
  const key = fileKey(filePath);
  const current = (fileQueues.get(key) || Promise.resolve()).catch(() => {}).then(action);
  fileQueues.set(key, current);
  try { return await current; }
  finally { if (fileQueues.get(key) === current) fileQueues.delete(key); }
}

async function readLocal(filePath, kind) {
  let payload;
  try { payload = JSON.parse(await readFile(filePath, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return { version: 1, updatedAt: null, [kind]: [] };
    throw error;
  }
  // A corrupt file must never be mistaken for an empty store and overwritten.
  if (!payload || !Array.isArray(payload[kind])) throw new Error(`Invalid ${kind} store.`);
  if (kind === "orders" && present(payload.submissions) && !Array.isArray(payload.submissions)) throw new Error("Invalid order submissions store.");
  return payload;
}

async function writeLocal(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ ...payload, updatedAt: new Date().toISOString() }, null, 2), { flag: "wx" });
    await rename(temporary, filePath);
  } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
}

async function transaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function lock(client, key) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
}

function page({ limit = 200, offset = 0 }) {
  const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.floor(Number(value)))) : fallback;
  return { limit: bounded(limit, 200, 1, 501), offset: bounded(offset, 0, 0, Number.MAX_SAFE_INTEGER) };
}

function assertRecord(record, id) {
  if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.id !== "string" || !record.id.trim()) throw fail("A record ID is required.", 400);
  if (present(id) && record.id !== id) throw fail("A record ID cannot be changed.", 400);
}

function orderError(error) {
  if (error?.code !== "23505") return error;
  if (/reference/i.test(error.constraint || "") || /\bKey\s+\(reference\)\s*=/i.test(error.detail || "")) return referenceConflict();
  return fail("Order already exists.", 409, "ORDER_ID_CONFLICT");
}

const orderSort = (a, b) => ((Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)) || String(b.id).localeCompare(String(a.id));
const userSort = (a, b) => a.role.localeCompare(b.role) || String(a.name || "").toLowerCase().localeCompare(String(b.name || "").toLowerCase()) || a.username.localeCompare(b.username) || a.id.localeCompare(b.id);

const arraySql = (expression) => `(CASE WHEN jsonb_typeof(${expression}) = 'array' THEN ${expression} ELSE '[]'::jsonb END)`;
const allocationsSql = `(CASE WHEN jsonb_array_length(${arraySql("data->'fulfillmentAllocations'")}) > 0 THEN ${arraySql("data->'fulfillmentAllocations'")} ELSE ${arraySql("data->'specialOrder'->'fulfillmentAllocations'")} END)`;
const numberSql = (expression) => `(CASE WHEN ${expression} ~ '^-?[0-9]+([.][0-9]+)?$' THEN (${expression})::numeric ELSE 0 END)`;
const noSpecialSql = "(data->'specialOrder' IS NULL OR data->'specialOrder' = 'null'::jsonb)";
const readyForPaymentSql = `((COALESCE(data->'fulfillmentReview'->>'status', '') <> 'pending') AND (${noSpecialSql} OR data->'specialOrder'->>'status' IN ('accepted', 'countered')))`;
const completedSql = "(fulfillment_status = 'shipped' OR COALESCE(data->'specialOrder'->>'status', '') = 'declined')";

const closedSql = "(payment_status = 'rejected' OR COALESCE(data->'specialOrder'->>'status', '') = 'declined')";
const liveSql = `(NOT ${closedSql} AND fulfillment_status <> 'shipped')`;
function queueSql(queue, syncRequired = false) {
  const paid = `${liveSql} AND payment_status = 'confirmed'`, unpaid = `${liveSql} AND payment_status <> 'confirmed'`;
  const office = `${paid} AND ${hasRouteSql("office")} AND COALESCE(data->>'officeShippedAt','') = ''`;
  const staleSync = `(data->'shopifySync'->>'status' IN ('creating','syncing') AND COALESCE(data->'shopifySync'->>'leaseExpiresAt','') <= to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;
  const syncNeeded = `(data->'shopifySync'->>'status' IN ('error','reconciliation_required') OR ${staleSync}${syncRequired ? " OR COALESCE(data->'shopifySync'->>'status','not_started') NOT IN ('storage_pending','creating','syncing')" : ""})`;
  const stockReady = `COALESCE(data->'shopifySync'->>'status','') NOT IN ('storage_pending','error','reconciliation_required','creating','syncing')${syncRequired ? " AND COALESCE(data->'shopifyOrder'->>'id','') <> ''" : ""}`;
  const checks = {
    unprocessed: unpaid, processing: paid, completed: `NOT ${closedSql} AND fulfillment_status = 'shipped'`, closed: closedSql,
    review: `${unpaid} AND NOT ${readyForPaymentSql}`,
    details: `${unpaid} AND ${readyForPaymentSql} AND (data->'paymentLink' IS NULL OR data->'paymentLink' = 'null'::jsonb)`,
    awaiting_payment: `${unpaid} AND data->'paymentLink' IS NOT NULL AND data->'paymentLink' <> 'null'::jsonb AND COALESCE(data->'paymentIssue'->>'type','') <> 'paid_pending'`,
    verify: `${unpaid} AND data->'paymentIssue'->>'type' = 'paid_pending'`,
    storage: `${office} AND data->'shopifySync'->>'status' = 'storage_pending'`,
    sync: `${office} AND COALESCE(data->'shopifyOrder'->>'id','') = '' AND ${syncNeeded}`,
    tracking: `${office} AND fulfillment_status = 'not_ready' AND ${stockReady} AND COALESCE(data->'tracking'->>'number','') = ''`,
    packing: `${office} AND fulfillment_status = 'not_ready' AND ${stockReady} AND COALESCE(data->'tracking'->>'number','') <> ''`,
    external: `${paid} AND ${hasRouteSql("external")} AND COALESCE(data->'externalTracking'->>'number','') = ''`,
    back_order: `${paid} AND fulfillment_status = 'back_order'`,
    payment_support: `${liveSql} AND data->'paymentIssue' IS NOT NULL AND data->'paymentIssue' <> 'null'::jsonb AND COALESCE(data->'paymentIssue'->>'status','') <> 'resolved' AND COALESCE(data->'paymentIssue'->>'type','') <> 'paid_pending'`,
  };
  if (!Object.hasOwn(checks, queue)) throw fail("Invalid order queue.", 400);
  return `(${checks[queue]})`;
}
const attentionQueues = ["verify", "review", "details", "storage", "sync", "tracking", "packing", "external", "back_order", "payment_support"];
function localQueue(order, queue, syncRequired) {
  const closed = order.paymentStatus === "rejected" || order.specialOrder?.status === "declined";
  const live = !closed && order.fulfillmentStatus !== "shipped", paid = live && order.paymentStatus === "confirmed", unpaid = live && !paid;
  const office = paid && localRoute(order, "office") && !order.officeShippedAt;
  const syncStatus = order.shopifySync?.status;
  const syncNeeded = ["error", "reconciliation_required"].includes(syncStatus)
    || (["creating", "syncing"].includes(syncStatus) && (Date.parse(order.shopifySync?.leaseExpiresAt) || 0) <= Date.now())
    || (syncRequired && !["storage_pending", "creating", "syncing"].includes(syncStatus));
  const ready = !["storage_pending", "error", "reconciliation_required", "creating", "syncing"].includes(order.shopifySync?.status) && (!syncRequired || Boolean(order.shopifyOrder?.id));
  const paymentReady = order.fulfillmentReview?.status !== "pending" && (!order.specialOrder || ["accepted", "countered"].includes(order.specialOrder.status));
  const checks = {
    unprocessed: unpaid, processing: paid, completed: !closed && order.fulfillmentStatus === "shipped", closed,
    review: unpaid && !paymentReady, details: unpaid && paymentReady && !order.paymentLink,
    awaiting_payment: unpaid && Boolean(order.paymentLink) && order.paymentIssue?.type !== "paid_pending",
    verify: unpaid && order.paymentIssue?.type === "paid_pending",
    storage: office && order.shopifySync?.status === "storage_pending",
    sync: office && !order.shopifyOrder?.id && syncNeeded,
    tracking: office && (order.fulfillmentStatus || "not_ready") === "not_ready" && ready && !order.tracking?.number,
    packing: office && (order.fulfillmentStatus || "not_ready") === "not_ready" && ready && Boolean(order.tracking?.number),
    external: paid && localRoute(order, "external") && !order.externalTracking?.number,
    back_order: paid && order.fulfillmentStatus === "back_order",
    payment_support: live && Boolean(order.paymentIssue) && order.paymentIssue.status !== "resolved" && order.paymentIssue.type !== "paid_pending",
  };
  return Boolean(checks[queue]);
}

function hasRouteSql(route) {
  const quantity = `COALESCE((SELECT ${numberSql(`allocation->>'${route}Quantity'`)} FROM jsonb_array_elements(${allocationsSql}) AS allocation WHERE allocation->>'variantId' = item->>'variantId' LIMIT 1), ${route === "office" ? numberSql("item->>'quantity'") : "0"})`;
  const unallocated = route === "office" ? `(${noSpecialSql} OR data->'specialOrder'->>'status' IN ('accepted', 'countered'))` : "false";
  return `EXISTS (SELECT 1 FROM jsonb_array_elements(${arraySql("data->'items'")}) AS item WHERE CASE WHEN jsonb_array_length(${allocationsSql}) = 0 THEN ${unallocated} ELSE ${quantity} > 0 END)`;
}

function orderConditions({ customerId, ids, paymentStatus, fulfillmentStatus, view, filter, search, active, internal, shopifySyncRequired, queue, from, to } = {}) {
  if (present(ids) && !Array.isArray(ids)) throw fail("Order IDs must be an array.", 400);
  if (present(view) && !["all", "pending", "ready", "external", "completed"].includes(view)) throw fail("Invalid order view.", 400);
  if (present(filter) && !["all", "needs_payment_details", "payment_to_verify", "special_review", "fulfillment_review", "support"].includes(filter)) throw fail("Invalid order filter.", 400);
  if (present(internal) && !["confirmed", "history"].includes(internal)) throw fail("Invalid internal order scope.", 400);
  const conditions = [], values = [];
  if (queue) conditions.push(queueSql(queue, shopifySyncRequired));
  for (const [operator, value] of [[">=", from], ["<", to]]) if (value) {
    if (!Number.isFinite(Date.parse(value))) throw fail("Invalid order date.", 400);
    values.push(value); conditions.push(`created_at ${operator} $${values.length}::timestamptz`);
  }
  for (const [column, value] of [["customer_id", customerId], ["id", ids], ["payment_status", paymentStatus], ["fulfillment_status", fulfillmentStatus]]) {
    if (!present(value)) continue;
    values.push(Array.isArray(value) ? [...new Set(value)] : value);
    conditions.push(`${column} ${Array.isArray(value) ? `= ANY($${values.length}::text[])` : `= $${values.length}`}`);
  }
  if (view === "completed") conditions.push(completedSql);
  if (view === "pending") conditions.push(`NOT ${completedSql}`, "NOT (payment_status = 'confirmed' AND fulfillment_status = 'not_ready')");
  if (view === "ready") conditions.push(`NOT ${completedSql}`, "payment_status = 'confirmed'", "fulfillment_status = 'not_ready'", "COALESCE(data->>'officeShippedAt', '') = ''", hasRouteSql("office"));
  if (view === "external") conditions.push("payment_status = 'confirmed'", "fulfillment_status <> 'shipped'", "COALESCE(data->'externalTracking'->>'number', '') = ''", hasRouteSql("external"));
  if (filter === "needs_payment_details") conditions.push("(data->'paymentLink' IS NULL OR data->'paymentLink' = 'null'::jsonb)", readyForPaymentSql);
  if (filter === "payment_to_verify") conditions.push("data->'paymentIssue'->>'type' = 'paid_pending'");
  if (filter === "special_review") conditions.push("data->'specialOrder'->>'status' = 'pending'");
  if (filter === "fulfillment_review") conditions.push(`NOT ${readyForPaymentSql}`, "COALESCE(data->'specialOrder'->>'status', '') <> 'pending'");
  if (filter === "support") conditions.push("data->'paymentIssue' IS NOT NULL", "data->'paymentIssue' <> 'null'::jsonb", "COALESCE(data->'paymentIssue'->>'status', '') <> 'resolved'", "COALESCE(data->'paymentIssue'->>'type', '') <> 'paid_pending'");
  if (String(search || "").trim()) {
    values.push(`%${String(search).trim().replace(/[\\%_]/g, "\\$&")}%`);
    conditions.push(`data::text ILIKE $${values.length}`);
  }
  if (active === true) conditions.push("COALESCE(data->'specialOrder'->>'status', '') <> 'declined'", "NOT EXISTS (SELECT 1 FROM op_customer_messages AS receipt WHERE receipt.kind = 'delivery_receipt' AND receipt.order_id = op_orders.id AND (receipt.status = 'received' OR COALESCE(receipt.data->>'receivedAt', '') <> ''))");
  if (internal) {
    conditions.push("payment_status = 'confirmed'", hasRouteSql("office"));
    if (internal === "confirmed") conditions.push("fulfillment_status <> 'shipped'", "COALESCE(data->>'officeShippedAt', '') = ''");
    else conditions.push("(fulfillment_status = 'shipped' OR COALESCE(data->>'officeShippedAt', '') <> '')");
    if (shopifySyncRequired === true) conditions.push("COALESCE(data->'shopifyOrder'->>'id', '') <> ''");
  }
  return { where: conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "", values };
}

function localRoute(order, route) {
  const allocations = order.fulfillmentAllocations?.length ? order.fulfillmentAllocations : order.specialOrder?.fulfillmentAllocations || [];
  if (!allocations.length) return route === "office" && (order.items || []).length > 0 && (!order.specialOrder || ["accepted", "countered"].includes(order.specialOrder.status));
  return (order.items || []).some((item) => {
    const allocation = allocations.find((entry) => entry.variantId === item.variantId);
    return Number(allocation ? allocation[`${route}Quantity`] || 0 : route === "office" ? item.quantity || 0 : 0) > 0;
  });
}

function localOrderMatches(order, options, received) {
  const { customerId, ids, paymentStatus, fulfillmentStatus, view, filter, active, internal, shopifySyncRequired } = options;
  const matches = (value, expected) => !present(expected) || (Array.isArray(expected) ? expected.includes(value) : value === expected);
  if (!matches(order.customer?.id, customerId) || (ids && !ids.has(order.id)) || !matches(order.paymentStatus || "pending", paymentStatus) || !matches(order.fulfillmentStatus || "not_ready", fulfillmentStatus)) return false;
  if (options.from && !(Date.parse(order.createdAt) >= Date.parse(options.from))) return false;
  if (options.to && !(Date.parse(order.createdAt) < Date.parse(options.to))) return false;
  if (options.queue && !localQueue(order, options.queue, shopifySyncRequired)) return false;
  const completed = order.fulfillmentStatus === "shipped" || order.specialOrder?.status === "declined";
  const ready = !completed && order.paymentStatus === "confirmed" && (order.fulfillmentStatus || "not_ready") === "not_ready";
  if (view === "completed" && !completed) return false;
  if (view === "pending" && (completed || ready)) return false;
  if (view === "ready" && (!ready || !localRoute(order, "office") || order.officeShippedAt)) return false;
  if (view === "external" && (order.paymentStatus !== "confirmed" || order.fulfillmentStatus === "shipped" || order.externalTracking?.number || !localRoute(order, "external"))) return false;
  const paymentReady = order.fulfillmentReview?.status !== "pending" && (!order.specialOrder || ["accepted", "countered"].includes(order.specialOrder.status));
  if (filter === "needs_payment_details" && (order.paymentLink || !paymentReady)) return false;
  if (filter === "payment_to_verify" && order.paymentIssue?.type !== "paid_pending") return false;
  if (filter === "special_review" && order.specialOrder?.status !== "pending") return false;
  if (filter === "fulfillment_review" && (paymentReady || order.specialOrder?.status === "pending")) return false;
  if (filter === "support" && (!order.paymentIssue || order.paymentIssue.status === "resolved" || order.paymentIssue.type === "paid_pending")) return false;
  if (active === true && (order.specialOrder?.status === "declined" || received.has(order.id))) return false;
  if (internal) {
    if (order.paymentStatus !== "confirmed" || !localRoute(order, "office")) return false;
    const dispatched = order.fulfillmentStatus === "shipped" || Boolean(order.officeShippedAt);
    if ((internal === "history") !== dispatched) return false;
    if (shopifySyncRequired === true && !order.shopifyOrder?.id) return false;
  }
  const search = String(options.search || "").trim().toLowerCase();
  return !search || JSON.stringify(order).toLowerCase().includes(search);
}

/**
 * database() must return a pg-compatible Pool after the parent ensures schema.
 * No migrations, legacy Blob reads, or snapshot upserts occur here.
 * Transforms run with locks held: keep them local. A null transform or unchanged
 * JSON returns the current record without writing; a missing row returns null.
 * SQL updated_at is maintained here; JSON updatedAt belongs to the caller.
 * onOrderWrite(client, next, current) runs only for actual writes,
 * before commit/rename. A SQL outbox hook must use this transaction's client.
 * Insert current is null. Local client is null; other files are not transactional.
 * Local orders retain {version, updatedAt, orders}, with an additive submissions
 * ledger so retries remain durable even when order JSON is subsequently changed.
 */
export function createRecordStore({ database, useDatabase = false, usersPath, ordersPath, seedUsers = () => [], normalizeUser = (user) => user, onOrderWrite }) {
  if (present(onOrderWrite) && typeof onOrderWrite !== "function") throw new TypeError("onOrderWrite must be a function.");
  const usesDatabase = () => typeof useDatabase === "function" ? useDatabase() : useDatabase;
  const db = async () => database();

  async function notifyOrderWrite(order, client, previous = null) {
    if (onOrderWrite) await onOrderWrite(client, copy(order), copy(previous));
  }

  function normalizedUser(input, id) {
    assertRecord(input, id);
    const user = copy(normalizeUser(copy(input)));
    assertRecord(user, input.id);
    user.username = String(user.username || "").trim().toLowerCase();
    user.email = String(user.email || "").trim().toLowerCase();
    user.role = user.role === "admin" ? "admin" : "customer";
    if (!user.username) throw fail("Username is required.", 400);
    return user;
  }

  const indexedEmail = (user) => user.email || `${user.username}@admin.local`;
  const loginKeys = (user) => [...new Set([user.username, indexedEmail(user)].filter(Boolean))];

  function assertLocalUser(users, user, excludedId) {
    const keys = new Set(loginKeys(user));
    if (users.some((entry) => entry.id !== excludedId && (entry.id === user.id || loginKeys(normalizedUser(entry)).some((key) => keys.has(key))))) throw userConflict();
  }

  async function assertDatabaseUser(client, user, excludedId = null) {
    const result = await client.query(
      "SELECT id FROM op_users WHERE ($2::text IS NULL OR id <> $2) AND (lower(username) = ANY($1::text[]) OR lower(email) = ANY($1::text[])) LIMIT 1",
      [loginKeys(user), excludedId],
    );
    if (result.rows.length) throw userConflict();
  }

  async function insertDatabaseUser(client, user) {
    await assertDatabaseUser(client, user);
    await client.query(
      `INSERT INTO op_users (id, username, email, role, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6::timestamptz, now()), now())`,
      [user.id, user.username, indexedEmail(user), user.role, JSON.stringify(user), user.createdAt || null],
    );
  }

  async function seeds() {
    const result = typeof seedUsers === "function" ? await seedUsers() : seedUsers;
    if (!Array.isArray(result)) throw new Error("seedUsers must return an array.");
    return result.map((user) => normalizedUser(user));
  }

  async function bootstrapDatabase(pool) {
    let promise = databaseBootstraps.get(pool);
    if (!promise) {
      promise = transaction(pool, async (client) => {
        await lock(client, membershipLock);
        const existing = await client.query("SELECT id FROM op_users LIMIT 1");
        if (!existing.rows.length) for (const user of await seeds()) await insertDatabaseUser(client, user);
      }).catch((error) => {
        if (databaseBootstraps.get(pool) === promise) databaseBootstraps.delete(pool);
        throw error?.code === "23505" ? userConflict() : error;
      });
      databaseBootstraps.set(pool, promise);
    }
    await promise;
  }

  async function bootstrapLocal() {
    const key = fileKey(usersPath);
    let promise = fileBootstraps.get(key);
    if (!promise) {
      promise = queued(usersPath, async () => {
        const payload = await readLocal(usersPath, "users");
        if (payload.users.length) return;
        const users = [];
        for (const user of await seeds()) { assertLocalUser(users, user); users.push(user); }
        if (users.length) await writeLocal(usersPath, { ...payload, users });
      }).catch((error) => {
        if (fileBootstraps.get(key) === promise) fileBootstraps.delete(key);
        throw error;
      });
      fileBootstraps.set(key, promise);
    }
    await promise;
  }

  async function userRead(sql, values, local) {
    if (usesDatabase()) {
      const pool = await db();
      await bootstrapDatabase(pool);
      return (await pool.query(sql, values)).rows.map((row) => normalizedUser(row.data));
    }
    await bootstrapLocal();
    return queued(usersPath, async () => local((await readLocal(usersPath, "users")).users.map((user) => normalizedUser(user))));
  }

  async function userWrite(postgres, local) {
    try {
      if (usesDatabase()) {
        const pool = await db();
        await bootstrapDatabase(pool);
        return await transaction(pool, async (client) => {
          // Bootstrap, insert, role mutation, and removal use this same lock.
          await lock(client, membershipLock);
          return postgres(client);
        });
      }
      await bootstrapLocal();
      return await queued(usersPath, async () => {
        const payload = await readLocal(usersPath, "users");
        const before = JSON.stringify(payload.users);
        const result = await local(payload.users);
        if (JSON.stringify(payload.users) !== before) await writeLocal(usersPath, payload);
        return result;
      });
    } catch (error) { throw error?.code === "23505" ? userConflict() : error; }
  }

  function guardDemotion(current, updated, adminCount) {
    if (current.role === "admin" && updated.role !== "admin" && adminCount <= 1) throw fail("At least one admin account must remain.");
  }

  const users = {
    async get(id) {
      return (await userRead("SELECT data FROM op_users WHERE id = $1", [id], (entries) => entries.filter((user) => user.id === id)))[0] || null;
    },
    async findLogin(login, { role } = {}) {
      const key = String(login || "").trim().toLowerCase();
      if (!key) return null;
      const matches = await userRead(
        `SELECT data FROM op_users WHERE (username = $1 OR email = $1)${present(role) ? " AND role = $2" : ""} LIMIT 2`,
        present(role) ? [key, role] : [key],
        (entries) => entries.filter((user) => loginKeys(user).includes(key) && (!present(role) || user.role === role)).slice(0, 2),
      );
      return matches.length === 1 ? matches[0] : null;
    },
    async list(options = {}) {
      const { role } = options;
      const { limit, offset } = page(options);
      const values = present(role) ? [role, limit, offset] : [limit, offset];
      return userRead(
        `SELECT data FROM op_users${present(role) ? " WHERE role = $1" : ""} ORDER BY role, lower(COALESCE(data->>'name', '')), username, id LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
        (entries) => entries.filter((user) => !present(role) || user.role === role).sort(userSort).slice(offset, offset + limit),
      );
    },
    async counts() {
      if (usesDatabase()) {
        const pool = await db();
        await bootstrapDatabase(pool);
        const { rows } = await pool.query("SELECT count(*) AS all, count(*) FILTER (WHERE role = 'admin') AS admin, count(*) FILTER (WHERE role = 'customer') AS customer FROM op_users");
        return { all: Number(rows[0].all), admin: Number(rows[0].admin), customer: Number(rows[0].customer) };
      }
      await bootstrapLocal();
      return queued(usersPath, async () => {
        const entries = (await readLocal(usersPath, "users")).users;
        return { all: entries.length, admin: entries.filter((user) => user.role === "admin").length, customer: entries.filter((user) => user.role !== "admin").length };
      });
    },
    async insert(input) {
      const user = normalizedUser(input);
      return userWrite(async (client) => { await insertDatabaseUser(client, user); return copy(user); }, (entries) => {
        assertLocalUser(entries, user);
        entries.push(copy(user));
        return copy(user);
      });
    },
    async update(id, transform, { onWrite } = {}) {
      return userWrite(async (client) => {
        const result = await client.query("SELECT data FROM op_users WHERE id = $1 FOR UPDATE", [id]);
        if (!result.rows.length) return null;
        const current = normalizedUser(result.rows[0].data);
        const next = await transform(copy(current));
        if (next == null) return copy(current);
        const updated = normalizedUser(next, id);
        if (JSON.stringify(updated) === JSON.stringify(current)) return copy(current);
        if (current.role === "admin" && updated.role !== "admin") {
          const admins = await client.query("SELECT id FROM op_users WHERE role = 'admin'");
          guardDemotion(current, updated, admins.rows.length);
        }
        await assertDatabaseUser(client, updated, id);
        await client.query("UPDATE op_users SET username = $2, email = $3, role = $4, data = $5::jsonb, updated_at = now() WHERE id = $1", [id, updated.username, indexedEmail(updated), updated.role, JSON.stringify(updated)]);
        if (onWrite) await onWrite(client, updated, current);
        return updated;
      }, async (entries) => {
        const index = entries.findIndex((user) => user.id === id);
        if (index < 0) return null;
        const current = normalizedUser(entries[index]);
        const next = await transform(copy(current));
        if (next == null) return copy(current);
        const updated = normalizedUser(next, id);
        if (JSON.stringify(updated) === JSON.stringify(current)) return copy(current);
        guardDemotion(current, updated, entries.filter((user) => user.role === "admin").length);
        assertLocalUser(entries, updated, id);
        entries[index] = updated;
        if (onWrite) await onWrite(null, updated, current);
        return copy(updated);
      });
    },
    async remove(id, { actorId } = {}) {
      const guard = (actor, target, adminCount) => {
        if (!actor || actor.role !== "admin") throw fail("An active admin account is required.", 401);
        if (!target) return;
        if (id === actorId) throw fail("You cannot remove the admin account you are signed in with.");
        if (target.role === "admin" && adminCount <= 1) throw fail("At least one admin account must remain.");
      };
      return userWrite(async (client) => {
        const actor = await client.query("SELECT data FROM op_users WHERE id = $1 AND role = 'admin'", [actorId || null]);
        guard(actor.rows[0]?.data, null, 0);
        const target = await client.query("SELECT data FROM op_users WHERE id = $1 FOR UPDATE", [id]);
        if (!target.rows.length) return null;
        const current = normalizedUser(target.rows[0].data);
        const admins = current.role === "admin" ? await client.query("SELECT id FROM op_users WHERE role = 'admin'") : { rows: [] };
        guard(actor.rows[0].data, current, admins.rows.length);
        await client.query("DELETE FROM op_users WHERE id = $1", [id]);
        return current;
      }, (entries) => {
        const actor = entries.find((user) => user.id === actorId);
        const index = entries.findIndex((user) => user.id === id);
        guard(actor, entries[index], entries.filter((user) => user.role === "admin").length);
        if (index < 0) return null;
        return normalizedUser(entries.splice(index, 1)[0]);
      });
    },
  };

  function submissionInfo(customerId, key, requestHash) {
    if (!key) return null;
    if (typeof key !== "string" || typeof customerId !== "string" || !customerId) throw fail("A customer and submission key are required.", 400);
    return { customerId, key, hash: present(requestHash) ? String(requestHash) : undefined };
  }

  async function saveDatabaseSubmission(client, info, order) {
    await client.query("INSERT INTO op_order_submissions (customer_id, request_key, request_hash, order_id) VALUES ($1, $2, $3, $4)", [info.customerId, info.key, info.hash ?? "", order.id]);
  }

  async function databaseSubmission(client, info) {
    const saved = await client.query("SELECT request_hash, order_id FROM op_order_submissions WHERE customer_id = $1 AND request_key = $2", [info.customerId, info.key]);
    if (saved.rows.length) {
      if (present(info.hash) && saved.rows[0].request_hash !== info.hash) throw hashConflict();
      const found = await client.query("SELECT data FROM op_orders WHERE id = $1 AND customer_id = $2", [saved.rows[0].order_id, info.customerId]);
      if (!found.rows.length) throw missingSubmission();
      return found.rows[0].data;
    }
    // Old orders may predate the ledger. Bind the first retry without rewriting them.
    const legacy = await client.query("SELECT data FROM op_orders WHERE customer_id = $1 AND data->>'idempotencyKey' = $2 ORDER BY created_at, id LIMIT 1", [info.customerId, info.key]);
    const order = legacy.rows[0]?.data;
    if (!order) return null;
    if (present(info.hash) && present(order.requestHash) && order.requestHash !== info.hash) throw hashConflict();
    await saveDatabaseSubmission(client, { ...info, hash: info.hash ?? order.requestHash }, order);
    return order;
  }

  function localSubmission(payload, info) {
    const saved = (payload.submissions || []).find((entry) => entry.customerId === info.customerId && entry.requestKey === info.key);
    if (saved) {
      if (present(info.hash) && saved.requestHash !== info.hash) throw hashConflict();
      const order = payload.orders.find((entry) => entry.id === saved.orderId && entry.customer?.id === info.customerId);
      if (!order) throw missingSubmission();
      return { order, changed: false };
    }
    const order = payload.orders.find((entry) => entry.customer?.id === info.customerId && entry.idempotencyKey === info.key);
    if (!order) return { order: null, changed: false };
    if (present(info.hash) && present(order.requestHash) && order.requestHash !== info.hash) throw hashConflict();
    saveLocalSubmission(payload, { ...info, hash: info.hash ?? order.requestHash }, order);
    return { order, changed: true };
  }

  function saveLocalSubmission(payload, info, order) {
    (payload.submissions ||= []).push({ customerId: info.customerId, requestKey: info.key, requestHash: info.hash ?? "", orderId: order.id, createdAt: new Date().toISOString() });
  }

  function assertLocalOrder(entries, order, excludedId) {
    assertRecord(order, excludedId);
    if (typeof order.reference !== "string" || !order.reference.trim()) throw fail("An order reference is required.", 400);
    if (entries.some((entry) => entry.id !== excludedId && entry.id === order.id)) throw fail("Order already exists.", 409, "ORDER_ID_CONFLICT");
    if (entries.some((entry) => entry.id !== excludedId && entry.reference === order.reference)) throw referenceConflict();
  }

  async function matchingLocalOrders(options) {
    const received = new Set();
    if (options.active === true) {
      // This is the existing local customer-message store's sibling filename.
      try {
        const payload = JSON.parse(await readFile(path.join(path.dirname(ordersPath), "customer-messages.json"), "utf8"));
        if (!Array.isArray(payload.messages)) throw new Error("Invalid customer messages store.");
        for (const message of payload.messages) if (message.kind === "delivery_receipt" && (message.status === "received" || message.receivedAt)) received.add(message.orderId);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const filters = { ...options, ids: options.ids ? new Set(options.ids) : null };
    return (await readLocal(ordersPath, "orders")).orders.filter((order) => localOrderMatches(order, filters, received));
  }

  const orders = {
    async overview({ from, to, shopifySyncRequired = false } = {}) {
      const period = orderConditions({ from, to }), scoped = period.where ? period.where.slice(7) : "true";
      const queues = ["unprocessed", "processing", "completed", "closed"];
      if (usesDatabase()) {
        const total = numberSql("data->>'total'");
        const fields = [`count(*) AS lifetime_total`, `count(*) FILTER (WHERE ${scoped}) AS total`,
          ...queues.map(key => `count(*) FILTER (WHERE ${scoped} AND ${queueSql(key)}) AS ${key}`),
          `COALESCE(sum(${total}) FILTER (WHERE ${scoped} AND NOT ${closedSql}),0) AS value`,
          `COALESCE(sum(${total}) FILTER (WHERE ${scoped} AND NOT ${closedSql} AND payment_status='confirmed'),0) AS paid_value`,
          `COALESCE(sum(${total}) FILTER (WHERE ${scoped} AND ${queueSql("unprocessed")}),0) AS pending_value`,
          ...attentionQueues.map(key => `count(*) FILTER (WHERE ${queueSql(key, shopifySyncRequired)}) AS attention_${key}`)];
        const { rows } = await (await db()).query(`SELECT ${fields.join(",\n")} FROM op_orders`, period.values), row = rows[0];
        return { total: Number(row.total), lifetimeTotal: Number(row.lifetime_total), ...Object.fromEntries(queues.map(key => [key, Number(row[key])])),
          value: Number(row.value), paidValue: Number(row.paid_value), pendingValue: Number(row.pending_value),
          attention: Object.fromEntries(attentionQueues.map(key => [key, Number(row[`attention_${key}`])])) };
      }
      return queued(ordersPath, async () => {
        const entries = (await readLocal(ordersPath, "orders")).orders;
        const selected = entries.filter(order => localOrderMatches(order, { from, to }, new Set()));
        const sum = rows => Math.round(rows.reduce((amount, order) => amount + (Number.isFinite(Number(order.total)) ? Number(order.total) : 0), 0) * 100) / 100;
        return { total: selected.length, lifetimeTotal: entries.length, ...Object.fromEntries(queues.map(key => [key, selected.filter(order => localQueue(order, key)).length])),
          value: sum(selected.filter(order => !localQueue(order, "closed"))), paidValue: sum(selected.filter(order => !localQueue(order, "closed") && order.paymentStatus === "confirmed")),
          pendingValue: sum(selected.filter(order => localQueue(order, "unprocessed"))),
          attention: Object.fromEntries(attentionQueues.map(key => [key, entries.filter(order => localQueue(order, key, shopifySyncRequired)).length])) };
      });
    },
    async get(id, { customerId } = {}) {
      if (usesDatabase()) {
        const values = present(customerId) ? [id, customerId] : [id];
        const result = await (await db()).query(`SELECT data FROM op_orders WHERE id = $1${present(customerId) ? " AND customer_id = $2" : ""}`, values);
        return result.rows[0]?.data || null;
      }
      return queued(ordersPath, async () => (await readLocal(ordersPath, "orders")).orders.find((order) => order.id === id && (!present(customerId) || order.customer?.id === customerId)) || null);
    },
    async list(options = {}) {
      const { where, values } = orderConditions(options);
      const { limit, offset } = page(options);
      if (options.ids?.length === 0) return [];
      if (usesDatabase()) {
        values.push(limit, offset);
        const result = await (await db()).query(`SELECT data FROM op_orders${where} ORDER BY created_at DESC, id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
        return result.rows.map((row) => row.data);
      }
      return queued(ordersPath, async () => (await matchingLocalOrders(options)).sort(orderSort).slice(offset, offset + limit));
    },
    async count(options = {}) {
      const { where, values } = orderConditions(options);
      if (options.ids?.length === 0) return 0;
      if (usesDatabase()) {
        const { rows } = await (await db()).query(`SELECT count(*) AS count FROM op_orders${where}`, values);
        return Number(rows[0].count);
      }
      return queued(ordersPath, async () => (await matchingLocalOrders(options)).length);
    },
    async insert(input, { requestHash } = {}) {
      const order = copy(input);
      assertLocalOrder([], order);
      const info = submissionInfo(order.customer?.id, order.idempotencyKey, requestHash ?? order.requestHash ?? "");
      try {
        if (usesDatabase()) return await transaction(await db(), async (client) => {
          if (info) {
            await lock(client, JSON.stringify(["op_order_submission", info.customerId, info.key]));
            const existing = await databaseSubmission(client, info);
            if (existing) return { created: false, order: existing };
          }
          await client.query(
            `INSERT INTO op_orders (id, reference, customer_id, payment_status, fulfillment_status, data, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, COALESCE($7::timestamptz, now()), now())`,
            [order.id, order.reference, order.customer?.id || null, order.paymentStatus || "pending", order.fulfillmentStatus || "not_ready", JSON.stringify(order), order.createdAt || null],
          );
          if (info) await saveDatabaseSubmission(client, info, order);
          await notifyOrderWrite(order, client);
          return { created: true, order };
        });
        return await queued(ordersPath, async () => {
          const payload = await readLocal(ordersPath, "orders");
          if (info) {
            const existing = localSubmission(payload, info);
            if (existing.order) {
              if (existing.changed) await writeLocal(ordersPath, payload);
              return { created: false, order: existing.order };
            }
          }
          assertLocalOrder(payload.orders, order);
          payload.orders.unshift(order);
          if (info) saveLocalSubmission(payload, info, order);
          await notifyOrderWrite(order, null);
          await writeLocal(ordersPath, payload);
          return { created: true, order };
        });
      } catch (error) { throw orderError(error); }
    },
    async update(id, transform) {
      const apply = async (current) => {
        const input = copy(current);
        if (!present(input.statusEvents)) input.statusEvents = [];
        const updated = await transform(input);
        if (updated == null) return { order: copy(current), changed: false };
        assertLocalOrder([], updated, id);
        return { order: copy(updated), changed: JSON.stringify(updated) !== JSON.stringify(current) };
      };
      try {
        if (usesDatabase()) return await transaction(await db(), async (client) => {
          const result = await client.query("SELECT data FROM op_orders WHERE id = $1 FOR UPDATE", [id]);
          if (!result.rows.length) return null;
          const { order: updated, changed } = await apply(result.rows[0].data);
          if (!changed) return updated;
          await client.query("UPDATE op_orders SET reference = $2, customer_id = $3, payment_status = $4, fulfillment_status = $5, data = $6::jsonb, updated_at = now() WHERE id = $1", [id, updated.reference, updated.customer?.id || null, updated.paymentStatus || "pending", updated.fulfillmentStatus || "not_ready", JSON.stringify(updated)]);
          await notifyOrderWrite(updated, client, result.rows[0].data);
          return updated;
        });
        return await queued(ordersPath, async () => {
          const payload = await readLocal(ordersPath, "orders");
          const index = payload.orders.findIndex((order) => order.id === id);
          if (index < 0) return null;
          const { order: updated, changed } = await apply(payload.orders[index]);
          if (!changed) return updated;
          assertLocalOrder(payload.orders, updated, id);
          await notifyOrderWrite(updated, null, payload.orders[index]);
          payload.orders[index] = updated;
          await writeLocal(ordersPath, payload);
          return updated;
        });
      } catch (error) { throw orderError(error); }
    },
    async findSubmission(customerId, key, requestHash) {
      const info = submissionInfo(customerId, key, requestHash);
      if (!info) return null;
      if (usesDatabase()) return transaction(await db(), async (client) => {
        await lock(client, JSON.stringify(["op_order_submission", info.customerId, info.key]));
        return databaseSubmission(client, info);
      });
      return queued(ordersPath, async () => {
        const payload = await readLocal(ordersPath, "orders");
        const result = localSubmission(payload, info);
        if (result.changed) await writeLocal(ordersPath, payload);
        return result.order;
      });
    },
  };

  return { users, orders };
}

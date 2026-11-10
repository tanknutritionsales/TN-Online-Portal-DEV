import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { boundedMap } from "./bounded-map.mjs";
import { createOrderEmail, deliverQueuedEmail, emailSetupStatus, normalizeCustomerCare } from "./customer-notifications.mjs";

const lifetimeMs = 23 * 60 * 60 * 1_000;
const delayMs = 30_000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fileQueues = new Map();
const events = { submitted: "order_received", payment_link_attached: "payment_ready", payment_confirmed: "payment_confirmed", shipped: "shipped", external_tracking_added: "shipped" };

/**
 * Transactional order-email outbox and demand-driven crash recovery.
 *
 * Parent integration:
 *   const notifications = createOrderNotifications({ ..., getOrder: id => records.orders.get(id) });
 *   // record-store onOrderWrite(client, next, previous): notifications.record(...)
 *   const hint = await notifications.beforeWrite(orderId); // before BEGIN
 *   const order = await records.orders.update(orderId, transform); // hook + COMMIT
 *   await notifications.afterWrite(orderId, hint); // catch/log after-commit errors
 *   // Worker: await notifications.recover(), then run the existing retry worker.
 *
 * Remove the old queueOrderEmail calls. SQL record() uses ONLY the caller's
 * transaction client; its errors must roll back the order too. Parent ensures
 * op_customer_messages schema before BEGIN. Local record(null, ...) uses
 * messages.insert. The current local hook runs before the order-file rename:
 * setup rows can survive a failed order save, since two files are not atomic.
 * Parent must keep runtimeConfig.allowed=false locally (no real delivery).
 * Identical payment-link saves must preserve attachedAt (parent transform).
 * Payment-link identity sorts object keys recursively before hashing so a
 * PostgreSQL JSONB round trip cannot change a valid notification's identity.
 *
 * readCare() returns customerCare, not the enclosing settings record. Local
 * messages.list MUST support {orderId, kind, statuses, limit}. SQL pending reads
 * are direct targeted queries, capped at 20 per order. getOrder(id) is optional
 * with SQL (defaults to a primary-key query), required for configured local
 * delivery. Delivery always uses a current order, never an action's old snapshot.
 *
 * runtimeConfig(care) may inject fetchImpl for offline tests. blobStore is an
 * optional lazy getStore factory with get/setJSON/list/delete; reads are strong.
 * filePath names an independent local dirty-hint queue, NOT the orders/messages
 * file. Its rename writes serialize across instances in the same Node process.
 * Hosted hints each have their own key, so concurrent actions never share a
 * read/modify/write snapshot. Hints contain UUID/order ID/timestamps only.
 *
 * The 30s hint delay assumes the parent bounds order transactions to <30s (15s
 * target). Recovery never scans order history, and processes at most two due
 * dirty hints per run. A full 20-message page retains its dirty hint so the next
 * run can hand off subsequent messages. Standard retry hints are durable BEFORE
 * any delivery or dirty-hint clear. Retrying either phase is idempotent.
 */
export function createOrderNotifications({
  database, useDatabase = false, messages, control, readCare, runtimeConfig,
  blobStore = null, namespace = blobStore ? undefined : "local", filePath,
  getOrder, now = Date.now,
} = {}) {
  if (typeof runtimeConfig !== "function" || typeof readCare !== "function" || typeof now !== "function") throw new TypeError("runtimeConfig, readCare and now are required functions.");
  if (!messages || !control || typeof control.syncRetry !== "function") throw new TypeError("messages and control with syncRetry are required.");
  if (typeof namespace !== "string" || !namespace.trim() || namespace.length > 180) throw new TypeError("A notification namespace is required.");
  if (blobStore && typeof blobStore !== "function") throw new TypeError("blobStore must be a lazy store factory.");
  if (!blobStore && (typeof filePath !== "string" || !filePath)) throw new TypeError("A separate local hint filePath is required.");
  if (getOrder !== undefined && typeof getOrder !== "function") throw new TypeError("getOrder must be a function.");
  const usesDatabase = () => typeof useDatabase === "function" ? useDatabase() : useDatabase;
  const prefix = `${encodeURIComponent(namespace)}/notification-orders/`;
  const fileKey = filePath ? path.resolve(filePath) : null;
  const namespaceKey = `ns:${encodeURIComponent(namespace)}`;

  async function localRead() {
    try {
      const payload = JSON.parse(await readFile(fileKey, "utf8"));
      if (payload?.version !== 1 || !payload.namespaces || typeof payload.namespaces !== "object" || Array.isArray(payload.namespaces)) throw new Error("Invalid notification recovery queue.");
      return payload;
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, namespaces: {} };
      throw error;
    }
  }

  async function localChange(transform) {
    const previous = fileQueues.get(fileKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const payload = await localRead();
      const records = payload.namespaces[namespaceKey] ||= {};
      transform(records);
      await mkdir(path.dirname(fileKey), { recursive: true });
      const temporary = `${fileKey}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(payload));
        await rename(temporary, fileKey);
      } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
    });
    fileQueues.set(fileKey, current);
    try { return await current; }
    finally { if (fileQueues.get(fileKey) === current) fileQueues.delete(fileKey); }
  }

  function validHint(hint) {
    return Boolean(hint && uuid.test(hint.id || "") && validOrderId(hint.orderId) &&
      Number.isSafeInteger(hint.dueAt) && Number.isSafeInteger(hint.expiresAt) &&
      hint.expiresAt > hint.dueAt && hint.expiresAt - hint.dueAt === lifetimeMs - delayMs);
  }

  async function clearHint(hint) {
    if (!hint) return;
    if (blobStore) await (await blobStore()).delete(`${prefix}${hint.id}`);
    else await localChange((records) => { delete records[hint.id]; });
  }

  async function allHints() {
    if (!blobStore) {
      // Await an in-process rename before taking a recovery snapshot.
      await (fileQueues.get(fileKey) || Promise.resolve()).catch(() => {});
      return Object.values((await localRead()).namespaces[namespaceKey] || {}).filter(validHint);
    }
    const store = await blobStore();
    const { blobs } = await store.list({ prefix });
    const records = await boundedMap(blobs.filter((blob) => blob.key.startsWith(prefix) && uuid.test(blob.key.slice(prefix.length))), async (blob) => {
      const hint = await store.get(blob.key, { type: "json", consistency: "strong" });
      return validHint(hint) && blob.key === `${prefix}${hint.id}` ? hint : null;
    });
    return records.filter(Boolean);
  }

  async function deliveryAllowed() {
    if ((await control.read()).paused) return false;
    if (!emailSetupStatus(runtimeConfig({})).configured) return false;
    return await control.emailEnabled() !== false;
  }

  async function beforeWrite(orderId) {
    assertOrderId(orderId);
    if (!emailSetupStatus(runtimeConfig({})).configured || await control.emailEnabled() === false) return null;
    const time = now();
    const hint = { id: randomUUID(), orderId, dueAt: time + delayMs, expiresAt: time + lifetimeMs };
    if (blobStore) await (await blobStore()).setJSON(`${prefix}${hint.id}`, hint);
    else await localChange((records) => { records[hint.id] = hint; });
    return hint;
  }

  async function record(client, next, previous = null) {
    if (!next || !validOrderId(next.id)) throw new TypeError("A saved order ID is required.");
    const appended = (next.statusEvents || []).slice(previous?.statusEvents?.length || 0).filter((event) => Object.hasOwn(events, event.type));
    if (!appended.length) return { recorded: 0 };
    if (usesDatabase() && !client?.query) throw new TypeError("SQL notification recording requires the order transaction client.");
    const rawCare = client
      ? (await client.query("SELECT data->'customerCare' AS customer_care FROM op_shop_settings WHERE id='default'")).rows[0]?.customer_care
      : await readCare();
    const care = normalizeCustomerCare(rawCare);
    const config = runtimeConfig(care);
    const setup = emailSetupStatus(config);
    const time = now();
    const stamp = new Date(time).toISOString();
    let recorded = 0;
    for (const event of appended) {
      const kind = events[event.type];
      if (!care.events[kind]) continue;
      const eventAt = Date.parse(event.at || next.updatedAt || next.createdAt);
      if (care.emailEnabledAt && (!Number.isFinite(eventAt) || eventAt < Date.parse(care.emailEnabledAt))) continue;
      const eventId = sourceEventId(next, event.type);
      if (eventId === null) continue;
      // An invalid/unconfigured portal URL must still allow an admin-visible
      // setup_required row, without creating any path to provider delivery.
      let portalUrl;
      try { portalUrl = new URL(config.portalUrl).href; }
      catch { portalUrl = "https://online-portal.invalid/"; }
      const message = createOrderEmail(next, kind, { portalUrl, care, eventId });
      Object.assign(message, { eventId, eventAt: Number.isFinite(eventAt) ? new Date(eventAt).toISOString() : stamp,
        createdAt: stamp, updatedAt: stamp, nextAttemptAt: stamp,
        status: !care.emailEnabled ? "disabled" : !setup.configured ? "setup_required" : "pending" });
      if (client) {
        const result = await client.query(
          `INSERT INTO op_customer_messages(id, kind, customer_id, order_id, status, data, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz,$8::timestamptz)
           ON CONFLICT (id) DO NOTHING RETURNING id`,
          [message.id, message.kind, message.customerId, message.orderId, message.status, JSON.stringify(message), stamp, stamp],
        );
        recorded += result.rowCount ?? result.rows.length;
      } else recorded += (await messages.insert(message)).created ? 1 : 0;
    }
    return { recorded };
  }

  async function afterWrite(orderId, hint = null, { deadline = Infinity, waitForCapacity = false } = {}) {
    assertOrderId(orderId);
    if (hint && (!validHint(hint) || hint.orderId !== orderId)) throw new TypeError("The recovery hint must belong to this order/action.");
    if (!await deliveryAllowed()) return { sent: 0, processed: 0, paused: true };
    if (hint && hint.expiresAt <= now()) { await clearHint(hint); return { sent: 0, processed: 0, expired: true }; }
    const pool = usesDatabase() ? await database() : null;
    const pending = pool
      ? (await pool.query("SELECT data FROM op_customer_messages WHERE order_id=$1 AND kind='email' AND status='pending' ORDER BY created_at ASC, id ASC LIMIT 20", [orderId])).rows.map((row) => row.data)
      : await messages.list({ orderId, kind: "email", statuses: ["pending"], limit: 20 });
    if (pending.some((message) => message.orderId !== orderId || message.kind !== "email" || message.status !== "pending") || pending.length > 20) throw new Error("Pending email lookup must be limited to the target order.");
    const due = [];
    let processed = 0, sent = 0;
    for (const message of pending) {
      let current = message;
      if (now() - Date.parse(message.createdAt) >= lifetimeMs || Number(message.attempts) >= 5) {
        current = await messages.update(message.id, (entry) => entry.status !== "pending" ? null : { ...entry, status: Number(entry.attempts) >= 5 ? "failed" : "expired", nextAttemptAt: null, updatedAt: new Date(now()).toISOString() });
        processed++;
      } else if (Date.parse(message.nextAttemptAt || message.createdAt) <= now()) due.push(message);
      // If any write fails, leave this action's dirty hint for the next run.
      await control.syncRetry(current);
    }
    if (pending.length < 20) await clearHint(hint);
    if (!due.length) return { sent, processed, idle: true };

    const care = normalizeCustomerCare(await readCare());
    if (!care.emailEnabled) { await control.setEmailEnabled(false); return { sent, processed, paused: true }; }
    const config = runtimeConfig(care);
    if (!emailSetupStatus(config).configured) return { sent, processed, paused: true };
    const order = getOrder ? await getOrder(orderId) : pool ? (await pool.query("SELECT data FROM op_orders WHERE id=$1", [orderId])).rows[0]?.data : undefined;
    if (!getOrder && !pool) throw new TypeError("Configured local delivery requires getOrder(orderId).");
    for (const message of due) {
      if (Date.now() + 8000 >= deadline) break;
      if ((await control.read()).paused || await control.emailEnabled() === false) break;
      const obsolete = !order || !care.events[message.event] ||
        (care.emailEnabledAt && Date.parse(message.eventAt || message.createdAt) < Date.parse(care.emailEnabledAt)) ||
        (message.event === "payment_ready" && (order.paymentStatus === "confirmed" || order.specialOrder?.status === "declined" ||
          (message.eventId && message.eventId !== sourceEventId(order, "payment_link_attached"))));
      const result = obsolete
        ? await messages.update(message.id, (entry) => entry.status !== "pending" ? null : { ...entry, status: "superseded", nextAttemptAt: null, updatedAt: new Date(now()).toISOString() })
        : await deliverQueuedEmail(messages, message.id, { ...config, waitForCapacity, deadline }, now());
      await control.syncRetry(result);
      processed++;
      if (result?.status === "sent") sent++;
    }
    return { sent, processed, ...(pending.length === 20 ? { remaining: true } : {}) };
  }

  async function recover({ deadline = Infinity } = {}) {
    if (Date.now() + 8000 >= deadline) return { sent: 0, processed: 0, remaining: true };
    if (!await deliveryAllowed()) return { sent: 0, processed: 0, recovered: 0, paused: true };
    const due = [];
    for (const hint of await allHints()) {
      if (hint.expiresAt <= now()) await clearHint(hint);
      else if (hint.dueAt <= now()) due.push(hint);
    }
    if (!due.length) return { sent: 0, processed: 0, recovered: 0, idle: true };
    let sent = 0, processed = 0, recovered = 0;
    for (const hint of due.sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id)).slice(0, 100)) {
      if (Date.now() + 8000 >= deadline) break;
      const result = await afterWrite(hint.orderId, hint, { deadline, waitForCapacity: true });
      sent += result.sent;
      processed += result.processed;
      if (result.paused) return { sent, processed, recovered, paused: true };
      recovered++;
    }
    return { sent, processed, recovered, ...(due.length > recovered ? { remaining: true } : {}) };
  }

  return { beforeWrite, record, afterWrite, recover };
}

function sourceEventId(order, type) {
  if (type === "submitted") return "submitted";
  if (type === "payment_confirmed") return "confirmed";
  if (type === "payment_link_attached") return order.paymentLink ? createHash("sha256").update(stableJson(order.paymentLink)).digest("hex") : null;
  if (type === "shipped") return order.officeShippedAt ? `office:${order.officeShippedAt}` : null;
  if (type === "external_tracking_added") return order.externalTracking?.addedAt ? `external:${order.externalTracking.addedAt}` : null;
  return null;
}

function stableJson(value) {
  // Normalize JSON semantics first (toJSON, omitted undefined, array nulls), then
  // sort objects without changing array order or payment-link field values.
  const sort = (entry) => Array.isArray(entry) ? entry.map(sort) : entry && typeof entry === "object"
    ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, sort(entry[key])])) : entry;
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value))));
}

function validOrderId(id) { return typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,179}$/.test(id); }
function assertOrderId(id) { if (!validOrderId(id)) throw new TypeError("A valid order ID is required."); }

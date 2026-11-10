import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applyDeliveryEvent } from "./email-webhooks.mjs";

const fileLocks = new Map();

export function createCustomerMessageStore({ database, useDatabase, filePath, localAllowed }) {
  let schemaReady;
  async function db() {
    const pool = await database();
    if (!schemaReady) {
      schemaReady = (async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock(hashtext('op_customer_messages_schema_v1'))");
          await client.query(`
        CREATE TABLE IF NOT EXISTS op_customer_messages (
          id text PRIMARY KEY,
          kind text NOT NULL,
          customer_id text NOT NULL,
          order_id text,
          status text NOT NULL,
          data jsonb NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS op_customer_messages_customer_idx ON op_customer_messages(customer_id, kind, created_at DESC);
        CREATE INDEX IF NOT EXISTS op_customer_messages_delivery_idx ON op_customer_messages(kind, status, updated_at);
          `);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally { client.release(); }
      })().catch((error) => { schemaReady = null; throw error; });
    }
    await schemaReady;
    return pool;
  }

  function requireLocal() {
    if (!localAllowed) throw new Error("Customer messaging requires database storage on hosted sites.");
  }

  async function readLocal() {
    requireLocal();
    try {
      const payload = JSON.parse(await readFile(filePath, "utf8"));
      return Array.isArray(payload.messages) ? payload.messages : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async function writeLocal(messages) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify({ version: 1, messages }, null, 2));
    await rename(temporaryPath, filePath);
  }

  async function localTransaction(action) {
    const previous = fileLocks.get(filePath) || Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    fileLocks.set(filePath, current);
    try { return await current; }
    finally { if (fileLocks.get(filePath) === current) fileLocks.delete(filePath); }
  }

  async function insert(message, { client } = {}) {
    if (useDatabase()) {
      const pool = client || await db();
      const result = await pool.query(
        `INSERT INTO op_customer_messages(id, kind, customer_id, order_id, status, data, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz,$8::timestamptz)
         ON CONFLICT (id) DO NOTHING RETURNING data`,
        [message.id, message.kind, message.customerId, message.orderId || null, message.status, JSON.stringify(message), message.createdAt, message.updatedAt],
      );
      if (result.rows[0]) return { created: true, message: result.rows[0].data };
      const existing = await pool.query("SELECT data FROM op_customer_messages WHERE id=$1", [message.id]);
      return { created: false, message: existing.rows[0]?.data || null };
    }
    return localTransaction(async () => {
      const messages = await readLocal();
      const existing = messages.find((entry) => entry.id === message.id);
      if (existing) return { created: false, message: existing };
      messages.unshift(message);
      await writeLocal(messages);
      return { created: true, message };
    });
  }

  async function list({ customerId, orderId, kind, statuses, limit = 100 } = {}) {
    const count = Math.min(300, Math.max(1, Number(limit) || 100));
    if (useDatabase()) {
      const pool = await db();
      const conditions = [];
      const values = [];
      if (customerId) { values.push(customerId); conditions.push(`customer_id=$${values.length}`); }
      if (orderId) { values.push(orderId); conditions.push(`order_id=$${values.length}`); }
      if (kind) { values.push(kind); conditions.push(`kind=$${values.length}`); }
      if (statuses?.length) { values.push(statuses); conditions.push(`status=ANY($${values.length}::text[])`); }
      values.push(count);
      const result = await pool.query(`SELECT data FROM op_customer_messages ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${values.length}`, values);
      return result.rows.map((row) => row.data);
    }
    const messages = await readLocal();
    return messages.filter((entry) => (!customerId || entry.customerId === customerId) && (!orderId || entry.orderId === orderId) && (!kind || entry.kind === kind) && (!statuses?.length || statuses.includes(entry.status))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, count);
  }

  async function existingIds(ids) {
    if (!ids.length) return new Set();
    if (useDatabase()) {
      const result = await (await db()).query("SELECT id FROM op_customer_messages WHERE id=ANY($1::text[])", [ids]);
      return new Set(result.rows.map((row) => row.id));
    }
    const wanted = new Set(ids);
    return new Set((await readLocal()).filter((entry) => wanted.has(entry.id)).map((entry) => entry.id));
  }

  async function update(id, transform) {
    if (useDatabase()) {
      const client = await (await db()).connect();
      try {
        await client.query("BEGIN");
        const result = await client.query("SELECT data FROM op_customer_messages WHERE id=$1 FOR UPDATE", [id]);
        const updated = result.rows[0] ? await transform(result.rows[0].data) : null;
        if (updated) {
          await client.query("UPDATE op_customer_messages SET status=$2,data=$3::jsonb,updated_at=$4::timestamptz WHERE id=$1", [id, updated.status, JSON.stringify(updated), updated.updatedAt]);
        }
        await client.query("COMMIT");
        return updated;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    }
    return localTransaction(async () => {
      const messages = await readLocal();
      const index = messages.findIndex((entry) => entry.id === id);
      if (index < 0) return null;
      const updated = await transform(messages[index]);
      if (!updated) return null;
      messages[index] = updated;
      await writeLocal(messages);
      return updated;
    });
  }

  async function getMany(ids) {
    if (!ids.length) return [];
    if (useDatabase()) {
      const result = await (await db()).query("SELECT data FROM op_customer_messages WHERE id=ANY($1::text[])", [ids]);
      return result.rows.map((row) => row.data);
    }
    const wanted = new Set(ids);
    return (await readLocal()).filter((entry) => wanted.has(entry.id));
  }

  async function recordDelivery(event) {
    if (useDatabase()) {
      const client = await (await db()).connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(event.messageId
          ? "SELECT data FROM op_customer_messages WHERE id=$1 AND kind='email' FOR UPDATE"
          : "SELECT data FROM op_customer_messages WHERE data->>'deliveryId'=$1 AND kind='email' LIMIT 1 FOR UPDATE", [event.messageId || event.providerId]);
        const updated = rows[0] ? applyDeliveryEvent(rows[0].data, event) : null;
        if (!updated) { await client.query("COMMIT"); return null; }
        const claimed = await client.query("INSERT INTO op_email_delivery_events(id,message_id,created_at) VALUES($1,$2,now()) ON CONFLICT(id) DO NOTHING RETURNING id", [event.id, updated.id]);
        if (!claimed.rows.length) { await client.query("COMMIT"); return null; }
        await client.query("UPDATE op_customer_messages SET data=$2::jsonb,updated_at=now() WHERE id=$1", [updated.id, JSON.stringify(updated)]);
        await client.query("COMMIT"); return updated;
      } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
      finally { client.release(); }
    }
    return localTransaction(async () => {
      const rows = await readLocal();
      const index = rows.findIndex(message => message.kind === "email" && (event.messageId ? message.id === event.messageId : message.deliveryId === event.providerId));
      if (index < 0) return null;
      const updated = applyDeliveryEvent(rows[index], event);
      if (updated) { rows[index] = updated; await writeLocal(rows); }
      return updated;
    });
  }

  async function emailPage({ limit = 50, offset = 0, search = "", event = "all", status = "all" } = {}) {
    limit = Math.min(100, Math.max(1, Number(limit) || 50)); offset = Math.max(0, Math.min(1000000, Number(offset) || 0));
    search = String(search || "").trim().slice(0, 180).toLowerCase();
    const attentionStatuses = ["failed", "bounced", "complained", "suppressed", "delayed"];
    const statuses = ["attention", "pending", "sending", "sent", "failed", "expired", "superseded", "disabled", "setup_required", "delivered", "delayed", "bounced", "complained", "suppressed"];
    if (status !== "all" && !statuses.includes(status)) status = "all";
    const events = ["order_received", "payment_ready", "payment_confirmed", "shipped", "email_verification", "password_reset", "password_changed"];
    if (event !== "all" && !events.includes(event)) event = "all";
    if (useDatabase()) {
      const pool = await db(), values = [], where = ["kind='email'"];
      if (search) { values.push(`%${search.replace(/[\\%_]/g, value => "\\" + value)}%`); where.push(`concat_ws(' ',data->>'to',data->>'subject',data->>'reference',data->>'customerName') ILIKE $${values.length}`); }
      if (event !== "all") { values.push(event); where.push(`data->>'event'=$${values.length}`); }
      if (status === "attention") { values.push(attentionStatuses); where.push(`COALESCE(data->>'deliveryStatus',status)=ANY($${values.length}::text[])`); }
      else if (status !== "all") { values.push(status); where.push(`COALESCE(data->>'deliveryStatus',status)=$${values.length}`); }
      const criteria = where.join(" AND ");
      const rows = await pool.query(`SELECT data FROM op_customer_messages WHERE ${criteria} ORDER BY created_at DESC,id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit + 1, offset]);
      const counts = await pool.query(`SELECT count(*) AS total, count(*) FILTER (WHERE COALESCE(data->>'deliveryStatus',status) IN ('failed','bounced','complained','suppressed','delayed')) AS attention FROM op_customer_messages WHERE ${criteria}`, values);
      const hasMore = rows.rows.length > limit;
      return { emails: rows.rows.slice(0, limit).map(row => row.data), page: { limit, offset, hasMore }, counts: { total: Number(counts.rows[0].total), attention: Number(counts.rows[0].attention) } };
    }
    const rows = (await readLocal()).filter(message => message.kind === "email" && (event === "all" || message.event === event) &&
      (status === "all" || (status === "attention" ? attentionStatuses.includes(message.deliveryStatus || message.status) : (message.deliveryStatus || message.status) === status)) && (!search || [message.to, message.subject, message.reference, message.customerName].join(" ").toLowerCase().includes(search)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { emails: rows.slice(offset, offset + limit), page: { limit, offset, hasMore: rows.length > offset + limit }, counts: { total: rows.length, attention: rows.filter(message => attentionStatuses.includes(message.deliveryStatus || message.status)).length } };
  }

  async function pruneSearchMisses(before) {
    if (useDatabase()) {
      await (await db()).query("DELETE FROM op_customer_messages WHERE kind='search_miss' AND created_at < $1::timestamptz", [before]);
      return;
    }
    await localTransaction(async () => {
      const messages = await readLocal();
      const retained = messages.filter((entry) => entry.kind !== "search_miss" || entry.createdAt >= before);
      if (retained.length !== messages.length) await writeLocal(retained);
    });
  }
  async function supportPage({ status = "open", limit = 50, offset = 0 } = {}) {
    if (!["open", "all"].includes(status)) throw Object.assign(new Error("Choose a valid support filter."), { status: 400 });
    limit = Math.min(100, Math.max(1, Number(limit) || 50)); offset = Math.max(0, Math.floor(Number(offset) || 0));
    if (useDatabase()) {
      const pool = await db();
      const [rows, counts] = await Promise.all([
        pool.query(`SELECT data FROM op_customer_messages WHERE kind='support'${status === "open" ? " AND status <> 'resolved'" : ""} ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2`, [limit + 1, offset]),
        pool.query("SELECT count(*) AS total,count(*) FILTER (WHERE status <> 'resolved') AS open FROM op_customer_messages WHERE kind='support'"),
      ]);
      return { requests: rows.rows.slice(0,limit).map(row=>row.data), page: { limit, offset, hasMore: rows.rows.length > limit },
        counts: { total: Number(counts.rows[0].total), open: Number(counts.rows[0].open) } };
    }
    const all = (await readLocal()).filter(entry=>entry.kind === "support").sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
    const rows = all.filter(entry=>status === "all" || entry.status !== "resolved");
    return { requests: rows.slice(offset,offset+limit), page: {limit,offset,hasMore:rows.length>offset+limit}, counts: {total:all.length,open:all.filter(entry=>entry.status!=="resolved").length} };
  }
  async function overview() {
    if (useDatabase()) {
      const { rows } = await (await db()).query(`SELECT
        count(*) FILTER (WHERE kind='support' AND status <> 'resolved') AS support,
        count(*) FILTER (WHERE kind='email' AND COALESCE(data->>'deliveryStatus',status) IN ('failed','bounced','complained','suppressed','delayed','delivery_delayed')) AS email
        FROM op_customer_messages`);
      return { support: Number(rows[0].support), email: Number(rows[0].email) };
    }
    const rows = await readLocal();
    return { support: rows.filter(entry => entry.kind === "support" && entry.status !== "resolved").length,
      email: rows.filter(entry => entry.kind === "email" && ["failed", "bounced", "complained", "suppressed", "delayed", "delivery_delayed"].includes(entry.deliveryStatus || entry.status)).length };
  }
  return { insert, list, update, existingIds, getMany, pruneSearchMisses, recordDelivery, emailPage, overview, supportPage };
}

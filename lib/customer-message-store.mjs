import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

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

  async function insert(message) {
    if (useDatabase()) {
      const pool = await db();
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

  async function list({ customerId, kind, statuses, limit = 100 } = {}) {
    const count = Math.min(300, Math.max(1, Number(limit) || 100));
    if (useDatabase()) {
      const pool = await db();
      const conditions = [];
      const values = [];
      if (customerId) { values.push(customerId); conditions.push(`customer_id=$${values.length}`); }
      if (kind) { values.push(kind); conditions.push(`kind=$${values.length}`); }
      if (statuses?.length) { values.push(statuses); conditions.push(`status=ANY($${values.length}::text[])`); }
      values.push(count);
      const result = await pool.query(`SELECT data FROM op_customer_messages ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${values.length}`, values);
      return result.rows.map((row) => row.data);
    }
    const messages = await readLocal();
    return messages.filter((entry) => (!customerId || entry.customerId === customerId) && (!kind || entry.kind === kind) && (!statuses?.length || statuses.includes(entry.status))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, count);
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

  return { insert, list, update, existingIds };
}

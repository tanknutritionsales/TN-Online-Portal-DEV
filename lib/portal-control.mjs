import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { boundedMap } from "./bounded-map.mjs";

const fileQueues = new Map();
function serialized(key, work) {
  const result = (fileQueues.get(key) || Promise.resolve()).catch(() => {}).then(work);
  fileQueues.set(key, result.catch(() => {}));
  return result;
}

export const openPortal = () => ({ version: 1, revision: "initial", paused: false, changedAt: null, changedBy: null, history: [] });
export const publicPortalStatus = (control) => ({ paused: control.paused, message: control.paused ? "The portal is temporarily unavailable. Please check back shortly." : "" });

// Availability and retry hints deliberately live outside Postgres. Reading them
// must not wake the database. Production and preview namespaces stay separate.
export function createPortalControlStore({ filePath, blobStore = null, namespace = "production", withWriteLock = (work) => work() }) {
  const prefix = `${namespace}/`;
  const retryFile = path.join(path.dirname(filePath), "notification-retries.json");
  const emailFile = path.join(path.dirname(filePath), "notification-settings.json");
  async function readLocal(file, fallback) {
    try { return JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
  }
  async function writeLocal(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, file);
  }
  async function readControl() {
    try {
      const value = blobStore ? await (await blobStore()).get(`${prefix}availability`, { type: "json", consistency: "strong" }) : await readLocal(filePath, null);
      if (value === null) return openPortal();
      if (value.version !== 1 || typeof value.paused !== "boolean" || typeof value.revision !== "string" || !Array.isArray(value.history)) throw new Error("Invalid availability record");
      return value;
    } catch {
      throw Object.assign(new Error("Portal availability could not be checked. Please try again shortly."), { status: 503, code: "PORTAL_CONTROL_UNAVAILABLE" });
    }
  }
  async function setPaused({ paused, revision, actor }) {
    return serialized(filePath, () => withWriteLock(async () => {
      const current = await readControl();
      if (revision !== current.revision) throw Object.assign(new Error("Portal availability changed. Refresh it and confirm again."), { status: 409 });
      if (current.paused === paused) throw Object.assign(new Error(`The portal is already ${paused ? "paused" : "open"}.`), { status: 409 });
      const event = { paused, at: new Date().toISOString(), by: { id: actor.userId, username: actor.username } };
      const next = { version: 1, revision: randomUUID(), paused, changedAt: event.at, changedBy: event.by, history: [...current.history, event].slice(-30) };
      if (blobStore) await (await blobStore()).setJSON(`${prefix}availability`, next);
      else await writeLocal(filePath, next);
      if ((await readControl()).revision !== next.revision) throw Object.assign(new Error("The change could not be verified. Refresh portal availability before continuing."), { status: 503 });
      return next;
    }));
  }
  async function emailEnabled() {
    const record = blobStore ? await (await blobStore()).get(`${prefix}email-enabled`, { type: "json", consistency: "strong" }) : await readLocal(emailFile, null);
    if (record === null) return null;
    if (typeof record.enabled !== "boolean") throw new Error("Email availability could not be checked.");
    return record.enabled;
  }
  async function setEmailEnabled(enabled) {
    const record = { enabled: Boolean(enabled) };
    if (blobStore) await (await blobStore()).setJSON(`${prefix}email-enabled`, record);
    else await serialized(emailFile, () => writeLocal(emailFile, record));
  }
  async function clearRetry(id) {
    if (blobStore) return (await blobStore()).delete(`${prefix}retries/${id}`);
    await serialized(retryFile, async () => {
      const records = await readLocal(retryFile, {});
      delete records[id];
      await writeLocal(retryFile, records);
    });
  }
  async function syncRetry(message) {
    if (!message) return; // Another worker may own the lease; keep its hint.
    if (message.kind !== "email" || !/^email-[a-f0-9]{64}$/.test(message.id)) return;
    const expiresAt = Math.min(Date.parse(message.createdAt) + 23 * 60 * 60 * 1000, message.expiresAt ? Date.parse(message.expiresAt) : Infinity);
    if (message.permanentFailure || message.deliveryStatus || !["pending", "failed", "sending"].includes(message.status) || message.attempts >= 5 || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return clearRetry(message.id);
    const nextAttemptAt = message.status === "sending" ? message.lockedUntil : message.nextAttemptAt || message.createdAt;
    const record = { id: message.id, nextAttemptAt, expiresAt };
    if (blobStore) await (await blobStore()).setJSON(`${prefix}retries/${message.id}`, record);
    else await serialized(retryFile, async () => {
      const records = await readLocal(retryFile, {});
      records[message.id] = record;
      await writeLocal(retryFile, records);
    });
  }
  async function dueRetries(now = Date.now()) {
    let records;
    if (blobStore) {
      const store = await blobStore();
      const { blobs } = await store.list({ prefix: `${prefix}retries/` });
      records = (await boundedMap(blobs, blob => store.get(blob.key, { type: "json", consistency: "strong" }))).filter(Boolean);
    } else records = Object.values(await readLocal(retryFile, {}));
    const due = [];
    for (const record of records) {
      if (!/^email-[a-f0-9]{64}$/.test(record.id || "")) continue;
      if (!Number.isFinite(record.expiresAt) || record.expiresAt <= now) { await clearRetry(record.id); continue; }
      if (Date.parse(record.nextAttemptAt) <= now) due.push(record);
    }
    return due.sort((a, b) => a.expiresAt - b.expiresAt || Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt)).slice(0, 100);
  }
  return { read: readControl, setPaused, emailEnabled, setEmailEnabled, syncRetry, clearRetry, dueRetries };
}

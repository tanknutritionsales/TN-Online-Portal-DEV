import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createPortalControlStore } from "../lib/portal-control.mjs";
import { createNotificationWorker } from "../lib/notification-worker.mjs";
import { createPortalRuntimeLoader, portalRuntimeConfig } from "../lib/netlify-runtime.mjs";
import { createOrderEmail, normalizeCustomerCare } from "../lib/customer-notifications.mjs";
import { startIsolatedPortal } from "./isolated-portal.mjs";

const runtimeKeys = ["OP_RUNTIME_NETLIFY", "OP_RUNTIME_CONTEXT", "OP_RUNTIME_DEPLOY_ID"];
const previousRuntime = Object.fromEntries(runtimeKeys.map((key) => [key, process.env[key]]));
try {
  let imports = 0;
  const server = { handleRequest() {} };
  const load = createPortalRuntimeLoader(async () => {
    imports++;
    assert.equal(process.env.OP_RUNTIME_NETLIFY, "true", "Hosted storage must be configured before importing the server.");
    assert.equal(process.env.OP_RUNTIME_CONTEXT, "production");
    return server;
  });
  await assert.rejects(load({}), /deployment metadata/);
  const context = { deploy: { context: "production", id: "deploy-one" } };
  assert.equal(await load(context), server);
  assert.equal(await load(context), server);
  assert.equal(imports, 1);
  assert.equal(portalRuntimeConfig().namespace, "production");
  await assert.rejects(load({ deploy: { context: "deploy-preview", id: "preview-one" } }), /deployment changed/);
  assert.equal(portalRuntimeConfig({ OP_RUNTIME_NETLIFY: "true", OP_RUNTIME_CONTEXT: "production", OP_RUNTIME_DEPLOY_ID: "deploy-two" }).namespace, "production", "Production controls persist across redeploys.");
  const preview = portalRuntimeConfig({ OP_RUNTIME_NETLIFY: "true", OP_RUNTIME_CONTEXT: "deploy-preview", OP_RUNTIME_DEPLOY_ID: "preview-one" });
  assert.equal(preview.namespace, "preview-one");
  assert.equal(preview.productionDeploy, false, "Previews cannot send production emails.");
  assert.equal(portalRuntimeConfig({ CONTEXT: "production", DEPLOY_ID: "untrusted-build-value" }).netlify, false, "Build-time variables are not required or trusted as runtime metadata.");
  let attempts = 0;
  const retry = createPortalRuntimeLoader(async () => { if (++attempts === 1) throw new Error("retry import"); return server; });
  await assert.rejects(retry(context), /retry import/);
  assert.equal(await retry(context), server);
} finally {
  for (const key of runtimeKeys) {
    if (previousRuntime[key] === undefined) delete process.env[key];
    else process.env[key] = previousRuntime[key];
  }
}

const directory = await mkdtemp(path.join(tmpdir(), "op-control-test-"));
try {
  const blobs = new Map();
  let locks = 0;
  const store = {
    get: async (key, options) => { assert.equal(options.consistency, "strong"); return structuredClone(blobs.get(key) ?? null); },
    setJSON: async (key, value) => { blobs.set(key, structuredClone(value)); },
    delete: async (key) => { blobs.delete(key); },
    list: async ({ prefix }) => ({ blobs: [...blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) }),
  };
  const control = createPortalControlStore({ filePath: path.join(directory, "control.json"), blobStore: async () => store, withWriteLock: async (work) => { locks++; return work(); } });
  const actor = { userId: "admin", username: "Admin" };
  assert.equal((await control.read()).paused, false);
  assert.equal(locks, 0, "Ordinary availability checks never acquire a database lock.");
  const paused = await control.setPaused({ paused: true, revision: "initial", actor });
  assert.equal(paused.history.length, 1);
  await assert.rejects(control.setPaused({ paused: false, revision: "initial", actor }), (error) => error.status === 409);
  await control.setPaused({ paused: false, revision: paused.revision, actor });
  const preview = createPortalControlStore({ filePath: path.join(directory, "preview.json"), blobStore: async () => store, namespace: "preview" });
  assert.equal((await preview.read()).revision, "initial", "Preview controls must not share production state.");
  const care = normalizeCustomerCare({ emailEnabled: true });
  const message = createOrderEmail({ id: "order", reference: "TEST", customer: { id: "customer", email: "test@example.com" }, total: 1 }, "order_received", { portalUrl: "https://example.com", care, eventId: "event" });
  await control.syncRetry({ ...message, status: "failed", nextAttemptAt: new Date(Date.now() - 1).toISOString() });
  assert.equal((await control.dueRetries()).length, 1);
  await control.syncRetry({ ...message, status: "failed", nextAttemptAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((await control.dueRetries()).length, 0, "Future retries must not wake Postgres early.");
  await control.syncRetry({ ...message, status: "sent" });
  assert.equal((await control.dueRetries()).length, 0);
  blobs.set("production/availability", { paused: false });
  await assert.rejects(control.read(), (error) => error.code === "PORTAL_CONTROL_UNAVAILABLE", "Malformed controls must fail closed.");

  let sqlCalls = 0, sends = 0, pausedFlag = false, emailEnabled = true, due = [], queuedStatus = "pending";
  const cfg = { allowed: true, apiKey: "fake", from: "test@example.com", portalUrl: "https://example.com" };
  const workerControl = {
    read: async () => ({ paused: pausedFlag }), emailEnabled: async () => emailEnabled,
    dueRetries: async () => due, setEmailEnabled: async (value) => { emailEnabled = value; },
    clearRetry: async (id) => { due = due.filter((entry) => entry.id !== id); }, syncRetry: async () => {},
  };
  const worker = createNotificationWorker({
    control: workerControl, runtimeConfig: () => cfg,
    readCare: async () => { sqlCalls++; return care; },
    messages: { getMany: async () => { sqlCalls++; return [{ ...message, status: queuedStatus }]; }, update: async () => { throw new Error("Unexpected update"); } },
    readOrders: async () => { sqlCalls++; return [{ id: "order" }]; },
    deliver: async () => { sends++; return { ...message, status: "sent" }; },
  });
  assert.equal((await worker()).idle, true);
  assert.equal(sqlCalls, 0, "An empty retry queue must make ZERO database calls.");
  due = [{ id: message.id }]; pausedFlag = true;
  assert.equal((await worker()).paused, true);
  assert.equal(sqlCalls, 0, "Pausing prevents database calls even when work is queued.");
  pausedFlag = false; emailEnabled = false;
  assert.equal((await worker()).paused, true);
  assert.equal(sqlCalls, 0, "Disabled email must not read settings from Postgres.");
  emailEnabled = true; cfg.apiKey = "";
  assert.equal((await worker()).paused, true);
  assert.equal(sqlCalls, 0, "Unconfigured delivery must not read Postgres.");
  cfg.apiKey = "fake";
  assert.equal((await worker()).sent, 1);
  assert.equal(sends, 1);
  assert.equal(sqlCalls, 3);
  queuedStatus = "sent";
  assert.equal((await worker()).processed, 0);
  assert.equal(sends, 1, "A stale retry hint must never resend an accepted email.");
  assert.equal(sqlCalls, 5, "Terminal retries are removed before loading orders.");
  await worker();
  assert.equal(sqlCalls, 5, "Once stale hints are removed, idle runs return to ZERO SQL.");
} finally {
  if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("op-control-test-")) throw new Error("Unexpected test path");
  await rm(directory, { recursive: true, force: true });
}

const portal = await startIsolatedPortal();
try {
  function client() {
    let cookie = "";
    return async (url, body, expected = 200, headers = {}) => {
      const response = await fetch(portal.url + url, { method: body ? "POST" : "GET", headers: { "x-op-client": "portal", ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
      const payload = await response.json();
      assert.equal(response.status, expected, JSON.stringify(payload));
      return payload;
    };
  }
  const admin = client(), customer = client(), anonymous = client();
  await admin("/api/auth/admin-login", { username: "admin", password: "admin" });
  await customer("/api/auth/login", { username: "user", password: "user" });
  assert.equal((await anonymous("/api/portal-status")).paused, false);
  await customer("/api/admin/portal-control", null, 401);
  await anonymous("/api/admin/portal-control", null, 401);
  const control = (await admin("/api/admin/portal-control")).control;
  const revision = control.revision;
  await admin("/api/admin/portal-control", { action: "pause", revision, confirmation: "PAUSE PORTAL" }, 403);
  const reviewed = await admin("/api/admin/portal-control/review", { acknowledged: true, revision });
  await admin("/api/admin/portal-control", { action: "pause", token: reviewed.token, revision, confirmation: "PAUSE PORTAL" }, 403);
  await admin("/api/admin/portal-control/verify", { token: reviewed.token, password: "wrong" }, 403);
  const verified = await admin("/api/admin/portal-control/verify", { token: reviewed.token, password: "admin" });
  await admin("/api/admin/portal-control", { action: "pause", token: verified.token, revision, confirmation: "wrong" }, 400);
  const usersPath = path.join(portal.directory, "data/users.json");
  const activeUsers = await readFile(usersPath, "utf8");
  const revoked = JSON.parse(activeUsers);
  const recoveryAdmin = { ...revoked.users.find((user) => user.role === "admin"), id: "recovery-admin", username: "recovery-admin", email: "recovery@admin.local" };
  revoked.users = revoked.users.map((user) => user.role === "admin" ? { ...user, role: "customer" } : user);
  revoked.users.push(recoveryAdmin); // Preserve one admin so normal account recovery does not restore the revoked account.
  await writeFile(usersPath, JSON.stringify(revoked));
  await admin("/api/admin/portal-control", { action: "pause", token: verified.token, revision, confirmation: "PAUSE PORTAL" }, 403);
  await writeFile(usersPath, activeUsers);
  const paused = await admin("/api/admin/portal-control", { action: "pause", token: verified.token, revision, confirmation: "PAUSE PORTAL" });
  assert.equal(paused.control.paused, true);
  const usersBefore = await readFile(path.join(portal.directory, "data/users.json"), "utf8");
  assert.equal((await anonymous("/api/portal-status")).paused, true);
  assert.equal((await customer("/api/orders", null, 503)).code, "PORTAL_PAUSED");
  await customer("/api/support", null, 503);
  await customer("/api/cart/check", { items: [] }, 503);
  await anonymous("/api/auth/login", { username: "user", password: "user" }, 503);
  await anonymous("/api/auth/register", { username: "blocked" }, 503);
  await anonymous("/api/internal/orders/confirmed", null, 401);
  await anonymous("/api/internal/orders/confirmed", null, 503, { "x-internal-token": "dev-internal-token" });
  assert.equal(await readFile(path.join(portal.directory, "data/users.json"), "utf8"), usersBefore, "Paused customer traffic must not modify accounts.");
  assert.equal((await admin("/api/admin/portal-control")).control.paused, true, "Admin can reach Resume while paused.");
  const adminAgain = client();
  await adminAgain("/api/auth/admin-login", { username: "admin", password: "admin" });
  await writeFile(usersPath, JSON.stringify(revoked));
  await admin("/api/admin/portal-control", { action: "resume", confirm: true, revision: paused.control.revision }, 403);
  await writeFile(usersPath, activeUsers);
  await admin("/api/admin/portal-control", { action: "resume", confirm: true, revision: paused.control.revision });
  assert.equal((await anonymous("/api/portal-status")).paused, false);
  await customer("/api/orders");
  await admin("/api/admin/portal-control", { action: "pause", token: verified.token, revision, confirmation: "PAUSE PORTAL" }, 409);
  const legacyMessage = createOrderEmail({ id: "legacy-order", reference: "LEGACY", customer: { id: "customer", email: "test@example.com" }, total: 1 }, "order_received", { portalUrl: "https://example.com", care: normalizeCustomerCare({}), eventId: "event" });
  await writeFile(path.join(portal.directory, "data/customer-messages.json"), JSON.stringify({ version: 1, messages: [legacyMessage] }));
  await admin("/api/admin/customer-care");
  const retryHints = JSON.parse(await readFile(path.join(portal.directory, "data/notification-retries.json"), "utf8"));
  assert.ok(retryHints[legacyMessage.id], "Opening Customer support recovers pending delivery hints without an idle history scan.");
  console.log("Portal control tests passed: enforced three-step confirmation, stale-token rejection, customer/internal gates, admin recovery, isolated storage, and zero-SQL idle workers.");
} finally { await portal.close(); }

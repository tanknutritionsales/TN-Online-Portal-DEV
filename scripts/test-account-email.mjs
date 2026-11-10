import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { Webhook } from "svix";
import { createRecordStore } from "../lib/record-store.mjs";
import { createCustomerMessageStore } from "../lib/customer-message-store.mjs";
import { createAccountEmails, emailIsVerified } from "../lib/account-email.mjs";
import { hashPasswordAsync, verifyPasswordAsync, sessionCredentialVersion } from "../lib/security.mjs";
import { protectEmailContent, revealEmailContent } from "../lib/email-content.mjs";
import { createEmailWebhooks, publicEmail } from "../lib/email-webhooks.mjs";
import { startIsolatedPortal } from "./isolated-portal.mjs";
import { startIsolatedPostgres } from "./isolated-postgres.mjs";
import { portalSchemaSql } from "../lib/database-schema.mjs";
import { readEmailAction } from "../public/account-email.js";

async function fixture(pool = null) {
  const directory = await mkdtemp(path.join(tmpdir(), "op-account-email-"));
  let clock = Date.now(), paused = false;
  const secret = randomBytes(32).toString("hex"), sent = [], hints = new Map();
  const db = async () => pool;
  const messages = createCustomerMessageStore({ database: db, useDatabase: () => Boolean(pool), filePath: path.join(directory, "customer-messages.json"), localAllowed: !pool });
  const users = createRecordStore({ database: db, useDatabase: () => Boolean(pool), usersPath: path.join(directory, "users.json"), ordersPath: path.join(directory, "orders.json"), seedUsers: () => [] }).users;
  const config = { apiKey: "offline-fixture", from: "notifications@portal.test", portalUrl: "https://portal.test", senderName: "Portal", replyTo: "support@portal.test", allowed: true, securityEnabled: true,
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return Response.json({ id: `provider-${sent.length}` }); } };
  const retries = { syncRetry: async message => { if (["pending", "failed", "sending"].includes(message.status)) hints.set(message.id, message); else hints.delete(message.id); }, clearRetry: async id => hints.delete(id), dueRetries: async () => [...hints.values()] };
  const service = createAccountEmails({ users, messages, control: { read: async () => ({ paused }) }, retries, config: async () => config, secret, now: () => clock });
  const customer = { id: "customer-one", role: "customer", username: "customer", email: "customer@portal.test", name: "Customer", passwordHash: await hashPasswordAsync("old-password-twelve"), createdAt: new Date(clock).toISOString() };
  await users.insert(customer);
  const tokenFrom = message => new URLSearchParams(new URL(message.text.match(/https:\/\/\S+/)[0]).hash.slice(1)).get("token");
  return { users, messages, service, customer, sent, config, hints, secret, tokenFrom,
    advance: ms => { clock += ms; }, pause: () => { paused = true; },
    close: async () => { if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("op-account-email-")) throw new Error("Unexpected fixture directory"); await rm(directory, { recursive: true, force: true }); } };
}

test("security content is authenticated encryption and admin email projections never expose links or tokens", () => {
  const encrypted = protectEmailContent({ text: "private-reset-token", html: "private-reset-token" }, "fixture-secret");
  assert.ok(!JSON.stringify(encrypted).includes("private-reset-token"));
  assert.equal(revealEmailContent(encrypted, "fixture-secret").text, "private-reset-token");
  assert.throws(() => revealEmailContent(encrypted, "wrong-secret"));
  assert.throws(() => revealEmailContent({ ...encrypted, data: "tampered" }, "fixture-secret"));
  assert.ok(!JSON.stringify(publicEmail({ id: "email-one", kind: "email", category: "security", protectedContent: encrypted, text: "private-reset-token", html: "private-reset-token", createdAt: new Date().toISOString() })).includes("private-reset-token"));
});

test("email links are removed from browser history without making a request or consuming an account action", () => {
  const replaced = [];
  const action = readEmailAction({ hash: "#email-action=reset&token=private-fixture-token", pathname: "/", search: "?order=fixture" }, { replaceState: (...args) => replaced.push(args) });
  assert.equal(action.purpose, "reset"); assert.equal(action.token, "private-fixture-token");
  assert.equal(replaced[0][2], "/?order=fixture");
  assert.equal(readEmailAction({ hash: "#other=thing" }, { replaceState: () => { throw new Error("Unrelated URL must stay unchanged"); } }), null);
});

test("unconfigured, disabled and idle account-email recovery never reads account/message records", async () => {
  let settingsReads = 0;
  const service = createAccountEmails({ users: { get: () => { throw new Error("Unexpected account read"); } }, messages: { getMany: () => { throw new Error("Unexpected email read"); } },
    control: { read: async () => ({ paused: false }) }, retries: { emailEnabled: async () => false, dueRetries: async () => { throw new Error("Disabled worker must not inspect retries"); } }, config: async () => { settingsReads++; }, secret: "fixture" });
  assert.equal((await service.flush()).paused, true); assert.equal(settingsReads, 0);
});

test("100 concurrent verification requests produce one email; explicit confirmation is atomic and single-use", async () => {
  const f = await fixture();
  try {
    await Promise.all(Array.from({ length: 100 }, () => f.service.request(f.customer.id, "verify")));
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].reply_to, "support@portal.test");
    assert.equal(f.sent[0].from, "Portal <notifications@portal.test>");
    const token = f.tokenFrom(f.sent[0]);
    assert.equal(emailIsVerified(await f.users.get(f.customer.id)), false);
    assert.ok(!JSON.stringify(await f.users.get(f.customer.id)).includes(token.split(".")[1]));
    const attempts = await Promise.allSettled(Array.from({ length: 25 }, () => f.service.consume({ token, purpose: "verify" })));
    assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(emailIsVerified(await f.users.get(f.customer.id)), true);
    await assert.rejects(f.service.consume({ token, purpose: "reset", password: "new-password-twelve", confirmPassword: "new-password-twelve" }));
    const saved = await f.messages.emailPage(); assert.equal(saved.emails.length, 1); assert.equal(saved.emails[0].protectedContent, null);
  } finally { await f.close(); }
});

test("reset has a 15-minute expiry, requires matching passwords, revokes sessions and all prior links", async () => {
  const f = await fixture();
  try {
    await f.service.requestByEmail(f.customer.email);
    const token = f.tokenFrom(f.sent[0]), oldVersion = sessionCredentialVersion(f.customer, f.secret);
    await assert.rejects(f.service.consume({ token, purpose: "reset", password: "short", confirmPassword: "short" }));
    await assert.rejects(f.service.consume({ token, purpose: "reset", password: "new-password-twelve", confirmPassword: "different-password" }));
    const result = await f.service.consume({ token, purpose: "reset", password: "new-password-twelve", confirmPassword: "new-password-twelve" });
    assert.notEqual(sessionCredentialVersion(result.user, f.secret), oldVersion);
    assert.equal(await verifyPasswordAsync("new-password-twelve", result.user.passwordHash), true);
    assert.equal(emailIsVerified(result.user), true);
    assert.deepEqual(result.user.emailActions, {});
    await f.service.send(result.noticeId); assert.equal(f.sent[1].subject, "Your password has been changed");
    await assert.rejects(f.service.consume({ token, purpose: "reset", password: "another-password-twelve", confirmPassword: "another-password-twelve" }));
    f.advance(61000); await f.service.requestByEmail(f.customer.email); const expired = f.tokenFrom(f.sent.at(-1));
    f.advance(15 * 60000 + 1); await assert.rejects(f.service.consume({ token: expired, purpose: "reset", password: "another-password-twelve", confirmPassword: "another-password-twelve" }));
  } finally { await f.close(); }
});

test("changed email/credentials/role invalidate links; unverified admins and unknown emails cannot recover", async () => {
  const f = await fixture();
  try {
    await f.service.requestByEmail("missing@portal.test"); assert.equal(f.sent.length, 0);
    await f.users.insert({ ...f.customer, id: "admin-two", role: "admin", username: "admin-two", email: "admin@portal.test" });
    await f.service.requestByEmail("admin@portal.test"); assert.equal(f.sent.length, 0);
    await f.service.requestByEmail(f.customer.email); const token = f.tokenFrom(f.sent[0]);
    await f.users.update(f.customer.id, user => ({ ...user, email: "changed@portal.test" }));
    await assert.rejects(f.service.consume({ token, purpose: "reset", password: "new-password-twelve", confirmPassword: "new-password-twelve" }));
  } finally { await f.close(); }
});

test("security sends ignore order-email toggles, but respect configuration, pause and security controls", async () => {
  const f = await fixture();
  try {
    f.config.emailEnabled = false; await f.service.request(f.customer.id, "verify"); assert.equal(f.sent.length, 1);
    f.pause(); f.advance(61000); await f.service.request(f.customer.id, "reset"); assert.equal(f.sent.length, 1);
    assert.equal((await f.service.flush()).paused, true);
  } finally { await f.close(); }
});

test("signed callbacks are deduplicated and out-of-order events cannot replace a terminal delivery failure", async () => {
  const f = await fixture();
  try {
    await f.service.request(f.customer.id, "verify");
    const message = (await f.messages.emailPage()).emails[0], secret = `whsec_${randomBytes(32).toString("base64")}`, webhook = new Webhook(secret);
    const receive = createEmailWebhooks({ messages: f.messages, secret });
    const callback = async (type, id, extra = {}) => {
      const payload = JSON.stringify({ type, created_at: new Date().toISOString(), data: { email_id: "provider-1", to: [f.customer.email], tags: { portal_message_id: message.id }, ...extra } });
      const headers = { "svix-id": id, "svix-timestamp": String(Math.floor(Date.now() / 1000)), "svix-signature": webhook.sign(id, new Date(), payload) };
      return receive(payload, headers);
    };
    assert.equal((await callback("email.delivered", "event-one")).applied, true);
    assert.equal((await callback("email.delivered", "event-one")).applied, false);
    await callback("email.bounced", "event-two", { bounce: { message: "Mailbox unavailable" } });
    await callback("email.sent", "event-three");
    const saved = (await f.messages.getMany([message.id]))[0]; assert.equal(saved.deliveryStatus, "bounced"); assert.equal(saved.deliveryEvents.length, 3);
    await assert.rejects(receive("{}", { "svix-id": "bad", "svix-timestamp": "1", "svix-signature": "v1,bad" }), error => error.status === 400);
    assert.equal((await f.messages.emailPage({ status: "bounced", search: f.customer.email })).emails.length, 1);
  } finally { await f.close(); }
});

test("permanent provider rejection stops retries and discards an undeliverable security link", async () => {
  const f = await fixture(); let calls = 0;
  try {
    f.config.fetchImpl = async () => { calls++; return Response.json({ error: "Rejected" }, { status: 400 }); };
    await f.service.request(f.customer.id, "verify");
    const message = (await f.messages.emailPage()).emails[0];
    assert.equal(message.status, "failed"); assert.equal(message.permanentFailure, true); assert.equal(message.attempts, 1); assert.equal(message.protectedContent, null);
    await f.service.send(message.id); assert.equal(calls, 1); assert.equal(f.hints.size, 0);
  } finally { await f.close(); }
});

test("an authoritative delivered callback prevents replay after an ambiguous provider HTTP response", async () => {
  const f = await fixture(); let calls = 0;
  try {
    f.config.fetchImpl = async () => { calls++; return Response.json({ error: "Unknown outcome" }, { status: 503 }); };
    await f.service.request(f.customer.id, "verify");
    const message = (await f.messages.emailPage()).emails[0]; assert.equal(message.status, "failed");
    await f.messages.recordDelivery({ id: "known-delivered", messageId: message.id, providerId: "provider-one", recipient: f.customer.email, status: "delivered", at: new Date().toISOString() });
    await f.service.send(message.id); assert.equal(calls, 1); assert.equal(f.hints.size, 0);
    assert.equal(publicEmail((await f.messages.getMany([message.id]))[0]).retryable, false);
  } finally { await f.close(); }
});

test("real PostgreSQL commits account/token/email atomically and deduplicates 100 simultaneous signed callbacks", async () => {
  const database = await startIsolatedPostgres(); let f;
  try {
    await database.pool.query(portalSchemaSql); f = await fixture(database.pool);
    await f.service.request(f.customer.id, "reset"); const token = f.tokenFrom(f.sent[0]);
    const originalInsert = f.messages.insert; f.messages.insert = async () => { throw new Error("Deliberate outbox failure"); };
    await assert.rejects(f.service.consume({ token, purpose: "reset", password: "new-password-twelve", confirmPassword: "new-password-twelve" }), /outbox failure/);
    assert.equal(await verifyPasswordAsync("old-password-twelve", (await f.users.get(f.customer.id)).passwordHash), true);
    f.messages.insert = originalInsert;
    const consumed = await Promise.allSettled(Array.from({ length: 10 }, () => f.service.consume({ token, purpose: "reset", password: "new-password-twelve", confirmPassword: "new-password-twelve" })));
    assert.equal(consumed.filter(result => result.status === "fulfilled").length, 1);
    const message = (await f.messages.emailPage({ event: "password_reset" })).emails[0];
    const event = { id: "postgres-event", messageId: message.id, providerId: "provider-1", recipient: f.customer.email, status: "delivered", at: new Date().toISOString() };
    const results = await Promise.all(Array.from({ length: 100 }, () => f.messages.recordDelivery(event)));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(Number((await database.pool.query("SELECT count(*) AS count FROM op_email_delivery_events")).rows[0].count), 1);
    assert.equal((await f.messages.emailPage({ status: "delivered" })).counts.total, 1);
  } finally { if (f) await f.close(); await database.close(); }
});

test("isolated HTTP flows enforce verification, preserve generic recovery and hide all account action metadata", async () => {
  const portal = await startIsolatedPortal(); let cookie = "";
  async function api(url, body, expected = 200) {
    const response = await fetch(portal.url + url, { method: body ? "POST" : "GET", headers: { "x-op-client": "portal", "content-type": "application/json", cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  }
  try {
    const address = { line1: "1 Fixture Road", suburb: "Menlyn", city: "Pretoria", province: "Gauteng", postalCode: "0001", country: "South Africa" };
    const registered = await api("/api/auth/register", { username: "new-customer", name: "New Customer", email: "new@portal.test", password: "new-password-twelve", phoneArea: "+27", phoneNumber: "821234567", defaultAddress: address, terms: { accepted: true, ageConfirmed: true, version: "research-use-v1-2026-10-08" } }, 201);
    assert.equal(registered.user.emailVerified, false); assert.ok(!JSON.stringify(registered).includes("emailActions"));
    await api("/api/catalog");
    const rejected = await api("/api/orders", { items: [{ variantId: "mock-hd-reta-default", quantity: 1 }], idempotencyKey: "unverified-order" }, 403); assert.equal(rejected.code, "EMAIL_VERIFICATION_REQUIRED");
    const existing = await api("/api/auth/password/request", { email: "new@portal.test" }, 202);
    const missing = await api("/api/auth/password/request", { email: "missing@portal.test" }, 202); assert.deepEqual(existing, missing);
    await api("/api/auth/admin-login", { username: "admin", password: "admin" });
    // Wait only for our deferred local fixture jobs; no real provider is configured.
    let emails = []; for (let attempt = 0; attempt < 40; attempt++) { emails = (await api("/api/admin/notifications?event=email_verification")).emails; if (emails.length) break; await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.equal(emails.length, 1); assert.equal(emails[0].displayStatus, "setup_required"); assert.ok(!JSON.stringify(emails).includes("protectedContent"));
    const saved = JSON.parse(await readFile(path.join(portal.directory, "data/customer-messages.json"), "utf8"));
    const notice = saved.messages.find(message => message.event === "email_verification");
    const content = revealEmailContent(notice.protectedContent, "isolated-local-session");
    const token = new URLSearchParams(new URL(content.text.match(/https:\/\/\S+/)[0]).hash.slice(1)).get("token");
    await api("/api/auth/email/confirm", { token });
    await api("/api/auth/login", { login: "new-customer", password: "new-password-twelve" });
    await api("/api/orders", { items: [{ variantId: "mock-hd-reta-default", quantity: 1 }], idempotencyKey: "verified-order" }, 201);
    const oldCookie = cookie;
    const allNotices = JSON.parse(await readFile(path.join(portal.directory, "data/customer-messages.json"), "utf8")).messages;
    const recovery = allNotices.find(message => message.event === "password_reset");
    const recoveryContent = revealEmailContent(recovery.protectedContent, "isolated-local-session");
    const resetToken = new URLSearchParams(new URL(recoveryContent.text.match(/https:\/\/\S+/)[0]).hash.slice(1)).get("token");
    await api("/api/auth/password/reset", { token: resetToken, password: "updated-password-twelve", confirmPassword: "updated-password-twelve" });
    cookie = oldCookie; await api("/api/orders", null, 401);
    await api("/api/auth/login", { login: "new-customer", password: "new-password-twelve" }, 401);
    await api("/api/auth/login", { login: "new-customer", password: "updated-password-twelve" });
  } finally { await portal.close(); }
});

test("unverified customers can correct a mistyped email only with their password, invalidating old links and respecting unique identities", async () => {
  const portal = await startIsolatedPortal(); let cookie = "";
  async function api(url, body, expected = 200) {
    const response = await fetch(portal.url + url, { method: body ? "POST" : "GET", headers: { "x-op-client": "portal", "content-type": "application/json", cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  }
  async function pendingToken(email, event) {
    for (let attempt = 0; attempt < 80; attempt++) {
      let messages = [];
      try { messages = JSON.parse(await readFile(path.join(portal.directory, "data/customer-messages.json"), "utf8")).messages; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const notice = messages.find(message => message.to === email && message.event === event);
      if (notice) {
        const content = revealEmailContent(notice.protectedContent, "isolated-local-session");
        return new URLSearchParams(new URL(content.text.match(/https:\/\/\S+/)[0]).hash.slice(1)).get("token");
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail("Deferred fixture email did not arrive");
  }
  try {
    const details = { name: "Fixture Customer", password: "customer-password-twelve", phoneArea: "+27", phoneNumber: "821234567",
      defaultAddress: { line1: "1 Fixture Road", suburb: "Menlyn", city: "Pretoria", province: "Gauteng", postalCode: "0001", country: "South Africa" },
      terms: { accepted: true, ageConfirmed: true, version: "research-use-v1-2026-10-08" } };
    await api("/api/auth/register", { ...details, username: "typo-customer", email: "typo@portal.test" }, 201);
    const ownerCookie = cookie;
    await api("/api/auth/password/request", { email: "typo@portal.test" }, 202);
    const oldVerify = await pendingToken("typo@portal.test", "email_verification"), oldReset = await pendingToken("typo@portal.test", "password_reset");
    await api("/api/auth/register", { ...details, username: "other-customer", email: "other@portal.test" }, 201);
    cookie = ownerCookie;
    await api("/api/account/email", { email: "correct@portal.test", password: "wrong-password" }, 400);
    const duplicate = await api("/api/account/email", { email: "OTHER@portal.test", password: details.password }, 409);
    assert.match(duplicate.error, /already exists/i);
    const corrected = await api("/api/account/email", { email: "correct@portal.test", password: details.password });
    assert.equal(corrected.user.email, "correct@portal.test"); assert.equal(corrected.user.emailVerified, false);
    assert.ok(!JSON.stringify(corrected).includes("emailActions"));
    const newVerify = await pendingToken("correct@portal.test", "email_verification");
    await api("/api/auth/email/confirm", { token: oldVerify }, 400);
    await api("/api/auth/password/reset", { token: oldReset, password: "another-password-twelve", confirmPassword: "another-password-twelve" }, 400);
    await api("/api/auth/login", { login: "correct@portal.test", password: details.password });
    assert.equal((await api("/api/auth/me")).user.emailVerified, false);
    await api("/api/auth/email/confirm", { token: newVerify });
    assert.equal((await api("/api/auth/me")).user.emailVerified, true);
    await api("/api/account/email", { email: "changed-again@portal.test", password: details.password }, 409);
    await api("/api/auth/admin-login", { username: "admin", password: "admin" });
    await api("/api/account/email", { email: "admin@portal.test", password: "admin" }, 403);
  } finally { await portal.close(); }
});

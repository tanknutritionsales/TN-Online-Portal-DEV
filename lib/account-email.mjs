import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { emailSetupStatus, deliverQueuedEmail } from "./customer-notifications.mjs";
import { hashPasswordAsync, validateNewPassword, sessionCredentialVersion } from "./security.mjs";
import { protectEmailContent } from "./email-content.mjs";

export const accountEmailEvents = new Set(["email_verification", "password_reset", "password_changed"]);
export const emailIsVerified = user => Boolean(user && user.emailVerifiedAddress === String(user.email).toLowerCase() && Number.isFinite(Date.parse(user.emailVerifiedAt)));
export const realEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || "") && !/@(?:admin\.local|example\.(?:com|invalid))$/i.test(value);
const digest = value => createHash("sha256").update(value).digest("hex");
const stamp = time => new Date(time).toISOString();
const invalid = () => Object.assign(new Error("This link has expired or has already been used. Please request a new one."), { status: 400, code: "EMAIL_LINK_INVALID" });
const equal = (left, right) => typeof left === "string" && typeof right === "string" && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));

export function createAccountEmails({ users, messages, control, retries, config, secret, now = Date.now, deliver = deliverQueuedEmail }) {
  function actionUrl(purpose, token, settings) {
    const url = new URL(settings.portalUrl);
    if (url.protocol !== "https:" && !(settings.local && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) throw new Error("A trusted HTTPS portal address is required.");
    url.search = "";
    url.hash = new URLSearchParams({ "email-action": purpose, token }).toString();
    return url.href;
  }
  function email(user, event, id, settings, { token, purpose, expiresAt } = {}) {
    const titles = { email_verification: "Verify your email address", password_reset: "Reset your password", password_changed: "Your password has been changed" };
    const title = titles[event];
    const link = token ? actionUrl(purpose, token, settings) : null;
    const description = event === "email_verification" ? "Confirm your email address to place orders and receive account updates."
      : event === "password_reset" ? "Use this single-use link to choose a new password. It expires in 15 minutes. If you did not request this, you can ignore this email."
      : "Your account password was changed. If you did not make this change, contact our support team immediately.";
    const escape = text => String(text).replace(/[&<>"']/g, value => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[value]));
    const text = `${title}\n\n${description}${link ? `\n\n${link}` : ""}${settings.replyTo ? `\n\nNeed help? ${settings.replyTo}` : ""}`;
    const html = `<div style="font-family:Arial,sans-serif;color:#171717;max-width:560px;margin:auto;padding:24px"><p style="color:#b71921;font-weight:bold">${escape(settings.senderName || "Tank Nutrition")}</p><h1 style="font-size:24px">${title}</h1><p>${description}</p>${link ? `<p><a href="${escape(link)}" style="display:inline-block;background:#c91b24;color:white;padding:12px 20px;border-radius:6px;text-decoration:none">${event === "password_reset" ? "Reset password" : "Verify email"}</a></p>` : ""}${settings.replyTo ? `<p>Need help? ${escape(settings.replyTo)}</p>` : ""}</div>`;
    return { id: `email-${digest(`account:${id}`)}`, kind: "email", category: "security", event, actionId: id,
      customerId: user.id, customerName: user.name || "", orderId: null, reference: "Account", to: user.email,
      subject: title, protectedContent: protectEmailContent({ text, html }, secret),
      status: settings.securityEnabled === false ? "disabled" : emailSetupStatus(settings).configured ? "pending" : "setup_required",
      attempts: 0, createdAt: stamp(now()), updatedAt: stamp(now()), nextAttemptAt: stamp(now()), expiresAt: expiresAt || stamp(now() + 23 * 3600000) };
  }
  function actionValid(user, action, purpose, tokenSecret) {
    return action && action.purpose === purpose && action.email === user.email && action.role === user.role &&
      action.credentialVersion === sessionCredentialVersion(user, secret) && Date.parse(action.expiresAt) > now() &&
      (!tokenSecret || equal(action.hash, digest(tokenSecret)));
  }
  async function currentMessage(message) {
    if (!accountEmailEvents.has(message.event) || Date.parse(message.expiresAt || 0) <= now()) return false;
    const user = await users.get(message.customerId);
    if (!user || user.email !== message.to) return false;
    if (message.event === "password_changed") return true;
    const purpose = message.event === "password_reset" ? "reset" : "verify";
    const action = user.emailActions?.[purpose];
    return action?.id === message.actionId && actionValid(user, action, purpose) && (purpose !== "verify" || !emailIsVerified(user));
  }
  async function send(id, { waitForCapacity = false, deadline } = {}) {
    if ((await control.read()).paused) return null;
    if (await retries.emailEnabled?.() === false) return null;
    const settings = await config();
    if (settings.securityEnabled === false || !emailSetupStatus(settings).configured) return null;
    const message = (await messages.getMany([id]))[0];
    if (!message || !accountEmailEvents.has(message.event)) { await retries.clearRetry(id); return null; }
    if (message.deliveryStatus || message.permanentFailure) { await retries.clearRetry(id); return message; }
    if (!["pending", "failed", "sending"].includes(message.status)) { await retries.clearRetry(id); return message; }
    if (!await currentMessage(message)) {
      const result = await messages.update(id, entry => ({ ...entry, status: "superseded", protectedContent: null, updatedAt: stamp(now()) }));
      await retries.clearRetry(id); return result;
    }
    const result = await deliver(messages, id, { ...settings, securityKey: secret, waitForCapacity, deadline }, now());
    await retries.syncRetry(result);
    return result;
  }
  async function request(userId, purpose) {
    if (!["verify", "reset"].includes(purpose)) throw new TypeError("Invalid account email purpose.");
    const settings = await config(), id = randomUUID(), tokenSecret = randomBytes(32).toString("base64url");
    if (settings.securityEnabled === false) return null;
    let queued = null;
    const createdAt = now(), expiresAt = stamp(createdAt + (purpose === "reset" ? 15 * 60000 : 24 * 3600000));
    const hint = { id: `email-${digest(`account:${id}`)}`, kind: "email", status: "pending", attempts: 0, createdAt: stamp(createdAt), nextAttemptAt: stamp(createdAt + 30000), expiresAt };
    const ready = settings.securityEnabled !== false && emailSetupStatus(settings).configured;
    if (ready) await retries.syncRetry(hint); // Save recovery intent before the transaction.
    try {
      await users.update(userId, user => {
        if (!realEmail(user.email) || (purpose === "verify" && emailIsVerified(user)) || (purpose === "reset" && user.role === "admin" && !emailIsVerified(user))) return null;
        const old = user.emailActions?.[purpose];
        if (old && actionValid(user, old, purpose) && createdAt - Date.parse(old.createdAt) < 60000) return null;
        const token = `${Buffer.from(user.id).toString("base64url")}.${tokenSecret}`;
        queued = email(user, purpose === "verify" ? "email_verification" : "password_reset", id, settings, { token, purpose, expiresAt });
        user.emailActions = { ...user.emailActions, [purpose]: { id, purpose, hash: digest(tokenSecret), email: user.email, role: user.role,
          credentialVersion: sessionCredentialVersion(user, secret), createdAt: stamp(createdAt), expiresAt } };
        return user;
      }, { onWrite: async client => { await messages.insert(queued, { client }); } });
    } catch (error) { if (ready) await retries.clearRetry(hint.id).catch(() => {}); throw error; }
    if (!queued) { if (ready) await retries.clearRetry(hint.id); return null; }
    if (ready) await send(queued.id);
    return { id: queued.id, status: queued.status };
  }
  async function requestByEmail(value) {
    const address = String(value || "").trim().toLowerCase();
    if (!realEmail(address)) return;
    const user = await users.findLogin(address);
    if (user?.email === address) await request(user.id, "reset");
  }
  function parseToken(token) {
    if (typeof token !== "string" || token.length > 350 || !/^[\w-]+\.[\w-]{43}$/.test(token)) throw invalid();
    const [encoded, value] = token.split(".");
    const id = Buffer.from(encoded, "base64url").toString("utf8");
    if (!id || id.length > 160 || Buffer.from(id).toString("base64url") !== encoded) throw invalid();
    return { id, value };
  }
  async function consume({ token, purpose, password, confirmPassword }) {
    if (!["verify", "reset"].includes(purpose)) throw invalid();
    const parsed = parseToken(token), before = await users.get(parsed.id);
    if (!before || !actionValid(before, before.emailActions?.[purpose], purpose, parsed.value)) throw invalid();
    let passwordHash;
    if (purpose === "reset") {
      validateNewPassword(password);
      if (password !== confirmPassword) throw Object.assign(new Error("Passwords must match."), { status: 400 });
      passwordHash = await hashPasswordAsync(password);
    }
    const settings = await config(), noticeId = randomUUID();
    const noticeHint = { id: `email-${digest(`account:${noticeId}`)}`, kind: "email", status: "pending", attempts: 0, createdAt: stamp(now()), nextAttemptAt: stamp(now() + 30000) };
    const ready = purpose === "reset" && settings.securityEnabled !== false && emailSetupStatus(settings).configured;
    if (ready) await retries.syncRetry(noticeHint);
    let notice;
    let user;
    try { user = await users.update(parsed.id, current => {
      if (!actionValid(current, current.emailActions?.[purpose], purpose, parsed.value)) throw invalid();
      current.emailVerifiedAddress = current.email;
      current.emailVerifiedAt = stamp(now());
      if (purpose === "reset") {
        current.passwordHash = passwordHash;
        current.emailActions = {};
        notice = email(current, "password_changed", noticeId, settings);
      } else { current.emailActions = { ...current.emailActions }; delete current.emailActions.verify; }
      return current;
    }, { onWrite: async client => { if (notice) await messages.insert(notice, { client }); } }); }
    catch (error) { if (ready) await retries.clearRetry(noticeHint.id).catch(() => {}); throw error; }
    if (!user) throw invalid();
    return { user, noticeId: notice?.id };
  }
  async function flush({ deadline = Infinity } = {}) {
    if ((await control.read()).paused) return { sent: 0, paused: true };
    if (await retries.emailEnabled?.() === false) return { sent: 0, paused: true };
    // Deployment configuration only: do not wake SQL for an idle worker.
    const base = await config({ lightweight: true });
    if (!emailSetupStatus(base).configured) return { sent: 0, idle: true };
    const hints = await retries.dueRetries(now());
    if (!hints.length) return { sent: 0, idle: true };
    let sent = 0, processed = 0;
    for (const hint of hints.slice(0, 100)) {
      if (Date.now() + 8000 >= deadline) break;
      if ((await send(hint.id, { waitForCapacity: true, deadline }))?.status === "sent") sent++;
      processed++;
    }
    return { sent, processed, remaining: processed < hints.length };
  }
  return { request, requestByEmail, consume, send, flush, currentMessage };
}

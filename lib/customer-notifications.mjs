import { createHash, randomUUID } from "node:crypto";
import { revealEmailContent } from "./email-content.mjs";

export function normalizeCustomerCare(input = {}) {
  if (!input || typeof input !== "object") input = {};
  const clean = (value, length = 180) => String(value || "").replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, length);
  const email = clean(input.supportEmail).toLowerCase();
  return {
    supportEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "",
    whatsappNumber: clean(input.whatsappNumber, 30).replace(/[^0-9]/g, "").slice(0, 15),
    supportHours: clean(input.supportHours, 180),
    emailEnabled: Boolean(input.emailEnabled),
    securityEmailsEnabled: input.securityEmailsEnabled !== false,
    requireVerifiedEmailForOrders: input.requireVerifiedEmailForOrders !== false,
    emailEnabledAt: Number.isFinite(Date.parse(input.emailEnabledAt)) ? new Date(input.emailEnabledAt).toISOString() : null,
    senderName: clean(input.senderName || "Tank Nutrition", 80),
    events: Object.fromEntries(["order_received", "payment_ready", "payment_confirmed", "shipped"].map((kind) => [kind, input.events?.[kind] !== false])),
  };
}

export function emailSetupStatus({ apiKey, from, portalUrl, allowed = true }) {
  const missing = [];
  if (!apiKey) missing.push("Email service API key");
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from || "")) missing.push("Verified sender email");
  try { if (new URL(portalUrl).protocol !== "https:") missing.push("Public portal HTTPS address"); }
  catch { missing.push("Public portal HTTPS address"); }
  if (!allowed) missing.push("Production database delivery");
  return { configured: missing.length === 0, missing };
}

export function createOrderEmail(order, kind, { portalUrl, care, eventId }) {
  const id = `email-${createHash("sha256").update(`${order.id}:${kind}:${eventId}`).digest("hex")}`;
  const titles = {
    order_received: "Order received",
    payment_ready: "Payment details are ready",
    payment_confirmed: "Payment confirmed",
    shipped: order.fulfillmentStatus === "shipped" ? "Your order has shipped" : "Shipment update",
  };
  const descriptions = {
    order_received: "Our team will review availability and provide payment details in your account.",
    payment_ready: "Your order has been reviewed. Sign in to view your payment details and complete payment.",
    payment_confirmed: "Your payment has been confirmed. Your order is being processed.",
    shipped: "Shipment details are available in your account. Open your order to view tracking.",
  };
  const orderUrl = new URL(portalUrl);
  orderUrl.searchParams.set("order", order.id);
  const reference = String(order.reference || "");
  const title = titles[kind];
  if (!title) throw new Error("Unknown notification event.");
  const amount = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(Number(order.total || 0));
  const text = `${title}\n\nOrder ${reference}\nTotal: ${amount}\n\n${descriptions[kind]}\n\nView order: ${orderUrl.href}${care.supportEmail ? `\n\nNeed help? ${care.supportEmail}` : ""}`;
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const html = `<div style="font-family:Arial,sans-serif;color:#171717;max-width:560px;margin:auto;padding:24px"><p style="color:#b71921;font-weight:bold">${escape(care.senderName)}</p><h1 style="font-size:24px">${escape(title)}</h1><p>Order <strong>${escape(reference)}</strong><br>Total: ${escape(amount)}</p><p>${escape(descriptions[kind])}</p><p><a style="display:inline-block;background:#c91b24;color:#fff;padding:12px 20px;text-decoration:none;border-radius:6px" href="${escape(orderUrl.href)}">View order</a></p>${care.supportEmail ? `<p>Need help? ${escape(care.supportEmail)}</p>` : ""}</div>`;
  const now = new Date().toISOString();
  return { id, kind: "email", event: kind, customerId: order.customer.id, customerName: order.customer.name || "", orderId: order.id, reference, to: order.customer.email, subject: `${title} - ${reference}`, text, html, status: "pending", attempts: 0, createdAt: now, updatedAt: now, nextAttemptAt: now };
}

export async function sendResendEmail(message, { apiKey, from, senderName, replyTo, securityKey, reserveSendSlot, waitForCapacity = false, deadline, fetchImpl = fetch }) {
  if (reserveSendSlot) await reserveSendSlot({ wait: waitForCapacity, deadline });
  const content = message.protectedContent ? revealEmailContent(message.protectedContent, securityKey) : message;
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "idempotency-key": message.id },
    signal: AbortSignal.timeout(5500),
    body: JSON.stringify({ from: `${senderName} <${from}>`, to: [message.to], subject: message.subject, text: content.text, html: content.html, tags: [{ name: "portal_message_id", value: message.id }], ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const quota = ["daily_quota_exceeded", "monthly_quota_exceeded"].includes(payload.name);
    const header = response.headers?.get("retry-after"), seconds = Number(header);
    const retryAfterSeconds = header && Number.isFinite(seconds) && seconds >= 0 ? Math.min(86400, Math.max(1, seconds)) : 60;
    throw Object.assign(new Error(quota ? "Email sending quota reached. Check the email service plan and usage." : `Email delivery failed (HTTP ${response.status}). Check email service settings and the recipient address.`), {
      emailDeferred: response.status === 429 && !quota, emailQuota: quota, retryAfterSeconds: quota ? Math.max(3600, retryAfterSeconds) : retryAfterSeconds,
      permanentEmailFailure: response.status >= 400 && response.status < 500 && ![408,429].includes(response.status) && payload.name !== "concurrent_idempotent_requests",
    });
  }
  const result = await response.json();
  if (!result.id) throw new Error("The email service did not confirm delivery acceptance.");
  return String(result.id).slice(0, 180);
}

export async function deliverQueuedEmail(store, id, config, now = Date.now()) {
  const lease = randomUUID();
  const claimed = await store.update(id, (message) => {
    if (message.kind !== "email" || !["pending", "failed", "sending"].includes(message.status) || message.deliveryStatus || message.permanentFailure) return null;
    if (message.attempts >= 5 || (message.status === "sending" && Date.parse(message.lockedUntil) > now)) return null;
    if (Date.parse(message.nextAttemptAt || 0) > now) return null;
    if (now - Date.parse(message.createdAt) >= 23 * 60 * 60 * 1000 || (message.expiresAt && Date.parse(message.expiresAt) <= now)) return { ...message, status: "expired", protectedContent: null, updatedAt: new Date(now).toISOString() };
    return { ...message, status: "sending", lease, attempts: message.attempts + 1, lockedUntil: new Date(now + 120_000).toISOString(), updatedAt: new Date(now).toISOString() };
  });
  if (!claimed || claimed.status !== "sending") return claimed;
  try {
    const deliveryId = await sendResendEmail(claimed, config);
    return await store.update(id, (current) => current.lease !== lease ? null : { ...current, status: "sent", deliveryId, sentAt: new Date().toISOString(), lastError: "", nextAttemptAt: null, ...(current.category === "security" ? { protectedContent: null } : {}), updatedAt: new Date().toISOString() });
  } catch (error) {
    return store.update(id, (current) => {
      if (current.lease !== lease) return null;
      const attempts = Math.max(0, current.attempts - (error.emailDeferred || error.emailQuota ? 1 : 0));
      return { ...current, attempts, status: error.emailDeferred ? "pending" : "failed", permanentFailure: Boolean(error.permanentEmailFailure),
        ...(error.permanentEmailFailure && current.category === "security" ? { protectedContent: null } : {}),
        lastError: error.name === "TimeoutError" ? "The email service timed out. Delivery will be retried." : String(error.message || "Email delivery failed.").slice(0, 240),
        nextAttemptAt: attempts >= 5 || error.permanentEmailFailure ? null : new Date(Date.now() + (error.emailDeferred || error.emailQuota ? error.retryAfterSeconds * 1000 : 60000 * (2 ** attempts))).toISOString(), updatedAt: new Date().toISOString() };
    });
  }
}

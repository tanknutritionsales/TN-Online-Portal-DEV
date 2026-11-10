import { Webhook } from "svix";

export const deliveryRanks = { sent: 0, delayed: 1, delivered: 2, failed: 3, bounced: 4, suppressed: 4, complained: 5 };
export function applyDeliveryEvent(message, event) {
  if (message.kind !== "email" || (message.deliveryId && message.deliveryId !== event.providerId)) return null;
  if (event.recipient && message.to.toLowerCase() !== event.recipient.toLowerCase()) return null;
  if ((message.deliveryEvents || []).some(item => item.id === event.id)) return null;
  const previousRank = deliveryRanks[message.deliveryStatus] ?? -1, rank = deliveryRanks[event.status];
  const next = { ...message, deliveryId: event.providerId,
    deliveryEvents: [...(message.deliveryEvents || []), { id: event.id, status: event.status, at: event.at, detail: event.detail || "" }].slice(-30),
    updatedAt: new Date().toISOString() };
  if (rank > previousRank || (rank === previousRank && event.at >= (message.deliveryUpdatedAt || ""))) {
    next.deliveryStatus = event.status;
    next.deliveryUpdatedAt = event.at;
    next.deliveryDetail = event.detail || "";
  }
  return next;
}

export function createEmailWebhooks({ messages, secret }) {
  return async function receive(raw, headers) {
    const signingSecret = typeof secret === "function" ? secret() : secret;
    if (!signingSecret) throw Object.assign(new Error("Email delivery callbacks are not configured."), { status: 503, code: "EMAIL_WEBHOOK_UNCONFIGURED" });
    if (Buffer.byteLength(raw) > 256000) throw Object.assign(new Error("Webhook body is too large."), { status: 413 });
    let payload;
    try { new Webhook(signingSecret).verify(raw, headers); payload = JSON.parse(raw); }
    catch { throw Object.assign(new Error("Invalid email callback signature."), { status: 400 }); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw Object.assign(new Error("Invalid email callback."), { status: 400 });
    const mapping = { "email.sent": "sent", "email.delivered": "delivered", "email.delivery_delayed": "delayed", "email.bounced": "bounced", "email.complained": "complained", "email.failed": "failed", "email.suppressed": "suppressed" };
    const status = Object.hasOwn(mapping, payload.type) ? mapping[payload.type] : null;
    if (!status) return { received: true, ignored: true };
    const data = payload.data || {}, tags = Array.isArray(data.tags) ? Object.fromEntries(data.tags.map(item => [item.name, item.value])) : data.tags || {};
    const messageId = /^email-[a-f0-9]{64}$/.test(tags.portal_message_id || "") ? tags.portal_message_id : null;
    const providerId = String(data.email_id || "");
    if (!/^[\w-]{1,180}$/.test(providerId) || !Number.isFinite(Date.parse(payload.created_at))) throw Object.assign(new Error("Invalid email callback."), { status: 400 });
    const recipients = Array.isArray(data.to) ? data.to : [data.to];
    if (recipients.length !== 1 || typeof recipients[0] !== "string") return { received: true, ignored: true };
    const detail = String(data.bounce?.message || data.failed?.reason || data.error?.message || data.suppressed?.message || "").replace(/[<>\u0000-\u001f]/g, " ").slice(0, 300);
    const result = await messages.recordDelivery({ id: headers["svix-id"], messageId, providerId, recipient: recipients[0], status, at: new Date(payload.created_at).toISOString(), detail });
    return { received: true, applied: Boolean(result) };
  };
}

export function publicEmail(message) {
  const blocked = ["bounced", "complained", "suppressed", "failed"].includes(message.deliveryStatus);
  return { id: message.id, customerId: message.customerId, customerName: message.customerName || "", orderId: message.orderId || null,
    reference: message.reference || "Account", category: message.category || "order", event: message.event, to: message.to, subject: message.subject,
    status: message.status, deliveryStatus: message.deliveryStatus || null, displayStatus: message.deliveryStatus || message.status,
    attempts: message.attempts, lastError: message.lastError || "", deliveryDetail: message.deliveryDetail || "",
    sentAt: message.sentAt || null, createdAt: message.createdAt, deliveryUpdatedAt: message.deliveryUpdatedAt || null,
    history: (message.deliveryEvents || []).map(({ status, at, detail }) => ({ status, at, detail })),
    retryable: message.category !== "security" && !blocked && !message.deliveryStatus && ["pending", "failed", "setup_required", "disabled"].includes(message.status) && Date.now() - Date.parse(message.createdAt) < 23 * 3600000 };
}

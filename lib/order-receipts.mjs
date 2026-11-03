const hour = 3_600_000;
export function normalizeDeliverySettings(input = {}) {
  const number = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.round(Number(value)))) : fallback;
  return { enabled: input?.enabled !== false, delayDays: number(input?.delayDays ?? 3, 3, 1, 30), snoozeHours: number(input?.snoozeHours ?? 24, 24, 1, 168) };
}

export function fullyShippedAt(order, { officeRequired = true, externalRequired = false } = {}) {
  if (!isFullyShipped(order, { officeRequired, externalRequired })) return null;
  // Once recorded, dispatch time is stable even if staff correct tracking later.
  if (Number.isFinite(Date.parse(order.shippedAt))) return new Date(order.shippedAt).toISOString();
  const events = (order.statusEvents || []).filter((event) => event.type === "shipped" || (externalRequired && event.type === "external_tracking_added")).map((event) => event.at);
  const dates = [order.shippedAt, ...(officeRequired ? [order.officeShippedAt] : []), ...(externalRequired ? [order.externalTracking?.addedAt] : []), ...events].map(Date.parse).filter(Number.isFinite);
  return dates.length ? new Date(Math.max(...dates)).toISOString() : null;
}

function isFullyShipped(order, { officeRequired = true, externalRequired = false } = {}) {
  if (order.paymentStatus !== "confirmed" || order.fulfillmentStatus !== "shipped") return false;
  // Tracking can be entered before packing. For split orders, Office must actually dispatch.
  if (officeRequired && externalRequired && !order.officeShippedAt && !(order.statusEvents || []).some((event) => event.type === "shipped")) return false;
  if (externalRequired && !order.externalTracking?.number) return false;
  return true;
}

export function deliveryReceiptView(order, record, settings, shipping = {}, now = Date.now()) {
  const options = normalizeDeliverySettings(settings);
  const shipped = fullyShippedAt(order, shipping);
  const receivedAt = record?.receivedAt || null;
  const snoozedUntil = record?.snoozedUntil || null;
  const promptAfter = shipped ? new Date(Date.parse(shipped) + options.delayDays * 24 * hour).toISOString() : null;
  return {
    receivedAt, snoozedUntil, fullyShippedAt: shipped, promptAfter,
    canConfirm: options.enabled && isFullyShipped(order, shipping) && !receivedAt,
    promptDue: options.enabled && Boolean(shipped) && !receivedAt && Date.parse(promptAfter) <= now && (!snoozedUntil || Date.parse(snoozedUntil) <= now),
  };
}

export async function recordDeliveryResponse(store, order, customerId, action, settings, shipping = {}, now = Date.now()) {
  if (order.customer?.id !== customerId) throw Object.assign(new Error("Order not found."), { status: 404 });
  if (!["received", "not_yet"].includes(action)) throw Object.assign(new Error("Choose Received or Not yet."), { status: 400 });
  const id = `receipt:${order.id}`, stamp = new Date(now).toISOString();
  const existing = (await store.getMany([id]))[0];
  if (existing?.customerId && existing.customerId !== customerId) throw Object.assign(new Error("Order not found."), { status: 404 });
  if (existing?.receivedAt) return existing;
  const view = deliveryReceiptView(order, existing, settings, shipping, now);
  if (!view.canConfirm) throw Object.assign(new Error("Receipt can be confirmed once the complete order has shipped."), { status: 409 });
  await store.insert({ id, kind: "delivery_receipt", customerId, orderId: order.id, status: "waiting", createdAt: stamp, updatedAt: stamp });
  return store.update(id, (current) => {
    if (current.receivedAt) return current;
    return { ...current, status: action === "received" ? "received" : "waiting", receivedAt: action === "received" ? stamp : null, snoozedUntil: action === "received" ? null : new Date(now + normalizeDeliverySettings(settings).snoozeHours * hour).toISOString(), fullyShippedAt: view.fullyShippedAt, updatedAt: stamp };
  });
}

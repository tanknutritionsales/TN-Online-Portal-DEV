import { emailSetupStatus } from "./customer-notifications.mjs";

export function createNotificationWorker({ control, runtimeConfig, readCare, messages, readOrders, deliver }) {
  return async function flush() {
    if ((await control.read()).paused) return { sent: 0, paused: true };
    // Check deployment configuration and cheap retry hints BEFORE Postgres.
    if (!emailSetupStatus(runtimeConfig({})).configured || await control.emailEnabled() === false) return { sent: 0, paused: true };
    const due = await control.dueRetries();
    if (!due.length) return { sent: 0, processed: 0, idle: true };
    const care = await readCare();
    if (!care.emailEnabled) { await control.setEmailEnabled(false); return { sent: 0, paused: true }; }
    const config = runtimeConfig(care);
    if (!emailSetupStatus(config).configured) return { sent: 0, paused: true };
    const queued = await messages.getMany(due.map((marker) => marker.id));
    for (const marker of due) if (!queued.some((message) => message.id === marker.id)) await control.clearRetry(marker.id);
    const eligible = [];
    for (const message of queued) {
      if (!["pending", "failed", "sending"].includes(message.status) || message.attempts >= 5 || Date.now() - Date.parse(message.createdAt) >= 23 * 60 * 60 * 1000) {
        await control.clearRetry(message.id);
      } else if (Date.parse(message.status === "sending" ? message.lockedUntil : message.nextAttemptAt || message.createdAt) > Date.now()) {
        await control.syncRetry(message);
      } else eligible.push(message);
    }
    if (!eligible.length) return { sent: 0, processed: 0 };
    const orders = await readOrders();
    let sent = 0, processed = 0;
    for (const message of eligible) {
      if ((await control.read()).paused) break;
      const order = orders.find((entry) => entry.id === message.orderId);
      let result;
      if (!order || !care.events[message.event] || (message.event === "payment_ready" && (order.paymentStatus === "confirmed" || order.specialOrder?.status === "declined"))) {
        result = await messages.update(message.id, (entry) => ({ ...entry, status: "superseded", updatedAt: new Date().toISOString() }));
      } else result = await deliver(message.id, config);
      await control.syncRetry(result);
      processed++;
      if (result?.status === "sent") sent++;
    }
    return { sent, processed };
  };
}

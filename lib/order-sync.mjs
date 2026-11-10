import { createHash, randomUUID } from "node:crypto";

function stableJSON(value) {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]]))
    : entry);
}

// Only inputs to the Office order belong here. External tracking, status events,
// notification state and unrelated fulfillment updates must not invalidate it.
export function orderSyncFingerprint(order, items) {
  const lines = items.map(({ variantId, quantity, price }) => ({ variantId, quantity: Number(quantity), price: Number(price) }))
    .sort((left, right) => stableJSON(left).localeCompare(stableJSON(right)));
  return createHash("sha256").update(stableJSON({
    id: order.id,
    reference: order.reference,
    items: lines,
    customer: order.customer,
    address: order.delivery?.address,
    deliveryFee: Number(order.deliveryFee || 0),
    courierLine: order.courierLine || null,
    currencyCode: order.currencyCode || "ZAR",
    paymentProvider: order.paymentLink?.provider || order.paymentProvider || "",
  })).digest("hex");
}

function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

function requireReviewedPayment(order) {
  if (order.paymentStatus !== "confirmed") throw conflict("Payment must be confirmed before Shopify sync.");
  if (order.specialOrder && !["accepted", "countered"].includes(order.specialOrder.status)) {
    throw conflict("Review and approve the special order before Shopify sync.");
  }
  if (order.fulfillmentReview?.status !== "reviewed") throw conflict("Review fulfillment before Shopify sync.");
}

function requireOfficeItems(items) {
  if (!Array.isArray(items)) throw conflict("Office allocations must be an array.");
  const seen = new Set();
  for (const item of items) {
    if (!item.variantId || seen.has(item.variantId) || !Number.isSafeInteger(Number(item.quantity)) || Number(item.quantity) <= 0
      || item.price == null || !Number.isFinite(Number(item.price)) || Number(item.price) < 0) {
      throw conflict("Office allocations need unique variants, positive integer quantities and valid saved prices.");
    }
    seen.add(item.variantId);
  }
}

function needsReconciliation(state = {}) {
  // Positive dispatch evidence always wins, including contradictory old records.
  if (state.dispatchedAt || state.reconciliationRequired || state.remoteCandidate?.id
    || state.status === "reconciliation_required" || state.status === "creating" || state.phase === "creating") return true;
  if (state.noOrderCreated === true) return false;
  if (state.noOrderCreated === false) return true;
  // These legacy outcomes were written only BEFORE remote creation: the Office
  // stock gate returned a shortage, or there were no Office lines to dispatch.
  if (["storage_pending", "external"].includes(state.status)) return false;
  // Legacy errors/syncing never persisted a dispatch marker. Their absence is
  // not proof of failure, and disabling sync must not erase that uncertainty.
  if (state.attemptedAt || state.attemptedBy || state.claimToken || state.leaseExpiresAt
    || state.phase || state.syncedAt || state.lastDispatchedAt) return true;
  // Untouched and never-attempted disabled orders are safe. Unrecognized or
  // incomplete failure states fail closed even if their old timestamp is absent.
  return Boolean(state.status && !["not_started", "disabled"].includes(state.status));
}

function event(order, type, label, at, key) {
  if (!Array.isArray(order.statusEvents)) order.statusEvents = [];
  const id = `order-sync:${order.id}:${key}`;
  if (!order.statusEvents.some((entry) => entry.id === id)) order.statusEvents.push({ id, at, actor: "system", type, label });
}

/**
 * orders.update must lock/reload ONE record and commit its synchronous transform
 * before resolving. A null transform result is a no-op returning the current row.
 * No injected network operation runs inside a transform. findRemote must return
 * an identity-verified remote order (or null); an empty search NEVER permits create.
 * Returns the current order, including syncing/error/reconciliation_required states.
 * Guard failures throw 409; persistence failures propagate to the caller.
 */
export function createOrderSync({ orders, enabled = false, officeItems, checkStock, createRemote, findRemote, now = Date.now, leaseMs = 90_000 }) {
  if (!orders?.get || !orders?.update || ![officeItems, checkStock, createRemote, findRemote, now].every((value) => typeof value === "function")) {
    throw new TypeError("Order sync requires a record store and injected stock, create, lookup and clock functions.");
  }
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new TypeError("leaseMs must be positive.");
  const clock = () => {
    const value = new Date(now()).getTime();
    if (!Number.isFinite(value)) throw new TypeError("Order sync clock must return a valid time.");
    return value;
  };
  const isEnabled = async () => Boolean(typeof enabled === "function" ? await enabled() : enabled);
  const detail = (error) => String(error?.message || "Shopify sync failed.").slice(0, 500);
  const change = (order, patch, release = false) => {
    order.shopifySync = { ...order.shopifySync, ...patch, ...(release ? { claimToken: null, leaseExpiresAt: null, phase: null } : {}) };
    order.updatedAt = new Date(clock()).toISOString();
    return order;
  };

  return async function sync(orderId, actor = {}) {
    const initial = await orders.get(orderId);
    if (!initial) throw Object.assign(new Error("Order not found."), { status: 404 });
    if (initial.shopifyOrder?.id) return initial;
    const syncEnabled = await isEnabled();
    const claimToken = randomUUID();
    const claimed = await orders.update(orderId, (order) => {
      if (order.shopifyOrder?.id) return null;
      const previous = order.shopifySync || {};
      if (previous.claimToken && Date.parse(previous.leaseExpiresAt) > clock()) return null;
      requireReviewedPayment(order);
      const items = officeItems(order);
      requireOfficeItems(items);
      const uncertain = needsReconciliation(previous);
      const fingerprint = orderSyncFingerprint(order, items);
      // A previously dispatched payload cannot be silently replaced or reclassified.
      if (uncertain && previous.fingerprint && previous.fingerprint !== fingerprint) {
        return change(order, { status: "reconciliation_required", reconciliationRequired: true, message: "The dispatched order payload changed. Check Shopify and resolve the saved quote before continuing." }, true);
      }
      if (!items.length && !uncertain) {
        if (previous.status === "external") return null;
        const at = new Date(clock()).toISOString();
        event(order, "shopify_order_skipped", "Shopify order skipped for external fulfillment", at, "external");
        return change(order, { status: "external", fingerprint, reconciliationRequired: false, dispatchedAt: null, syncedAt: at, message: "No Office items. Shopify order creation skipped." }, true);
      }
      if (!syncEnabled) {
        return change(order, { status: "disabled", reconciliationRequired: uncertain, message: "Shopify order sync is disabled." }, true);
      }
      const at = clock();
      return change(order, {
        status: uncertain ? "reconciliation_required" : "syncing",
        phase: uncertain ? "reconciling" : "checking_stock",
        claimToken,
        leaseExpiresAt: new Date(at + leaseMs).toISOString(),
        attemptedAt: new Date(at).toISOString(),
        attemptedBy: String(typeof actor === "string" ? actor : actor.username || actor.userId || "admin").slice(0, 120),
        fingerprint: uncertain ? previous.fingerprint || fingerprint : fingerprint,
        reconciliationRequired: uncertain,
        dispatchedAt: uncertain ? previous.dispatchedAt || null : null,
        noOrderCreated: !uncertain,
        shortfalls: [],
        message: uncertain ? "Checking Shopify for an earlier uncertain creation. No new order will be created." : "Checking Office stock.",
      });
    });
    if (!claimed) throw Object.assign(new Error("Order not found."), { status: 404 });
    if (claimed.shopifySync?.claimToken !== claimToken) return claimed;

    // Token fencing applies to every completion, including errors. Never replace
    // a whole snapshot: payment, tracking and other concurrent fields stay current.
    const updateClaim = (transform) => orders.update(orderId, (order) => {
      if (order.shopifySync?.claimToken !== claimToken || order.shopifyOrder?.id) return null;
      return transform(order);
    });
    const payloadError = (order) => {
      try {
        requireReviewedPayment(order);
        const items = officeItems(order);
        requireOfficeItems(items);
        if (!items.length || orderSyncFingerprint(order, items) !== claimed.shopifySync.fingerprint) {
          throw conflict("The saved Office order payload changed during sync.");
        }
        return null;
      } catch (error) { return error; }
    };
    const reconcile = (order, message, extra = {}) => change(order, { status: "reconciliation_required", reconciliationRequired: true, message, ...extra }, true);
    const finalize = (remote, reconciled = false) => updateClaim((order) => {
      const invalid = payloadError(order);
      if (invalid) return reconcile(order, detail(invalid), { remoteCandidate: remote });
      order.shopifyOrder = structuredClone(remote);
      const at = new Date(clock()).toISOString();
      event(order, reconciled ? "shopify_order_reconciled" : "shopify_order_created", `Shopify order ${remote.name || remote.id} ${reconciled ? "reconciled" : "created"}`, at, `remote:${remote.id}`);
      order.items = (order.items || []).map(({ storageBackedQuantity, ...item }) => item);
      return change(order, { status: "synced", reconciliationRequired: false, syncedAt: at, remoteCandidate: null, message: `Linked ${remote.name || remote.id}.` }, true);
    });

    if (claimed.shopifySync.reconciliationRequired) {
      let remote;
      try { remote = await findRemote(structuredClone(claimed)); }
      catch (error) { return updateClaim((order) => reconcile(order, `Shopify lookup failed: ${detail(error)} Check Shopify before any reset.`)); }
      if (!remote?.id) {
        return updateClaim((order) => reconcile(order, "No verified Shopify match found. Creation remains blocked: check Shopify manually; search indexing may be delayed."));
      }
      return finalize(remote, true);
    }

    let shortfalls;
    try {
      shortfalls = await checkStock(structuredClone(claimed));
      if (!Array.isArray(shortfalls)) throw new TypeError("Office stock check must return a shortfall array.");
    } catch (error) {
      return updateClaim((order) => change(order, { status: "error", noOrderCreated: true, message: `Office stock check failed: ${detail(error)}` }, true));
    }
    if (shortfalls.length) {
      return updateClaim((order) => change(order, { status: "storage_pending", shortfalls: structuredClone(shortfalls), noOrderCreated: true, message: "Transfer stock to Office, then check again." }, true));
    }

    const dispatchEnabled = await isEnabled();
    const dispatched = await updateClaim((order) => {
      const invalid = payloadError(order);
      if (invalid) return change(order, { status: "error", noOrderCreated: true, message: detail(invalid) }, true);
      if (!dispatchEnabled) return change(order, { status: "disabled", noOrderCreated: true, message: "Shopify order sync is disabled." }, true);
      if (!(Date.parse(order.shopifySync.leaseExpiresAt) > clock())) {
        return change(order, { status: "error", noOrderCreated: true, message: "Sync lease expired before dispatch. Retry the stock check." }, true);
      }
      // This commit is deliberately separate from createRemote. A crash after
      // this point always reconciles, even if the request never left the process.
      return change(order, { phase: "creating", dispatchedAt: new Date(clock()).toISOString(), noOrderCreated: false, message: "Creating Shopify order." });
    });
    if (!dispatched || dispatched.shopifyOrder?.id || dispatched.shopifySync?.claimToken !== claimToken || dispatched.shopifySync.phase !== "creating") return dispatched;

    let remote;
    try {
      remote = await createRemote(structuredClone(dispatched));
      if (!remote?.id) throw new Error("Shopify did not return an order ID; creation may have succeeded.");
    } catch (error) {
      if (error?.noOrderCreated === true) {
        return updateClaim((order) => change(order, { status: "error", dispatchedAt: null, lastDispatchedAt: order.shopifySync.dispatchedAt, noOrderCreated: true, reconciliationRequired: false, message: detail(error) }, true));
      }
      return updateClaim((order) => reconcile(order, `Shopify creation outcome is uncertain: ${detail(error)} Check Shopify before any reset.`));
    }
    // Keep this OUTSIDE the remote-error catch. A failed database commit must
    // propagate; the committed dispatch marker forces later reconciliation.
    return finalize(remote);
  };
}

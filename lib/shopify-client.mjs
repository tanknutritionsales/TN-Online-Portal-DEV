const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener("abort", aborted); resolve(); }
  function aborted() { clearTimeout(timer); reject(signal.reason); }
  signal?.addEventListener("abort", aborted, { once: true });
});

// Reconciliation may release fulfillment only for one exact, still-paid order.
// A cancelled/refunded match needs staff investigation, never another create.
export function verifiedCreatedOrder(connection, sourceIdentifier, expected, currencyCode = "ZAR") {
  if (!connection || connection.pageInfo?.hasNextPage) throw new Error("Shopify lookup could not establish a unique order.");
  const matches = (connection.nodes || []).filter(order => order.sourceIdentifier === sourceIdentifier);
  if (matches.length > 1) throw new Error("Multiple matching Shopify orders require staff review.");
  if (!matches.length) return null;
  const remote = matches[0];
  if (remote.cancelledAt || remote.displayFinancialStatus !== "PAID") throw new Error("The matching Shopify order is cancelled or is no longer fully paid. Staff review is required.");
  if (remote.lineItems?.pageInfo?.hasNextPage) throw new Error("Shopify order lines require staff review.");
  const actual = remote.lineItems?.nodes || [];
  const cents = value => Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) : NaN;
  if (expected.length !== actual.length || expected.some(item => !actual.some(line =>
    line.variant?.id === item.variantId && line.quantity === item.quantity &&
    cents(line.originalUnitPriceSet?.shopMoney?.amount) === cents(item.price) &&
    line.originalUnitPriceSet?.shopMoney?.currencyCode === currencyCode))) {
    throw new Error("Shopify quantities or prices do not match the approved order. Staff review is required.");
  }
  return remote;
}

// Read retries are bounded. Ambiguous mutation responses are NEVER replayed.
export function createShopifyClient({ endpoint, getAccessToken, fetchImpl = fetch, timeoutMs = 15_000, sleep = pause }) {
  return async function request(query, variables = {}, { signal, mutation = false } = {}) {
    const token = await getAccessToken({ signal });
    if (!token) throw Object.assign(new Error("Shopify access is not configured."), { status: 503, noOrderCreated: true });
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response, payload;
      try {
        response = await fetchImpl(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-shopify-access-token": token }, body: JSON.stringify({ query, variables }), signal: combined });
        payload = await response.json();
      } catch (error) {
        if (!mutation && attempt < 2 && !signal?.aborted) { await sleep(300 * 2 ** attempt, signal); continue; }
        throw Object.assign(new Error("Shopify could not be reached. Please try again shortly."), { cause: error, status: 503 });
      }
      if (response.ok && !payload.errors) return payload;
      const throttled = response.status === 429 || payload.errors?.some((error) => error.extensions?.code === "THROTTLED");
      const transient = throttled || [502, 503, 504].includes(response.status);
      if (!mutation && transient && attempt < 2 && !signal?.aborted) {
        const retry = Number(response.headers?.get?.("retry-after"));
        await sleep(Math.min(2_000, retry > 0 ? retry * 1000 : 400 * 2 ** attempt), signal);
        continue;
      }
      throw Object.assign(new Error(throttled ? "Shopify is busy. Please try again shortly." : "Shopify could not complete this request."), {
        status: 503,
        noOrderCreated: mutation && ([400, 401, 403, 429].includes(response.status) || Boolean(payload.errors?.length &&
          payload.errors.every((error) => ["THROTTLED", "ACCESS_DENIED", "GRAPHQL_VALIDATION_FAILED", "GRAPHQL_PARSE_FAILED"].includes(error.extensions?.code)))),
      });
    }
  };
}

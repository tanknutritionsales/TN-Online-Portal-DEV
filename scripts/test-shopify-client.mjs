import assert from "node:assert/strict";
import { createShopifyClient, verifiedCreatedOrder } from "../lib/shopify-client.mjs";

const endpoint = "https://isolated.invalid/graphql";
const response = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let calls = 0;
const client = (fetchImpl) => createShopifyClient({ endpoint, getAccessToken: async () => "offline-placeholder", fetchImpl, sleep: async () => {} });
const read = client(async (url, options) => {
  assert.equal(url, endpoint);
  assert.equal(options.headers["x-shopify-access-token"], "offline-placeholder");
  return ++calls === 1 ? response(429, {}) : response(200, { data: { ok: true } });
});
assert.equal((await read("query Offline { shop { name } }")).data.ok, true);
assert.equal(calls, 2);

calls = 0;
await assert.rejects(client(async () => { calls++; throw new TypeError("Sensitive upstream URL"); })("query Offline { shop { name } }"), error => !error.message.includes("Sensitive"));
assert.equal(calls, 3, "Read retries must have a hard bound.");

for (const outcome of [
  () => { throw new TypeError("Network outcome unknown"); },
  () => response(500, { errors: [{ message: "Internal exception", extensions: { code: "INTERNAL_SERVER_ERROR" } }] }),
  () => response(200, { data: null, errors: [{ message: "Unknown mutation failure" }] }),
]) {
  calls = 0;
  await assert.rejects(client(async () => { calls++; return outcome(); })("mutation Offline { orderCreate { order { id } } }", {}, { mutation: true }), error => error.noOrderCreated !== true);
  assert.equal(calls, 1, "An uncertain mutation must never be automatically replayed.");
}
for (const [status, body] of [
  [429, {}], [403, {}],
  [200, { errors: [{ extensions: { code: "THROTTLED" } }] }],
]) {
  calls = 0;
  await assert.rejects(client(async () => { calls++; return response(status, body); })("mutation Offline { orderCreate { order { id } } }", {}, { mutation: true }), error => error.noOrderCreated === true);
  assert.equal(calls, 1);
}
const controller = new AbortController();
controller.abort(new Error("Cancelled fixture"));
calls = 0;
await assert.rejects(client(async (_url, { signal }) => { calls++; signal.throwIfAborted(); })("query Offline { shop { name } }", {}, { signal: controller.signal }));
assert.equal(calls, 1);
console.log("Shopify transport checks passed: bounded read retries, cancellation, sanitized errors and zero automatic replay of uncertain mutations.");

const expected = [{ variantId: "variant-one", quantity: 2, price: 190 }];
const remote = { id: "order-one", sourceIdentifier: "portal-one", displayFinancialStatus: "PAID", cancelledAt: null,
  lineItems: { nodes: [{ variant: { id: "variant-one" }, quantity: 2, originalUnitPriceSet: { shopMoney: { amount: "190.00", currencyCode: "ZAR" } } }], pageInfo: { hasNextPage: false } } };
const lookup = order => verifiedCreatedOrder({ nodes: [order], pageInfo: { hasNextPage: false } }, "portal-one", expected);
assert.equal(lookup(remote).id, remote.id);
for (const displayFinancialStatus of ["REFUNDED", "PARTIALLY_REFUNDED", "VOIDED", "PENDING", "AUTHORIZED"]) {
  assert.throws(() => lookup({ ...remote, displayFinancialStatus }), /no longer fully paid/);
}
assert.throws(() => lookup({ ...remote, cancelledAt: new Date().toISOString() }), /cancelled/);
assert.throws(() => lookup({ ...remote, lineItems: { ...remote.lineItems, nodes: [{ ...remote.lineItems.nodes[0], quantity: 3 }] } }), /quantities or prices/);
assert.equal(lookup({ ...remote, sourceIdentifier: "unrelated" }), null);
assert.throws(() => verifiedCreatedOrder({ nodes: [remote, remote] }, "portal-one", expected), /Multiple/);
assert.throws(() => verifiedCreatedOrder({ nodes: [remote], pageInfo: { hasNextPage: true } }, "portal-one", expected), /unique/);
console.log("Shopify reconciliation checks passed: exact unique paid match, cancelled/refunded rejection, saved quantities/prices and pagination guards.");

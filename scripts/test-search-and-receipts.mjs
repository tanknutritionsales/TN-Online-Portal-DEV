import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createCatalogSearch, normalizeSearchSettings, anonymousSearchTerm } from "../public/catalog-search.js";
import { deliveryReceiptView, normalizeDeliverySettings, recordDeliveryResponse } from "../lib/order-receipts.mjs";
import { createCustomerMessageStore } from "../lib/customer-message-store.mjs";
import { startIsolatedPortal } from "./isolated-portal.mjs";
import { createSettingsUpdater } from "../lib/shop-settings-store.mjs";

const product = (id, title, tags, inStock = true, vendor = "HD LABS") => ({ id, title, tags, vendor, variant: { id: `${id}-variant`, sku: id, price: 100, inStock } });
const products = [
  product("blend", "HD PEN WOLVERINE 20MG", ["blend-wolverine", "compound-bpc-157", "compound-tb-500"]),
  product("var10", "KF ORAL VAR 10MG", ["compound-oxandrolone"], false, "KEIFEI PHARMACEUTICALS"),
  product("var100", "HD ORAL VAR 100MG", ["compound-oxandrolone"]),
  product("dbol", "KF ORAL DB 10MG", ["compound-metandienone"], true, "KEIFEI PHARMACEUTICALS"),
  product("sema", "HD PEN SEMA 5MG", ["compound-semaglutide", "class-glp-1-related"]),
  product("reta", "HD VIAL RETATRUTIDE 60MG", ["compound-retatrutide", "class-glp-1-related"]),
  product("tirz", "HD PEN TIRZ 30MG", ["compound-tirzepatide", "class-glp-1-related"]),
  product("cagri", "HD VIAL CAGRI 10MG", ["compound-cagrilintide"]),
  product("enhancer", "HU ORAL GLP-1 ENHANCER 570MG", ["peptides"]),
  product("semax", "HD VIAL SEMAX 10MG", ["compound-semax"]),
  product("mt2", "HU NASAL MELANOTAN 10MG", ["compound-melanotan-2"]),
  product("melatonin", "HU ORAL MELATONIN 5MG", ["compound-melatonin"]),
  product("mk677", "KH MK 677 50TABS", ["compound-ibutamoren", "sarms"]),
  product("mk2866", "KH MK 2866 50TABS", ["compound-mk-2866", "class-sarm"]),
  product("cardarine", "KF ORAL CARD 10MG", ["compound-gw-501516", "sarms"]),
  product("clo", "BP ORAL CLO 25MG", ["compound-clomiphene"]),
  product("enclo", "BP ORAL ENCLO 25MG", ["compound-enclomiphene"]),
  product("t3mcg", "KF ORAL T3 25MCG", ["compound-liothyronine"]),
  product("t3mg", "UPA ORAL T3 25MG", ["compound-liothyronine"]),
  product("bpc", "HD VIAL BPC-157 10MG", ["compound-bpc-157"], false),
  product("nad", "HD VIAL NAD+ 300MG", ["compound-nad", "peptides"]),
  product("slu", "HD PEN SLU PP332 5MG", ["compound-slu-pp-332", "peptides"]),
  product("dac", "CLINIC VIAL CJC-1295 DAC 5MG", ["compound-cjc-1295"]),
  product("no-dac", "CLINIC VIAL CJC-1295 (WITHOUT DAC) 5MG", ["compound-cjc-1295"]),
  product("unknown-dac", "BP PEN CJC / IPA 20MG", ["blend-cjc-ipa"]),
  product("new", "UPA ORAL OSTARINE 10MG", []),
  product("new-blend", "NEW VIAL WOLVERINE", []),
  product("limitless", "BP ORAL LIMITLESS 20 15MG", []),
  product("deferred-deca", "KF VIAL DECA BLEND 300MG", []),
];
const index = createCatalogSearch(products);
const ids = (query, engine = index) => engine.search(query).map((match) => match.product.id);
assert.deepEqual(ids("oxandrolone"), ["var100", "var10"]);
assert.deepEqual(ids("anavar 10mg"), ["var10"]);
assert.deepEqual(ids("KF oxandrolone 10 mg"), ["var10"]);
assert.deepEqual(ids("oxan"), ["var100", "var10"]);
assert.deepEqual(ids("anav"), ["var100", "var10"]);
assert.deepEqual(ids("oxan 10mg"), ["var10"]);
assert.deepEqual(ids("diana"), ["dbol"]);
assert.deepEqual(ids("KF diana 10mg"), ["dbol"]);
assert.deepEqual(ids("KF diana 100mg"), []);
assert.deepEqual(new Set(ids("GLP-1")), new Set(["sema", "tirz", "reta"]));
assert.deepEqual(new Set(ids("GLP 1")), new Set(ids("GLP1")));
assert.deepEqual(ids("glp 1 enhancer"), ["enhancer"]);
assert.deepEqual(ids("GLP1 pen"), ["sema", "tirz"]);
assert.deepEqual(ids("reta"), ["reta"]);
assert.deepEqual(ids("sema"), ["sema"]);
assert.deepEqual(ids("semax"), ["semax"]);
assert.deepEqual(ids("clo"), ["clo"]);
assert.deepEqual(ids("enclo"), ["enclo"]);
assert.deepEqual(ids("Melanotan"), ["mt2"]);
assert.deepEqual(ids("Melatonin"), ["melatonin"]);
assert.deepEqual(ids("MK677"), ["mk677"]);
assert.deepEqual(new Set(ids("sarms")), new Set(["mk2866", "new"]));
assert.deepEqual(ids("T3 25mcg"), ["t3mcg"]);
assert.deepEqual(ids("T3 25mg"), ["t3mg"]);
assert.deepEqual(ids("BPC"), ["bpc", "blend"]); // Direct compound wins even when out of stock.
assert.ok(index.search("BPC")[1].reason.includes("Blend"));
assert.ok(!ids("peptides").includes("nad") && !ids("peptides").includes("slu"));
assert.deepEqual(ids("CJC no DAC"), ["no-dac"]);
assert.deepEqual(ids("CJC with DAC"), ["dac"]);
assert.deepEqual(ids("MK687"), []);
assert.deepEqual(ids("MK 28"), []);
assert.deepEqual(index.suggest("MK687"), []);
assert.deepEqual(index.suggest("oxandrolne"), ["oxandrolone"]);
assert.ok(index.suggest("oxandroone").includes("oxandrolone"));
assert.ok(index.suggest("pxandrolone").includes("oxandrolone"));
assert.ok(index.suggest("diannabol").includes("dianabol"));
assert.ok(index.suggest("retatrutdie").includes("retatrutide"));
assert.deepEqual(index.suggest("Melatonin"), []);
assert.deepEqual(ids("Limitless"), ["limitless"]);
assert.deepEqual(ids(""), products.map((p) => p.id));
assert.equal(index.entries.find((e) => e.product.id === "new").inferred, true);
assert.deepEqual(index.entries.find((e) => e.product.id === "new-blend").primary, []);
assert.deepEqual(index.entries.find((e) => e.product.id === "deferred-deca").primary, []);
const customized = normalizeSearchSettings();
customized.groups.find((g) => g.id === "oxandrolone").aliases.push("approved alternate name");
assert.deepEqual(new Set(ids("approved alternate name", createCatalogSearch(products, customized))), new Set(["var10", "var100"]));
customized.assignments.var10 = [];
assert.deepEqual(ids("anavar", createCatalogSearch(products, customized)), ["var100"]);
assert.ok(ids("VAR", createCatalogSearch(products, customized)).includes("var10"));
assert.doesNotThrow(() => normalizeSearchSettings({ groups: [null, {}, { id: "valid", label: "Valid" }], categories: [null, {}] }));
assert.equal(anonymousSearchTerm("test@example.com"), "");
assert.equal(anonymousSearchTerm("0821234567"), "");
assert.equal(anonymousSearchTerm("082 123 4567"), "");
assert.equal(anonymousSearchTerm("https://example.com/private"), "");
assert.equal(anonymousSearchTerm("oxandrolne"), "oxandrolne");

let savedSettings = { a: 1, b: 2 };
const updateLocal = createSettingsUpdater({ useDatabase: () => false, read: async () => ({ settings: structuredClone(savedSettings) }), write: async (settings) => { savedSettings = settings; return { settings }; } });
await Promise.all([updateLocal((current) => ({ ...current, a: 3 })), updateLocal((current) => ({ ...current, b: 4 }))]);
assert.deepEqual(savedSettings, { a: 3, b: 4 });
const settingsStatements = [];
let releaseCount = 0;
const settingsClient = { query: async (sql) => { settingsStatements.push(sql); return { rows: sql.includes("FOR UPDATE") ? [{ data: { a: 1 } }] : [] }; }, release: () => releaseCount++ };
const updateDb = createSettingsUpdater({ useDatabase: () => true, database: async () => ({ connect: async () => settingsClient }), normalize: (value) => value, defaults: () => ({}) });
assert.deepEqual((await updateDb((current) => ({ ...current, b: 2 }))).settings, { a: 1, b: 2 });
assert.ok(settingsStatements.some((sql) => sql.includes("pg_advisory_xact_lock")));
assert.equal(settingsStatements.at(-1), "COMMIT");
await assert.rejects(updateDb(() => { throw new Error("Invalid settings patch"); }), /Invalid settings patch/);
assert.equal(settingsStatements.at(-1), "ROLLBACK"); assert.equal(releaseCount, 2);

const now = Date.parse("2026-11-03T10:00:00Z"), day = 86400000;
const shipped = { id: "receipt-order", reference: "QA-RECEIPT", customer: { id: "demo-user", name: "Test Customer", email: "user@example.com" }, paymentStatus: "confirmed", fulfillmentStatus: "shipped", shippedAt: new Date(now - 3 * day).toISOString(), officeShippedAt: new Date(now - 3 * day).toISOString(), updatedAt: new Date(now).toISOString(), createdAt: new Date(now - 4 * day).toISOString(), items: [{ variantId: "mock-hd-reta-default", productTitle: "HD VIAL RETA 32MG", quantity: 2, price: 100 }], subtotal: 200, total: 350, deliveryFee: 150, tracking: { courier: "Courier Guy", number: "QA-TRACKING", url: "https://example.com/track" } };
assert.equal(deliveryReceiptView(shipped, null, {}, {}, now - 1).promptDue, false);
assert.equal(deliveryReceiptView(shipped, null, {}, {}, now).promptDue, true);
assert.equal(deliveryReceiptView(shipped, null, { enabled: false }, {}, now).canConfirm, false);
assert.equal(deliveryReceiptView({ ...shipped, paymentStatus: "pending" }, null, {}, {}, now).canConfirm, false);
assert.equal(deliveryReceiptView({ ...shipped, officeShippedAt: null, externalTracking: { number: "external", addedAt: new Date(now).toISOString() } }, null, {}, { officeRequired: true, externalRequired: true }, now).canConfirm, false);
assert.equal(deliveryReceiptView({ ...shipped, shippedAt: new Date(now).toISOString(), externalTracking: { number: "external", addedAt: new Date(now).toISOString() } }, null, {}, { officeRequired: true, externalRequired: true }, now).promptDue, false);
assert.equal(deliveryReceiptView({ ...shipped, externalTracking: { number: "corrected-tracking", addedAt: new Date(now).toISOString() } }, null, {}, { officeRequired: true, externalRequired: true }, now).promptDue, true);
assert.equal(deliveryReceiptView({ ...shipped, shippedAt: null, officeShippedAt: null }, null, {}, {}, now).canConfirm, true);
assert.equal(deliveryReceiptView({ ...shipped, shippedAt: null, officeShippedAt: null }, null, {}, {}, now).promptDue, false);
assert.deepEqual(normalizeDeliverySettings({ delayDays: 0, snoozeHours: 999 }), { enabled: true, delayDays: 1, snoozeHours: 168 });

const portal = await startIsolatedPortal();
class Session {
  cookie = "";
  async request(route, { status = 200, ...options } = {}) {
    const response = await fetch(portal.url + route, { ...options, headers: { "content-type": "application/json", "x-op-client": "portal", cookie: this.cookie, ...options.headers } });
    if (response.headers.get("set-cookie")) this.cookie = response.headers.get("set-cookie").split(";")[0];
    const payload = await response.json(); assert.equal(response.status, status, `${route}: ${JSON.stringify(payload)}`); return payload;
  }
  post(route, data, status) { return this.request(route, { method: "POST", body: JSON.stringify(data), status }); }
}
try {
  const store = createCustomerMessageStore({ useDatabase: () => false, localAllowed: true, filePath: path.join(portal.directory, "data", "concurrency.json") });
  const snoozed = await recordDeliveryResponse(store, shipped, "demo-user", "not_yet", {}, {}, now);
  assert.equal(deliveryReceiptView(shipped, snoozed, {}, {}, now + day - 1).promptDue, false);
  assert.equal(deliveryReceiptView(shipped, snoozed, {}, {}, now + day).promptDue, true);
  await Promise.all(Array.from({ length: 12 }, (_, i) => recordDeliveryResponse(store, shipped, "demo-user", i % 2 ? "received" : "not_yet", {}, {}, now + i)));
  const final = (await store.getMany(["receipt:receipt-order"]))[0];
  assert.equal(final.status, "received");
  assert.ok(final.receivedAt);
  assert.equal(final.snoozedUntil, null);
  assert.equal((await recordDeliveryResponse(store, shipped, "demo-user", "received", {}, {}, now + day)).receivedAt, final.receivedAt);
  await assert.rejects(recordDeliveryResponse(store, shipped, "someone-else", "received", {}), (error) => error.status === 404);
  assert.equal((await store.list({ kind: "delivery_receipt" })).length, 1);

  const customer = new Session(), admin = new Session(), anonymous = new Session();
  await customer.post("/api/auth/login", { login: "user", password: "user" });
  await admin.post("/api/auth/admin-login", { username: "admin", password: "admin" });
  await mkdir(path.join(portal.directory, "data"), { recursive: true });
  const pending = { ...shipped, id: "pending-order", paymentStatus: "pending", fulfillmentStatus: "not_ready" };
  const someoneElse = { ...shipped, id: "private-order", customer: { id: "another-customer" } };
  await writeFile(path.join(portal.directory, "data", "orders.json"), JSON.stringify({ orders: [shipped, pending, someoneElse] }));
  await anonymous.request("/api/orders", { status: 401 });
  await customer.post(`/api/orders/${someoneElse.id}/delivery-confirmation`, { action: "received" }, 404);
  await customer.post(`/api/orders/${pending.id}/delivery-confirmation`, { action: "received" }, 409);
  await customer.post(`/api/orders/${shipped.id}/delivery-confirmation`, { action: "invalid" }, 400);
  const beforeSettings = (await admin.request("/api/shop-settings")).settings;
  await admin.post("/api/admin/shop-settings", { search: { ...beforeSettings.search, typoSuggestions: false }, deliveryConfirmation: { enabled: true, delayDays: 4, snoozeHours: 12 } });
  const changedSettings = (await admin.request("/api/shop-settings")).settings;
  assert.deepEqual(changedSettings.payment, beforeSettings.payment);
  assert.equal(changedSettings.search.typoSuggestions, false);
  assert.equal(changedSettings.deliveryConfirmation.delayDays, 4);
  await Promise.all([admin.post("/api/admin/shop-settings", { search: { ...changedSettings.search, typoSuggestions: true } }), admin.post("/api/admin/shop-settings", { deliveryConfirmation: { enabled: true, delayDays: 5, snoozeHours: 12 } })]);
  const concurrentSettings = (await admin.request("/api/shop-settings")).settings;
  assert.equal(concurrentSettings.search.typoSuggestions, true);
  assert.equal(concurrentSettings.deliveryConfirmation.delayDays, 5);
  const received = (await customer.post(`/api/orders/${shipped.id}/delivery-confirmation`, { action: "received" })).order;
  assert.equal(received.customerStatus, "Completed");
  assert.equal(received.fulfillmentStatus, "shipped");
  assert.equal(received.tracking.number, "QA-TRACKING");
  const again = (await customer.post(`/api/orders/${shipped.id}/delivery-confirmation`, { action: "not_yet" })).order;
  assert.equal(again.deliveryReceipt.receivedAt, received.deliveryReceipt.receivedAt);
  assert.equal((await customer.request("/api/orders")).orders.length, 2);
  const staffOrder = (await admin.request("/api/admin/orders")).orders.find((order) => order.id === shipped.id);
  assert.equal(staffOrder.deliveryReceipt.receivedAt, received.deliveryReceipt.receivedAt);
  const persisted = JSON.parse(await readFile(path.join(portal.directory, "data", "orders.json"), "utf8"));
  assert.deepEqual(persisted.orders[0], shipped); // Customer receipt cannot overwrite dispatch/payment or Shark data.
  await anonymous.post("/api/search/misses", { query: "oxandrolne" }, 401);
  await customer.request("/api/admin/search", { status: 401 });
  await Promise.all(Array.from({ length: 4 }, () => customer.post("/api/search/misses", { query: "oxandrolne" })));
  await customer.post("/api/search/misses", { query: "private@example.com" });
  const misses = (await admin.request("/api/admin/search")).misses;
  assert.equal(misses.length, 1); assert.equal(misses[0].count, 4);
  assert.ok(!JSON.stringify(misses).includes("demo-user"));
  await admin.post(`/api/admin/search/${encodeURIComponent(misses[0].id)}/resolve`, {});
  assert.equal((await admin.request("/api/admin/search")).misses[0].status, "resolved");
  console.log("Search and delivery checks passed: aliases, strict compounds/codes/strengths, categories, suggestions, inferred singles, settings, ownership, chronological receipt, concurrent idempotency, preserved dispatch and anonymous search feedback.");
} finally { await portal.close(); }

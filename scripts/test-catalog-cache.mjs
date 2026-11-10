// Offline concurrency/lease tests. No server import, credentials, SQL or network.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { after, test } from "node:test";
import { getStore } from "@netlify/blobs";
import { createCatalogCache, createNetlifyCatalogStore } from "../lib/catalog-cache.mjs";

const require = createRequire(import.meta.url);
const sdkVersion = require("@netlify/blobs/package.json").version;
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("Network access is forbidden in catalogue cache tests."); };
after(() => { globalThis.fetch = originalFetch; });

const copy = (value) => structuredClone(value);
const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clock(start = 1_000) {
  let time = start;
  return { now: () => time, advance: (ms) => { time += ms; }, sleep: async (ms) => { time += ms; await turn(); } };
}
function atomicStore() {
  const records = new Map();
  const calls = { read: 0, write: 0 };
  let serial = 0;
  return {
    records, calls,
    async read(key) { calls.read++; return copy(records.get(key) || null); },
    async write(key, value, condition) {
      calls.write++;
      const current = records.get(key);
      assert.ok(condition.onlyIfNew === true || typeof condition.onlyIfMatch === "string", "Every write must be conditional.");
      assert.ok(!(condition.onlyIfNew && condition.onlyIfMatch), "Write conditions must be mutually exclusive.");
      if ((condition.onlyIfNew && current) || (condition.onlyIfMatch && current?.etag !== condition.onlyIfMatch)) return { modified: false };
      const etag = `"${++serial}"`;
      records.set(key, { value: copy(value), etag });
      return { modified: true, etag };
    },
  };
}
async function setLease(store, until) {
  const [key, record] = [...store.records][0];
  await store.write(key, { ...record.value, lease: { owner: "interrupted-instance", until } }, { onlyIfMatch: record.etag });
}
const errorCode = (code) => (error) => error.status === 503 && error.code === code;
const catalog = (version = 1) => ({
  source: "fixture", version,
  products: [{ id: "p1", title: "Fixture", variant: {
    id: "v1", title: "Default", sku: "FIXTURE", price: "10.00", inStock: true,
    availableQuantity: 7, officeAvailableQuantity: 3, storageQuantity: 4, inventoryQuantity: 3,
  } }],
});

test("construction/status/idle and fresh memory hits do no I/O; default whole-catalogue TTL is 60 seconds", async () => {
  const time = clock();
  const store = atomicStore();
  let loads = 0;
  const cache = createCatalogCache({ store, namespace: "production:deploy-a", now: time.now, load: async () => { loads++; return catalog(loads); } });
  assert.equal(cache.status().source, "empty");
  await turn();
  assert.deepEqual(store.calls, { read: 0, write: 0 });
  assert.equal(loads, 0);
  await cache.get();
  assert.equal(cache.status().expiresAt - cache.status().loadedAt, 60_000);
  assert.equal(cache.status().staleUntil - cache.status().expiresAt, 300_000);
  const calls = copy(store.calls);
  for (let i = 0; i < 20; i++) { await cache.get(); cache.status(); }
  assert.deepEqual(store.calls, calls);
  assert.equal(loads, 1);
  time.advance(60_000);
  assert.equal(cache.status().fresh, false);
  assert.deepEqual(store.calls, calls, "TTL expiry alone must not wake the loader/store.");
});

test("200 local readers share one load; callers cannot mutate cached private data", async () => {
  const gate = deferred();
  let loads = 0;
  const value = catalog();
  const cache = createCatalogCache({ load: async () => { loads++; await gate.promise; return value; } });
  const readers = Array.from({ length: 200 }, () => cache.get());
  await turn();
  assert.equal(loads, 1);
  assert.equal(cache.status().refreshing, true);
  gate.resolve();
  const results = await Promise.all(readers);
  assert.equal(results.length, 200);
  results[0].products[0].variant.availableQuantity = -1;
  value.products[0].variant.availableQuantity = -2;
  assert.equal((await cache.get()).products[0].variant.availableQuantity, 7);
  assert.equal(results[1].products[0].variant.availableQuantity, 7);
  assert.equal(loads, 1);
  assert.equal(cache.status().refreshing, false);
});

test("200 readers across 40 instances make one load on cold start and one after expiry", async () => {
  const time = clock();
  const store = atomicStore();
  let loads = 0;
  const caches = Array.from({ length: 40 }, () => createCatalogCache({
    store, namespace: "production:deploy-a", now: time.now, pollMs: 1, waitMs: 1_000,
    load: async () => { loads++; await turn(); return catalog(loads); },
  }));
  const readAll = () => Promise.all(Array.from({ length: 200 }, (_, index) => caches[index % caches.length].get()));
  assert.ok((await readAll()).every((value) => value.version === 1));
  assert.equal(loads, 1);
  time.advance(60_000);
  assert.ok((await readAll()).every((value) => value.version === 2));
  assert.equal(loads, 2);
  assert.equal(store.records.size, 1);
  const reads = store.calls.read;
  await readAll();
  assert.equal(store.calls.read, reads);
});

test("a new instance uses the shared fresh record without loading upstream", async () => {
  const time = clock();
  const store = atomicStore();
  await createCatalogCache({ store, namespace: "prod:a", now: time.now, load: async () => catalog() }).get();
  const next = createCatalogCache({ store, namespace: "prod:a", now: time.now, load: () => assert.fail("Fresh shared hits must not load/SQL.") });
  assert.equal((await next.get()).version, 1);
  assert.equal(next.status().source, "shared");
  assert.equal(next.status().fresh, true);
});

test("a crashed instance's expired lease is taken over conditionally", async () => {
  const time = clock();
  const store = atomicStore();
  const options = { store, namespace: "prod:a", ttlMs: 10, now: time.now, sleep: time.sleep, pollMs: 5, waitMs: 50 };
  await createCatalogCache({ ...options, load: async () => catalog() }).get();
  time.advance(10);
  await setLease(store, time.now() + 20);
  let loads = 0;
  const next = createCatalogCache({ ...options, load: async () => { loads++; return catalog(2); } });
  assert.equal((await next.get()).version, 2);
  assert.equal(loads, 1);
  assert.ok(time.now() >= 1_030);
  assert.equal([...store.records.values()][0].value.lease, null);
});

test("lease contention waits for the winner and reuses its publication", async () => {
  const store = atomicStore();
  const started = deferred();
  const gate = deferred();
  const first = createCatalogCache({ store, namespace: "prod:a", load: async () => { started.resolve(); await gate.promise; return catalog(2); } });
  const loading = first.get();
  await started.promise;
  let sleeps = 0;
  const second = createCatalogCache({
    store, namespace: "prod:a", sleep: async () => { sleeps++; gate.resolve(); await loading; },
    load: () => assert.fail("A contender must not load while a lease is held."),
  });
  assert.equal((await second.get()).version, 2);
  await loading;
  assert.equal(sleeps, 1);
});

test("contention has a bounded wait; only browsing gets bounded stale fallback", async () => {
  const time = clock();
  const store = atomicStore();
  const options = { store, namespace: "prod:a", ttlMs: 10, staleMs: 100, now: time.now, sleep: time.sleep, pollMs: 5, waitMs: 20 };
  await createCatalogCache({ ...options, load: async () => catalog() }).get();
  time.advance(10);
  await setLease(store, time.now() + 1_000);
  const next = createCatalogCache({ ...options, load: () => assert.fail("Contention must not bypass the lease.") });
  assert.equal((await next.get({ allowStale: true })).version, 1);
  assert.equal(time.now(), 1_030);
  assert.equal(next.status().source, "stale");
  await assert.rejects(next.get(), errorCode("CATALOG_REFRESH_BUSY"));
  time.advance(100);
  await assert.rejects(next.get({ allowStale: true }), errorCode("CATALOG_REFRESH_BUSY"));
});

test("an expired owner cannot publish or release its successor's record", async () => {
  const time = clock();
  const store = atomicStore();
  const started = deferred();
  const gate = deferred();
  const old = createCatalogCache({ store, namespace: "prod:a", now: time.now, load: async () => { started.resolve(); await gate.promise; return catalog(1); } });
  const oldRead = old.get();
  const rejected = assert.rejects(oldRead, errorCode("CATALOG_LEASE_LOST"));
  await started.promise;
  time.advance(30_001);
  const successor = createCatalogCache({ store, namespace: "prod:a", now: time.now, load: async () => catalog(2) });
  assert.equal((await successor.get()).version, 2);
  const winner = copy([...store.records.values()][0]);
  gate.resolve();
  await rejected;
  assert.deepEqual([...store.records.values()][0], winner, "Expired owner must not replace the winner or add a retry cooldown.");
  assert.equal((await old.get()).version, 2);
});

test("load failures preserve stale deadlines, reject strict readers and cool down across instances", async () => {
  const time = clock();
  const store = atomicStore();
  let failing = false;
  let loads = 0;
  const options = { store, namespace: "prod:a", ttlMs: 10, staleMs: 100, retryMs: 5, now: time.now };
  const load = async () => { loads++; if (failing) throw new Error("PRIVATE stock=7"); return catalog(); };
  const cache = createCatalogCache({ ...options, load });
  await cache.get();
  const hardDeadline = cache.status().staleUntil;
  time.advance(10);
  failing = true;
  const results = await Promise.allSettled([cache.get({ allowStale: true }), cache.get()]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.status, 503);
  assert.doesNotMatch(results[1].reason.message, /PRIVATE|stock|7/);
  assert.equal(loads, 2, "Mixed policies still share the same refresh.");
  const another = createCatalogCache({ ...options, load });
  assert.equal((await another.get({ allowStale: true })).version, 1);
  await assert.rejects(another.get(), errorCode("CATALOG_RETRY_LATER"));
  assert.equal(loads, 2);
  assert.equal(cache.status().staleUntil, hardDeadline);
  time.advance(hardDeadline - time.now());
  await assert.rejects(cache.get({ allowStale: true }), errorCode("CATALOG_CACHE_UNAVAILABLE"));
  assert.equal(cache.status().stale, false);
  assert.equal(cache.status().staleUntil, hardDeadline);
});

test("local failure cooldown prevents repeated loads and staleMs=0 forbids fallback", async () => {
  const time = clock();
  let failing = false;
  let loads = 0;
  const cache = createCatalogCache({ ttlMs: 10, staleMs: 0, retryMs: 5, now: time.now, load: async () => { loads++; if (failing) throw new Error(); return catalog(); } });
  await cache.get();
  time.advance(10);
  failing = true;
  await assert.rejects(cache.get({ allowStale: true }));
  await assert.rejects(cache.get({ allowStale: true }), errorCode("CATALOG_RETRY_LATER"));
  assert.equal(loads, 2);
  time.advance(5);
  failing = false;
  await cache.get();
  assert.equal(loads, 3);
});

test("upstream numeric/private error codes are sanitized without breaking browsing fallback", async () => {
  for (const code of [503, "CATALOG_PRIVATE_QUANTITY_7"]) {
    const time = clock();
    let failing = false;
    const cache = createCatalogCache({ ttlMs: 10, retryMs: 0, now: time.now, load: async () => {
      if (failing) throw Object.assign(new Error("Private quantity 7"), { code });
      return catalog();
    } });
    await cache.get();
    failing = true;
    time.advance(10);
    assert.equal((await cache.get({ allowStale: true })).version, 1);
    assert.equal(cache.status().lastErrorCode, "CATALOG_CACHE_UNAVAILABLE");
    await assert.rejects(cache.get(), errorCode("CATALOG_CACHE_UNAVAILABLE"));
  }
});

test("shared store outage does not trigger an uncoordinated upstream load", async () => {
  const time = clock();
  const store = atomicStore();
  let loads = 0;
  const cache = createCatalogCache({ store, namespace: "prod:a", ttlMs: 10, staleMs: 100, now: time.now, load: async () => { loads++; return catalog(); } });
  await cache.get();
  store.read = async () => { throw new Error("offline"); };
  assert.equal((await cache.get()).version, 1, "A fresh memory hit survives a shared store outage.");
  time.advance(10);
  assert.equal((await cache.get({ allowStale: true })).version, 1);
  await assert.rejects(cache.get());
  const cold = createCatalogCache({ store, namespace: "prod:a", now: time.now, load: () => assert.fail("Store errors must not cause a herd.") });
  await assert.rejects(cold.get({ allowStale: true }));
  assert.equal(loads, 1);
});

test("failed publication preserves the old stale snapshot rather than extending its life", async () => {
  const time = clock();
  const store = atomicStore();
  let loads = 0;
  const cache = createCatalogCache({ store, namespace: "prod:a", ttlMs: 10, staleMs: 100, now: time.now, load: async () => catalog(++loads) });
  await cache.get();
  const deadline = cache.status().staleUntil;
  const write = store.write.bind(store);
  store.write = async (key, value, condition) => {
    if (value.entry?.value.version === 2) throw new Error("publish unavailable");
    return write(key, value, condition);
  };
  time.advance(10);
  assert.equal((await cache.get({ allowStale: true })).version, 1);
  assert.equal(cache.status().staleUntil, deadline);
  assert.equal([...store.records.values()][0].value.entry.value.version, 1);
  await assert.rejects(cache.get());
});

test("a hung loader times out, receives an aborted signal and relinquishes its lease", async () => {
  const store = atomicStore();
  let signal;
  const cache = createCatalogCache({ store, namespace: "prod:a", leaseMs: 100, loadTimeoutMs: 10, load: async (options) => { signal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(cache.get(), errorCode("CATALOG_LOAD_TIMEOUT"));
  assert.equal(signal.aborted, true);
  assert.equal([...store.records.values()][0].value.lease, null);
  assert.equal(cache.status().refreshing, false);
});

test("deployment/source/cache-name namespaces cannot collide; independent availability TTL is supported", async () => {
  const time = clock();
  const store = atomicStore();
  let loads = 0;
  const make = (namespace, name = "catalog", ttlMs = 60_000) => createCatalogCache({ store, namespace, name, ttlMs, now: time.now, load: async () => catalog(++loads) });
  const caches = [make("production:deploy-a:shop"), make("production:deploy-b:shop"), make("preview:deploy-a:shop"), make("production:deploy-a:other-shop"), make("a/b", "c"), make("a", "b/c"), make("production:deploy-a:shop", "availability", 30_000)];
  await Promise.all(caches.map((cache) => cache.get()));
  assert.equal(loads, caches.length);
  assert.equal(store.records.size, caches.length);
  time.advance(30_000);
  assert.equal(caches[0].status().fresh, true);
  assert.equal(caches.at(-1).status().fresh, false);
  await caches.at(-1).get();
  assert.equal(loads, caches.length + 1);
});

test("shorter reader TTL and stale window cap previously stored longer windows", async () => {
  const time = clock();
  const store = atomicStore();
  await createCatalogCache({ store, namespace: "prod:a", ttlMs: 300_000, staleMs: 300_000, now: time.now, load: async () => catalog() }).get();
  time.advance(30_000);
  const shorter = createCatalogCache({ store, namespace: "prod:a", ttlMs: 30_000, staleMs: 0, now: time.now, load: async () => { throw new Error(); } });
  await assert.rejects(shorter.get({ allowStale: true }));
  assert.equal(shorter.status().expiresAt, 31_000);
  assert.equal(shorter.status().staleUntil, 31_000);
});

test("forced admin refresh bypasses completed local/shared values, coalesces and never falls back stale", async () => {
  const store = atomicStore();
  let loads = 0;
  let failing = false;
  const cache = createCatalogCache({ store, namespace: "prod:a", load: async () => { loads++; if (failing) throw new Error(); return catalog(loads); } });
  await cache.get();
  const forced = await Promise.all(Array.from({ length: 20 }, () => cache.get({ forceRefresh: true })));
  assert.ok(forced.every((value) => value.version === 2));
  assert.equal(loads, 2);
  failing = true;
  await assert.rejects(cache.get({ forceRefresh: true, allowStale: true }));
  assert.equal((await cache.get()).version, 2, "A failed admin refresh does not discard an otherwise fresh snapshot.");
});

test("force arriving during a normal shared hit still performs an upstream refresh", async () => {
  const store = atomicStore();
  await createCatalogCache({ store, namespace: "prod:a", load: async () => catalog() }).get();
  const gate = deferred();
  const reading = deferred();
  const read = store.read.bind(store);
  let first = true;
  store.read = async (key) => {
    const result = await read(key);
    if (first) { first = false; reading.resolve(); await gate.promise; }
    return result;
  };
  let loads = 0;
  const cache = createCatalogCache({ store, namespace: "prod:a", load: async () => { loads++; return catalog(2); } });
  const normal = cache.get();
  await reading.promise;
  const forced = cache.get({ forceRefresh: true });
  gate.resolve();
  assert.equal((await normal).version, 1);
  assert.equal((await forced).version, 2);
  assert.equal(loads, 1);
});

test("status/errors contain no catalogue/private quantities; production public projection strips cached quantities", async () => {
  const cache = createCatalogCache({ load: async () => catalog() });
  const cached = await cache.get();
  assert.equal(cached.products[0].variant.availableQuantity, 7, "Private stock stays available on the server.");
  assert.doesNotMatch(JSON.stringify(cache.status()), /products|variant|Quantity|sku|FIXTURE/);
  // Execute only the existing pure response mapper, never import/start server.js.
  const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
  const start = source.indexOf("function publicCatalogProduct(");
  assert.notEqual(start, -1, "Parent integration must retain a customer-safe response mapper.");
  const end = source.indexOf("\nfunction ", start + 1);
  assert.notEqual(end, -1);
  const project = new Function(`${source.slice(start, end)}; return publicCatalogProduct;`)();
  const publicProducts = cached.products.map(project);
  assert.equal(publicProducts[0].variant.inStock, true);
  assert.doesNotMatch(JSON.stringify(publicProducts), /availableQuantity|officeAvailableQuantity|storageQuantity|inventoryQuantity/);
  assert.equal((await cache.get()).products[0].variant.availableQuantity, 7, "Response projection must not mutate the private cache.");
});

test("configuration errors, corrupt shared records and non-JSON loads fail closed", async () => {
  const store = atomicStore();
  assert.throws(() => createCatalogCache({ store, load: () => catalog() }), /namespace/);
  assert.throws(() => createCatalogCache({ load: () => catalog(), ttlMs: 0 }), /ttlMs/);
  assert.throws(() => createCatalogCache({ load: () => catalog(), staleMs: -1 }), /staleMs/);
  assert.throws(() => createCatalogCache({ load: () => catalog(), leaseMs: 10, loadTimeoutMs: 10 }), /shorter/);
  assert.throws(() => createCatalogCache({ load: () => catalog(), namespace: "/".repeat(256) }), /600-byte/);
  await assert.rejects(createCatalogCache({ load: () => undefined }).get(), errorCode("CATALOG_INVALID_VALUE"));
  await assert.rejects(createCatalogCache({ load: () => ({ circular: 1n }) }).get(), errorCode("CATALOG_INVALID_VALUE"));
  await createCatalogCache({ store, namespace: "prod:a", load: async () => catalog() }).get();
  [...store.records.values()][0].value.namespace = "other-deploy";
  const next = createCatalogCache({ store, namespace: "prod:a", load: () => assert.fail("Corrupt store data must not trigger an uncoordinated load.") });
  await assert.rejects(next.get(), errorCode("CATALOG_INVALID_RECORD"));
  await assert.rejects(next.get({ forceRefresh: "true" }), /booleans/);
});

test("Blobs adapter rejects 8.2/unknown SDKs without opening a store and checks conditional results", async () => {
  let opened = 0;
  for (const sdkVersion of [undefined, "8.2.0", "11.1.7", "11.1.8-beta.1"]) {
    assert.throws(() => createNetlifyCatalogStore({ sdkVersion, getStore: () => { opened++; } }), errorCode("CATALOG_CONDITIONAL_WRITES_REQUIRED"));
  }
  assert.equal(opened, 0);
  const store = createNetlifyCatalogStore({ sdkVersion: "11.1.8", getStore: () => { opened++; return { getWithMetadata: async () => null, setJSON: async () => undefined }; } });
  assert.equal(opened, 0, "Store construction must be lazy.");
  await assert.rejects(store.write("key", {}, {}), /condition/);
  await assert.rejects(store.write("key", {}, { onlyIfNew: true, onlyIfMatch: "a" }), /condition/);
  assert.equal(opened, 0);
  await assert.rejects(store.write("key", {}, { onlyIfNew: true }), errorCode("CATALOG_CONDITIONAL_WRITES_REQUIRED"));
  assert.equal(opened, 1);
});

test(`installed Blobs ${sdkVersion}: real SDK emits conditional HTTP headers and handles 412/409 entirely offline`, async () => {
  const records = new Map();
  const requests = [];
  let serial = 0;
  let opened = 0;
  const store = createNetlifyCatalogStore({ sdkVersion, getStore: (options) => {
    opened++;
    assert.equal(options.consistency, "strong");
    return getStore({
      ...options, siteID: "offline-site", token: "fake-offline-token",
      edgeURL: "https://catalog-eventual.invalid", uncachedEdgeURL: "https://catalog-strong.invalid",
      fetch: async (url, options) => {
        const target = new URL(url);
        assert.equal(target.hostname, "catalog-strong.invalid", "All reads/writes must use strong consistency.");
        const headers = new Headers(options.headers);
        const method = options.method.toUpperCase();
        requests.push({ method, headers });
        const current = records.get(target.pathname);
        if (method === "GET") return current ? new Response(JSON.stringify(current.value), { headers: { etag: current.etag } }) : new Response(null, { status: 404 });
        assert.equal(method, "PUT");
        if (headers.get("if-none-match") === "*" && current) return new Response(null, { status: 412 });
        if (headers.has("if-match") && current?.etag !== headers.get("if-match")) return new Response(null, { status: 409 });
        assert.ok(headers.has("if-match") || headers.get("if-none-match") === "*", "SDK must not silently drop write conditions.");
        const etag = `"offline-${++serial}"`;
        records.set(target.pathname, { value: JSON.parse(options.body), etag });
        return new Response(null, { headers: { etag } });
      },
    });
  } });
  assert.equal(opened, 0);
  assert.equal(await store.read("contract"), null);
  const created = await store.write("contract", { version: 1 }, { onlyIfNew: true });
  assert.equal(created.modified, true);
  assert.deepEqual(await store.write("contract", { version: 2 }, { onlyIfNew: true }), { modified: false });
  assert.deepEqual(await store.write("contract", { version: 2 }, { onlyIfMatch: "wrong" }), { modified: false });
  assert.equal((await store.write("contract", { version: 2 }, { onlyIfMatch: created.etag })).modified, true);
  assert.deepEqual((await store.read("contract")).value, { version: 2 });
  assert.equal(opened, 1);
  assert.ok(requests.some((request) => request.headers.get("if-none-match") === "*"));
  assert.ok(requests.some((request) => request.headers.has("if-match")));
  let loads = 0;
  const make = () => createCatalogCache({ store, namespace: "production:deploy-a", pollMs: 1, load: async () => catalog(++loads) });
  const values = await Promise.all(Array.from({ length: 20 }, () => make().get()));
  assert.ok(values.every((value) => value.version === 1));
  assert.equal(loads, 1, "Actual installed SDK and adapter must enforce the cache lease together.");
});

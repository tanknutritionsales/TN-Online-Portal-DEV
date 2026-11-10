import { randomUUID } from "node:crypto";

const errorCodes = new Set([
  "CATALOG_CACHE_UNAVAILABLE", "CATALOG_INVALID_RECORD", "CATALOG_INVALID_VALUE",
  "CATALOG_CONDITIONAL_WRITES_REQUIRED", "CATALOG_LOAD_TIMEOUT", "CATALOG_LEASE_LOST",
  "CATALOG_RETRY_LATER", "CATALOG_REFRESH_BUSY", "CATALOG_REFRESH_EXPIRED",
]);

/**
 * Server-only, demand-driven catalogue cache. No SQL, SDK imports, background
 * refreshes, HTTP handlers or public payload projection live in this module.
 *
 * Proposed integration (parent owns server.js/package.json):
 * - Rename the current full catalogue fetch to loadCatalog; inject it as load.
 *   load({ signal }) must pass that AbortSignal to every upstream fetch so a
 *   timed-out refresh stops its work. A late result is never cached regardless.
 * - Create ONE cache per runtime, shared by every user/session. Default whole-
 *   catalogue TTL is 60s, with at most 5 additional minutes of browsing fallback.
 *   Alternatively use name: "details", ttlMs: 300_000 and a separate name:
 *   "availability", ttlMs: 30_000, staleMs: 0 after splitting the loaders.
 * - Hosted: inject createNetlifyCatalogStore({ getStore, sdkVersion }) after
 *   trusted handler deployment initialization. Use namespace such as
 *   `${context}:${deployId}:${shopDomain}`; include the production deployment ID
 *   too. Never key by customer/session. Bump name/namespace for loader changes.
 * - Browse with await cache.get({ allowStale: true }); always apply the existing
 *   publicCatalogPayload/publicCatalogProduct before sending customer JSON.
 *   Values here intentionally retain PRIVATE quantities for server-side use.
 * - Checkout uses parent's variant-specific LIVE reads and rejects upstream
 *   failures. A TTL-fresh catalogue is not an inventory reservation. The default
 *   get() rejects stale values; it does not replace that live validation.
 * - Only an authorized admin route may call get({ forceRefresh: true }). This
 *   bypasses completed cache values, but joins an overlapping refresh. Never
 *   accept this flag from customer request parameters. status() is payload-free
 *   admin diagnostics and performs no I/O. Keep it behind admin authorization.
 * - Wire node scripts/test-catalog-cache.mjs into the parent's checks. No hosted
 *   credentials or real Shopify/Netlify calls are needed by those tests.
 *
 * Store injection contract (omit store for local memory + single-flight):
 *   read(key) -> null | { value: record, etag: string }, strongly consistent
 *   write(key, record, { onlyIfNew: true } | { onlyIfMatch: etag })
 *     -> { modified: boolean, etag?: string } (etag required on success)
 * Conditional writes MUST be atomic. There is deliberately no unsafe fallback
 * to an unconditional write, SQL lock, or uncoordinated load on store failure.
 *
 * The cached value and lease occupy ONE record. Publishing/releasing uses the
 * lease's ETag, fencing out an expired owner after a successor has claimed it.
 * Leases expire without delete/list/cleanup jobs. Failed refreshes briefly cool
 * down across instances; stale age never resets when a read/load/write fails.
 */
export function createCatalogCache({
  load,
  store,
  namespace = store ? undefined : "local",
  name = "catalog",
  ttlMs = 60_000,
  staleMs = 300_000,
  leaseMs = 30_000,
  waitMs = 5_000,
  pollMs = 100,
  retryMs = 1_000,
  loadTimeoutMs = Math.floor(leaseMs * 0.8),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof load !== "function" || typeof now !== "function" || typeof sleep !== "function") {
    throw new TypeError("load, now and sleep must be functions.");
  }
  for (const [label, value] of Object.entries({ namespace, name })) {
    if (typeof value !== "string" || !value.trim() || value.length > 256) throw new TypeError(`${label} is required (1-256 characters).`);
  }
  for (const [label, value] of Object.entries({ ttlMs, staleMs, leaseMs, waitMs, pollMs, retryMs, loadTimeoutMs })) {
    const minimum = ["staleMs", "waitMs", "retryMs"].includes(label) ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${label} must be an integer >= ${minimum}.`);
  }
  if (loadTimeoutMs >= leaseMs) throw new TypeError("loadTimeoutMs must be shorter than leaseMs.");
  if (store && (typeof store.read !== "function" || typeof store.write !== "function")) throw new TypeError("store requires read and atomic conditional write functions.");

  const key = `op-catalog/v1/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
  if (Buffer.byteLength(key, "utf8") > 600) throw new TypeError("Encoded namespace/name exceed the Blobs 600-byte key limit.");
  let memory = null;
  let flight = null;
  let source = "empty";
  let retryAt = 0;
  let leaseUntil = 0;
  let lastFailureAt = null;
  let lastErrorCode = null;

  const fresh = (entry, time = now()) => Boolean(entry && entry.loadedAt <= time && time < entry.expiresAt);
  const stale = (entry, time = now()) => Boolean(entry && entry.loadedAt <= time && time < entry.staleUntil);
  const emptyRecord = () => ({ version: 1, namespace, name, entry: null, lease: null, retryAt: 0 });

  function remember(entry, from) {
    if (entry && (!memory || entry.loadedAt >= memory.loadedAt)) memory = entry;
    source = from;
  }

  function failure(error) {
    lastFailureAt = now();
    lastErrorCode = errorCodes.has(error?.code) ? error.code : "CATALOG_CACHE_UNAVAILABLE";
    return unavailable(lastErrorCode);
  }

  async function readRecord() {
    const result = await store.read(key);
    if (result === null) return { value: emptyRecord(), etag: null };
    const value = result?.value;
    if (typeof result?.etag !== "string" || !result.etag || value?.version !== 1 || value.namespace !== namespace || value.name !== name ||
        !Number.isSafeInteger(value.retryAt) || value.retryAt < 0 ||
        (value.lease !== null && (!value.lease || typeof value.lease.owner !== "string" || !value.lease.owner || !Number.isSafeInteger(value.lease.until)))) {
      throw unavailable("CATALOG_INVALID_RECORD");
    }
    if (value.entry !== null) {
      const entry = value.entry;
      if (!entry || typeof entry.revision !== "string" || !entry.revision || !Object.hasOwn(entry, "value") ||
          ![entry.loadedAt, entry.expiresAt, entry.staleUntil].every(Number.isSafeInteger) ||
          entry.loadedAt < 0 || entry.expiresAt <= entry.loadedAt || entry.staleUntil < entry.expiresAt) {
        throw unavailable("CATALOG_INVALID_RECORD");
      }
      // A reader's shorter configuration also applies to existing shared data.
      const expiresAt = Math.min(entry.expiresAt, entry.loadedAt + ttlMs);
      const normalized = { ...entry, value: jsonCopy(entry.value), expiresAt, staleUntil: Math.min(entry.staleUntil, expiresAt + staleMs) };
      remember(normalized, "shared");
      return { value: { ...value, entry: normalized }, etag: result.etag };
    }
    return { value, etag: result.etag };
  }

  async function writeRecord(value, etag) {
    const result = await store.write(key, value, etag === null ? { onlyIfNew: true } : { onlyIfMatch: etag });
    if (typeof result?.modified !== "boolean" || (result.modified && (typeof result.etag !== "string" || !result.etag))) {
      throw unavailable("CATALOG_CONDITIONAL_WRITES_REQUIRED");
    }
    return result;
  }

  async function loadEntry() {
    const controller = new AbortController();
    let timer;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => load({ signal: controller.signal })),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(unavailable("CATALOG_LOAD_TIMEOUT"));
          }, loadTimeoutMs);
        }),
      ]);
      const copy = jsonCopy(value);
      const loadedAt = now();
      return { value: copy, revision: randomUUID(), loadedAt, expiresAt: loadedAt + ttlMs, staleUntil: loadedAt + ttlMs + staleMs };
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh(forceRefresh) {
    if (!store) {
      if (now() < retryAt) throw unavailable("CATALOG_RETRY_LATER");
      try {
        const entry = await loadEntry();
        remember(entry, "load");
        retryAt = 0;
        return { entry, refreshed: true };
      } catch (error) {
        retryAt = now() + retryMs;
        throw error;
      }
    }

    const deadline = now() + waitMs;
    let budget = waitMs;
    let initialRevision;
    let attempts = 0;
    while (true) {
      const record = await readRecord();
      const { entry, lease } = record.value;
      leaseUntil = lease?.until || 0;
      if (initialRevision === undefined) initialRevision = entry?.revision ?? null;
      const changed = Boolean(entry && entry.revision !== initialRevision);
      if (fresh(entry) && (!forceRefresh || changed)) return { entry, refreshed: changed };
      if (now() < record.value.retryAt) throw unavailable("CATALOG_RETRY_LATER");

      if (!lease || now() >= lease.until) {
        const claim = { ...record.value, lease: { owner: randomUUID(), until: now() + leaseMs }, retryAt: 0 };
        const acquired = await writeRecord(claim, record.etag);
        if (acquired.modified) {
          leaseUntil = claim.lease.until;
          try {
            const next = await loadEntry();
            if (now() >= claim.lease.until) throw unavailable("CATALOG_LEASE_LOST");
            const published = await writeRecord({ ...claim, entry: next, lease: null, retryAt: 0 }, acquired.etag);
            if (!published.modified) throw unavailable("CATALOG_LEASE_LOST");
            leaseUntil = 0;
            remember(next, "load");
            return { entry: next, refreshed: true };
          } catch (error) {
            // Never delete a lease: an expired owner could delete its successor.
            // CAS release preserves the old entry and cannot undo a new owner.
            await writeRecord({ ...claim, lease: null, retryAt: now() + retryMs }, acquired.etag).catch(() => {});
            leaseUntil = 0;
            throw error;
          }
        }
      }

      const remaining = Math.min(budget, deadline - now());
      if (remaining <= 0) throw unavailable("CATALOG_REFRESH_BUSY");
      const delay = Math.min(pollMs * 2 ** Math.min(attempts++, 4), 1_000, remaining);
      await sleep(delay);
      budget -= delay;
      // Re-read once at the deadline: a peer may have just published or its lease
      // may have expired. No uncoordinated load happens when the wait runs out.
    }
  }

  function startFlight(forced) {
    const current = { forced };
    current.promise = refresh(forced).finally(() => { if (flight === current) flight = null; });
    flight = current;
    return current;
  }

  return {
    async get({ allowStale = false, forceRefresh = false } = {}) {
      if (typeof allowStale !== "boolean" || typeof forceRefresh !== "boolean") throw new TypeError("Cache read flags must be booleans.");
      if (!forceRefresh && fresh(memory)) {
        source = "memory";
        return jsonCopy(memory.value);
      }
      try {
        while (true) {
          const current = flight || startFlight(forceRefresh);
          const result = await current.promise;
          // An admin forcing a refresh during an ordinary shared-cache lookup
          // must not accidentally get that lookup's pre-existing snapshot.
          if (forceRefresh && !current.forced && !result.refreshed) continue;
          if (!fresh(result.entry)) throw unavailable("CATALOG_REFRESH_EXPIRED");
          return jsonCopy(result.entry.value);
        }
      } catch (error) {
        const safeError = failure(error);
        if (allowStale && !forceRefresh && stale(memory)) {
          source = "stale";
          return jsonCopy(memory.value);
        }
        throw safeError;
      }
    },

    status() {
      const time = now();
      return {
        namespace, name, source,
        loadedAt: memory?.loadedAt ?? null,
        expiresAt: memory?.expiresAt ?? null,
        staleUntil: memory?.staleUntil ?? null,
        ageMs: memory ? Math.max(0, time - memory.loadedAt) : null,
        fresh: fresh(memory, time),
        stale: Boolean(!fresh(memory, time) && stale(memory, time)),
        refreshing: Boolean(flight || leaseUntil > time),
        lastFailureAt, lastErrorCode,
      };
    },
  };
}

/**
 * Lazy adapter for the verified Blobs conditional API. Installed 8.2.0 accepts
 * metadata only and returns void; do NOT pass it lease options (they are ignored).
 * Parent upgrades dependencies, reads @netlify/blobs/package.json's version and
 * injects getStore. Conservatively require >=11.1.8, the target reviewed API:
 * getWithMetadata({type:"json", consistency:"strong"}), setJSON(..., conditions)
 * -> {modified, etag}. Construction and version checks make no hosted requests.
 */
export function createNetlifyCatalogStore({ getStore, sdkVersion, name = "op-catalog-cache" } = {}) {
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(sdkVersion || "");
  const supported = version && (Number(version[1]) > 11 || (Number(version[1]) === 11 &&
    (Number(version[2]) > 1 || (Number(version[2]) === 1 && Number(version[3]) >= 8))));
  if (!supported) throw unavailable("CATALOG_CONDITIONAL_WRITES_REQUIRED");
  if (typeof getStore !== "function") throw new TypeError("getStore must be an injected factory.");
  let pending;
  const resolve = () => {
    if (!pending) {
      pending = Promise.resolve().then(() => getStore({ name, consistency: "strong" })).then((value) => {
        if (typeof value?.getWithMetadata !== "function" || typeof value?.setJSON !== "function") throw unavailable("CATALOG_CONDITIONAL_WRITES_REQUIRED");
        return value;
      }).catch((error) => { pending = null; throw error; });
    }
    return pending;
  };
  return {
    async read(key) {
      const result = await (await resolve()).getWithMetadata(key, { type: "json", consistency: "strong" });
      return result === null ? null : { value: result.data, etag: result.etag };
    },
    async write(key, value, condition) {
      if (!(condition?.onlyIfNew === true && !Object.hasOwn(condition, "onlyIfMatch")) &&
          !(typeof condition?.onlyIfMatch === "string" && condition.onlyIfMatch && !Object.hasOwn(condition, "onlyIfNew"))) {
        throw new TypeError("An atomic write condition is required.");
      }
      const result = await (await resolve()).setJSON(key, value, condition);
      if (typeof result?.modified !== "boolean" || (result.modified && !result.etag)) throw unavailable("CATALOG_CONDITIONAL_WRITES_REQUIRED");
      return result;
    },
  };
}

function jsonCopy(value) {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error();
    return JSON.parse(json);
  } catch {
    throw unavailable("CATALOG_INVALID_VALUE");
  }
}

function unavailable(code) {
  return Object.assign(new Error("The catalogue is temporarily unavailable. Please try again shortly."), { code, status: 503 });
}

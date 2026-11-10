// Real PostgreSQL, exclusively in a fresh guarded OS-temp cluster. Never loads
// .env, DATABASE_URL, portal data, or any hosted service. No fallback to mocks.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createRateLimiter, securitySchemaSql } from "../lib/security.mjs";
import { startIsolatedPostgres } from "./isolated-postgres.mjs";

const secret = randomBytes(32).toString("hex");
const identityHash = ({ key, bucket, windowMs }) => createHmac("sha256", secret)
  .update(JSON.stringify(["op-rate-limit:v1", key, bucket, windowMs])).digest("hex");
const isClaim = ({ text }) => text.includes("INSERT INTO op_rate_limits AS limits");
const isCleanup = ({ text }) => text.includes("DELETE FROM op_rate_limits AS limits USING expired");

test("isolated helper rejects external connection/path overrides before starting anything", async () => {
  for (const options of [{ url: "postgresql://example.invalid/forbidden" }, { connectionString: "forbidden" },
    { directory: "C:\\" }, { host: "127.0.0.1" }, { onQuery: true }]) {
    await assert.rejects(startIsolatedPostgres(options), TypeError);
  }
});

test("identity hook failure shuts down the native cluster and removes its directory", { timeout: 60_000 }, async () => {
  let directory;
  await assert.rejects(startIsolatedPostgres({ onQuery: () => { throw new Error("Intentional identity-hook failure"); } }), (error) => {
    directory = error.directory;
    assert.match(error.message, /Intentional identity-hook failure/);
    assert.doesNotMatch(error.message, /Cleanup failed/);
    return true;
  });
  assert.ok(directory);
  await assert.rejects(lstat(directory), (error) => error.code === "ENOENT");
  console.log("Deliberate identity-hook failure: pool drained, native server stopped, temporary directory removed.");
});

test("security SQL against a disposable native PostgreSQL cluster", { timeout: 120_000 }, async (t) => {
  const observed = [];
  const database = await startIsolatedPostgres({ poolSize: 16, onQuery: (query) => observed.push(query) }).catch((error) => {
    console.error(error.message); // Helper errors already redact generated credentials.
    throw error;
  });
  const { pool, url, directory, close } = database;
  try {
    const address = new URL(url);
    assert.equal(address.hostname, "127.0.0.1");
    assert.ok(address.username && address.password);
    assert.match(path.basename(directory), /^op-postgres-/);
    assert.ok(pool.options.max >= 12);
    const { rows: [version] } = await pool.query("SELECT current_setting('server_version') AS version");
    console.log(`Native PostgreSQL ${version.version}; isolated loopback cluster, pool max ${pool.options.max}.`);
    // Exercise migration idempotence as well as the actual table/index syntax.
    await pool.query(securitySchemaSql);
    await pool.query(securitySchemaSql);

    const limiter = (overrides = {}) => createRateLimiter({
      useDatabase: () => true, database: async () => pool, secret, cleanupBatchSize: 0, ...overrides,
    });

    await t.test("eight instances claim 200 concurrent requests per identity with exactly 12 accepted", async () => {
      // Warm at least twelve independent connections, making concurrent claims
      // reach PostgreSQL rather than hiding races behind a one-client mock.
      await Promise.all(Array.from({ length: 16 }, async () => {
        const client = await pool.connect();
        try { await client.query("SELECT pg_sleep(0.01)"); }
        finally { client.release(); }
      }));
      assert.ok(pool.totalCount >= 12);
      const windowMs = 3_600_000;
      const { rows: [{ now }] } = await pool.query("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now");
      const untilBoundary = windowMs - Number(now) % windowMs;
      if (untilBoundary < 10_000) await delay(untilBoundary + 30);
      const workers = Array.from({ length: 8 }, () => limiter());
      const inputs = [
        { key: "192.0.2.71", bucket: "login", limit: 12, windowMs },
        { key: "192.0.2.72", bucket: "login", limit: 12, windowMs },
        { key: "192.0.2.71", bucket: "register", limit: 12, windowMs },
      ];
      const before = observed.filter(isClaim).length;
      const pending = inputs.map((input) => Promise.all(Array.from({ length: 200 }, (_, index) => workers[index % 8].check(input))));
      const groups = await Promise.all(pending);
      for (const results of groups) {
        assert.equal(results.filter((result) => result.allowed).length, 12);
        assert.equal(results.filter((result) => !result.allowed).length, 188);
        assert.deepEqual(results.filter((result) => result.allowed).map((result) => result.remaining).sort((a, b) => a - b),
          Array.from({ length: 12 }, (_, index) => index));
        assert.equal(new Set(results.map((result) => result.resetAt)).size, 1);
        assert.ok(results.filter((result) => !result.allowed).every((result) => result.remaining === 0 && result.retryAfterSeconds > 0));
      }
      assert.equal(observed.filter(isClaim).length - before, 600);
      const { rows } = await pool.query("SELECT key_hash, window_start_ms, hits, expires_at FROM op_rate_limits ORDER BY key_hash");
      assert.equal(rows.length, 3);
      for (const row of rows) {
        assert.match(row.key_hash, /^[0-9a-f]{64}$/);
        assert.equal(row.hits, 12, "Denied claims never increment the capped persisted counter.");
        assert.equal(row.expires_at.getTime(), Number(row.window_start_ms) + windowMs);
      }
      for (const input of inputs) {
        assert.ok(rows.some((row) => row.key_hash === identityHash(input)));
        assert.ok(!JSON.stringify(rows).includes(input.key), "Persist only HMAC identities, never raw IPs.");
        assert.ok(observed.filter(isClaim).every((query) => !JSON.stringify(query.values).includes(input.key)));
      }
      assert.ok(!JSON.stringify(rows).includes(secret));
      await assert.rejects(workers[0].consume(inputs[0].key, inputs[0].bucket, 12, windowMs),
        (error) => error.status === 429 && error.code === "RATE_LIMITED" && error.retryAfterSeconds > 0);
      console.log("Real claim results: 3 identities × 200 requests; each accepted 12 and denied 188 across 8 limiter instances.");
    });

    await t.test("real TTL resets quota without deleting the previous window", async () => {
      const input = { key: "192.0.2.80", bucket: "expiry", limit: 1, windowMs: 1000 };
      const { rows: [{ now }] } = await pool.query("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now");
      const remaining = 1000 - Number(now) % 1000;
      if (remaining < 250) await delay(remaining + 20);
      const worker = limiter();
      const first = await worker.check(input);
      assert.equal(first.allowed, true);
      assert.equal((await worker.check(input)).allowed, false);
      await delay(Math.max(1, first.resetAt - Date.now() + 50));
      const renewed = await worker.check(input);
      assert.equal(renewed.allowed, true);
      assert.ok(renewed.resetAt > first.resetAt);
      const { rows } = await pool.query("SELECT hits, expires_at <= statement_timestamp() AS expired FROM op_rate_limits WHERE key_hash = $1 ORDER BY window_start_ms", [identityHash(input)]);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((row) => row.hits), [1, 1]);
      assert.equal(rows[0].expired, true);
      assert.equal(rows[1].expired, false);
      // Keep later cleanup counts independent of this deliberately short TTL.
      await pool.query("DELETE FROM op_rate_limits WHERE key_hash = $1", [identityHash(input)]);
    });

    await t.test("bounded cleanup skips a locked expired row and preserves live limits", async () => {
      const hashes = Array.from({ length: 7 }, () => randomBytes(32).toString("hex"));
      await pool.query(`INSERT INTO op_rate_limits (key_hash, window_start_ms, hits, expires_at)
        SELECT value, 0, 1, statement_timestamp() - interval '1 day' FROM unnest($1::text[]) AS value`, [hashes]);
      const countExpired = async () => Number((await pool.query("SELECT count(*) AS count FROM op_rate_limits WHERE expires_at <= statement_timestamp()" )).rows[0].count);
      const before = await countExpired();
      let now = 1000;
      const worker = limiter({ cleanupBatchSize: 2, cleanupIntervalMs: 100, now: () => now });
      const input = { key: "192.0.2.90", bucket: "cleanup", limit: 1, windowMs: 3_600_000 };
      const locked = await pool.connect();
      const cleanupBefore = observed.filter(isCleanup).length;
      try {
        await locked.query("BEGIN");
        await locked.query("SELECT key_hash FROM op_rate_limits WHERE key_hash = $1 FOR UPDATE", [hashes[0]]);
        const result = await worker.check(input);
        assert.equal(result.allowed, true);
        assert.equal(await countExpired(), before - 2);
        assert.equal((await pool.query("SELECT count(*) AS count FROM op_rate_limits WHERE key_hash = $1", [hashes[0]])).rows[0].count, "1");
        assert.equal(observed.filter(isCleanup).length - cleanupBefore, 1);
        await Promise.all(Array.from({ length: 20 }, () => worker.check(input)));
        assert.equal(await countExpired(), before - 2);
        assert.equal(observed.filter(isCleanup).length - cleanupBefore, 1, "Concurrent traffic obeys cleanup cooldown.");
      } finally {
        await locked.query("ROLLBACK");
        locked.release();
      }
      now += 100;
      await worker.check(input);
      assert.equal(await countExpired(), before - 4);
      assert.equal(observed.filter(isCleanup).length - cleanupBefore, 2);
      for (let attempt = 0; attempt < 6; attempt++) {
        now += 100;
        await worker.check(input);
      }
      assert.equal(await countExpired(), 0);
      const { rows: [live] } = await pool.query("SELECT hits FROM op_rate_limits WHERE key_hash = $1", [identityHash(input)]);
      assert.equal(live.hits, 1, "Cleanup and denied requests cannot erase/reset live claims.");
    });

    await t.test("constructing unused limiters and idle turns issue zero queries", async () => {
      const before = observed.length;
      limiter({ cleanupBatchSize: 100 });
      await delay(150);
      assert.equal(observed.length, before);
    });
  } finally {
    await Promise.all([close(), close()]);
  }
  await assert.rejects(lstat(directory), (error) => error.code === "ENOENT", "close removes its exact verified temporary directory.");
  assert.equal(pool.ending, true);
  await close();
  console.log("Isolated PostgreSQL stopped; verified temporary cluster directory removed.");
});

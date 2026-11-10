// Offline only: no server, credentials, network, files, or hosted data access.
import assert from "node:assert/strict";
import { createHash, createHmac, scryptSync } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";
import {
  constantTimeTokenEqual,
  createLocalRateLimiter,
  createRateLimiter,
  hashPasswordAsync,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  securitySchemaSql,
  sessionCredentialVersion,
  validateNewPassword,
  validatePasswordPolicy,
  verifyPasswordAsync,
} from "../lib/security.mjs";

const claim = (overrides = {}) => ({ key: "192.0.2.45", bucket: "login", limit: 3, windowMs: 10_000, ...overrides });

// Models statement-time windows and atomic PostgreSQL statements shared by
// independent instances. Yield BEFORE reading/updating so all claims overlap.
// Also check the SQL's actual conflict/cap predicates: this mock is not a SQL
// engine, so database execution still belongs in the parent's migration QA.
class MockRateDatabase {
  now = 123_450;
  claims = [];
  cleanups = [];
  rows = new Map();
  failClaim = false;
  failCleanup = false;
  beforeCleanup;

  async query(sql, values) {
    assert.doesNotMatch(sql, /\b(?:CREATE|ALTER|DROP|TRUNCATE)\b/i, "Runtime must not migrate schema.");
    const timestamp = this.now;
    if (sql.includes("INSERT INTO op_rate_limits")) {
      assert.match(sql, /ON CONFLICT \(key_hash, window_start_ms\) DO UPDATE/);
      assert.match(sql, /SET hits = limits\.hits \+ 1\s+WHERE limits\.hits < \$3::integer/);
      assert.match(sql, /statement_timestamp\(\)/);
      assert.match(sql, /FROM current_window LEFT JOIN claim ON true/);
      assert.equal(values.length, 3);
      const [hash, windowMs, limit] = values;
      assert.match(hash, /^[a-f0-9]{64}$/);
      this.claims.push({ sql, values });
      await tick();
      if (this.failClaim) throw new Error("Mock database unavailable");
      const start = Math.floor(timestamp / windowMs) * windowMs;
      const id = `${hash}:${start}`;
      const row = this.rows.get(id) || { hash, start, hits: 0, expiresAt: start + windowMs };
      const allowed = row.hits < limit;
      if (allowed) {
        row.hits++;
        this.rows.set(id, row);
      }
      return { rows: [{
        allowed, remaining: allowed ? limit - row.hits : 0,
        reset_at: String(row.expiresAt), retry_after: String(Math.ceil((row.expiresAt - timestamp) / 1000)),
      }] };
    }
    assert.match(sql, /DELETE FROM op_rate_limits/);
    assert.match(sql, /WHERE expires_at <= statement_timestamp\(\)/);
    assert.match(sql, /ORDER BY expires_at\s+LIMIT \$1::integer\s+FOR UPDATE SKIP LOCKED/);
    assert.match(sql, /limits\.key_hash = expired\.key_hash\s+AND limits\.window_start_ms = expired\.window_start_ms/);
    this.cleanups.push({ sql, values });
    await this.beforeCleanup?.();
    if (this.failCleanup) throw new Error("Mock cleanup unavailable");
    const expired = [...this.rows.entries()].filter(([, row]) => row.expiresAt <= timestamp)
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt).slice(0, values[0]);
    for (const [id] of expired) this.rows.delete(id);
    return { rows: [], rowCount: expired.length };
  }
}

function distributed(db, overrides = {}) {
  return createRateLimiter({ useDatabase: () => true, database: async () => db, cleanupBatchSize: 0, ...overrides });
}

test("schema exposes the composite unique key and indexed TTL without executing DDL", () => {
  assert.match(securitySchemaSql, /CREATE TABLE IF NOT EXISTS op_rate_limits/);
  assert.match(securitySchemaSql, /PRIMARY KEY \(key_hash, window_start_ms\)/);
  assert.match(securitySchemaSql, /CHECK \(hits > 0\)/);
  assert.match(securitySchemaSql, /CREATE INDEX IF NOT EXISTS .* ON op_rate_limits \(expires_at\)/);
});

test("construction and idle turns never resolve storage or schedule SQL; local checks stay local", async () => {
  let modes = 0, connections = 0, queries = 0;
  const limiter = createRateLimiter({
    useDatabase: () => { modes++; return true; },
    database: async () => { connections++; return { query: async () => { queries++; } }; },
  });
  assert.equal(typeof limiter.check, "function");
  assert.equal(typeof limiter.consume, "function");
  await tick();
  await tick();
  assert.deepEqual([modes, connections, queries], [0, 0, 0]);
  const local = createRateLimiter({ useDatabase: async () => false, database: async () => { throw new Error("No local SQL allowed"); } });
  assert.equal((await local.check(claim())).allowed, true);
  await tick();
  assert.deepEqual([modes, connections, queries], [0, 0, 0]);
});

test("160 concurrent claims from eight instances admit exactly the shared quota", async () => {
  const db = new MockRateDatabase();
  const workers = Array.from({ length: 8 }, () => distributed(db, { secret: "shared-test-secret" }));
  const input = claim({ limit: 7 });
  const results = await Promise.all(Array.from({ length: 160 }, (_, index) => workers[index % workers.length].check(input)));
  assert.equal(results.filter((row) => row.allowed).length, 7);
  assert.equal(results.filter((row) => !row.allowed).length, 153);
  assert.deepEqual(results.filter((row) => row.allowed).map((row) => row.remaining).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(db.rows.size, 1);
  assert.equal([...db.rows.values()][0].hits, 7, "Denied claims must not inflate or overflow the counter.");
  assert.equal(db.claims.length, 160, "One atomic statement per claim, with no read/update race.");
  assert.equal(db.cleanups.length, 0);
  const expectedHash = createHmac("sha256", "shared-test-secret")
    .update(JSON.stringify(["op-rate-limit:v1", input.key, input.bucket, input.windowMs])).digest("hex");
  assert.equal(db.claims[0].values[0], expectedHash);
  for (const { sql, values } of db.claims) {
    assert.ok(!JSON.stringify(values).includes(input.key), "Raw IP must not reach the database.");
    assert.ok(!sql.includes(input.key));
  }
});

test("identity isolates key, bucket, window duration and secret without delimiter collisions", async () => {
  const db = new MockRateDatabase();
  const limiter = distributed(db);
  assert.equal((await limiter.check(claim({ limit: 1 }))).allowed, true);
  assert.equal((await limiter.check(claim({ limit: 1 }))).allowed, false);
  for (const change of [{ key: "192.0.2.46" }, { bucket: "register" }, { windowMs: 20_000 }]) {
    assert.equal((await limiter.check(claim({ limit: 1, ...change }))).allowed, true);
  }
  assert.equal((await limiter.check(claim({ key: "c", bucket: "a:b", limit: 1 }))).allowed, true);
  assert.equal((await limiter.check(claim({ key: "b:c", bucket: "a", limit: 1 }))).allowed, true);
  assert.equal((await distributed(db, { secret: "other-secret" }).check(claim({ limit: 1 }))).allowed, true);
  assert.equal(db.rows.size, 7);
  assert.equal(db.claims[0].values[0], createHash("sha256")
    .update(JSON.stringify(["op-rate-limit:v1", "192.0.2.45", "login", 10_000])).digest("hex"));
});

test("database clock controls expiry, retry metadata and exact window boundaries", async () => {
  const db = new MockRateDatabase();
  db.now = 9_001;
  const limiter = distributed(db, { now: () => 0 });
  const input = claim({ limit: 1 });
  assert.deepEqual(await limiter.check(input), { allowed: true, limit: 1, remaining: 0, resetAt: 10_000, retryAfterSeconds: 0 });
  assert.deepEqual(await limiter.check(input), { allowed: false, limit: 1, remaining: 0, resetAt: 10_000, retryAfterSeconds: 1 });
  db.now = 10_000;
  assert.equal((await limiter.check(input)).allowed, true);
  assert.equal((await limiter.check(input)).retryAfterSeconds, 10);
  assert.equal(db.rows.size, 2, "Expired rows need not be deleted before new windows work.");
  assert.equal([...db.rows.values()][0].expiresAt, 10_000, "Denials never extend TTL.");
});

test("consume returns an accepted result and rejects with the parent's 429 metadata", async () => {
  const limiter = createLocalRateLimiter({ now: () => 9_100 });
  assert.equal((await limiter.consume("ip", "login", 1, 10_000)).allowed, true);
  await assert.rejects(limiter.consume("ip", "login", 1, 10_000), (error) =>
    error.status === 429 && error.code === "RATE_LIMITED" && error.retryAfterSeconds === 1 && error.resetAt === 10_000);
});

test("opportunistic cleanup is batch bounded, throttled and expires only old windows", async () => {
  const db = new MockRateDatabase();
  for (let index = 0; index < 5; index++) db.rows.set(`expired-${index}`, { expiresAt: index, hits: 1 });
  let now = 1_000;
  const limiter = distributed(db, { now: () => now, cleanupBatchSize: 2, cleanupIntervalMs: 100 });
  await limiter.check(claim());
  assert.equal(db.cleanups.length, 1);
  assert.deepEqual(db.cleanups[0].values, [2]);
  assert.equal(db.rows.size, 4, "Delete only two of five expired rows; preserve the live claim.");
  await Promise.all(Array.from({ length: 20 }, () => limiter.check(claim())));
  assert.equal(db.cleanups.length, 1);
  now += 100;
  await limiter.check(claim());
  assert.equal(db.cleanups.length, 2);
  assert.equal(db.rows.size, 2);
  await tick();
  assert.equal(db.cleanups.length, 2, "No cleanup while idle.");
});

test("concurrent checks cannot start overlapping cleanup in the same instance", async () => {
  const db = new MockRateDatabase();
  let release, announce;
  const started = new Promise((resolve) => { announce = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  db.beforeCleanup = async () => { announce(); await gate; };
  let now = 0;
  const limiter = distributed(db, { now: () => now, cleanupBatchSize: 2, cleanupIntervalMs: 1 });
  const first = limiter.check(claim());
  await started;
  now = 1_000;
  try {
    await Promise.all(Array.from({ length: 20 }, () => limiter.check(claim())));
    assert.equal(db.cleanups.length, 1);
  } finally { release(); await first; }
});

test("claim/database failures propagate without using local capacity; cleanup failure preserves a claim", async () => {
  const db = new MockRateDatabase();
  db.failClaim = true;
  const limiter = distributed(db, { cleanupBatchSize: 2 });
  await assert.rejects(limiter.check(claim()), /Mock database unavailable/);
  assert.equal(limiter.localSize, 0);
  assert.equal(db.cleanups.length, 0);
  const brokenProvider = createRateLimiter({ useDatabase: () => true, database: async () => { throw new Error("No connection"); } });
  await assert.rejects(brokenProvider.consume("ip", "login", 1, 1000), /No connection/);
  assert.equal(brokenProvider.localSize, 0);
  db.failClaim = false;
  db.failCleanup = true;
  assert.equal((await limiter.check(claim({ limit: 1 }))).allowed, true);
  assert.equal((await limiter.check(claim({ limit: 1 }))).allowed, false);
  assert.equal(db.cleanups.length, 1, "Failed cleanup also observes the cooldown.");
});

test("malformed database results fail closed", async () => {
  const good = { allowed: true, remaining: 2, reset_at: "10000", retry_after: "10" };
  for (const rows of [[], [good, good], [{}], [{ ...good, allowed: "true" }],
    [{ ...good, remaining: null }], [{ ...good, remaining: 3 }], [{ ...good, reset_at: "" }],
    [{ ...good, reset_at: "9007199254740993" }], [{ ...good, retry_after: 11 }],
    [{ ...good, allowed: false }]]) {
    const limiter = distributed({ query: async () => ({ rows }) });
    await assert.rejects(limiter.check(claim()), /Invalid database rate limit claim result/);
    assert.equal(limiter.localSize, 0);
  }
});

test("invalid claims and configuration reject before storage access", async () => {
  let accesses = 0;
  const limiter = createRateLimiter({ useDatabase: () => { accesses++; return true; } });
  for (const change of [{ key: "" }, { key: 1 }, { bucket: "" }, { bucket: null },
    { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: 2_147_483_648 },
    { windowMs: 0 }, { windowMs: Infinity }, { windowMs: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(limiter.check(claim(change)), TypeError);
  }
  assert.equal(accesses, 0);
  for (const options of [{ maxEntries: 0 }, { pruneBatchSize: 0 }, { cleanupIntervalMs: 0 },
    { cleanupBatchSize: -1 }, { cleanupBatchSize: 10_001 }, { secret: "" }, { now: 1 }, { useDatabase: true }]) {
    assert.throws(() => createRateLimiter(options), TypeError);
  }
  await assert.rejects(createLocalRateLimiter({ now: () => -1 }).check(claim()), TypeError);
});

test("local concurrent claims share one counter and reset exactly at the fixed-window edge", async () => {
  let now = 9_999;
  const limiter = createLocalRateLimiter({ now: () => now });
  const input = claim({ limit: 5 });
  const results = await Promise.all(Array.from({ length: 80 }, () => limiter.check(input)));
  assert.equal(results.filter((row) => row.allowed).length, 5);
  assert.equal(limiter.localSize, 1);
  assert.equal(results.at(-1).retryAfterSeconds, 1);
  now = 10_000;
  assert.equal((await limiter.check(input)).allowed, true);
  assert.equal((await limiter.check(claim({ bucket: "other", limit: 1 }))).allowed, true);
  assert.equal((await limiter.check(claim({ windowMs: 20_000, limit: 1 }))).allowed, true);
});

test("local high-cardinality traffic stays bounded and cannot evict live blocked clients", async () => {
  let now = 1;
  const limiter = createLocalRateLimiter({ now: () => now, maxEntries: 3, pruneBatchSize: 1 });
  for (const key of ["hot", "second", "third"]) assert.equal((await limiter.check(claim({ key, limit: 1 }))).allowed, true);
  for (let index = 0; index < 100; index++) {
    assert.equal((await limiter.check(claim({ key: `churn-${index}`, limit: 1 }))).allowed, false);
    assert.equal(limiter.localSize, 3);
  }
  assert.equal((await limiter.check(claim({ key: "hot", limit: 1 }))).allowed, false);
  now = 10_000;
  assert.equal((await limiter.check(claim({ key: "new", limit: 1 }))).allowed, true);
  for (let index = 0; index < 5; index++) await limiter.check(claim({ key: "new", limit: 1 }));
  assert.equal(limiter.localSize, 1, "Rotating bounded pruning eventually removes every expired entry.");
  assert.equal((await limiter.check(claim({ key: "new", limit: 1 }))).allowed, false);
});

test("claim inputs are captured before asynchronous backend selection", async () => {
  const input = claim();
  const db = new MockRateDatabase();
  const limiter = distributed(db, { useDatabase: async () => { await tick(); return true; } });
  const result = limiter.check(input);
  input.limit = 99;
  input.windowMs = 1;
  input.key = "changed";
  await result;
  assert.equal(db.claims[0].values[1], 10_000);
  assert.equal(db.claims[0].values[2], 3);
});

test("new password policy enforces 12–128 Unicode characters without trimming or composition rules", () => {
  assert.equal(PASSWORD_MIN_LENGTH, 12);
  assert.equal(PASSWORD_MAX_LENGTH, 128);
  for (const password of ["a".repeat(12), "x".repeat(128), "long pass phrase", " 0123456789 ", "🔐".repeat(12), "🔐".repeat(128)]) {
    assert.equal(validatePasswordPolicy(password).valid, true);
    assert.equal(validateNewPassword(password), password);
  }
  for (const [password, code] of [["x".repeat(11), "PASSWORD_TOO_SHORT"], ["x".repeat(129), "PASSWORD_TOO_LONG"],
    ["🔐".repeat(6), "PASSWORD_TOO_SHORT"], ["🔐".repeat(129), "PASSWORD_TOO_LONG"],
    [" ".repeat(12), "PASSWORD_BLANK"], ["\t".repeat(12), "PASSWORD_BLANK"],
    [null, "PASSWORD_TYPE"], [123456789012, "PASSWORD_TYPE"], [{ toString: () => "x".repeat(12) }, "PASSWORD_TYPE"]]) {
    assert.equal(validatePasswordPolicy(password).code, code);
    assert.throws(() => validateNewPassword(password), (error) => error.status === 400 && error.code === code);
  }
});

test("async hashing matches legacy default scrypt exactly and verifies existing short/long logins", async () => {
  const salt = "0123456789abcdef0123456789abcdef";
  const legacy = `${salt}:${scryptSync("user", salt, 64).toString("hex")}`;
  const pending = hashPasswordAsync("user", salt);
  assert.ok(pending instanceof Promise);
  assert.equal(await pending, legacy);
  assert.equal(await verifyPasswordAsync("user", legacy), true);
  assert.equal(await verifyPasswordAsync("wrong", legacy), false);
  assert.throws(() => validateNewPassword("user"), (error) => error.code === "PASSWORD_TOO_SHORT");
  const oldLong = "legacy ".repeat(25);
  assert.ok(oldLong.length > 128);
  assert.equal(await verifyPasswordAsync(oldLong, await hashPasswordAsync(oldLong)), true);
  assert.equal(await verifyPasswordAsync("", await hashPasswordAsync("")), true, "Verification never reapplies new-credential policy.");
});

test("new hashes use random salts, preserve whitespace and reject malformed storage", async () => {
  const password = "  long pass phrase  ";
  const [first, second] = await Promise.all([hashPasswordAsync(password), hashPasswordAsync(password)]);
  assert.match(first, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPasswordAsync(password, first), true);
  assert.equal(await verifyPasswordAsync(password.trim(), first), false);
  const [salt, hash] = first.split(":");
  assert.equal(await verifyPasswordAsync(password, `${salt}:${hash.toUpperCase()}`), true);
  for (const stored of [undefined, null, 3, "", "salt", `:${hash}`, `${salt}:`, `${salt}:${hash.slice(2)}`,
    `${salt}:${hash}zz`, `${salt}:${hash}:extra`, `${salt}:${hash}\n`, `${salt}:${"z".repeat(128)}`]) {
    assert.equal(await verifyPasswordAsync(password, stored), false);
  }
  assert.equal(await verifyPasswordAsync(null, first), false);
  await assert.rejects(hashPasswordAsync(123), TypeError);
  await assert.rejects(hashPasswordAsync(password, "bad:salt"), TypeError);
});

test("session credential versions are deterministic, HMAC keyed and revoke on every credential identity change", () => {
  const user = { id: "account", role: "customer", passwordHash: "legacy-salt:legacy-hash" };
  const version = sessionCredentialVersion(user, "session-test-secret");
  assert.match(version, /^[\w-]{43}$/);
  assert.equal(sessionCredentialVersion({ ...user, displayName: "Updated" }, "session-test-secret"), version);
  assert.equal(version, createHmac("sha256", "session-test-secret")
    .update(JSON.stringify(["op-session-version:v1", user.id, user.role, user.passwordHash])).digest("base64url"));
  for (const change of [{ id: "another" }, { role: "admin" }, { passwordHash: "changed-hash" }]) {
    assert.equal(constantTimeTokenEqual(version, sessionCredentialVersion({ ...user, ...change }, "session-test-secret")), false);
  }
  assert.notEqual(sessionCredentialVersion(user, "rotated-secret"), version);
  assert.equal(sessionCredentialVersion(user, Buffer.from("session-test-secret")), version);
  for (const change of [{ id: "" }, { role: null }, { passwordHash: "" }]) {
    assert.throws(() => sessionCredentialVersion({ ...user, ...change }, "secret"), TypeError);
  }
  assert.throws(() => sessionCredentialVersion(user, ""), TypeError);
});

test("constant-time token comparison handles length differences and fails closed on absent/non-string values", () => {
  assert.equal(constantTimeTokenEqual("same-token", "same-token"), true);
  assert.equal(constantTimeTokenEqual("ab", "ba"), false);
  assert.equal(constantTimeTokenEqual("a", "a".repeat(1000)), false);
  assert.equal(constantTimeTokenEqual("token", "token\0"), false);
  assert.equal(constantTimeTokenEqual(" token ", "token"), false);
  assert.equal(constantTimeTokenEqual("é", "e\u0301"), false);
  assert.equal(constantTimeTokenEqual("\ud800", "\ufffd"), false);
  for (const invalid of [undefined, null, "", 123, {}, Buffer.from("token")]) {
    assert.equal(constantTimeTokenEqual(invalid, invalid), false);
    assert.equal(constantTimeTokenEqual("token", invalid), false);
  }
});

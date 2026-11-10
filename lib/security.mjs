import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

// Apply through the parent's migration path. Importing/constructing a limiter
// never connects, creates schema, schedules work, or reads environment variables.
export const securitySchemaSql = `
CREATE TABLE IF NOT EXISTS op_rate_limits (
  key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  window_start_ms bigint NOT NULL,
  hits integer NOT NULL CHECK (hits > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (key_hash, window_start_ms)
);
CREATE INDEX IF NOT EXISTS op_rate_limits_expiry_idx ON op_rate_limits (expires_at);
`;

// The database clock defines fixed windows across instances. The conditional
// UPSERT claims at most limit slots under a row lock, including on first insert.
// Denied requests do not increment hits, extend TTL, or require a second read.
const CLAIM_SQL = `
WITH current_window AS (
  SELECT floor(extract(epoch FROM statement_timestamp()) * 1000 / $2::bigint)::bigint
    * $2::bigint AS start_ms
), claim AS (
  INSERT INTO op_rate_limits AS limits (key_hash, window_start_ms, hits, expires_at)
  SELECT $1, start_ms, 1, to_timestamp((start_ms + $2::bigint)::double precision / 1000)
  FROM current_window
  ON CONFLICT (key_hash, window_start_ms) DO UPDATE
    SET hits = limits.hits + 1
    WHERE limits.hits < $3::integer
  RETURNING hits
)
SELECT claim.hits IS NOT NULL AS allowed,
  coalesce($3::integer - claim.hits, 0) AS remaining,
  current_window.start_ms + $2::bigint AS reset_at,
  ceil((current_window.start_ms + $2::bigint
    - extract(epoch FROM statement_timestamp()) * 1000) / 1000)::bigint AS retry_after
FROM current_window LEFT JOIN claim ON true
`;

// Indexed, batch-bounded, and nonblocking with respect to other row claims or
// cleaners. TTL is logical immediately; physical deletion waits for traffic.
const CLEANUP_SQL = `
WITH expired AS (
  SELECT key_hash, window_start_ms FROM op_rate_limits
  WHERE expires_at <= statement_timestamp()
  ORDER BY expires_at
  LIMIT $1::integer
  FOR UPDATE SKIP LOCKED
)
DELETE FROM op_rate_limits AS limits USING expired
WHERE limits.key_hash = expired.key_hash
  AND limits.window_start_ms = expired.window_start_ms
`;

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a positive safe integer up to ${maximum}.`);
  }
}

function nonemptyText(value, name) {
  if (typeof value !== "string" || !value.length) throw new TypeError(`${name} must be a nonempty string.`);
}

function secretKey(secret, name) {
  if (!(typeof secret === "string" || Buffer.isBuffer(secret)) || !secret.length) {
    throw new TypeError(`${name} must be a nonempty string or Buffer.`);
  }
}

function validateClaim({ key, bucket, limit, windowMs }) {
  nonemptyText(key, "key");
  nonemptyText(bucket, "bucket");
  positiveInteger(limit, "limit", 2_147_483_647);
  positiveInteger(windowMs, "windowMs");
}

function keyHash({ key, bucket, windowMs }, secret) {
  // JSON tuple framing avoids separator collisions; neither backend stores IPs.
  const input = JSON.stringify(["op-rate-limit:v1", key, bucket, windowMs]);
  return (secret === undefined ? createHash("sha256") : createHmac("sha256", secret))
    .update(input).digest("hex");
}

function decision(allowed, limit, remaining, resetAt, retryAfterSeconds) {
  return { allowed, limit, remaining, resetAt, retryAfterSeconds: allowed ? 0 : retryAfterSeconds };
}

/**
 * check({ key, bucket, limit, windowMs }) -> Promise<{
 *   allowed, limit, remaining, resetAt: epochMilliseconds, retryAfterSeconds
 * }>. key is the caller's trusted/canonical client IP (never accept arbitrary
 * forwarded headers). Use identical bucket policies and optional secret on
 * all instances sharing a database. Changing the secret resets their quotas.
 *
 * Call only for selected write routes AFTER the no-SQL pause gate. GET/status
 * routes and paused/idle workers must not call check. There is no background work.
 * consume(key, bucket, limit, windowMs) wraps check and throws status 429 on denial,
 * with code RATE_LIMITED, retryAfterSeconds and resetAt for the HTTP adapter.
 * Database errors propagate; they never fall back to an independent local quota.
 * Cleanup failures cannot undo an already atomic claim and retry on later traffic.
 * Local capacity fails closed for new keys; active counters are never evicted.
 */
export function createRateLimiter({
  database,
  useDatabase = () => false,
  secret,
  now = Date.now,
  maxEntries = 10_000,
  pruneBatchSize = 100,
  cleanupIntervalMs = 60_000,
  cleanupBatchSize = 100,
} = {}) {
  if (typeof useDatabase !== "function" || typeof now !== "function") throw new TypeError("useDatabase and now must be functions.");
  if (secret !== undefined) secretKey(secret, "secret");
  positiveInteger(maxEntries, "maxEntries");
  positiveInteger(pruneBatchSize, "pruneBatchSize");
  positiveInteger(cleanupIntervalMs, "cleanupIntervalMs");
  if (cleanupBatchSize !== 0) positiveInteger(cleanupBatchSize, "cleanupBatchSize", 10_000);
  const entries = new Map();
  let pruneIterator = entries.entries();
  let nextCleanupAt = -Infinity;
  let cleaning = false;

  function time() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("now() must return nonnegative safe epoch milliseconds.");
    return value;
  }

  function pruneLocal(timestamp) {
    const count = Math.min(pruneBatchSize, entries.size);
    for (let inspected = 0; inspected < count; inspected++) {
      let next = pruneIterator.next();
      if (next.done) {
        pruneIterator = entries.entries();
        next = pruneIterator.next();
        if (next.done) break;
      }
      if (next.value[1].resetAt <= timestamp) entries.delete(next.value[0]);
    }
  }

  function checkLocal(input, hash) {
    const timestamp = time();
    pruneLocal(timestamp);
    let entry = entries.get(hash);
    if (entry && entry.resetAt <= timestamp) {
      entries.delete(hash);
      entry = undefined;
    }
    if (!entry) {
      const resetAt = Math.floor(timestamp / input.windowMs) * input.windowMs + input.windowMs;
      if (!Number.isSafeInteger(resetAt)) throw new RangeError("Rate limit window exceeds safe epoch milliseconds.");
      if (entries.size >= maxEntries) {
        return decision(false, input.limit, 0, resetAt, Math.ceil((resetAt - timestamp) / 1000));
      }
      entry = { hits: 0, resetAt };
      entries.set(hash, entry);
    }
    const allowed = entry.hits < input.limit;
    if (allowed) entry.hits++;
    return decision(allowed, input.limit, Math.max(0, input.limit - entry.hits), entry.resetAt,
      Math.ceil((entry.resetAt - timestamp) / 1000));
  }

  async function cleanup(pool) {
    if (!cleanupBatchSize || cleaning) return;
    const timestamp = time();
    if (timestamp < nextCleanupAt) return;
    // Reserve before awaiting so concurrent checks in this instance share a gate.
    nextCleanupAt = timestamp + cleanupIntervalMs;
    cleaning = true;
    try { await pool.query(CLEANUP_SQL, [cleanupBatchSize]); }
    catch { /* Opportunistic housekeeping; never substitute for a failed claim. */ }
    finally { cleaning = false; }
  }

  async function check({ key, bucket, limit, windowMs }) {
    const input = { key, bucket, limit, windowMs };
    validateClaim(input);
    const hash = keyHash(input, secret);
    if (!await useDatabase()) return checkLocal(input, hash);
    if (typeof database !== "function") throw new TypeError("database must lazily return a pg-compatible query client.");
    const pool = await database();
    const result = await pool.query(CLAIM_SQL, [hash, input.windowMs, input.limit]);
    const rows = result?.rows;
    const row = rows?.[0];
    const integer = (value) => typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)) ? Number(value) : NaN;
    const remaining = integer(row?.remaining), resetAt = integer(row?.reset_at), retryAfter = integer(row?.retry_after);
    if (!Array.isArray(rows) || rows.length !== 1 || typeof row?.allowed !== "boolean"
      || !Number.isSafeInteger(remaining) || remaining < 0 || remaining >= input.limit
      || !Number.isSafeInteger(resetAt) || resetAt < 0
      || !Number.isSafeInteger(retryAfter) || retryAfter < 1 || retryAfter > Math.ceil(input.windowMs / 1000)
      || (!row.allowed && remaining !== 0)) {
      throw new Error("Invalid database rate limit claim result.");
    }
    const answer = decision(row.allowed, input.limit, remaining, resetAt, retryAfter);
    await cleanup(pool);
    return answer;
  }

  async function consume(key, bucket, limit, windowMs) {
    const result = await check({ key, bucket, limit, windowMs });
    if (!result.allowed) {
      throw Object.assign(new Error("Too many requests. Please try again shortly."), {
        status: 429, code: "RATE_LIMITED", retryAfterSeconds: result.retryAfterSeconds, resetAt: result.resetAt,
      });
    }
    return result;
  }

  return { check, consume, get localSize() { return entries.size; } };
}

export function createLocalRateLimiter(options = {}) {
  return createRateLimiter({ ...options, useDatabase: () => false });
}

// Count Unicode code points, permit passphrases/spaces, and never trim, normalize,
// or truncate credentials. This policy is ONLY for newly chosen credentials.
export function validatePasswordPolicy(password) {
  if (typeof password !== "string") return { valid: false, code: "PASSWORD_TYPE", message: "Password must be text." };
  let length = 0;
  for (const character of password) {
    if (++length > PASSWORD_MAX_LENGTH) return { valid: false, code: "PASSWORD_TOO_LONG", message: `Use at most ${PASSWORD_MAX_LENGTH} characters for the password.` };
  }
  if (length < PASSWORD_MIN_LENGTH) return { valid: false, code: "PASSWORD_TOO_SHORT", message: `Use at least ${PASSWORD_MIN_LENGTH} characters for the password.` };
  if (!password.trim()) return { valid: false, code: "PASSWORD_BLANK", message: "Password cannot contain only whitespace." };
  return { valid: true, code: null, message: "" };
}

export function validateNewPassword(password) {
  const result = validatePasswordPolicy(password);
  if (!result.valid) throw Object.assign(new Error(result.message), { status: 400, code: result.code });
  return password;
}

/** Legacy-compatible salt:hex(scrypt(password, salt, 64)), with Node defaults
 * N=16384, r=8, p=1. Salt remains UTF-8 text, NOT decoded hex. Policy is separate
 * so legacy demo/env credentials and existing logins do not acquire a new rule. */
export async function hashPasswordAsync(password, salt = randomBytes(16).toString("hex")) {
  if (typeof password !== "string") throw new TypeError("Password must be text.");
  if (typeof salt !== "string" || !salt.length || salt.length > 1024 || salt.includes(":")) throw new TypeError("Invalid password salt.");
  const hash = await scryptAsync(password, salt, 64);
  return `${salt}:${hash.toString("hex")}`;
}

export async function verifyPasswordAsync(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;
  const match = /^([^:]{1,1024}):([a-f\d]{128})$/i.exec(stored);
  if (!match || match[0].length !== stored.length) return false;
  const actual = await scryptAsync(password, match[1], 64);
  return timingSafeEqual(actual, Buffer.from(match[2], "hex"));
}

/** Fixed-size digest comparison for nonempty string tokens, including unequal
 * lengths. JSON framing preserves exact strings (even unpaired surrogates).
 * Hashing still takes time proportional to input length; bound request bodies. */
export function constantTimeTokenEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left.length || !right.length) return false;
  const digest = (value) => createHash("sha256").update(JSON.stringify(["op-token:v1", value])).digest();
  return timingSafeEqual(digest(left), digest(right));
}

/** Put the fingerprint in the signed session; recompute from the CURRENT saved
 * account and compare on authenticated access. Password/role/id/secret changes
 * revoke it. This helper itself performs no account reads or cookie operations. */
export function sessionCredentialVersion({ id: userId, role, passwordHash }, secret) {
  nonemptyText(userId, "userId");
  nonemptyText(role, "role");
  nonemptyText(passwordHash, "passwordHash");
  secretKey(secret, "secret");
  return createHmac("sha256", secret)
    .update(JSON.stringify(["op-session-version:v1", userId, role, passwordHash])).digest("base64url");
}

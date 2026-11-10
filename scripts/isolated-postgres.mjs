// Disposable native PostgreSQL for tests. Never accepts connection/path overrides
// or reads DATABASE_URL/PG* settings. The returned URL contains a random secret:
// pass it directly to tests, never print it or save it in repository files.
import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import pg from "pg";

const workerKind = "op-isolated-postgres";
const samePath = (left, right) => {
  const normalize = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
};

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function deadline(work, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

/** Returns { pool, url, directory, close }. Always await close() in finally and
 * release checked-out clients first. close() is idempotent, ends the pool, stops
 * via embedded-postgres, then verifies/removes exactly its own temp directory.
 * Optional onQuery({ text, values }) observes actual client queries, including
 * the read-only identity guard on every new connection. It must not log secrets.
 */
export async function startIsolatedPostgres(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some((key) => !["onQuery", "poolSize"].includes(key))
    || (options.poolSize !== undefined && (!Number.isInteger(options.poolSize) || options.poolSize < 1 || options.poolSize > 32))) {
    throw new TypeError("Only the optional onQuery observer is supported; database/path overrides are forbidden.");
  }
  const { onQuery } = options;
  if (onQuery !== undefined && typeof onQuery !== "function") throw new TypeError("onQuery must be a function.");
  const tempRoot = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(tempRoot, "op-postgres-"));
  const identity = await lstat(directory);
  const user = `op_${randomBytes(10).toString("hex")}`;
  const password = randomBytes(32).toString("base64url");
  let pool, worker, closing;
  let diagnostics = "";
  const redact = (value) => String(value instanceof Error ? value.message : value ?? "Unknown embedded PostgreSQL failure")
    .replaceAll(password, "[redacted]").replaceAll(user, "[test-user]")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted connection URL]");
  const capture = (value) => { diagnostics = (diagnostics + "\n" + redact(value)).slice(-8192); };

  async function removeOwnedDirectory() {
    if (!samePath(path.dirname(directory), tempRoot) || !/^op-postgres-[a-z\d]+$/i.test(path.basename(directory))) {
      throw new Error("Refusing to remove an unexpected PostgreSQL temporary path.");
    }
    const current = await lstat(directory).catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (!current) return;
    if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino
      || !samePath(await realpath(directory), directory)) {
      throw new Error("Refusing to remove a replaced or redirected PostgreSQL temporary directory.");
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  function waitFor(type, timeoutMs) {
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        worker.off("message", message);
        worker.off("error", failure);
        worker.off("exit", exit);
        error ? reject(error) : resolve();
      };
      const message = (value) => {
        if (value.type === type) finish();
        else if (value.type === `${type}-failed`) finish(new Error(redact(value.error)));
      };
      const failure = (error) => finish(new Error(redact(error)));
      const exit = (code) => finish(new Error(`Embedded PostgreSQL worker exited unexpectedly (${code}).`));
      const timer = setTimeout(() => finish(new Error(`Embedded PostgreSQL ${type} timed out.`)), timeoutMs);
      worker.on("message", message).on("error", failure).on("exit", exit);
    });
  }

  async function close() {
    if (!closing) closing = (async () => {
      let poolError;
      try { if (pool) await deadline(pool.end(), 10_000, "Timed out draining the isolated PostgreSQL pool; release borrowed clients."); }
      catch (error) { poolError = error; }
      if (worker) {
        const stopped = waitFor("stopped", 20_000);
        worker.postMessage({ type: "stop" });
        try { await stopped; } // Never delete while a native cluster might still be running.
        catch (error) {
          // A failed native stop must report an error instead of keeping a test
          // reporter alive forever. Keep the directory for targeted recovery.
          worker.unref();
          throw error;
        }
        await worker.terminate();
      }
      await removeOwnedDirectory();
      if (poolError) throw new Error(redact(poolError));
    })();
    return closing;
  }

  try {
    const port = await freePort();
    // Native tools inherit only OS/runtime necessities, never portal credentials,
    // DATABASE_URL, PGHOST, PGPASSWORD, PGSERVICE, NODE_OPTIONS or other test knobs.
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|userprofile|appdata|localappdata|homedrive|homepath|lang|lc_\w+|tz)$/i.test(key)));
    worker = new Worker(new URL(import.meta.url), {
      workerData: { kind: workerKind, directory, port, user, password },
      env: environment, execArgv: [], stdout: true, stderr: true,
    });
    worker.stdout.on("data", capture);
    worker.stderr.on("data", capture);
    worker.on("error", capture);
    worker.on("message", (message) => { if (message.type === "diagnostic") capture(message.text); });
    await waitFor("ready", 45_000);
    pool = new pg.Pool({
      host: "127.0.0.1", port, user, password, database: "postgres", ssl: false,
      max: options.poolSize || 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000,
      application_name: "op-isolated-postgres", options: "-c statement_timeout=15000 -c lock_timeout=10000",
      async onConnect(client) {
        const query = client.query.bind(client);
        if (onQuery) client.query = (...args) => {
          onQuery({ text: typeof args[0] === "string" ? args[0] : args[0]?.text, values: args[1] ?? args[0]?.values });
          return query(...args);
        };
        const connection = client.connectionParameters;
        if (connection.host !== "127.0.0.1" || connection.port !== port || connection.user !== user
          || connection.database !== "postgres" || connection.ssl) throw new Error("Refusing a non-isolated PostgreSQL connection.");
        const { rows: [server] } = await client.query(`SELECT current_setting('data_directory') AS directory,
          host(inet_server_addr()) AS host, inet_server_port() AS port, current_user AS username`);
        if (!samePath(server.directory, directory) || server.host !== "127.0.0.1" || server.port !== port || server.username !== user) {
          throw new Error("Refusing queries against an unverified PostgreSQL cluster.");
        }
      },
    });
    pool.on("error", capture);
    // Verify identity before the caller can issue any writes, even on first use.
    const client = await pool.connect();
    client.release();
    const url = new URL(`postgresql://127.0.0.1:${port}/postgres`);
    url.username = user;
    url.password = password;
    return { pool, url: url.href, directory, close };
  } catch (error) {
    let cleanupError;
    try { await close(); } catch (failure) { cleanupError = redact(failure); }
    throw Object.assign(new Error(`Isolated PostgreSQL startup failed: ${redact(error)}${diagnostics ? `\n${diagnostics}` : ""}${cleanupError ? `\nCleanup failed; directory retained: ${cleanupError}` : ""}`), { directory });
  }
}

async function runClusterWorker() {
  // The dependency omits windowsHide and spawn error listeners. Patch only this
  // worker's builtin module before loading it; the parent stays untouched.
  const { default: childProcess } = await import("node:child_process");
  const { syncBuiltinESMExports } = await import("node:module");
  const spawn = childProcess.spawn;
  const children = new Set();
  let logs = "", cluster, pgControl, stopRequested = false;
  const redact = (value) => String(value instanceof Error ? value.message : value ?? "Unknown native failure")
    .replaceAll(workerData.password, "[redacted]").replaceAll(workerData.user, "[test-user]");
  const capture = (value) => {
    const text = redact(value);
    logs = (logs + "\n" + text).slice(-8192);
    parentPort.postMessage({ type: "diagnostic", text });
  };
  childProcess.spawn = (command, args, options) => {
    if (stopRequested && /(?:^|[\\/])(?:initdb|postgres)(?:\.exe)?$/i.test(command)) {
      throw new Error("Isolated PostgreSQL startup was cancelled.");
    }
    // The package stops Windows clusters using taskkill, which may be denied in
    // a restricted process tree. Keep its stop lifecycle, but use its bundled
    // pg_ctl to request shutdown of this exact owned directory instead.
    if (process.platform === "win32" && command === "taskkill") {
      if (!pgControl || args[1] !== String(cluster?.process?.pid)) throw new Error("Refusing to stop an unexpected PostgreSQL process.");
      command = pgControl;
      args = ["stop", "-D", workerData.directory, "-m", "fast", "-w", "-t", "15"];
    }
    const child = spawn(command, args, { ...options, windowsHide: true });
    children.add(child);
    child.on("error", capture); // Also lets the package's close listener reject.
    if (command === pgControl) child.stderr?.on("data", capture);
    child.once("close", () => children.delete(child));
    return child;
  };
  syncBuiltinESMExports();
  const started = (async () => {
    if (process.platform === "win32") ({ pg_ctl: pgControl } = await import("@embedded-postgres/windows-x64"));
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    cluster = new EmbeddedPostgres({
      databaseDir: workerData.directory, port: workerData.port,
      user: workerData.user, password: workerData.password, authMethod: "scram-sha-256",
      persistent: true, createPostgresUser: false, autoRehydrateSymlinks: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      postgresFlags: ["-h", "127.0.0.1", "-c", "unix_socket_directories=", "-c", "max_connections=40"],
      onLog: capture, onError: capture,
    });
    await cluster.initialise();
    if (stopRequested) throw new Error("Isolated PostgreSQL startup was cancelled.");
    await cluster.start();
    if (stopRequested) throw new Error("Isolated PostgreSQL startup was cancelled.");
    parentPort.postMessage({ type: "ready" });
  })();
  started.catch((error) => parentPort.postMessage({ type: "ready-failed", error: `${redact(error)}\n${logs}` }));
  let stopping;
  parentPort.on("message", ({ type }) => {
    if (type !== "stop") return;
    if (!stopping) stopping = (async () => {
      stopRequested = true;
      // A failed/timed-out initdb must not make close wait forever for started.
      // Only handles spawned by this worker can be signalled. Cancelling initdb
      // closes its pipes, and the package still removes its password file.
      for (const child of children) {
        if (child !== cluster?.process && /(?:^|[\\/])initdb(?:\.exe)?$/i.test(child.spawnfile)
          && child.exitCode === null && child.signalCode === null) child.kill();
      }
      // The package's stop() waits for a future exit event; an already failed
      // server has no future event. Clear that dead handle before calling stop.
      if (cluster?.process && (cluster.process.exitCode !== null || cluster.process.signalCode !== null)) cluster.process = undefined;
      const closed = [...children].map((child) => new Promise((resolve) => child.once("close", resolve)));
      if (cluster) await deadline(cluster.stop(), 12_000, "Timed out stopping the owned PostgreSQL postmaster.");
      // Stop the server BEFORE awaiting startup: a server that never emits its
      // ready line must still be stopped, and its close event settles start().
      await deadline(started.catch(() => {}), 5000, "Timed out cancelling isolated PostgreSQL startup.");
      // stop() itself spawns pg_ctl on Windows; include that new child as well
      // as the handles captured before shutdown, without signalling other PIDs.
      const stoppingChildren = [...children].map((child) => new Promise((resolve) => child.once("close", resolve)));
      await deadline(Promise.all([...closed, ...stoppingChildren]), 2000, "Timed out draining owned PostgreSQL process handles.");
      parentPort.postMessage({ type: "stopped" });
      parentPort.unref();
    })();
    stopping.catch((error) => parentPort.postMessage({ type: "stopped-failed", error: redact(error) }));
  });
}

if (!isMainThread && workerData?.kind === workerKind) await runClusterWorker();
